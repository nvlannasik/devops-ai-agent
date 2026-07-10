import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentMemory, parseSeverity, extractRootCause } from "./index.js";

const SAMPLE_RCA = [
  "🔴 *Critical Severity Incident*",
  "",
  "*📍 Root Cause*",
  "Pod payment-api-xxx OOMKilled — memory leak in connection pool.",
  "",
  "*📊 Evidence*",
  "• Pod restarted 15x in 30min",
  "",
  "*📈 Confidence:* `High`",
].join("\n");

test("parseSeverity reads the severity label", () => {
  assert.equal(parseSeverity("*🔴 Severity:* `critical`"), "critical");
  assert.equal(parseSeverity("no severity here"), null);
});

test("extractRootCause pulls only the Root Cause section", () => {
  const cause = extractRootCause(SAMPLE_RCA);
  assert.equal(cause, "Pod payment-api-xxx OOMKilled — memory leak in connection pool.");
});

test("extractRootCause returns null when absent", () => {
  assert.equal(extractRootCause("just some text"), null);
});

test("recall/store are safe no-ops when Postgres is disabled (pool=null)", async () => {
  const mem = new IncidentMemory(null);
  assert.equal(await mem.recall({ alertname: "X", namespace: "ns" }), "");
  await mem.store({ alertname: "X" }, SAMPLE_RCA); // must not throw
  await mem.close(); // must not throw
});

test("recall returns '' without an alertname to key on", async () => {
  // a fake pool would never be hit because the alertname guard returns first
  const mem = new IncidentMemory({ query: async () => assert.fail("should not query") } as any);
  assert.equal(await mem.recall({ namespace: "ns" }), "");
});
