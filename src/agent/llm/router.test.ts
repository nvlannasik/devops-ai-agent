import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterLLMClient } from "./router.js";
import { withRoute } from "../../utils/trace/index.js";
import type { LLMClient, LLMResponse, Message } from "./types.js";

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

// LLM_BACKEND_<N>_MODEL never reaches `config` — the router is the only place that knows
// which model answered. A dropped `model: this.models.get(name)` would leave both
// assertions below undefined, not merely one of them wrong.
test("the response carries the answering backend's configured model, not a substitute", async () => {
  const calls: string[] = [];
  const m = new Map<string, LLMClient>([
    ["light1", fake(answer("L"), calls, "light1")],
    ["heavy1", fake(answer("H"), calls, "heavy1")],
  ]);
  const models = new Map([["light1", "light-model"], ["heavy1", "heavy-model"]]);
  const r = new RouterLLMClient(m, ["heavy1"], ["light1"], models);

  const heavyRes = await r.chat([], [], "sys"); // no route context -> heavy chain
  assert.equal(heavyRes.backend, "heavy1");
  assert.equal(heavyRes.model, "heavy-model");

  const lightRes = await withRoute("light", () => r.chat([], [], "sys"));
  assert.equal(lightRes.backend, "light1");
  assert.equal(lightRes.model, "light-model");
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

test("withRoute('heavy') uses the heavy chain and never touches light", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("heavy", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["heavy1"]);
  assert.equal(res.content[0].text, "H");
  assert.ok(!calls.includes("light1"));
});

// Production runs up to MAX_CONCURRENT_INVESTIGATIONS flows against ONE RouterLLMClient.
// Every other test here is sequential, so a module-level `{route, escalated}` singleton would
// pass all of them. This one interleaves two flows on purpose: A escalates, then B must still
// start at its light backend. With shared state, B's second call skips light and this fails.
test("escalation in one flow does not leak into a concurrent one", async () => {
  const calls: string[] = [];
  const aEscalated = Promise.withResolvers<void>();
  const bStarted = Promise.withResolvers<void>();
  const flowOf = (messages: Message[]) => messages[0].content as string;

  const light: LLMClient = {
    async chat(messages) {
      const flow = flowOf(messages);
      calls.push(`light:${flow}`);
      if (flow === "A") throw new Error("light down for A");
      return answer(`L-${flow}`);
    },
  };
  const heavy: LLMClient = {
    async chat(messages) {
      calls.push(`heavy:${flowOf(messages)}`);
      return answer(`H-${flowOf(messages)}`);
    },
  };
  const m = new Map<string, LLMClient>([["light1", light], ["heavy1", heavy]]);
  const r = new RouterLLMClient(m, ["heavy1"], ["light1"]);
  const say = (flow: string) => r.chat([{ role: "user", content: flow }], [], "sys");

  await Promise.all([
    withRoute("light", async () => {
      await say("A"); // light fails -> heavy; escalated = true for THIS context only
      aEscalated.resolve();
      await bStarted.promise;
      await say("A"); // sticky: straight to heavy
    }),
    withRoute("light", async () => {
      await aEscalated.promise;
      await say("B"); // light succeeds
      bStarted.resolve();
      await say("B"); // must STILL try light — A's escalation is not ours
    }),
  ]);

  assert.deepEqual(calls.filter((c) => c.endsWith(":A")), ["light:A", "heavy:A", "heavy:A"]);
  assert.deepEqual(calls.filter((c) => c.endsWith(":B")), ["light:B", "light:B"]);
});

test("two light backends where first fails and second succeeds does NOT set escalated", async () => {
  const calls: string[] = [];
  let light1CallCount = 0;
  const light1: LLMClient = {
    async chat() {
      calls.push("light1");
      light1CallCount++;
      if (light1CallCount === 1) throw new Error("transient failure");
      return answer("L1");
    },
  };
  const light2 = fake(answer("L2"), calls, "light2");
  const heavy1 = fake(answer("H"), calls, "heavy1");

  const m = new Map<string, LLMClient>([["light1", light1], ["light2", light2], ["heavy1", heavy1]]);
  const r = new RouterLLMClient(m, ["heavy1"], ["light1", "light2"]);

  await withRoute("light", async () => {
    // First call: light1 fails, light2 succeeds. This is a lateral hop within light tier.
    const res1 = await r.chat([], [], "sys");
    assert.deepEqual(calls, ["light1", "light2"]);
    assert.equal(res1.content[0].text, "L2");

    // Second call in same context: escalation was NOT set (it was a lateral hop, not a tier crossing),
    // so we try light1 first again. This time it succeeds.
    const res2 = await r.chat([], [], "sys");
    assert.deepEqual(calls, ["light1", "light2", "light1"]);
    assert.equal(res2.content[0].text, "L1");
  });
});
