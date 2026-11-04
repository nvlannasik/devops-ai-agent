import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposal, PROPOSABLE_ACTIONS } from "./proposal.js";
import { targetKey, ungroundedTargetRefusal } from "./evidence-refusals.js";
import { NO_POD_TARGET } from "./remediator.js";

// Node actions (spec 2026-11-04 Part A): cluster-scoped, so a proposal carries namespace "".
test("cordon, uncordon and drain parse to a node proposal", () => {
  const c = parseProposal('{"action":"k8s_cordon","node":"Worker2","reason":"disk pressure"}')!;
  assert.deepEqual(
    { action: c.action, namespace: c.namespace, name: c.name, toolParams: c.toolParams, reason: c.reason },
    { action: "k8s_cordon", namespace: "", name: "worker2", toolParams: { node: "worker2" }, reason: "disk pressure" }
  );
  assert.match(c.summary, /cordon node `worker2`/);
  assert.match(parseProposal('{"action":"k8s_uncordon","node":"worker2"}')!.summary, /uncordon node `worker2`/);
  assert.match(parseProposal('{"action":"k8s_drain","node":"worker2"}')!.summary, /drain node `worker2`.*DaemonSet/);
  assert.equal(parseProposal('{"action":"k8s_drain"}'), null);
});

test("node actions are proposable and keyed without a namespace", () => {
  for (const a of ["k8s_cordon", "k8s_uncordon", "k8s_drain"]) assert.ok((PROPOSABLE_ACTIONS as readonly string[]).includes(a), a);
  assert.equal(targetKey("k8s_cordon", "", "worker1", "stg"), "stg:k8s_cordon:/worker1");
  assert.equal(targetKey("k8s_cordon", "", "worker1"), "k8s_cordon:/worker1");
});

test("a node seen in the evidence grounds the proposal; an invented one does not", () => {
  const p = parseProposal('{"action":"k8s_cordon","node":"worker2"}')!;
  assert.equal(ungroundedTargetRefusal(p, '{"name":"worker2","conditions":{"DiskPressure":"True"}}'), null);
  assert.match(ungroundedTargetRefusal(p, '{"name":"worker1"}') ?? "", /worker2/);
});

test("node actions schedule no pod-readiness verification", () => {
  for (const a of ["k8s_cordon", "k8s_uncordon", "k8s_drain", "k8s_delete_orphan"]) assert.ok(NO_POD_TARGET.has(a), a);
  assert.equal(NO_POD_TARGET.has("k8s_rollout_restart"), false);
});
