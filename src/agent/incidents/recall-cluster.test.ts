import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IncidentMemory } from "./index.js";

test("the migration adds a nullable cluster to three tables", () => {
  const sql = readFileSync(new URL("../../../migrations/017_cluster.sql", import.meta.url), "utf8");
  for (const table of ["incidents", "remediations", "remediation_checks"]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cluster TEXT`));
  }
  assert.doesNotMatch(sql, /NOT NULL/);
});

// Rows as Postgres would return them for KubePodCrashLooping/kube-system: one from before
// multi-cluster (NULL = the local cluster, dev), one from stg.
const day = (d: string) => new Date(`2026-11-0${d}T00:00:00Z`);
const fakePool = () => ({
  query: async (sql: string) => {
    if (/FROM incident_feedback/.test(sql)) {
      return { rows: [{ created_at: day("1"), confirmed_root_cause: "DEV-CONFIRMED longhorn csi leader election", action_taken: null, outcome: "resolved", cluster: "dev" }] };
    }
    return {
      rows: [
        { created_at: day("2"), severity: "warning", assessed_severity: "low", confidence: "medium", root_cause: "STG-OWN coredns restart", cluster: "stg" },
        { created_at: day("1"), severity: "warning", assessed_severity: "low", confidence: "high", root_cause: "DEV-OWN metallb speaker", cluster: "dev" },
      ],
    };
  },
});

test("recall prefers the same cluster", async () => {
  const mem = new IncidentMemory(fakePool() as never);
  const text = await mem.recall({ alertname: "KubePodCrashLooping", namespace: "kube-system" }, { cluster: "stg", local: "dev" });
  const own = text.split("## Prior similar incidents")[1]?.split("##")[0] ?? "";
  assert.match(own, /STG-OWN/, "stg's own RCA stays in the agent's-own tier");
  assert.doesNotMatch(own, /DEV-OWN/);
  assert.doesNotMatch(text, /Previously CONFIRMED by on-call/, "another cluster's confirmed cause is not a strong prior here");
  const related = text.split("## Possibly related — same alert on another cluster")[1] ?? "";
  assert.match(related, /seen on dev.*DEV-OWN/);
  assert.match(related, /confirmed on dev.*DEV-CONFIRMED/);
});

test("without a cluster, recall is what it was", async () => {
  const mem = new IncidentMemory(fakePool() as never);
  const text = await mem.recall({ alertname: "KubePodCrashLooping", namespace: "kube-system" });
  assert.match(text, /Previously CONFIRMED by on-call[\s\S]*DEV-CONFIRMED/);
  assert.match(text, /Prior similar incidents[\s\S]*STG-OWN[\s\S]*DEV-OWN/);
  assert.doesNotMatch(text, /another cluster/);
});

// A tiny emulation of the two predicates under test, so the test reads behaviour rather than SQL text.
const openRows = [
  { id: 1, channel: "C", thread_ts: "1.1", alertname: "KubePodCrashLooping", namespace: "kube-system", subjects: null, created_at: new Date(), alert_started_at: null, cluster: "stg" },
  { id: 2, channel: "C", thread_ts: "2.2", alertname: "KubePodCrashLooping", namespace: "kube-system", subjects: null, created_at: new Date(), alert_started_at: null, cluster: null },
];
const openPool = {
  query: async (sql: string, params: unknown[]) => {
    const keyed = /COALESCE\(cluster/.test(sql);
    const [, , local, cluster] = params as [string, number, string | null, string | null];
    return { rows: openRows.filter((r) => !keyed || (r.cluster ?? local) === cluster) };
  },
};

test("correlation stays inside one cluster", async () => {
  const mem = new IncidentMemory(openPool as never);
  assert.deepEqual((await mem.openRelatable("kube-system", 30, { cluster: "dev", local: "dev" })).map((r) => r.id), [2]);
  assert.deepEqual((await mem.openRelatable("kube-system", 30, { cluster: "stg", local: "dev" })).map((r) => r.id), [1]);
  assert.equal((await mem.openRelatable("kube-system", 30)).length, 2, "single-cluster: no filter");
});

test("a thread's incident row says its cluster", async () => {
  const pool = { query: async (_sql: string, params: unknown[]) => ({ rows: params[0] === "9.9" ? [{ cluster: "stg" }] : params[0] === "8.8" ? [{ cluster: null }] : [] }) };
  const mem = new IncidentMemory(pool as never);
  assert.deepEqual(await mem.clusterForThread("9.9"), { cluster: "stg" });
  assert.deepEqual(await mem.clusterForThread("8.8"), { cluster: null }, "a pre-multi-cluster row: found, NULL");
  assert.equal(await mem.clusterForThread("7.7"), null, "no incident on this thread");
});
