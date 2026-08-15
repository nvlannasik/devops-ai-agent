import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertDeduplicator } from "./index.js";

// No Redis configured in tests → exercises the in-memory fallback path.

test("first sighting processes, immediate repeat is suppressed", async () => {
  const d = new AlertDeduplicator();
  const labels = { alertname: "OOMKilled", namespace: "payment" };
  assert.equal(await d.shouldProcess(labels), true);
  assert.equal(await d.shouldProcess(labels), false);
});

test("label order does not affect the fingerprint", async () => {
  const d = new AlertDeduplicator();
  assert.equal(await d.shouldProcess({ a: "1", b: "2" }), true);
  assert.equal(await d.shouldProcess({ b: "2", a: "1" }), false); // same alert, reordered
});

test("a different alert is processed independently", async () => {
  const d = new AlertDeduplicator();
  assert.equal(await d.shouldProcess({ alertname: "A" }), true);
  assert.equal(await d.shouldProcess({ alertname: "B" }), true);
});

test("expired entry is processed again", async () => {
  const d = new AlertDeduplicator();
  const labels = { alertname: "HighLatency" };
  assert.equal(await d.shouldProcess(labels, 1), true); // 1ms TTL
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await d.shouldProcess(labels, 1), true); // TTL lapsed → processed again
});

test("clear releases the claim so the next firing is processed again", async () => {
  const d = new AlertDeduplicator();
  const labels = { alertname: "PodNotHealthy", namespace: "dev-auth" };
  assert.equal(await d.shouldProcess(labels), true);
  assert.equal(await d.shouldProcess(labels), false); // suppressed while claimed
  await d.clear(labels); // alert resolved
  assert.equal(await d.shouldProcess(labels), true); // re-fire → fresh investigation
});
