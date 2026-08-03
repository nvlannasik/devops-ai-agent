import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute } from "./server.js";

test("matchRoute recognises the three pages and the probe", () => {
  assert.deepEqual(matchRoute("/"), { kind: "overview" });
  assert.deepEqual(matchRoute("/incidents"), { kind: "list" });
  assert.deepEqual(matchRoute("/healthz"), { kind: "health" });
  assert.deepEqual(matchRoute("/incidents/42"), { kind: "detail", id: 42 });
});

test("matchRoute tolerates a trailing slash", () => {
  assert.deepEqual(matchRoute("/incidents/"), { kind: "list" });
});

// A non-numeric id must not reach the query layer as text — it would be a type error at
// the database rather than a 404 here.
test("matchRoute rejects a non-numeric incident id", () => {
  assert.deepEqual(matchRoute("/incidents/abc"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/1;DROP TABLE incidents"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/-1"), { kind: "notfound" });
});

test("matchRoute returns notfound for anything else", () => {
  assert.deepEqual(matchRoute("/admin"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/../etc/passwd"), { kind: "notfound" });
});
