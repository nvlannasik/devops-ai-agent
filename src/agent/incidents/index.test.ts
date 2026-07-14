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
  assert.equal(await mem.store({ alertname: "X" }, SAMPLE_RCA), null); // no id when disabled
  await mem.close(); // must not throw
});

test("store returns the inserted id and persists the Slack thread link", async () => {
  let captured: { sql: string; params: unknown[] } | null = null;
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return { rows: [{ id: "42" }] }; // pg returns BIGSERIAL as string
    },
  } as any;
  const mem = new IncidentMemory(fakePool);

  const id = await mem.store({ alertname: "X", namespace: "ns" }, SAMPLE_RCA, { channel: "C123", threadTs: "1720.99" });
  assert.equal(id, 42);
  assert.match(captured!.sql, /RETURNING id/);
  assert.deepEqual(captured!.params.slice(-2), ["C123", "1720.99"]); // channel, thread_ts
});

test("recall returns '' without an alertname to key on", async () => {
  // a fake pool would never be hit because the alertname guard returns first
  const mem = new IncidentMemory({ query: async () => assert.fail("should not query") } as any);
  assert.equal(await mem.recall({ namespace: "ns" }), "");
});

test("recall renders the CONFIRMED tier above the hypothesis tier", async () => {
  const fakePool = {
    query: async (sql: string) =>
      sql.includes("incident_feedback")
        ? { rows: [{ created_at: "2026-07-01", confirmed_root_cause: "pool exhausted", action_taken: "scaled to 4", outcome: "resolved" }] }
        : { rows: [{ created_at: "2026-06-19", severity: "critical", confidence: "High", root_cause: "OOM leak" }] },
  } as any;
  const out = await new IncidentMemory(fakePool).recall({ alertname: "X", namespace: "payment" });
  assert.match(out, /Previously CONFIRMED by on-call/);
  assert.match(out, /pool exhausted; action: scaled to 4; outcome: resolved/);
  assert.match(out, /Prior similar incidents/);
  assert.ok(out.indexOf("CONFIRMED") < out.indexOf("Prior similar"), "confirmed tier must come first");
});

test("storeFeedback maps a unique violation to 'duplicate' and null pool to 'failed'", async () => {
  const fb = { slackUser: "U1", triggerKey: "123.45", rawExcerpt: "…", confirmed_root_cause: "x", action_taken: null, outcome: "resolved" };
  const dupPool = { query: async () => { const e: any = new Error("dup"); e.code = "23505"; throw e; } } as any;
  assert.equal(await new IncidentMemory(dupPool).storeFeedback(1, fb), "duplicate");
  assert.equal(await new IncidentMemory(null).storeFeedback(1, fb), "failed");
});

test("findIncidentByThread maps the row id (pg returns BIGSERIAL as string)", async () => {
  const mem = new IncidentMemory({ query: async () => ({ rows: [{ id: "7" }] }) } as any);
  assert.equal(await mem.findIncidentByThread("C1", "111.22"), 7);
  const empty = new IncidentMemory({ query: async () => ({ rows: [] }) } as any);
  assert.equal(await empty.findIncidentByThread("C1", "111.22"), null);
});
