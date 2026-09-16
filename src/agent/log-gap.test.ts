import { test } from "node:test";
import assert from "node:assert/strict";
import { demandsLogs, logGapAction, LOG_GAP_NOTICE, LOG_TOOLS, type LogGapState } from "./index.js";
import { loadSkills, resolveSkillsDir } from "./skills/index.js";

// The SHIPPED playbooks, like skills/real.test.ts: the gate reads their bodies, so an edit that
// drops `k8s_get_pod_logs` from crashloopbackoff.md silently disables it for every crashloop
// investigation. That is the failure this file is here to make loud.
const registry = loadSkills(resolveSkillsDir());
const skill = (name: string) => {
  const s = registry.all().find((x) => x.name === name);
  assert.ok(s, `playbook ${name} is gone — the log-gap gate reads it`);
  return s!;
};

test("the log-gap gate fires for the playbooks that read logs", () => {
  // B04 loaded crashloopbackoff and answered without logs; A13 loaded log-alert and reported an
  // empty filtered Loki query as "no errors".
  for (const name of ["crashloopbackoff", "log-alert", "oomkilled", "pod-not-ready"]) {
    assert.equal(demandsLogs([skill(name)]), true, `${name} reads logs but the gate does not know it`);
  }
});

test("it stays off the cases with no logs to read", () => {
  // A Pending pod never started a container, and a PVC that never bound has none either. Nudging
  // those would cost an LLM call per investigation to be told what is already true.
  for (const name of ["pod-pending", "pvc-pending", "service-unavailable"]) {
    assert.equal(demandsLogs([skill(name)]), false, `${name} has no logs to read but the gate nudges anyway`);
  }
  assert.equal(demandsLogs([]), false);
});

test("the notice says what to call, and that an empty query is a fact about the query", () => {
  assert.match(LOG_GAP_NOTICE, /k8s_get_pod_logs/);
  assert.match(LOG_GAP_NOTICE, /previous.{0,10}true/);
  // The first wording said "call it with previous: true" flatly, and A13 obeyed it on a pod that
  // had never restarted: no previous instance exists, the call came back empty, and the answer
  // reported the logs as inaccessible while the running container was printing the evidence.
  assert.match(LOG_GAP_NOTICE, /if the pod is Running and has not restarted, there IS no previous instance/);
  assert.match(LOG_GAP_NOTICE, /retry without it rather than reporting the logs as unavailable/);
  // A13's failure mode: empty result read as evidence of absence.
  assert.match(LOG_GAP_NOTICE, /fact about the QUERY and not about the workload/);
  // B04's: the RCA recommended the tool call it was holding.
  assert.match(LOG_GAP_NOTICE, /Do not recommend that a human run a log query you can run yourself/);
  // C03's: logs genuinely absent is a valid answer, stated and paid for in confidence.
  assert.match(LOG_GAP_NOTICE, /genuinely unavailable/);
  // C01's: the gate also fires on a healthy namespace, because "nothing is wrong" and "I did not
  // look" are the same sentence until someone looks. It must not turn a correct clean bill of
  // health into a hedged one.
  assert.match(LOG_GAP_NOTICE, /lower the Confidence only if your conclusion actually depends on them/);
  assert.match(LOG_GAP_NOTICE, /a complete answer, not a thin one/);
  for (const t of LOG_TOOLS) assert.ok(t.startsWith("k8s_") || t.startsWith("loki_"), t);
});

// ── The gate's own decision ──────────────────────────────────────────────────
// A run that has just answered, with the playbooks that read logs loaded and no log line seen.
const ripe = (over: Partial<LogGapState> = {}): LogGapState => ({
  mode: "alert",
  demandsLogs: true,
  sawLogLines: false,
  nudged: false,
  toolsDisabled: false,
  toolRounds: 1,
  toolRoundsAtNudge: -1,
  holdingAnswer: false,
  ...over,
});

test("an alert that never read a log line gets one more round", () => {
  assert.equal(logGapAction(ripe()), "nudge");
});

// Observed 2026-09-15 on thread 1789488072: "apakah ada anomali di cluster 1 jam kebelakang ini?"
// was answered correctly, the gate fired on playbooks four turns older than the question, and the
// retry replaced the answer with "That's outside what I do". Twice.
test("a conversation is never nudged — its playbooks belong to earlier questions", () => {
  assert.equal(logGapAction(ripe({ mode: "conversation" })), "answer");
  assert.equal(logGapAction(ripe({ mode: "investigation" })), "answer");
});

test("the nudge is spent once, and never with no tool round behind it or tools already off", () => {
  assert.equal(logGapAction(ripe({ nudged: true })), "answer");
  assert.equal(logGapAction(ripe({ toolRounds: 0 })), "answer");
  assert.equal(logGapAction(ripe({ toolsDisabled: true })), "answer");
  assert.equal(logGapAction(ripe({ sawLogLines: true })), "answer");
  assert.equal(logGapAction(ripe({ demandsLogs: false })), "answer");
});

// The half that was missing: the nudge REPLACES the answer it interrupted, so a retry that
// gathered nothing must not be allowed to.
test("a nudge round that ran no tools gives the first answer back", () => {
  const held = ripe({ nudged: true, holdingAnswer: true, toolRoundsAtNudge: 1, toolRounds: 1 });
  assert.equal(logGapAction(held), "restore");
});

test("a nudge round that DID fetch logs keeps its own answer", () => {
  const fetched = ripe({
    nudged: true,
    holdingAnswer: true,
    toolRoundsAtNudge: 1,
    toolRounds: 2,
    sawLogLines: true,
  });
  assert.equal(logGapAction(fetched), "answer");
});
