import { test } from "node:test";
import assert from "node:assert/strict";
import { DashboardQueries } from "./queries.js";
import { parseFilters } from "./filters.js";

type Call = { sql: string; params: unknown[] };
const stub = (calls: Call[], rowsFor: (sql: string) => unknown[] = () => []) =>
  ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
    end: async () => {},
    on: () => {},
  }) as never;

test("list asks for one row more than the page size so it knows there is a next page", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls));
  await q.list(parseFilters(new URLSearchParams("pageSize=50&page=2")));

  const limit = calls[0].params.at(-2);
  const offset = calls[0].params.at(-1);
  assert.equal(limit, 51, "must over-fetch by one to detect hasMore without a COUNT");
  assert.equal(offset, 50);
});

test("list reports hasMore and trims the extra row back off", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: i }));
  const q = new DashboardQueries(stub([], () => rows));
  const out = await q.list(parseFilters(new URLSearchParams("pageSize=50")));
  assert.equal(out.hasMore, true);
  assert.equal(out.rows.length, 50);
});

test("absent filters become SQL NULLs so the predicate short-circuits", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams("")));
  assert.deepEqual(calls[0].params.slice(0, 6), [null, null, null, null, null, null]);
});

test("set filters are passed positionally in the documented order", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(
    parseFilters(new URLSearchParams("from=2026-07-01&alertname=X&namespace=prod&severity=critical&resolved=true"))
  );
  const [from, to, alertname, namespace, severity, resolved] = calls[0].params;
  assert.equal((from as Date).toISOString().slice(0, 10), "2026-07-01");
  assert.equal(to, null);
  assert.deepEqual([alertname, namespace, severity, resolved], ["X", "prod", "critical", true]);
});

test("detail returns null for an id that does not exist", async () => {
  const q = new DashboardQueries(stub([], () => []));
  assert.equal(await q.detail(999), null);
});

test("with no pool the dashboard reports itself disabled instead of throwing", async () => {
  const q = new DashboardQueries(null);
  assert.equal(q.enabled, false);
  await assert.doesNotReject(() => q.close());
});

// Recomputing five aggregates on every refresh is unthrottled load on the same event
// loop that handles alerts — and there is no auth in front of the refresh button.
test("overview is cached for 60s: a second call issues no new queries", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls));
  await q.overview();
  const afterFirst = calls.length;
  await q.overview();
  assert.equal(calls.length, afterFirst, "second overview() must be served from cache");
});
