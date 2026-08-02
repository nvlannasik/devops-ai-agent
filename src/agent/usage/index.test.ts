import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageStore } from "./index.js";
import logger from "../../utils/logger/index.js";

type Call = { sql: string; params: unknown[] };
const stubPool = (calls: Call[], fail = false) =>
  ({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (fail) throw new Error("db is down");
      return { rows: [] };
    },
  }) as never;

test("record inserts the token counts with the router's attribution", async () => {
  const calls: Call[] = [];
  await new UsageStore(stubPool(calls)).record({
    threadTs: "1785282508.001",
    backend: "sonnet",
    route: "heavy",
    model: "claude-sonnet-5",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO llm_usage/);
  assert.deepEqual(calls[0].params, ["1785282508.001", "sonnet", "heavy", "claude-sonnet-5", 100, 20, 5, 3]);
});

test("record tolerates a non-router provider with no attribution", async () => {
  const calls: Call[] = [];
  await new UsageStore(stubPool(calls)).record({
    threadTs: null, backend: null, route: null, model: null,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  assert.deepEqual(calls[0].params.slice(0, 4), [null, null, null, null]);
});

// A cost data point is worth less than an investigation. This is the whole reason
// record() swallows: without it, a Postgres blip during an incident would abort the
// investigation that incident needs.
test("a failing insert is swallowed, never thrown", async () => {
  const calls: Call[] = [];
  await assert.doesNotReject(() =>
    new UsageStore(stubPool(calls, true)).record({
      threadTs: "t", backend: null, route: null, model: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
  );
});

// `assert.doesNotReject` alone can't tell "correctly skipped" apart from "attempted and
// swallowed": with pool=null, calling `this.pool.query(...)` would throw a TypeError that
// record()'s own try/catch catches and logs via logger.warn — same non-rejecting outcome.
// Asserting zero warn calls proves the `if (!this.pool) return;` guard actually ran.
test("no pool configured is a no-op — no query attempted, nothing logged", async (t) => {
  const warn = t.mock.method(logger, "warn");
  await assert.doesNotReject(() =>
    new UsageStore(null).record({
      threadTs: "t", backend: null, route: null, model: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
  );
  assert.equal(warn.mock.callCount(), 0);
});

// The backfill must never steal rows from an earlier incident in the same thread,
// hence `incident_id IS NULL` in the WHERE clause.
test("linkToIncident only claims rows that are not yet linked", async () => {
  const calls: Call[] = [];
  await new UsageStore(stubPool(calls)).linkToIncident(42, "1785282508.001");
  assert.match(calls[0].sql, /UPDATE llm_usage/);
  assert.match(calls[0].sql, /incident_id IS NULL/);
  assert.deepEqual(calls[0].params, [42, "1785282508.001"]);
});

// Same shape, same distinction as record()'s null-pool test above.
test("linkToIncident: no pool configured is a no-op — no query attempted, nothing logged", async (t) => {
  const warn = t.mock.method(logger, "warn");
  await assert.doesNotReject(() => new UsageStore(null).linkToIncident(42, "1785282508.001"));
  assert.equal(warn.mock.callCount(), 0);
});
