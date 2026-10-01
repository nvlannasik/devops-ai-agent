import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { TraceStore, INSERT_CHUNK, type EventRow } from "./store.js";

type Call = { sql: string; params: unknown[] };
const stub = (calls: Call[], fail = false) =>
  ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (fail) throw new Error("db down");
      return { rows: [], rowCount: 3 };
    },
  }) as unknown as Pool;

const row = (seq: number): EventRow => ({ threadTs: "1.1", seq, kind: "tool", name: "k8s_list_pods", outcome: null, payload: { run: "r", result: "[]" } });

test("rows go in one INSERT, seven parameters each, payload as JSON text", async () => {
  const calls: Call[] = [];
  await new TraceStore(stub(calls)).insert([row(0), row(1)]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO agent_events/);
  assert.equal(calls[0]!.params.length, 14);
  assert.equal(calls[0]!.params[5], JSON.stringify(row(0).payload));
});

test("a large run is split so no statement exceeds Postgres' parameter limit", async () => {
  const calls: Call[] = [];
  await new TraceStore(stub(calls)).insert(Array.from({ length: INSERT_CHUNK + 1 }, (_, i) => row(i)));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.params.length <= 65535));
});

test("no pool, no rows, or a failing database: nothing throws", async () => {
  await new TraceStore(null).insert([row(0)]);
  await new TraceStore(stub([])).insert([]);
  await new TraceStore(stub([], true)).insert([row(0)]);
  assert.equal(await new TraceStore(stub([], true)).prune(), 0);
});

test("prune deletes run bodies at 30 days and gate rows at 180", async () => {
  const calls: Call[] = [];
  const n = await new TraceStore(stub(calls)).prune();
  const sql = calls.map((c) => c.sql).join("\n");
  assert.match(sql, /kind <> 'gate'[\s\S]*30 days/);
  assert.match(sql, /kind = 'gate'[\s\S]*180 days/);
  assert.equal(n, 6);
});
