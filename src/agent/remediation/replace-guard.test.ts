import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePods, replacementRefusal, REPLACEMENT_ACTIONS } from "./replace-guard.js";

const pod = (name: string, ready: boolean, restarts = 0) => ({ name, ready, restarts });
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
    { name: "api-1-a", ready: false, restarts: 7 },
    { name: "api-1-b", ready: true, restarts: 0 },
  ]);
});

test("the guard covers exactly the two actions that rebuild a pod from the same spec", () => {
  assert.deepEqual([...REPLACEMENT_ACTIONS].sort(), ["k8s_delete_pod", "k8s_rollout_restart"]);
});
