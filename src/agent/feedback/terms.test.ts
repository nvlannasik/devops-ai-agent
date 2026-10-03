import { test } from "node:test";
import assert from "node:assert/strict";
import { keyTerms } from "./terms.js";

// What an on-call engineer confirmed, turned into what a replayed answer must contain. A human's
// sentence never matches the agent's sentence; the names and error terms in it do.

test("the one confirmed root cause on record yields its workload, not its prose", () => {
  // incident_feedback, 2026-09-09 — verbatim.
  const t = keyTerms("Image pull failure for bench-probe/p1 due to misconfiguration of image tag/registry/secret.");
  assert.deepEqual(t.map((x) => x.term), ["bench-probe/p1"]);
});

test("backticked names, k8s names, env vars and error states are all kept, once each", () => {
  const t = keyTerms("DATABASE_URL was missing from configmap `orders-api-config`, so orders-api pods went CrashLoopBackOff; orders-api recovered after the fix.");
  assert.deepEqual(new Set(t.map((x) => x.term)), new Set(["orders-api-config", "orders-api", "DATABASE_URL", "CrashLoopBackOff"]));
});

test("an upper-case acronym state like OOMKilled counts; ordinary words and sentences do not", () => {
  assert.deepEqual(keyTerms("worker was OOMKilled at the 256Mi limit").map((x) => x.term), ["OOMKilled", "256Mi"]);
  assert.deepEqual(keyTerms("The database was down, we restarted it and/or waited."), []);
});

test("each term comes back as a regex that matches it literally", () => {
  const [t] = keyTerms("checkout-gateway.v1.2 (canary)");
  assert.equal(t!.term, "checkout-gateway.v1.2");
  assert.ok(new RegExp(t!.pattern, "i").test("rolled back checkout-gateway.v1.2 today"));
  assert.ok(!new RegExp(t!.pattern, "i").test("checkout-gatewayXv1Y2"), "dots must be literal");
});

test("at most six terms, so a long note cannot turn into an unpassable case", () => {
  const many = Array.from({ length: 10 }, (_, i) => `svc-${i}`).join(", ");
  assert.equal(keyTerms(many).length, 6);
});
