import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePods, replacementRefusal, REPLACEMENT_ACTIONS } from "./replace-guard.js";

const pod = (name: string, ready: boolean, restarts = 0, status = "Running") => ({ name, ready, restarts, status });
const del = (target: string, pods: ReturnType<typeof pod>[]) =>
  replacementRefusal("k8s_delete_pod", { namespace: "x", pod: target }, pods);
const restart = (name: string, pods: ReturnType<typeof pod>[]) =>
  replacementRefusal("k8s_rollout_restart", { namespace: "x", name }, pods);

// The three benchmark failures this guard was written from.

test("a delete on the only pod of a single-replica workload is refused", () => {
  // C03 and A02: the model proposed deleting the one pod there is. Nothing about the replacement
  // differs from the original, so the fault comes back with it.
  const r = del("settlement-worker-55f4d46d77-rdtm9", [pod("settlement-worker-55f4d46d77-rdtm9", false, 4)]);
  assert.match(r ?? "", /single replica/);
  assert.match(r ?? "", /puts it in the spec/);
});

test("a restart is refused once the kubelet has already restarted every pod", () => {
  // C08: one replica, crashlooping. The restart being proposed has been performed three times
  // already, by the kubelet, and the pod came back the same each time.
  const r = restart("storefront", [pod("storefront-6796dcf65d-jq2qh", false, 3)]);
  assert.match(r ?? "", /already done that 3 time\(s\)/);
});

test("a genuinely wedged pod among healthy siblings still gets its card", () => {
  // The case delete_pod is actually for: same ReplicaSet, two siblings serving, one stuck.
  assert.equal(
    del("api-6b747db7c9-zwdcv", [
      pod("api-6b747db7c9-zwdcv", false, 0),
      pod("api-6b747db7c9-m4p8t", true),
      pod("api-6b747db7c9-q1x7v", true),
    ]),
    null
  );
});

test("siblings are the pods of the SAME ReplicaSet, not of the workload", () => {
  // Mid-rollout the OLD ReplicaSet is healthy and the new one is not. Counting those as siblings
  // would read "one wedged pod among healthy siblings" off a broken rollout — A09's shape.
  const rollout = [
    pod("web-frontend-fc9b67d8f-bzbf9", false, 0), // new RS, cannot start
    pod("web-frontend-f5497dbc7-aaaaa", true), // old RS, still serving
    pod("web-frontend-f5497dbc7-bbbbb", true),
  ];
  assert.match(del("web-frontend-fc9b67d8f-bzbf9", rollout) ?? "", /no healthy sibling/);
});

test("a restart is refused when no pod ever reached Running", () => {
  // A04: an ImagePullBackOff pod has restartCount 0 — the container never ran — so the
  // restart-count rule alone let a restart card through for a missing pull secret.
  const r = restart("checkout-gateway", [pod("checkout-gateway-7d9f-x2k", false, 0, "Pending")]);
  assert.match(r ?? "", /has reached Running/);
  assert.match(r ?? "", /failed before its process did/);
  // Mid-rollout with the old ReplicaSet still serving USED to pass here — this rule needs every
  // pod to be off Running and the serving one is on it. A09 showed that was the wrong outcome,
  // so the stuck-rollout rule above now catches this shape instead, by a different sentence.
  assert.match(
    restart("web-frontend", [
      pod("web-frontend-fc9b67d8f-bzbf9", false, 0, "Pending"),
      pod("web-frontend-f5497dbc7-aaaaa", true),
    ]) ?? "",
    /in flight and stuck/
  );
  // an unknown phase is not evidence of anything
  assert.equal(restart("api", [pod("api-1-a", false, 0, "")]), null);
});

test("a restart with any pod ready, or with none restarted, is left alone", () => {
  // Partial outage: something is still serving, so a fresh pod plausibly comes up healthy.
  assert.equal(restart("api", [pod("api-1-a", false, 2), pod("api-1-b", true, 0)]), null);
  // A08's shape — Running, never ready, zero restarts (a wrong probe path). Not decidable from
  // this payload, and the guard says so by passing it.
  assert.equal(restart("storefront", [pod("storefront-1-a", false, 0)]), null);
});

