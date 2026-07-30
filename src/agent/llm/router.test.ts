import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterLLMClient } from "./router.js";
import { withRoute } from "../../utils/trace/index.js";
import type { LLMClient, LLMResponse } from "./types.js";

// A fake backend is a plain object — that is the whole point of injecting the map.
function fake(res: LLMResponse | (() => never), calls: string[], name: string): LLMClient {
  return {
    async chat() {
      calls.push(name);
      if (typeof res === "function") res();
      return res;
    },
  };
}

const answer = (text: string): LLMResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

const toolRound = (): LLMResponse => ({
  content: [{ type: "tool_use", id: "t1", name: "k8s_list_pods", input: {} }],
  stopReason: "tool_use",
});

const boom = () => {
  throw new Error("backend down");
};

function build(calls: string[], light: LLMClient, heavy: LLMClient, heavy2?: LLMClient) {
  const m = new Map<string, LLMClient>([["light1", light], ["heavy1", heavy]]);
  if (heavy2) m.set("heavy2", heavy2);
  return new RouterLLMClient(m, heavy2 ? ["heavy1", "heavy2"] : ["heavy1"], ["light1"]);
}

test("no route context uses the heavy chain", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await r.chat([], [], "sys");
  assert.deepEqual(calls, ["heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("withRoute('light') uses the light chain", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1"]);
  assert.equal(res.content[0].text, "L");
});

test("a throwing light backend falls up to heavy", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("a throwing heavy backend propagates and NEVER falls down to light", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(boom, calls, "heavy1"));
  await assert.rejects(() => r.chat([], [], "sys"), /all LLM backends failed/);
  assert.deepEqual(calls, ["heavy1"]);
  assert.ok(!calls.includes("light1"));
});

test("an empty response falls up", async () => {
  const calls: string[] = [];
  const empty: LLMResponse = { content: [], stopReason: "end_turn" };
  const r = build(calls, fake(empty, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("a tool_use round with no text is NOT a failure", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(toolRound(), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1"]);
  assert.equal(res.stopReason, "tool_use");
});

test("a serialized-content-block answer falls up", async () => {
  const calls: string[] = [];
  const junk = answer('[{"type":"tool_use","name":"k8s_list_pods"}]');
  const r = build(calls, fake(junk, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("escalation is sticky for the rest of the investigation", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  await withRoute("light", async () => {
    await r.chat([], [], "sys");
    await r.chat([], [], "sys");
  });
  assert.deepEqual(calls, ["light1", "heavy1", "heavy1"]);
});

test("lateral failover inside the heavy tier", async () => {
  const calls: string[] = [];
  const r = build(
    calls,
    fake(answer("L"), calls, "light1"),
    fake(boom, calls, "heavy1"),
    fake(answer("H2"), calls, "heavy2")
  );
  const res = await r.chat([], [], "sys");
  assert.deepEqual(calls, ["heavy1", "heavy2"]);
  assert.equal(res.content[0].text, "H2");
});

test("an exhausted chain names every backend and sets cause", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(boom, calls, "heavy1"));
  await assert.rejects(
    () => withRoute("light", () => r.chat([], [], "sys")),
    (err: Error) => {
      assert.match(err.message, /light1/);
      assert.match(err.message, /heavy1/);
      assert.ok(err.cause instanceof Error);
      return true;
    }
  );
});

test("the constructor rejects a route naming an unknown backend", () => {
  assert.throws(
    () => new RouterLLMClient(new Map(), ["ghost"], []),
    /ghost/
  );
});

test("the constructor rejects an empty heavy chain", () => {
  const m = new Map<string, LLMClient>([["a", fake(answer("A"), [], "a")]]);
  assert.throws(() => new RouterLLMClient(m, [], ["a"]), /heavy/);
});

test("shutdown reaches every backend even when one throws", async () => {
  const stopped: string[] = [];
  const mk = (name: string, fail = false): LLMClient => ({
    async chat() {
      return answer(name);
    },
    async shutdown() {
      stopped.push(name);
      if (fail) throw new Error("shutdown failed");
    },
  });
  const m = new Map<string, LLMClient>([["a", mk("a", true)], ["b", mk("b")]]);
  await new RouterLLMClient(m, ["a", "b"], []).shutdown();
  assert.deepEqual(stopped.sort(), ["a", "b"]);
});
