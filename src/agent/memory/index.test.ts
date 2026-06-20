import { test } from "node:test";
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
