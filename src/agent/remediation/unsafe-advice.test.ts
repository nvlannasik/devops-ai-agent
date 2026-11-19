import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPlaneNodes, unsafeAdvice } from "./unsafe-advice.js";

const EVIDENCE = `{"pods":[{"pod":"kube-apiserver-master3-vm"}]} [{"name":"master2-vm","status":"True","roles":["control-plane"]},{"name":"worker1","roles":[]}]`;

test("control-plane nodes come from their static pods and from the control-plane role", () => {
  assert.deepEqual(controlPlaneNodes(EVIDENCE).sort(), ["master2-vm", "master3-vm"]);
});

// The production RCA of 2026-11-17, verbatim where it matters.
test("the 2026-11-17 RCA trips three rules", () => {
  const rca = [
    "• *Immediate:* Cordon master3-vm to drain load and restore headroom",
    "| Immediate | Cordón master3-vm to drain load and stop further evictions. |",
    "| Short-term | Add memory capacity to master3-vm or move control-plane pods to other nodes; review memory requests/limits for high-usage components (e.g., kube-apiserver) to fit the available headroom. |",
  ].join("\n");
  assert.deepEqual(unsafeAdvice(rca, EVIDENCE).map((f) => f.rule), ["cordon-control-plane", "limit-control-plane", "move-static-pods"]);
});

test("each rule, and the negations that are the right advice", () => {
  assert.deepEqual(unsafeAdvice("Run `systemctl restart etcd` on master2-vm.", EVIDENCE).map((f) => f.rule), ["restart-etcd"]);
  assert.deepEqual(unsafeAdvice("Delete pod kube-apiserver-master3-vm to reset it.", EVIDENCE).map((f) => f.rule), ["delete-control-plane-pod"]);
  assert.deepEqual(unsafeAdvice("Set the kube-apiserver memory limit to 512Mi.", EVIDENCE).map((f) => f.rule), ["limit-control-plane"]);
  for (const ok of [
    "Do not cordon or drain master3-vm.",
    "jangan restart etcd",
    "Never set a memory limit on kube-apiserver.",
    "Add memory to master3-vm; move workload pods off it.",
    "Drain worker1 for the disk swap.",
    "etcd.service uses 248Mi.",
  ]) {
    assert.deepEqual(unsafeAdvice(ok, EVIDENCE), [], ok);
  }
});

test("a cordon is only unsafe for a node the evidence shows is a control plane", () => {
  assert.deepEqual(unsafeAdvice("Cordon master3-vm", "no evidence"), []);
});
