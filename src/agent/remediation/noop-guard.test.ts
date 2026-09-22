import { test } from "node:test";
import assert from "node:assert/strict";
import { noOpImageRefusal, noOpResourcesRefusal, LISTING_FOR_KIND } from "./noop-guard.js";

// C03 on the agus backend, three attempts out of three: busybox:1.36 proposed for a container
// already running busybox:1.36, one of them admitting it in its own reason.
const listing = JSON.stringify([
  { name: "settlement-worker", containers: [{ name: "worker", image: "busybox:1.36" }] },
  { name: "other", containers: [{ name: "app", image: "nginx:alpine" }] },
]);

test("setting the image to the one already running is refused", () => {
  const why = noOpImageRefusal("k8s_set_image", { name: "settlement-worker", image: "busybox:1.36" }, listing);
  assert.match(why ?? "", /already running/);
  assert.match(why ?? "", /the fix names a DIFFERENT tag/);
});

test("a genuine image change is let through", () => {
  assert.equal(
    noOpImageRefusal("k8s_set_image", { name: "settlement-worker", image: "busybox:1.37" }, listing),
    null
  );
});

test("with a container named, only that container counts", () => {
  const two = JSON.stringify([
    { name: "api", containers: [{ name: "app", image: "repo:v1" }, { name: "sidecar", image: "repo:v2" }] },
  ]);
  // v2 is on the sidecar, not on the container being changed — a real change to `app`
  assert.equal(noOpImageRefusal("k8s_set_image", { name: "api", container: "app", image: "repo:v2" }, two), null);
  assert.match(noOpImageRefusal("k8s_set_image", { name: "api", container: "app", image: "repo:v1" }, two) ?? "", /already running/);
});

test("no other action is this guard's business", () => {
  for (const a of ["k8s_rollout_restart", "k8s_scale", "k8s_set_resources", "k8s_delete_pod"]) {
    assert.equal(noOpImageRefusal(a, { name: "settlement-worker", image: "busybox:1.36" }, listing), null, a);
  }
});

// Tolerant like parsePods: another repo's payload, and anything unreadable refuses nothing.
test("an unreadable or unrelated listing refuses nothing", () => {
  for (const bad of ["", "Error: upstream unavailable", "[]", "{}", JSON.stringify([{ name: "elsewhere" }])]) {
    assert.equal(noOpImageRefusal("k8s_set_image", { name: "settlement-worker", image: "busybox:1.36" }, bad), null, bad);
  }
});

test("every kind the proposal may name has a listing tool", () => {
  for (const k of ["deployment", "statefulset", "daemonset"]) assert.ok(LISTING_FOR_KIND[k], k);
});

// --- k8s_set_resources: the same refusal one action along (benchmark A05, 2026-09-23) ---

const recommend = JSON.stringify([
  {
    kind: "deployment", namespace: "bench-a05", workload: "batch-runner", container: "runner", replicas: 1,
    flags: ["no_data"],
    current: { cpuRequest: "64", memoryRequest: "64Mi", cpuLimit: null, memoryLimit: "128Mi" },
    observed: { note: "no cadvisor samples in the window" },
  },
]);

test("proposing the cpu request the pod already cannot be scheduled with is refused", () => {
  const r = noOpResourcesRefusal("k8s_set_resources", { name: "batch-runner", namespace: "bench-a05", cpu_request: "64" }, recommend);
  assert.match(r ?? "", /already configured with \(cpu_request=64\)/);
});

test("a real change passes, and so does a value the tool cannot report", () => {
  assert.equal(noOpResourcesRefusal("k8s_set_resources", { name: "batch-runner", cpu_request: "500m" }, recommend), null);
  // memory_limit 128Mi is unchanged, but cpu_request 500m is not — the proposal does something
  assert.equal(
    noOpResourcesRefusal("k8s_set_resources", { name: "batch-runner", cpu_request: "500m", memory_limit: "128Mi" }, recommend),
    null
  );
  assert.equal(noOpResourcesRefusal("k8s_set_resources", { name: "batch-runner", cpu_limit: "2" }, recommend), null, "cpuLimit is null — nothing to compare");
});

test("quantities, not strings: 1000m equals 1, and 64m does not equal 64", () => {
  const rec = JSON.stringify([{ workload: "w", container: "c", current: { cpuRequest: "1" } }]);
  assert.notEqual(noOpResourcesRefusal("k8s_set_resources", { name: "w", cpu_request: "1000m" }, rec), null);
  assert.equal(noOpResourcesRefusal("k8s_set_resources", { name: "w", cpu_request: "64m" }, rec), null);
});

test("unreadable input refuses nothing, and other actions are not its business", () => {
  assert.equal(noOpResourcesRefusal("k8s_set_resources", { name: "w", cpu_request: "1" }, "Error: upstream down"), null);
  assert.equal(noOpResourcesRefusal("k8s_set_resources", { name: "absent", cpu_request: "64" }, recommend), null);
  assert.equal(noOpResourcesRefusal("k8s_scale", { name: "batch-runner", cpu_request: "64" }, recommend), null);
});
