import test from "node:test";
import assert from "node:assert/strict";
import { settleAnswer } from "./answer-gates.js";
import { newRunState, type RunCtx } from "./run-state.js";
import { NO_EVIDENCE_NOTICE, ALERT_IN_SCOPE_NOTICE, declinesAlert } from "./control.js";
import { TraceRecorder } from "../trace/index.js";

const ctx: RunCtx = { threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 60_000, startedAt: Date.now(), tools: [], systemPrompt: "", opts: {} };
const host = (appended: unknown[]) => ({
  memory: { append: async (_t: string, m: unknown) => void appended.push(m), get: async () => [] } as never,
  trace: () => new TraceRecorder(null, { source: "prod", sha: "t" }),
});
const reply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" }) as never;

test("an alert answered with zero tool calls is nudged once: null, and the notice is appended", async () => {
  const appended: unknown[] = [];
  const s = newRunState([]);
  s.iterations = 1;
  assert.equal(await settleAnswer(host(appended), ctx, s, reply("All fine.")), null);
  assert.equal(s.noEvidenceNudged, true);
  assert.deepEqual(appended, [{ role: "user", content: NO_EVIDENCE_NOTICE }]);
});

test("an empty final response is never returned empty", async () => {
  const s = newRunState([]);
  s.toolRounds = 1;
  const out = await settleAnswer(host([]), ctx, s, reply(""));
  assert.match(out!, /empty response/);
});

// Bench A02, 2026-11-12: three tool rounds into a PodOOMKilled alert, the model's answer was the
// scope decline. The log-gap round got the same line back and restored it, and that was the RCA.
const DECLINE = "That's outside what I do — I'm a DevOps agent for this cluster: pods, logs, metrics, incidents, deploys. Ask me about a workload or an alert and I'm in.";

test("an alert answered with the out-of-scope line is nudged once, and never leaves as that line", async () => {
  const appended: unknown[] = [];
  const s = newRunState([]);
  s.iterations = 4;
  s.toolRounds = 3;
  assert.equal(await settleAnswer(host(appended), ctx, s, reply(DECLINE)), null);
  assert.equal(s.scopeDeclineNudged, true);
  assert.deepEqual(appended, [{ role: "user", content: ALERT_IN_SCOPE_NOTICE }]);
  assert.equal(s.preNudgeSummary, "", "the decline is not held: there is nothing in it to restore");

  // declined again: a visible failure, not the line
  s.iterations = 5;
  const out = await settleAnswer(host(appended), ctx, s, reply(DECLINE));
  assert.match(out!, /out-of-scope line, twice/);
  assert.match(out!, /3 tool round\(s\)/);
  assert.equal(appended.length, 1, "one nudge, never a loop");
});

test("the decline rule is the alert path's alone, and an RCA quoting the line is not a decline", () => {
  assert.equal(declinesAlert("alert", DECLINE), true);
  assert.equal(declinesAlert("alert", "Itu di luar lingkup saya — saya agen DevOps untuk cluster ini."), true);
  // a human's request can really be out of scope (bench C07)
  assert.equal(declinesAlert("conversation", DECLINE), false);
  assert.equal(declinesAlert("investigation", DECLINE), false);
  assert.equal(declinesAlert("alert", `*📍 Root Cause*\n${"x".repeat(700)}\nthe app logged "that's outside what I do"`), false);
  assert.equal(declinesAlert("alert", "*🟠 Severity:* High\n*📍 Root Cause*\nOOMKilled at 128Mi"), false);
});

test("a decline on the last call it could spend goes out as the visible failure", async () => {
  const s = newRunState([]);
  s.iterations = 10; // ctx.maxIterations — no call left for a nudge
  s.toolRounds = 9;
  const out = await settleAnswer(host([]), ctx, s, reply(DECLINE));
  assert.match(out!, /model failure, not a finding/);
});
