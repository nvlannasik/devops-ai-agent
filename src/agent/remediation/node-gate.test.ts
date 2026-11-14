import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeActionRefusal, nodeFaults, parseNodeDetail, vmActionRefusal } from "./node-gate.js";

const detail = (over: { ready?: string; pressure?: string[]; unschedulable?: boolean } = {}) =>
  JSON.stringify({
    name: "worker3-vm",
    conditions: [
      { type: "Ready", status: over.ready ?? "True" },
      ...["MemoryPressure", "DiskPressure", "PIDPressure"].map((t) => ({ type: t, status: over.pressure?.includes(t) ? "True" : "False" })),
    ],
    unschedulable: over.unschedulable ?? false,
    taints: over.unschedulable ? ["node.kubernetes.io/unschedulable=:NoSchedule"] : undefined,
  });
const read = (raw: string) => parseNodeDetail(raw)!;

// Bench C12, 2026-11-14: a stale NotReady alert, a Ready node, and a cordon of it.
test("cordon or drain of a healthy node is refused when the model proposed it", () => {
  for (const a of ["k8s_cordon", "k8s_drain"]) {
    assert.match(nodeActionRefusal(a, "worker3-vm", read(detail()), false) ?? "", /Ready with no pressure condition/, a);
  }
});

test("a node with a fault may be cordoned or drained; a human may ask for either on a healthy one", () => {
  assert.deepEqual(nodeFaults(read(detail({ ready: "Unknown", pressure: ["DiskPressure"] }))), ["Ready=Unknown", "DiskPressure"]);
  assert.equal(nodeActionRefusal("k8s_cordon", "worker3-vm", read(detail({ ready: "False" })), false), null);
  assert.equal(nodeActionRefusal("k8s_drain", "worker3-vm", read(detail({ pressure: ["MemoryPressure"] })), false), null);
  // bench C11: "worker3-vm needs maintenance tonight" — the reason is the human's
  assert.equal(nodeActionRefusal("k8s_cordon", "worker3-vm", read(detail()), true), null);
});

test("a cordon of a cordoned node and an uncordon of an uncordoned one change nothing, whoever asks", () => {
  assert.match(nodeActionRefusal("k8s_cordon", "n", read(detail({ unschedulable: true })), true) ?? "", /already cordoned/);
  assert.match(nodeActionRefusal("k8s_uncordon", "n", read(detail()), true) ?? "", /not cordoned/);
});

// Bench A16: a healthy node left cordoned — the uncordon is the repair.
test("uncordon passes for a cordoned healthy node, and is held while the fault behind the cordon remains", () => {
  assert.equal(nodeActionRefusal("k8s_uncordon", "worker3-vm", read(detail({ unschedulable: true })), false), null);
  assert.match(nodeActionRefusal("k8s_uncordon", "worker3-vm", read(detail({ unschedulable: true, pressure: ["DiskPressure"] })), false) ?? "", /still reports DiskPressure/);
  assert.equal(nodeActionRefusal("k8s_uncordon", "worker3-vm", read(detail({ unschedulable: true, pressure: ["DiskPressure"] })), true), null);
});

test("an unreadable node detail refuses nothing", () => {
  for (const bad of ["", "Error: nodes \"x\" not found", "{}", "{not json"]) assert.equal(parseNodeDetail(bad), null, bad);
});

// Bench C12, two attempts: vm_restart_service of kubelet on worker3-vm, with no VM agent configured.
test("a VM action needs a VM agent and a host that is not a Kubernetes node", () => {
  assert.match(vmActionRefusal("vm_restart_service", "worker3-vm", ["k8s_list_pods"], true) ?? "", /No VM agent is configured/);
  assert.match(vmActionRefusal("vm_restart_service", "worker3-vm", ["vm_restart_service"], true) ?? "", /is a Kubernetes node/);
  assert.equal(vmActionRefusal("vm_restart_service", "billing-vm", ["vm_restart_service"], false), null);
  assert.equal(vmActionRefusal("k8s_cordon", "worker3-vm", [], true), null);
});
