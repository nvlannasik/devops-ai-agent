import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallKey } from "./index.js";

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
