import { test } from "node:test";
import assert from "node:assert/strict";
import { demandsLogs, LOG_GAP_NOTICE, LOG_TOOLS } from "./index.js";
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
