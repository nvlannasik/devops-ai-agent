import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingMigrations } from "./migrate.js";

test("pendingMigrations filters non-sql, sorts, and skips applied", () => {
  const files = ["002_add_col.sql", "001_init.sql", "README.md", "003_index.sql"];
  const applied = new Set(["001_init.sql"]);
  assert.deepEqual(pendingMigrations(files, applied), ["002_add_col.sql", "003_index.sql"]);
});

test("pendingMigrations returns [] when everything is applied", () => {
  const files = ["001_init.sql", "002_x.sql"];
  assert.deepEqual(pendingMigrations(files, new Set(["001_init.sql", "002_x.sql"])), []);
});

test("pendingMigrations applies lexical order regardless of readdir order", () => {
  assert.deepEqual(pendingMigrations(["010_b.sql", "002_a.sql"], new Set()), ["002_a.sql", "010_b.sql"]);
});
