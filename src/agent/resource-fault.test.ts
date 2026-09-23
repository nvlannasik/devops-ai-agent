import { test } from "node:test";
import assert from "node:assert/strict";
import { resourceFaultRefusal } from "./index.js";
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
