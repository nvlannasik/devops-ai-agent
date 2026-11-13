import test from "node:test";
import assert from "node:assert/strict";
import { settleAnswer, UNGROUNDED_NOTICE } from "./answer-gates.js";
import { newRunState, type RunCtx } from "./run-state.js";
import { NO_EVIDENCE_NOTICE, ALERT_IN_SCOPE_NOTICE, declinesAlert } from "./control.js";
import { TraceRecorder } from "../trace/index.js";

const ctx: RunCtx = { threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 60_000, startedAt: Date.now(), tools: [], systemPrompt: "", opts: {} };
const host = (appended: unknown[], history: unknown[] = []) => ({
  memory: { append: async (_t: string, m: unknown) => void appended.push(m), get: async () => history } as never,
  skills: { all: () => [{ name: "gitops-drift" }] },
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

// Bench 2026-11-12, A13 #1: a correct RBAC diagnosis whose Immediate action invented a Role to
// create — "Example: create a Role `pod-lister`" — and failed the attempt on grounding.
const rcaWith = (immediate: string) =>
  "*🟠 Severity:* High\n\n" +
  `*🔧 Recommended Actions*\n1. *Immediate:* ${immediate}\n\n` +
  "*📍 Root Cause*\n1. *Symptom:* ServiceAccount `reporter` in `bench-a13` is forbidden to list pods — _k8s_get_pod_logs_ `bench-a13/reporter-7d9f8b6c5-x2k4q`\n\n" +
  "*📈 Confidence:* High — the denial is quoted from the pod's own log.";
const INVENTED = rcaWith("Bind a Role with `list` on `pods` to ServiceAccount `reporter`. Example: create a Role `pod-lister`.");
const CLEAN = rcaWith("Bind a Role granting `list` on `pods` to ServiceAccount `reporter` in `bench-a13`.");
const evidence = [
  { role: "assistant", content: [{ type: "tool_use", id: "1", name: "k8s_get_pod_logs", input: { namespace: "bench-a13", pod_name: "reporter-7d9f8b6c5-x2k4q" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: 'pods is forbidden: User "system:serviceaccount:bench-a13:reporter" cannot list resource "pods"' }] },
];
const grounded: RunCtx = { ...ctx, opts: { grounding: "Alert: ReporterErrors namespace=bench-a13\nDeployment/invoice-worker revision 2" } };
const midRun = () => {
  const s = newRunState([]);
  s.iterations = 3;
  s.toolRounds = 2;
  s.sawLogLines = true;
  return s;
};

test("an RCA naming a resource no tool result contained is held for one round, the name in the notice", async () => {
  const appended: unknown[] = [];
  const s = midRun();
  assert.equal(await settleAnswer(host(appended, evidence), grounded, s, reply(INVENTED)), null);
  assert.deepEqual(appended, [{ role: "user", content: UNGROUNDED_NOTICE(["pod-lister"]) }]);
  assert.equal(s.groundingHeld, INVENTED);

  // the rewrite took the name out: that is the answer, and the gate is spent
  s.iterations = 4;
  assert.equal(await settleAnswer(host(appended, evidence), grounded, s, reply(CLEAN)), CLEAN);
  assert.equal(s.groundingHeld, null);
  assert.equal(appended.length, 1);
});

test("a grounding round that does not improve the RCA returns the one it interrupted", async () => {
  const worse = [
    INVENTED.replace("pod-lister", "pods-reader"), // another name nobody saw
    "I removed the example as requested.", // no longer an RCA
    CLEAN.replace(/\*📈 Confidence:\*.*$/s, ""), // grounded, but it lost a section
    "That's outside what I do — I'm a DevOps agent for this cluster.", // and never the decline
  ];
  for (const retry of worse) {
    const s = midRun();
    assert.equal(await settleAnswer(host([], evidence), grounded, s, reply(INVENTED)), null);
    s.iterations = 4;
    s.rcaGapNudged = true; // the completeness gate is not what this test is about
    assert.equal(await settleAnswer(host([], evidence), grounded, s, reply(retry)), INVENTED, retry.slice(0, 40));
  }
});

test("the grounding gate stands down without the caller's evidence, without room, and for what was seen", async () => {
  // no opts.grounding: a mention, a delegate, a replayed run — exactly as before
  assert.equal(await settleAnswer(host([], evidence), ctx, midRun(), reply(INVENTED)), INVENTED);
  // one call left: a nudge now could end in the apology
  const last = midRun();
  last.iterations = 9;
  assert.equal(await settleAnswer(host([], evidence), grounded, last, reply(INVENTED)), INVENTED);
  // a name from the change timeline, the alert, a tool argument or a playbook is not an invention
  const seen = rcaWith("Roll `invoice-worker` back; see the `gitops-drift` playbook. Pod `reporter-7d9f8b6c5-x2k4q` is unaffected.");
  assert.equal(await settleAnswer(host([], evidence), grounded, midRun(), reply(seen)), seen);
});
