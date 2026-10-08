import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent, resourceFaultRefusal } from "./index.js";
import { parseProposal } from "./remediation/proposal.js";

const resize = (ns: string, workload: string) =>
  parseProposal(JSON.stringify({ action: "k8s_set_resources", namespace: ns, workload, kind: "deployment", memory_limit: "512Mi" }))!;

// A01, 2026-09-23: CrashLoopBackOff from a missing ConfigMap key, answered with a resize.
const configKeyMissing =
  '{"pod":"payments-api-6d4c8f9b7-abc12","phase":"Running","ready":false,"restarts":6,' +
  '"lastState":{"terminated":{"reason":"Error","exitCode":1}}}\n' +
  'Error: config key DATABASE_TIMEOUT not found in ConfigMap payments-config';

// A02: the OOMKill lives in lastState.terminated.reason, NOT in an event — the exact reason the
// earlier events-based version of this guard took A02 from 5/5 to 0 and was deleted.
const oomkilled =
  '{"pod":"backend-api-7f6d5c4b3-xy789","phase":"Running","ready":false,"restarts":4,' +
  '"lastState":{"terminated":{"reason":"OOMKilled","exitCode":137}}}';

// A05: the scheduler's own words.
const unschedulable = '{"pod":"orders-api-5b4c3d2e1-zz111","phase":"Pending","message":"0/3 nodes are available: 3 Insufficient cpu."}';

test("a resize with no resource fault anywhere in the evidence is refused", () => {
  assert.match(resourceFaultRefusal(resize("bench-a01", "payments-api"), configKeyMissing) ?? "", /no OOMKill, no throttling/);
});

test("the cases that MUST keep proposing are untouched", () => {
  assert.equal(resourceFaultRefusal(resize("bench-a02", "backend-api"), oomkilled), null, "A02: OOMKilled in lastState");
  assert.equal(resourceFaultRefusal(resize("bench-a05", "orders-api"), unschedulable), null, "A05: Insufficient cpu");
  assert.equal(resourceFaultRefusal(resize("bench-c02", "orders-api"), "container exceeded its memory limit and was restarted"), null);
  assert.equal(resourceFaultRefusal(resize("ns", "w"), '"flags":["cpu_throttled","oom_risk"]'), null, "k8s_recommend_resources flags count");
});

test("it fails open, and only judges resize proposals", () => {
  assert.equal(resourceFaultRefusal(resize("ns", "w"), null), null, "no thread to read");
  const restart = parseProposal('{"action":"k8s_rollout_restart","namespace":"ns","workload":"w"}')!;
  assert.equal(resourceFaultRefusal(restart, configKeyMissing), null);
});

// The gate above was measured in on A01 (88b5d2d) and then dropped from the chain when production
// and the bench were merged into refusalFor (b7b18e5): production had never called it, the bench's
// targetRefusalFor had, and the merge kept production's half. Live 2026-09-28, A01 again: the
// re-ask answered a missing ConfigMap key with a resize, and only the namespace allowlist stopped
// it. So this pins the WIRING, through refusalFor itself, with every other gate stubbed open.
const chainWith = (evidence: string) =>
  ({
    guardRefusalFor: async () => null,
    kindRefusalFor: async () => null,
    quarantineRefusalFor: async () => null,
    orphanRefusalFor: async () => null,
    scaleRefusalFor: async () => null,
    imageRefusalFor: async () => null,
    threadEvidence: async () => evidence,
  }) as unknown as DevOpsAgent;

test("refusalFor runs the resource-fault gate", async () => {
  const r = await DevOpsAgent.prototype.refusalFor.call(chainWith(configKeyMissing), resize("bench-a01", "payments-api"), {
    threadId: "t", offer: null, labels: { namespace: "bench-a01" }, rca: "",
  });
  assert.match(r?.reason ?? "", /no OOMKill, no throttling/);
});

test("a human's own request for a resize is not second-guessed by it", async () => {
  const r = await DevOpsAgent.prototype.refusalFor.call(chainWith(configKeyMissing), resize("bench-a01", "payments-api"), {
    userRequested: true, threadId: "t", offer: null, labels: { namespace: "bench-a01" }, rca: "",
  });
  assert.equal(r, null);
});

// Measured 2026-09-29 (bench on private-llm-agus): A07 proposed a resize for a pod stuck on an
// unbound PVC, 2 of 3 attempts, and the gate passed it. `nodes are available` was one of the
// "resource fault" words — and every FailedScheduling message opens with "0/3 nodes are
// available:", whatever the reason. Only the reason decides; a resize fixes exactly one of them.
test("a pod that cannot schedule for a reason that is not size is not a resource fault", () => {
  const unboundPvc =
    "warning failedscheduling 0/3 nodes are available: pod has unbound immediate persistentvolumeclaims. " +
    "preemption: 0/3 nodes are available: 3 preemption is not helpful for scheduling.";
  const selector = "warning failedscheduling 0/3 nodes are available: 3 node(s) didn't match pod's node affinity/selector.";
  assert.match(resourceFaultRefusal(resize("bench-a07", "ledger"), unboundPvc) ?? "", /no scheduling pressure/, "A07: unbound PVC");
  assert.match(resourceFaultRefusal(resize("bench-a06", "api"), selector) ?? "", /no scheduling pressure/, "A06: node selector");
  assert.equal(
    resourceFaultRefusal(resize("bench-a05", "orders-api"), "warning failedscheduling 0/3 nodes are available: 3 insufficient cpu."),
    null,
    "A05: insufficient cpu IS the resource fault"
  );
});
