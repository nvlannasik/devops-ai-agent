import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { REDIS_KEYS } from "./index.js";
import { REDIS_KEYS as DEDUP_KEYS } from "../dedup/index.js";
import assert from "node:assert/strict";
import { ConversationMemory } from "./index.js";
import type { Message } from "../llm/types.js";

const userText = (text: string): Message => ({ role: "user", content: text });
const assistantToolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "k8s_list_pods", input: {} }],
});
const userToolResult = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

test("in-memory backend round-trips appended messages", async () => {
  const memory = new ConversationMemory();
  await memory.append("t1", userText("issue"));
  await memory.append("t1", { role: "assistant", content: "ack" });
  const history = await memory.get("t1");
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "issue");
});

test("append keeps the original issue even past the storage cap", async () => {
  const memory = new ConversationMemory();
  await memory.append("t1", userText("ORIGINAL ISSUE"));
  // push well past MAX_MESSAGES (50) of tool_use/tool_result rounds
  for (let i = 0; i < 60; i++) {
    await memory.append("t1", assistantToolUse(`call-${i}`));
    await memory.append("t1", userToolResult(`call-${i}`));
  }
  const history = await memory.get("t1");
  assert.equal(history[0].content, "ORIGINAL ISSUE"); // not dropped by trimming
  assert.ok(history.length <= 50);

  // and no tool_result is left orphaned in storage
  const seen = new Set<string>();
  for (const message of history) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) seen.add(block.id);
      if (block.type === "tool_result") {
        assert.ok(block.tool_use_id && seen.has(block.tool_use_id));
      }
    }
  }
});

test("rca flag is tracked and cleared per thread", async () => {
  const memory = new ConversationMemory();
  assert.equal(await memory.hasRca("t1"), false);
  await memory.markRcaSent("t1");
  assert.equal(await memory.hasRca("t1"), true);
  await memory.clear("t1");
  assert.equal(await memory.hasRca("t1"), false);
  assert.deepEqual(await memory.get("t1"), []);
});

test("threads are isolated from each other", async () => {
  const memory = new ConversationMemory();
  await memory.append("a", userText("issue A"));
  await memory.append("b", userText("issue B"));
  assert.equal((await memory.get("a"))[0].content, "issue A");
  assert.equal((await memory.get("b"))[0].content, "issue B");
});

// ---- Durable playbooks (skills:<threadId>) ----
//
// The regression: DevOpsAgent.threadSkills was a plain in-process Map while the conversation sat
// in Redis. After a rollout a live thread came back with its history and none of its playbooks —
// a latency follow-up answered without the latency playbook, and nothing in the log said so.

type RedisCall = { cmd: string; args: unknown[] };

const stubRedis = (store: Map<string, string>, calls: RedisCall[] = []) =>
  ({
    get: async (k: string) => {
      calls.push({ cmd: "get", args: [k] });
      return store.get(k) ?? null;
    },
    set: async (k: string, v: string, ...rest: unknown[]) => {
      calls.push({ cmd: "set", args: [k, v, ...rest] });
      store.set(k, v);
      return "OK";
    },
    del: async (...keys: string[]) => {
      calls.push({ cmd: "del", args: keys });
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    exists: async (k: string) => (store.has(k) ? 1 : 0),
  }) as never;

test("in-memory backend round-trips a thread's playbooks", async () => {
  const memory = new ConversationMemory();
  assert.deepEqual(await memory.getSkills("t1"), [], "an unseen thread has no playbooks, not undefined");
  await memory.setSkills("t1", ["rca-format", "high-latency"]);
  assert.deepEqual(await memory.getSkills("t1"), ["rca-format", "high-latency"]);
});

test("playbooks survive in Redis under their own key, with the conversation's TTL", async () => {
  const store = new Map<string, string>();
  const calls: RedisCall[] = [];
  await new ConversationMemory(stubRedis(store, calls)).setSkills("t1", ["rca-format", "oomkilled"]);

  const write = calls.find((c) => c.cmd === "set")!;
  assert.equal(write.args[0], "skills:t1", "must not collide with conv: or rca:");
  assert.equal(write.args[2], "EX", "a playbook set that outlives its conversation is worse than none");
  assert.equal(write.args[3], 86400);

  // A second instance is what a restarted pod is.
  assert.deepEqual(await new ConversationMemory(stubRedis(store)).getSkills("t1"), ["rca-format", "oomkilled"]);
});

test("a corrupt or wrongly-shaped playbook entry costs the playbooks, never the thread", async () => {
  const store = new Map<string, string>();
  const memory = new ConversationMemory(stubRedis(store));

  store.set("skills:t1", "{not json");
  assert.deepEqual(await memory.getSkills("t1"), []);

  store.set("skills:t2", '{"name":"rca-format"}'); // an object, not an array
  assert.deepEqual(await memory.getSkills("t2"), []);

  store.set("skills:t3", '["rca-format", 42, null]');
  assert.deepEqual(await memory.getSkills("t3"), ["rca-format"], "non-strings are dropped, not stringified");
});

test("clear() drops the playbooks with the conversation on both backends", async () => {
  const memory = new ConversationMemory();
  await memory.setSkills("t1", ["rca-format"]);
  await memory.clear("t1");
  assert.deepEqual(await memory.getSkills("t1"), []);

  const store = new Map<string, string>();
  const calls: RedisCall[] = [];
  const redisMemory = new ConversationMemory(stubRedis(store, calls));
  await redisMemory.setSkills("t1", ["rca-format"]);
  await redisMemory.clear("t1");
  assert.deepEqual(calls.find((c) => c.cmd === "del")!.args, ["conv:t1", "rca:t1", "skills:t1"]);
  assert.deepEqual(await redisMemory.getSkills("t1"), []);
});

// The topology page lists REDIS_KEYS as "what this agent keeps in Redis". A second copy of that
// list would drift the first time someone added a key; this is what stops the FIRST copy from
// drifting from the code it describes. Same trick as skills/real.test.ts: read the shipped
// source, not a fixture, so the assertion is about what actually ships.
test("every Redis key this agent writes is named in REDIS_KEYS", async () => {
  const files = [
    new URL("./index.ts", import.meta.url),
    new URL("../dedup/index.ts", import.meta.url),
  ];
  const declared = new Set([
    ...Object.values(REDIS_KEYS).map((k) => k.prefix),
    ...Object.values(DEDUP_KEYS).map((k) => k.prefix),
  ]);

  for (const file of files) {
    const src = await readFile(file, "utf8");
    // A literal prefix reaching a redis call — `redis.get("conv:...")` rather than through the
    // constant. The constant form interpolates and so never matches this.
    for (const m of src.matchAll(/redis\.\w+\(\s*`([a-z_]+):/g)) {
      assert.ok(
        declared.has(m[1]!),
        `${m[1]}: is written to Redis but is not in REDIS_KEYS — the topology page will not list it`
      );
    }
  }
  // A negative control: without this, a regex that matched nothing would pass silently.
  assert.ok(declared.size >= 4, "the four known prefixes should be declared");
});
