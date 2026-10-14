// Tests for PostmortemStore (migration 015, spec 2026-10-14-postmortem-draft-design §4). Fake-pool
// pattern from src/agent/incidents/index.test.ts — no real Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PostmortemStore } from "./store.js";

const MIGRATION = readFileSync(new URL("../../../migrations/015_postmortems.sql", import.meta.url), "utf-8");

test("migration 015 creates the postmortems table and its incident index", () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS postmortems/);
  assert.match(MIGRATION, /postmortems_by_incident/);
});

test("store passes markdown through cleanDeep before the INSERT", async () => {
  let captured: unknown[] | null = null;
  const fakePool = {
    query: async (_sql: string, params: unknown[]) => {
      captured = params;
      return { rows: [{ id: "9" }] };
    },
  } as any;
  const store = new PostmortemStore(fakePool);
  const dirty = "lone surrogate \ud83d and a null byte \u0000 here";
  const id = await store.store(7, "U1", dirty, "claude");
  assert.equal(id, 9);
  const markdownParam = captured![3] as string;
  assert.ok(!markdownParam.includes("\u0000"), "null byte must be stripped");
  assert.ok(!markdownParam.includes("\ud83d"), "lone surrogate must be stripped");
});

test("latest: SQL orders by created_at DESC LIMIT 1 and maps the row", async () => {
  let sql = "";
  const fakePool = {
    query: async (s: string) => {
      sql = s;
      return {
        rows: [
          {
            id: "3",
            created_at: new Date("2026-10-14T10:00:00.000Z"),
            requested_by: "U1",
            backend: "claude",
            markdown: "# draft",
          },
        ],
      };
    },
  } as any;
  const store = new PostmortemStore(fakePool);
  const latest = await store.latest(7);
  assert.match(sql, /ORDER BY created_at DESC LIMIT 1/);
  assert.deepEqual(latest, {
    id: 3,
    createdAt: "2026-10-14T10:00:00.000Z",
    requestedBy: "U1",
    backend: "claude",
    markdown: "# draft",
  });
});

test("latest returns null when no draft has been stored", async () => {
  const fakePool = { query: async () => ({ rows: [] }) } as any;
  const store = new PostmortemStore(fakePool);
  assert.equal(await store.latest(7), null);
});

test("exists reflects whether a row is present", async () => {
  const present = new PostmortemStore({ query: async () => ({ rows: [{ "?column?": 1 }] }) } as any);
  assert.equal(await present.exists(7), true);
  const absent = new PostmortemStore({ query: async () => ({ rows: [] }) } as any);
  assert.equal(await absent.exists(7), false);
});

// ---- facts() ----

const INCIDENT_ROW = {
  id: "7",
  alertname: "SampleAppHighLatency",
  namespace: "sample-apps",
  severity: "high",
  assessed_severity: "high",
  alert_started_at: new Date("2026-10-14T10:00:00.000Z"),
  created_at: new Date("2026-10-14T10:00:05.000Z"),
  resolved_at: new Date("2026-10-14T10:20:00.000Z"),
  resolved_by: "alertmanager",
  root_cause: "TIMEOUT_MS lowered",
  rca: "*Root Cause*\nTIMEOUT_MS lowered",
  changes: null,
  thread_ts: "1728900000.000100",
};

function poolReturning(byTable: (sql: string) => { rows: any[] } | Promise<{ rows: any[] }>) {
  return { query: async (sql: string) => byTable(sql) } as any;
}

test("facts: a missing incident row returns null", async () => {
  const pool = poolReturning((sql) => (/FROM incidents WHERE id/.test(sql) ? { rows: [] } : { rows: [] }));
  const store = new PostmortemStore(pool);
  assert.equal(await store.facts(7), null);
});

test("facts: a remediations query that throws puts \"remediations\" in unavailable while the rest is still returned", async () => {
  const pool = poolReturning((sql) => {
    if (/FROM incidents WHERE id/.test(sql)) return { rows: [INCIDENT_ROW] };
    if (/FROM remediations/.test(sql)) throw new Error("boom");
    if (/FROM incident_feedback/.test(sql)) return { rows: [] };
    if (/FROM agent_events/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const store = new PostmortemStore(pool);
  const facts = await store.facts(7);
  assert.ok(facts);
  assert.deepEqual(facts!.remediations, []);
  assert.ok(facts!.unavailable.includes("remediations"));
  // the rest of the gathering still succeeded
  assert.equal(facts!.incident.alertname, "SampleAppHighLatency");
  assert.deepEqual(facts!.related, []);
});

test("facts: timestamps map to ISO strings", async () => {
  const pool = poolReturning((sql) => {
    if (/FROM incidents WHERE id/.test(sql)) return { rows: [INCIDENT_ROW] };
    if (/FROM remediations/.test(sql)) {
      return {
        rows: [
          {
            action: "k8s_rollout_restart",
            summary: "restart checkout-gateway",
            status: "succeeded",
            approved_by: "U2",
            created_at: new Date("2026-10-14T10:05:00.000Z"),
            executed_at: new Date("2026-10-14T10:08:00.000Z"),
            result: null,
            verdict: "recovered",
          },
        ],
      };
    }
    if (/FROM incident_feedback/.test(sql)) return { rows: [] };
    if (/FROM agent_events/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const store = new PostmortemStore(pool);
  const facts = await store.facts(7);
  assert.ok(facts);
  assert.equal(facts!.incident.createdAt, "2026-10-14T10:00:05.000Z");
  assert.equal(facts!.incident.alertStartedAt, "2026-10-14T10:00:00.000Z");
  assert.equal(facts!.incident.resolvedAt, "2026-10-14T10:20:00.000Z");
  assert.equal(facts!.remediations[0]!.createdAt, "2026-10-14T10:05:00.000Z");
  assert.equal(facts!.remediations[0]!.executedAt, "2026-10-14T10:08:00.000Z");
  assert.equal(facts!.changes, null); // changes NULL on the row is not a failure
  assert.ok(!facts!.unavailable.includes("change timeline"));
});

test("facts: with no pool, returns null without throwing", async () => {
  const store = new PostmortemStore(null);
  assert.equal(await store.facts(7), null);
});

test("with no pool, every method returns null/false/[] without throwing", async () => {
  const store = new PostmortemStore(null);
  assert.equal(await store.store(7, "U1", "md", "claude"), null);
  assert.equal(await store.latest(7), null);
  assert.equal(await store.exists(7), false);
  assert.equal(await store.facts(7), null);
});