test("it refuses nothing it cannot read", () => {
  assert.equal(del("api-1-a", []), null);
  assert.equal(restart("api", []), null);
  assert.equal(replacementRefusal("k8s_set_image", { namespace: "x", name: "api" }, [pod("api-1-a", false, 9)]), null);
  // a pod name with no dash cannot yield a sibling prefix
  assert.equal(del("api", [pod("api", false, 3)]), null);
  assert.deepEqual(parsePods("not json"), []);
  assert.deepEqual(parsePods('{"a":1}'), []);
  assert.deepEqual(parsePods("[{}]"), []);
});

test("parsePods reads the k8s_list_pods payload and defaults the fields it needs", () => {
  const raw =
    'Here are the pods:\n[{"name":"api-1-a","namespace":"x","status":"Running","ready":false,"restarts":7,"node":"w1"},' +
    '{"name":"api-1-b","status":"Running","ready":true}]';
  assert.deepEqual(parsePods(raw), [
    { name: "api-1-a", ready: false, restarts: 7, status: "Running" },
    { name: "api-1-b", ready: true, restarts: 0, status: "Running" },
  ]);
});

test("the guard covers exactly the two actions that rebuild a pod from the same spec", () => {
  assert.deepEqual([...REPLACEMENT_ACTIONS].sort(), ["k8s_delete_pod", "k8s_rollout_restart"]);
});

// ---- the stuck rollout (benchmark A09) ----
//
// 0 for 6 across two runs, and the two earlier rollout_restart rules could never reach it: both
// return early the moment any pod of the workload is ready, and in this shape the OLD ReplicaSet
// is ready — that is the whole point of the case.
const rolloutPods = JSON.stringify([
  { name: "web-frontend-7c9d4b6f8-aaaaa", ready: true, restarts: 0, status: "Running" },
  { name: "web-frontend-fc9b67d8f-bbbbb", ready: false, restarts: 0, status: "Running" },
]);

test("a restart is refused while a rollout is stuck with the old ReplicaSet still serving", () => {
  const why = replacementRefusal("k8s_rollout_restart", { name: "web-frontend" }, parsePods(rolloutPods));
  assert.match(why ?? "", /rollout of `web-frontend` is in flight and stuck/);
  assert.match(why ?? "", /web-frontend-fc9b67d8f/); // names the stalled ReplicaSet
  assert.match(why ?? "", /web-frontend-7c9d4b6f8/); // and the one carrying traffic
});

test("a healthy workload on one ReplicaSet is untouched", () => {
  const pods = JSON.stringify([
    { name: "web-frontend-7c9d4b6f8-aaaaa", ready: true, restarts: 0, status: "Running" },
    { name: "web-frontend-7c9d4b6f8-bbbbb", ready: false, restarts: 0, status: "Running" },
  ]);
  // one ReplicaSet, one unready pod — a genuinely wedged replica, which is what a restart is for
  assert.equal(replacementRefusal("k8s_rollout_restart", { name: "web-frontend" }, parsePods(pods)), null);
});

// podsOf matches by prefix and deliberately over-matches; the two older rules stay quiet under
// that because they need EVERY pod to look broken. This rule fires on a mixture, so it would
// fire wrongly without the exact two-segment shape in replicaSetOf.
test("a different workload sharing the name prefix is not read as a second ReplicaSet", () => {
  const pods = JSON.stringify([
    { name: "payments-api-7d9f4c2b1-aaaaa", ready: true, restarts: 0, status: "Running" },
    { name: "payments-6b747db7c9-bbbbb", ready: false, restarts: 0, status: "Running" },
  ]);
  // `payments` has exactly one ReplicaSet here; payments-api is another workload entirely
  assert.equal(replacementRefusal("k8s_rollout_restart", { name: "payments" }, parsePods(pods)), null);
});

test("a StatefulSet has no ReplicaSets, so the rollout rule cannot fire on it", () => {
  const pods = JSON.stringify([
    { name: "db-0", ready: true, restarts: 0, status: "Running" },
    { name: "db-1", ready: false, restarts: 0, status: "Running" },
  ]);
  assert.equal(replacementRefusal("k8s_rollout_restart", { name: "db" }, parsePods(pods)), null);
});
