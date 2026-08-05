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

// The two tests above are each individually satisfiable by a regression that breaks the
// other half: a stub with a fixed row count doesn't notice if the "+1" stops being
// requested, and a params check doesn't notice if the trim-back-to-pageSize stops
// happening. This stub actually honours limit/offset, so it pins over-fetch and trim
// *together* across three shapes: more rows exist beyond the page, fewer rows exist
// than a full page, and exactly one page's worth exists (the edge case: hasMore must
// be false even though pageSize+1 was requested).
const poolWithAvailableRows = (total: number) =>
  ({
    query: async (_sql: string, params: unknown[] = []) => {
      const limit = params.at(-2) as number;
      const offset = params.at(-1) as number;
      const n = Math.max(0, Math.min(limit, total - offset));
      return { rows: Array.from({ length: n }, (_, i) => ({ id: offset + i })) };
    },
    end: async () => {},
    on: () => {},
  }) as never;

test("list composes over-fetch and trim together: full page, partial page, exactly-one-page", async () => {
  const pageSize = 50;

  const full = await new DashboardQueries(poolWithAvailableRows(120)).list(
    parseFilters(new URLSearchParams(`pageSize=${pageSize}`))
  );
  assert.equal(full.rows.length, pageSize);
  assert.equal(full.hasMore, true);

  const partial = await new DashboardQueries(poolWithAvailableRows(30)).list(
    parseFilters(new URLSearchParams(`pageSize=${pageSize}`))
  );
  assert.equal(partial.rows.length, 30);
  assert.equal(partial.hasMore, false);

  const exactlyOnePage = await new DashboardQueries(poolWithAvailableRows(pageSize)).list(
    parseFilters(new URLSearchParams(`pageSize=${pageSize}`))
  );
  assert.equal(exactlyOnePage.rows.length, pageSize);
  assert.equal(exactlyOnePage.hasMore, false, "exactly pageSize rows available must not report a next page");
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

// Mechanical enforcement of the plan's "mandatory LIMIT on every query" rule: this
// inspects the actual SQL text, so it fails loudly the next time someone adds a query
// without a LIMIT — do not delete it as redundant with the tests above, none of which
// look at the SQL text itself.
// list() MUST be in here: it is the only query whose row count is driven by a URL, so it is
// the one the rule exists for. An earlier version of this test called overview() and detail()
// only — it covered 8 of 9 statements and missed the one that mattered.
test("every query this module can emit carries a LIMIT", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls, () => [{ id: 1 }])); // 1 row so detail's follow-ups fire
  await q.overview();
  await q.detail(1);
  await q.list(parseFilters(new URLSearchParams("")));
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c.sql, /\bLIMIT\b/i, `missing LIMIT: ${c.sql}`);
});

// sum() over INTEGER widens to BIGINT, and node-postgres hands BIGINT back as a string
// rather than lose precision. Without the coercion the totals still render — as "127" for
// 12 + 7 — which is a wrong number that looks like a plausible one.
test("token sums arrive as BIGINT strings and become numbers, not concatenations", async () => {
  const usage = (sql: string): unknown[] => {
    if (!sql.includes("FROM llm_usage")) return [];
    const line = { input: "12", output: "7", cache_read: "5", cache_creation: "1" };
    return sql.includes("GROUP BY")
      ? [{ backend: "private-llm", model: "qwen3-32b", calls: 3, ...line }]
      : [{ calls: 3, ...line }];
  };
  const o = await new DashboardQueries(stub([], usage)).overview();

  assert.equal(o.tokens.input, 12);
  assert.equal(o.tokens.output, 7);
  assert.equal(o.tokens.input + o.tokens.output, 19, `string sums would total "127"`);
  assert.equal(o.tokens.cacheRead, 5);
  assert.equal(o.tokens.cacheCreation, 1);
  assert.equal(o.tokens.byBackend[0].input, 12, "the per-backend rows widen the same way");
  assert.equal(o.tokens.byBackend[0].backend, "private-llm");
});

test("a window with no LLM calls reports zeros rather than NaN", async () => {
  const o = await new DashboardQueries(stub([])).overview();
  assert.deepEqual(o.tokens, {
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byBackend: [],
  });
});

// An interval spliced into the SQL text is an injection site the moment the window stops
// being a module constant — which is exactly the change someone will make to add a range
// picker. Bound as $1 it can never become one.
test("the 30-day window is bound as a parameter, never interpolated into the SQL", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).overview();
  const windowed = calls.filter((c) => c.sql.includes("$1::interval"));
  assert.ok(windowed.length >= 5, "the recurring, totals, remediation, feedback and token queries");
  for (const c of windowed) assert.deepEqual(c.params, ["30 days"], `not bound: ${c.sql}`);
  for (const c of calls) assert.doesNotMatch(c.sql, /interval '30 days'/);
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

// The cache hands out one shared object. If a consumer (e.g. a render path that sorts
// or annotates in place) could mutate it, that corruption would be visible to every
// other viewer for up to 60s. It must be frozen deeply enough that both an array
// mutation and a top-level field reassignment throw instead of silently succeeding.
test("overview()'s returned object is deep-frozen: mutating it throws, the cache is not corrupted", async () => {
  const q = new DashboardQueries(stub([]));
  const first = await q.overview();
  assert.throws(() => (first.weekly as unknown[]).push({ label: "x", value: 1 }));
  assert.throws(() => {
    (first as { totalIncidents: number }).totalIncidents = 999999;
  });
  const second = await q.overview();
  assert.equal(second.totalIncidents, 0, "the failed mutation must not have reached the cached value");
});
