import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { postgresTables, redisNamespaces } from "./stores.js";

// Against the SHIPPED migrations, not a fixture — the same trick as skills/real.test.ts. A test
// over a fixture proves the regex works; this proves the page describes what actually ships,
// and fails when someone adds migration 008 with a table the parser cannot see.
test("the incident memory's tables are read out of the shipped migrations", () => {
  const tables = postgresTables();
  const names = tables.map((t) => t.label);
  for (const expected of ["incidents", "remediations", "incident_feedback", "remediation_checks", "llm_usage"]) {
    assert.ok(names.includes(expected), `${expected} should be listed`);
  }
  // Every table names the migration that introduced it, and that file must exist.
  const files = new Set(readdirSync(new URL("../../migrations", import.meta.url)));
  for (const t of tables) assert.ok(files.has(t.detail), `${t.label} names a missing file: ${t.detail}`);
});

// Migration order is the order the feature set grew in, and a plain sort is what both this and
// runMigrations() rely on the `001_` numbering for.
test("tables come back in migration order", () => {
  const tables = postgresTables();
  assert.equal(tables[0]!.label, "incidents", "the first migration creates incidents");
  assert.deepEqual([...tables].sort((a, b) => a.detail.localeCompare(b.detail)), tables);
});

// A table created in one migration and re-declared with IF NOT EXISTS in a later one is one
// table, and it belongs to the migration that introduced it.
test("a table is listed once, under the migration that introduced it", () => {
  const tables = postgresTables();
  assert.equal(new Set(tables.map((t) => t.label)).size, tables.length);
});

// Composed from the constants the writing modules own — `agent/memory/index.test.ts` is what
// stops those constants falling behind the code. This asserts the composition, not the list.
test("the Redis namespaces cover conversation memory and alert dedup", () => {
  const ns = redisNamespaces();
  const labels = ns.map((n) => n.label);
  assert.deepEqual(labels, ["conv:*", "rca:*", "skills:*", "dedup:*"]);
  for (const n of ns) assert.ok(n.detail.length > 0, `${n.label} should say what it holds`);
});

// Called per request; the migrations cannot change while the process lives.
test("the table list is read once and cached", () => {
  assert.equal(postgresTables(), postgresTables(), "same array identity, so no fs call per request");
});
