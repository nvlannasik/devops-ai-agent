import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallKey, windowOf, memoCovers } from "./index.js";

const same = (a: unknown, b: unknown, msg: string) =>
  assert.equal(toolCallKey("k8s_list_events", a), toolCallKey("k8s_list_events", b), msg);
const differ = (a: unknown, b: unknown, msg: string) =>
  assert.notEqual(toolCallKey("k8s_list_events", a), toolCallKey("k8s_list_events", b), msg);

test("the pair that actually happened: a quoted number is the same call", () => {
  // Round 1 returned `[]`. The model read the empty result as a wrong argument TYPE and
  // re-sent all four tools with the numbers quoted — a whole round for identical data.
  same(
    { query: '{namespace="sample-apps"}', start: 1788487759, end: 1788509359 },
    { query: '{namespace="sample-apps"}', start: "1788487759", end: "1788509359" },
    "requoting a number must not buy a second query"
  );
  same({ namespace: "sample-apps", since_minutes: 180 }, { namespace: "sample-apps", since_minutes: "180" }, "");
});

test("argument order is not identity", () => {
  same({ namespace: "a", since_minutes: 5 }, { since_minutes: 5, namespace: "a" }, "key order changed the key");
  same({ a: { y: 1, x: 2 } }, { a: { x: 2, y: 1 } }, "nested key order changed the key");
});

test("a different tool or a different value is a different call", () => {
  assert.notEqual(toolCallKey("k8s_list_pods", { ns: "a" }), toolCallKey("k8s_list_events", { ns: "a" }));
  differ({ namespace: "sample-apps" }, { namespace: "sample-app" }, "one character apart read as the same call");
  differ({ namespace: "a" }, { namespace: "a", since_minutes: 5 }, "an extra argument read as the same call");
  differ({ since_minutes: 180 }, { since_minutes: 1800 }, "a wider window read as the same call");
});

test("a value that spells another object's shape does not collide with it", () => {
  // The normaliser stringifies scalars, so this is the collision to be sure about.
  differ({ a: '1","b":"2' }, { a: 1, b: 2 }, "a crafted string collided with a real argument pair");
});

test("null, undefined and a missing key are one thing", () => {
  same({ a: 1, b: null }, { a: 1, b: undefined }, "null and undefined are the same absent value");
  differ({ a: 1, b: null }, { a: 1 }, "an explicitly null argument is still an argument");
});

test("arrays keep their order, because a tool's list arguments do", () => {
  same({ pods: ["a", "b"] }, { pods: ["a", "b"] }, "");
  differ({ pods: ["a", "b"] }, { pods: ["b", "a"] }, "array order was normalised away");
});

// --- window params: asking for more of the same thing, not for a different thing ---
// Live 2026-09-22: k8s_get_pod_logs on one pod, four rounds — tail_lines 200, 10, 200, 200.
// Four calls, ~90s each on the slow backend, for output the run already had.

test("tail_lines and since_seconds are not part of a call's identity", () => {
  const pod = { pod_name: "checkout-gateway-774f8b79dd-rzzvt", namespace: "sample-apps" };
  same({ ...pod, tail_lines: 200 }, { ...pod, tail_lines: 10 }, "the tail size is a window, not a different call");
  same({ ...pod, tail_lines: 200 }, { ...pod, tail_lines: 200, since_seconds: 1200 }, "so is the age");
  differ({ ...pod, tail_lines: 200 }, { pod_name: "other-pod", namespace: "sample-apps", tail_lines: 200 }, "a different pod is a different call");
});

test("a narrower request is served from a wider result; a wider one is not", () => {
  // 200 lines already fetched, 10 asked for: the tail of 200 contains the tail of 10
  assert.equal(memoCovers(windowOf({ tail_lines: 200 }), windowOf({ tail_lines: 10 })), true);
  // 10 fetched, 200 asked for: answering that from the memo would be ten lines called two hundred
  assert.equal(memoCovers(windowOf({ tail_lines: 10 }), windowOf({ tail_lines: 200 })), false);
  // every dimension has to cover
  assert.equal(memoCovers(windowOf({ tail_lines: 200 }), windowOf({ tail_lines: 100, since_seconds: 3600 })), false);
  assert.equal(memoCovers(windowOf({ tail_lines: 200, since_seconds: 3600 }), windowOf({ tail_lines: 100, since_seconds: 600 })), true);
  // absent means the server's default, and a call that names nothing is covered by any result
  assert.equal(memoCovers(windowOf({ tail_lines: 50 }), windowOf({})), true);
});
