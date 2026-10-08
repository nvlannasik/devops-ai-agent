import { test } from "node:test";
import assert from "node:assert/strict";
import { noOpImageRefusal, noOpResourcesRefusal, oomShrinkRefusal, wrongKindRefusal, LISTING_FOR_KIND } from "./noop-guard.js";

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

// Bench A02, 2026-10-07, 2 of 3 attempts: a container OOMKilled at 128Mi, and a card LOWERING the
// limit to 32Mi — "to match observed peak usage", the usage it read just before the kernel killed it.
const a02 = JSON.stringify([{ workload: "backend-api", container: "api-server", current: { memoryLimit: "128Mi", memoryRequest: "64Mi" } }]);
const OOM = 'lastState: {"terminated":{"reason":"OOMKilled","exitCode":137}}';

test("on an OOMKill, a memory limit at or below the configured one is refused", () => {
  const p = { name: "backend-api", container: "api-server", memory_limit: "32Mi" };
  assert.match(oomShrinkRefusal("k8s_set_resources", p, a02, OOM) ?? "", /OOMKilled at its memory limit of 128Mi/);
  assert.ok(oomShrinkRefusal("k8s_set_resources", { ...p, memory_limit: "128Mi" }, a02, OOM), "unchanged is no fix either");
});

test("a raise passes; so does a lowered limit with no OOMKill in view (rightsizing)", () => {
  assert.equal(oomShrinkRefusal("k8s_set_resources", { name: "backend-api", container: "api-server", memory_limit: "256Mi" }, a02, OOM), null);
  assert.equal(oomShrinkRefusal("k8s_set_resources", { name: "backend-api", container: "api-server", memory_limit: "32Mi" }, a02, "all pods Running"), null);
  // a cpu-only change and an unreadable listing say nothing
  assert.equal(oomShrinkRefusal("k8s_set_resources", { name: "backend-api", cpu_limit: "200m" }, a02, OOM), null);
  assert.equal(oomShrinkRefusal("k8s_set_resources", { name: "backend-api", memory_limit: "32Mi" }, "not json", OOM), null);
});

// Bench A13 rerun, 2026-10-07: `k8s_set_image` to curlimages/curl:8.5.0 — the image already running —
// for container `curl`, which does not exist (the container is `reporter`). Filtering to a container
// that matches nothing compared against nothing, and the no-op passed.
test("a container name that matches no container does not hide a no-op image", () => {
  const l = JSON.stringify([{ name: "reporter", containers: [{ name: "reporter", image: "curlimages/curl:8.5.0" }] }]);
  assert.match(noOpImageRefusal("k8s_set_image", { name: "reporter", container: "curl", image: "curlimages/curl:8.5.0" }, l) ?? "", /already running/);
  // a REAL container name still scopes the comparison
  const two = JSON.stringify([{ name: "w", containers: [{ name: "app", image: "a:1" }, { name: "side", image: "b:1" }] }]);
  assert.equal(noOpImageRefusal("k8s_set_image", { name: "w", container: "app", image: "b:1" }, two), null);
});

// Bench B04, 2026-10-07 and -08: `payments` is a StatefulSet, the re-asked proposal said
// `kind: deployment`, and every kind-keyed check behind it failed open — the no-op gate listed
// Deployments, found no `payments`, and let a write of the image already running through. In
// production the dry-run's NotFound was the only thing left; with a Deployment AND a StatefulSet
// of one name in a namespace, the dry-run passes and the card acts on the other workload.
const sts = JSON.stringify([{ name: "payments", containers: [{ name: "api", image: "busybox:1.36" }] }]);
const none = JSON.stringify([]);

test("a workload proposed under a kind it is not is refused, naming the kind it is", () => {
  const why = wrongKindRefusal("k8s_set_image", { namespace: "bench-b04", name: "payments", kind: "deployment" }, {
    deployment: none, statefulset: sts, daemonset: none,
  });
  assert.match(why ?? "", /`bench-b04\/payments` is a StatefulSet, not a Deployment/);
  assert.match(why ?? "", /kind: statefulset/);
  // no kind at all means deployment to the MCP server, so it is the same mistake
  assert.ok(wrongKindRefusal("k8s_rollout_restart", { namespace: "bench-b04", name: "payments" }, { deployment: none, statefulset: sts }));
});

test("the kind gate lets through what it cannot judge, and what is right", () => {
  const p = { namespace: "x", name: "payments", kind: "statefulset" };
  assert.equal(wrongKindRefusal("k8s_set_image", p, { statefulset: sts }), null, "right kind");
  assert.equal(wrongKindRefusal("k8s_set_image", { ...p, kind: "deployment" }, { deployment: none, statefulset: none, daemonset: none }), null, "nowhere — the target gate's and the dry-run's");
  assert.equal(wrongKindRefusal("k8s_set_image", { ...p, kind: "deployment" }, { deployment: "Error: timeout", statefulset: sts }), null, "its own kind unreadable");
  assert.equal(wrongKindRefusal("k8s_set_image", { ...p, kind: "deployment" }, { deployment: sts, statefulset: sts }), null, "both kinds hold the name — the model's pick is not provably wrong");
  assert.equal(wrongKindRefusal("k8s_delete_pod", { namespace: "x", pod: "payments-0" }, { deployment: none, statefulset: sts }), null, "not a workload action");
});
