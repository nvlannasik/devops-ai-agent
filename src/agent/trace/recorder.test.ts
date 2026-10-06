import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceRecorder, instrumentLLM, instrumentMCP, MAX_RESULT_CHARS } from "./index.js";
import type { EventRow } from "./store.js";
import { withTrace } from "../../utils/trace/index.js";

const sink = () => {
  const rows: EventRow[] = [];
  return { rows, insert: async (r: EventRow[]) => void rows.push(...r) };
};
const rec = (s = sink()) => ({ s, r: new TraceRecorder(s, { source: "prod", sha: "abc" }) });
const gates = (rows: EventRow[]) => rows.filter((e) => e.kind === "gate").map((e) => `${e.name}:${e.outcome}`);

test("a run is buffered and written once, in order, with seq from 0", async () => {
  const { s, r } = rec();
  r.begin("1.1", { issue: "x" });
  r.tool("1.1", "k8s_list_pods", { namespace: "a" }, { result: "[]" }, 5);
  r.gate("1.1", "placeholder", "refused", "X");
  r.end("1.1", { answer: "done" });
  assert.equal(s.rows.length, 0, "nothing is written before finish");
  await r.finish("1.1");
  assert.deepEqual(s.rows.map((e) => [e.seq, e.kind]), [[0, "start"], [1, "tool"], [2, "gate"], [3, "end"]]);
  const run = s.rows[0]!.payload.run;
  assert.ok(typeof run === "string" && s.rows.every((e) => e.payload.run === run));
  assert.equal(s.rows[0]!.payload.source, "prod");
  assert.equal(s.rows[0]!.payload.sha, "abc");
  assert.equal(s.rows[2]!.payload.source, "prod", "gate rows carry source for the dashboard filter");
});

test("an outstanding nudge resolves as accepted at end, or as what the loop says", async () => {
  const { s, r } = rec();
  r.begin("1.1", {});
  r.gate("1.1", "log-gap", "nudge");
  r.end("1.1", {});
  await r.finish("1.1");
  assert.deepEqual(gates(s.rows), ["log-gap:nudge", "log-gap:accepted"]);

  const t = rec();
  t.r.begin("2.2", {});
  t.r.gate("2.2", "log-gap", "nudge");
  t.r.resolveNudge("2.2", "kept-earlier");
  t.r.end("2.2", {});
  await t.r.finish("2.2");
  assert.deepEqual(gates(t.s.rows), ["log-gap:nudge", "log-gap:kept-earlier"]);
});

test("a second nudge resolves the first as accepted — its retry is what the second interrupted", async () => {
  const { s, r } = rec();
  r.begin("1.1", {});
  r.gate("1.1", "log-gap", "nudge");
  r.gate("1.1", "image-gap", "nudge");
  r.resolveNudge("1.1", "restored");
  await r.finish("1.1");
  assert.deepEqual(gates(s.rows), ["log-gap:nudge", "log-gap:accepted", "image-gap:nudge", "image-gap:restored"]);
});

test("a gate with no open run is written on its own, not dropped", async () => {
  const { s, r } = rec();
  r.gate("9.9", "rca-structure", "card");
  await new Promise((res) => setImmediate(res));
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]!.payload.run, null);
  assert.equal(s.rows[0]!.payload.source, "prod");
});

test("llm and tool events outside a run are ignored", async () => {
  const { s, r } = rec();
  r.tool("9.9", "x", {}, { result: "y" }, 1);
  await r.finish("9.9");
  assert.equal(s.rows.length, 0);
});

test("a huge result is capped and flagged; NUL and lone surrogates never reach jsonb", async () => {
  const { s, r } = rec();
  r.begin("1.1", {});
  r.tool("1.1", "loki_query_range", {}, { result: "a\u0000b\ud83d" + "x".repeat(MAX_RESULT_CHARS) }, 1);
  await r.finish("1.1");
  const p = s.rows[1]!.payload as { result: string; truncated: boolean };
  assert.equal(p.truncated, true);
  assert.ok(p.result.length <= MAX_RESULT_CHARS);
  assert.ok(!p.result.includes("\u0000"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(p.result), "a lone high surrogate survived");
});

test("disabled recorder (no sink) does nothing and never throws", async () => {
  const r = new TraceRecorder(null, { source: "prod", sha: "x" });
  assert.equal(r.enabled, false);
  r.begin("1.1", {});
  r.gate("1.1", "log-gap", "nudge");
  await r.finish("1.1");
});

test("instrumented clients record under the ambient trace — parallel delegates stay apart", async () => {
  const { s, r } = rec();
  const llm = instrumentLLM({ chat: async () => ({ content: [{ type: "text" as const, text: "hi" }], stopReason: "end_turn" as const }) }, () => r);
  const mcp = instrumentMCP({ callTool: async (name: string) => (name === "bad" ? Promise.reject(new Error("boom")) : `ok:${name}`) }, () => r);
  r.begin("1.1", {});
  r.begin("1.1/sub-1", {});
  await Promise.all([
    withTrace("1.1", async () => { await llm.chat([], [], ""); await mcp.callTool("a", {}); }),
    withTrace("1.1/sub-1", async () => { await mcp.callTool("b", {}); await mcp.callTool("bad", {}).catch(() => {}); }),
  ]);
  await r.finish("1.1/sub-1");
  await r.finish("1.1");
  const by = (t: string) => s.rows.filter((e) => e.threadTs === t).map((e) => `${e.kind}:${e.name ?? ""}`);
  assert.deepEqual(by("1.1"), ["start:", "llm:", "tool:a"]);
  assert.deepEqual(by("1.1/sub-1"), ["start:", "tool:b", "tool:bad"]);
  assert.match(String(s.rows.find((e) => e.name === "bad")!.payload.error), /boom/);
});

test("a sink that throws costs the trace, never the caller", async () => {
  const r = new TraceRecorder({ insert: async () => { throw new Error("db down"); } }, { source: "prod", sha: "x" });
  r.begin("1.1", {});
  await r.finish("1.1");
});

test("every refusalFor gate string maps to its own gate name", async () => {
  const { refusalGate } = await import("./index.js");
  assert.equal(refusalGate("image gate"), "remediation-image");
  assert.equal(refusalGate("replacement guard"), "remediation-replacement");
  assert.equal(refusalGate("resource-fault gate"), "remediation-resource-fault");
  assert.equal(refusalGate("something new"), "remediation-other");
});

test("an llm event carries how long the call took, failover included", async () => {
  const { s, r } = rec();
  const llm = instrumentLLM(
    { chat: async () => (await new Promise((ok) => setTimeout(ok, 30)), { content: [], stopReason: "end_turn" as const, backend: "slow" }) },
    () => r
  );
  r.begin("1.1", {});
  await withTrace("1.1", () => llm.chat([], [], ""));
  await r.finish("1.1");
  const ev = s.rows.find((e) => e.kind === "llm")!;
  assert.equal(ev.name, "slow");
  assert.ok(typeof ev.payload.ms === "number" && ev.payload.ms >= 25, `ms=${ev.payload.ms}`);
});
