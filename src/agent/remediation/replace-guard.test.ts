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

test("a restart with any pod ready is left alone", () => {
  // Partial outage: something is still serving, so a fresh pod plausibly comes up healthy.
  assert.equal(restart("api", [pod("api-1-a", false, 2), pod("api-1-b", true, 0)]), null);
  // A08's shape — Running, never ready, zero restarts — USED to pass here, on the grounds that a
  // wrong probe path is not separable from a wedged process without the probe result. It is not
  // separable and does not need to be: a restart fails either way. Refused below by its own rule.
  assert.match(restart("storefront", [pod("storefront-1-a", false, 0)]) ?? "", /zero restarts/);
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

// ---- Running, never ready, never restarted (benchmark A08) ----
//
// The shape this file used to name as its ceiling and decline to decide. A08 is a readinessProbe
// pointing at /healthz on an nginx image that serves no such path: one replica, Running, zero
// restarts, never ready.
test("a restart is refused when every pod is Running with zero restarts and none is ready", () => {
  const why = restart("storefront", [pod("storefront-6796dcf65d-9qhq4", false, 0, "Running")]);
  assert.match(why ?? "", /Running with zero restarts and not one is ready/);
  assert.match(why ?? "", /readiness check/);
  // the one reading it refuses wrongly is named in the text, because a human reads this
  assert.match(why ?? "", /WAS serving and stopped/);
});

test("one restarted pod takes it out of the never-restarted rule and into the restart-count one", () => {
  const why = restart("storefront", [
    pod("storefront-6796dcf65d-9qhq4", false, 3, "Running"),
    pod("storefront-6796dcf65d-aaaaa", false, 2, "Running"),
  ]);
  assert.match(why ?? "", /kubelet has already done/);
});

test("a single ready replica still lets a restart through, whatever the others look like", () => {
  assert.equal(
    restart("storefront", [
      pod("storefront-6796dcf65d-9qhq4", false, 0, "Running"),
      pod("storefront-6796dcf65d-aaaaa", true, 0, "Running"),
    ]),
    null
  );
});

// ---- the sampling race (measured 2026-09-18) ----
//
// A CrashLoopBackOff pod running `sleep 3; exit 1` is READY for three seconds of every backoff
// cycle. Sampled there, k8s_list_pods returns `Running / ready: true / restarts: 2` — a real
// reading taken off the cluster — and the guard's first line, `some(p.ready)`, skipped all four
// rules. It refused nothing across a 57-attempt run while refusing correctly in earlier runs;
// the only difference was when the pods happened to be sampled.
test("a flapping pod that is ready this instant does not count as serving", () => {
  const flapping = [pod("settlement-worker-55f4d46d77-7c4zh", true, 2, "Running")];
  const why = restart("settlement-worker", flapping);
  assert.match(why ?? "", /kubelet has already done/);
});

test("a genuinely healthy pod still lets a restart through", () => {
  assert.equal(restart("api", [pod("api-1-a", true, 0, "Running"), pod("api-1-b", false, 1, "Running")]), null);
});

test("delete_pod sees a flapping sibling as no sibling at all", () => {
  const pods = [
    pod("api-6b747db7c9-zwdcv", false, 3, "Running"),
    pod("api-6b747db7c9-m4p8t", true, 4, "Running"), // ready right now, restarted four times
  ];
  assert.match(
    replacementRefusal("k8s_delete_pod", { pod: "api-6b747db7c9-zwdcv" }, pods) ?? "",
    /no healthy sibling|all 2 pods are unready/
  );
});
