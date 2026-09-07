import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreProposal, passRates, type Expectation, type TaskRun } from "./score.js";
import type { Proposal } from "../agent/remediation/proposal.js";

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  action: "k8s_set_resources",
  namespace: "webapp-backend",
  name: "backend-api",
  reason: "OOMKilled at the 128Mi limit",
  toolParams: { namespace: "webapp-backend", workload: "backend-api", kind: "deployment", memory_limit: "512Mi" },
  summary: "raise memory limit",
  ...over,
});

const oom: Expectation = {
  action: "k8s_set_resources",
  namespace: "webapp-backend",
  target: "backend-api",
  params: { kind: "deployment" },
  changed: { memory_limit: "128Mi" },
};

test("the right action on the right workload with a raised limit passes", () => {
  assert.deepEqual(scoreProposal(oom, proposal()), { pass: true, reasons: [] });
});

test("every miss says what it was, because a bare number does not tell you where to look", () => {
  const s = scoreProposal(oom, proposal({ action: "k8s_rollout_restart", namespace: "default", name: "frontend" }));
  assert.equal(s.pass, false);
  assert.equal(s.reasons.length, 3);
  assert.match(s.reasons.join("\n"), /action k8s_rollout_restart, expected k8s_set_resources/);
  assert.match(s.reasons.join("\n"), /namespace default/);
  assert.match(s.reasons.join("\n"), /target frontend/);
});

// The point of `changed`: "raise the limit" has no single right answer, so pinning one would
// score the model's taste. Echoing the broken value back is still a miss.
test("re-proposing the broken value is a miss, any other value passes", () => {
  assert.equal(scoreProposal(oom, proposal({ toolParams: { ...proposal().toolParams, memory_limit: "128Mi" } })).pass, false);
  assert.equal(scoreProposal(oom, proposal({ toolParams: { ...proposal().toolParams, memory_limit: "256Mi" } })).pass, true);
});

test("a field the fix has to change, left unset, is a miss", () => {
  const p = proposal({ toolParams: { namespace: "webapp-backend", workload: "backend-api", kind: "deployment", cpu_limit: "1" } });
  assert.match(scoreProposal(oom, p).reasons.join(), /memory_limit not set/);
});

test("params compare as strings, so a numeric replicas still matches", () => {
  const e: Expectation = { action: "k8s_scale", params: { replicas: "3" } };
  assert.equal(scoreProposal(e, proposal({ action: "k8s_scale", toolParams: { replicas: 3 } })).pass, true);
  assert.equal(scoreProposal(e, proposal({ action: "k8s_scale", toolParams: { replicas: 2 } })).pass, false);
});

// The failure mode this system has actually shipped: a proposal for a healthy namespace. A
// benchmark with no negative tasks scores that bug perfectly.
test("a task whose right answer is silence fails when the agent proposes anything", () => {
  const quiet: Expectation = { action: null };
  assert.equal(scoreProposal(quiet, null).pass, true);
  const s = scoreProposal(quiet, proposal());
  assert.equal(s.pass, false);
  assert.match(s.reasons[0]!, /but the correct answer is no proposal/);
});

test("no proposal where one was expected names the action that was missing", () => {
  assert.match(scoreProposal(oom, null).reasons[0]!, /no proposal; expected k8s_set_resources/);
});

// ---- pass rates ---------------------------------------------------------------------------

const run = (task: string, ...passes: boolean[]): TaskRun => ({
  task,
  attempts: passes.map((pass) => ({ pass, reasons: pass ? [] : ["x"] })),
});

test("pass@1 reads the first attempt, pass@k any, pass^k all", () => {
  const r = passRates([
    run("a", true, true, true),   // consistent
    run("b", false, true, false), // lucky
    run("c", true, false, false), // first-attempt only
    run("d", false, false, false),
  ]);
  assert.equal(r.tasks, 4);
  assert.equal(r.k, 3);
  assert.equal(r.pass1, 2 / 4, "pass@1 counts a and c");
  assert.equal(r.passK, 3 / 4, "pass@k counts a, b and c");
  assert.equal(r.passHatK, 1 / 4, "only a passed every attempt");
});

test("a task with no attempts is not consistent", () => {
  const r = passRates([{ task: "skipped", attempts: [] }]);
  assert.equal(r.passHatK, 0, "vacuous truth would report a task that never ran as perfect");
});

test("no tasks is zero, not a division by zero", () => {
  assert.deepEqual(passRates([]), { pass1: 0, passK: 0, passHatK: 0, k: 0, tasks: 0 });
});
