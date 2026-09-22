import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleOutRefusal, targetKey } from "./index.js";
import { parseProposal, type Proposal } from "./remediation/proposal.js";

const scale = (workload: string, replicas: number): Proposal =>
  parseProposal(JSON.stringify({ action: "k8s_scale", namespace: "sample-apps", workload, kind: "deployment", replicas }))!;

// The thread behind cards 85 and 88, 2026-09-22: the only throttling belonged to loadgen.
const loadgenThrottled =
  '{"alert":"KubernetesContainerCPUThrottling","pod":"loadgen-7dfdc4d5f-8c5sx","container":"loadgen","throttled":"10.55%"}\n' +
  '{"name":"orders-api-64859f979-j8lbh","phase":"Running","ready":true,"restarts":0}';

test("scaling a workload nothing measured as saturated is refused", () => {
  assert.match(scaleOutRefusal(scale("orders-api", 3), loadgenThrottled) ?? "", /nothing in this investigation measures that workload as saturated/);
  assert.match(scaleOutRefusal(scale("checkout-gateway", 4), loadgenThrottled) ?? "", /refused/);
});

test("the workload's own saturation lets it through", () => {
  const throttled = '{"alert":"KubernetesContainerCPUThrottling","pod":"orders-api-64859f979-j8lbh","container":"orders-api","throttled":"31%"}';
  assert.equal(scaleOutRefusal(scale("orders-api", 3), throttled), null);
  const backlog = '{"queue":"settlement","namespace":"sample-apps","workload":"settlement-worker","oldest_job":"310s","status":"not draining"}';
  assert.equal(scaleOutRefusal(scale("settlement-worker", 3), backlog), null);
});

test("no thread evidence at all refuses, and a quarantine is not this gate's business", () => {
  assert.notEqual(scaleOutRefusal(scale("orders-api", 3), null), null);
  assert.equal(scaleOutRefusal(scale("orders-api", 0), null), null, "replicas 0 belongs to the quarantine gate");
  assert.equal(scaleOutRefusal(parseProposal('{"action":"k8s_rollout_restart","namespace":"a","workload":"b"}')!, null), null);
});

test("the target key is action + object, not parameters", () => {
  assert.equal(targetKey("k8s_scale", "sample-apps", "orders-api"), "k8s_scale:sample-apps/orders-api");
  // A scale to 3 and a scale to 4 on the same workload are one pending decision, not two.
  assert.equal(
    targetKey("k8s_scale", "sample-apps", "Orders-API"),
    targetKey("k8s_scale", "sample-apps", "orders-api")
  );
});
