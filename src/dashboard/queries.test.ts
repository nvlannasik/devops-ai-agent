import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNT_CAP, DashboardQueries, NAV_COUNT_CAP } from "./queries.js";
import { PAGE_SIZE, parseFilters } from "./filters.js";

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
  await q.list(parseFilters(new URLSearchParams("page=2")));

  const limit = calls[0].params.at(-2);
  const offset = calls[0].params.at(-1);
  assert.equal(limit, PAGE_SIZE + 1, "must over-fetch by one to detect hasMore without a COUNT");
  assert.equal(offset, PAGE_SIZE);
});

test("list reports hasMore and trims the extra row back off", async () => {
  const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({ id: i }));
  const q = new DashboardQueries(stub([], () => rows));
  const out = await q.list(parseFilters(new URLSearchParams("")));
  assert.equal(out.hasMore, true);
  assert.equal(out.rows.length, PAGE_SIZE);
});

// The two tests above are each individually satisfiable by a regression that breaks the
// other half: a stub with a fixed row count doesn't notice if the "+1" stops being
// requested, and a params check doesn't notice if the trim-back-to-PAGE_SIZE stops
// happening. This stub actually honours limit/offset, so it pins over-fetch and trim
// *together* across three shapes: more rows exist beyond the page, fewer rows exist
// than a full page, and exactly one page's worth exists (the edge case: hasMore must
// be false even though PAGE_SIZE + 1 was requested).
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
  const none = parseFilters(new URLSearchParams(""));

  const full = await new DashboardQueries(poolWithAvailableRows(PAGE_SIZE * 3)).list(none);
  assert.equal(full.rows.length, PAGE_SIZE);
  assert.equal(full.hasMore, true);

  const partial = await new DashboardQueries(poolWithAvailableRows(PAGE_SIZE - 4)).list(none);
  assert.equal(partial.rows.length, PAGE_SIZE - 4);
  assert.equal(partial.hasMore, false);

  const exactlyOnePage = await new DashboardQueries(poolWithAvailableRows(PAGE_SIZE)).list(none);
  assert.equal(exactlyOnePage.rows.length, PAGE_SIZE);
  assert.equal(exactlyOnePage.hasMore, false, "exactly PAGE_SIZE rows available must not report a next page");
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
test("the window is bound as a parameter, never interpolated into the SQL", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).overview();
  const windowed = calls.filter((c) => c.sql.includes("$1::interval"));
  assert.ok(windowed.length >= 5, "the recurring, totals, remediation, feedback and token queries");
  // $1 is the interval in every one of them. The series query binds two more — the date_trunc
  // field and the to_char format — which is the whole point of that construction: they LOOK
  // like they would have to be spliced into the SQL and they do not.
  for (const c of windowed) {
    assert.equal(c.params[0], "30 days", `not bound: ${c.sql}`);
  }
  for (const c of calls) assert.doesNotMatch(c.sql, /interval '30 days'/);
});

// The range comes off a query string. If the bucket or its label format were interpolated,
// this is the test that would not exist — so it asserts the shape that makes them bindable:
// no range value appears anywhere in the SQL text of any query.
test("the bucket and its label format are bound too, never spliced into the SQL text", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).overview("24h");
  const series = calls.find((c) => c.sql.includes("date_trunc($2"));
  assert.ok(series, "no series query — or its bucket stopped being a bound parameter");
  assert.deepEqual(series.params, ["24 hours", "hour", "HH24:00"]);
  for (const c of calls) {
    assert.doesNotMatch(c.sql, /date_trunc\('/, `bucket spliced into SQL: ${c.sql}`);
    assert.doesNotMatch(c.sql, /interval '24 hours'/);
  }
});

// Three ranges, three cached answers. One slot would have each range evicting the others every
// time somebody moved the control, which on a 60s TTL is a full re-query per click.
test("the overview cache is keyed by range, so the three do not evict each other", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls));
  await q.overview("24h");
  const afterFirst = calls.length;
  await q.overview("7d");
  assert.ok(calls.length > afterFirst, "a different range must issue its own queries");
  const afterSecond = calls.length;
  await q.overview("24h");
  assert.equal(calls.length, afterSecond, "the first range was evicted by the second");
});

// An unrecognised ?range= must not reach RANGES[] as a key and produce undefined.
test("an unknown range falls back to the default rather than querying with undefined", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).overview("90d" as never);
  const windowed = calls.filter((c) => c.sql.includes("$1::interval"));
  for (const c of windowed) assert.equal(c.params[0], "30 days");
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

// ---------- the bounded count ----------

// An exact COUNT(*) over a filtered table is a full scan on the same event loop that handles
// alerts, and nobody clicks through to page 400. The count walks at most COUNT_CAP rows and
// then reports "this many or more" — a flat cost in exchange for a number no one reads.
test("the count query is capped rather than an unbounded COUNT(*)", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams("")));
  assert.equal(calls.length, 2, "one page of rows, one count");
  const count = calls[1];
  assert.match(count.sql, /count\(\*\)/i);
  assert.match(count.sql, /\bLIMIT\b/i, "the cap is what keeps this from scanning the table");
  assert.equal(count.params.at(-1), COUNT_CAP);
});

// A page of rows under a total that excludes them is the failure this guards: the two queries
// filter the same table and must filter it identically.
test("the page and its count carry the same predicate and the same filter parameters", async () => {
  const calls: Call[] = [];
  const qs = "from=2026-07-01&alertname=X&namespace=prod&severity=critical&resolved=true";
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams(qs)));
  const [rows, count] = calls;
  assert.deepEqual(count.params.slice(0, 6), rows.params.slice(0, 6));
  const where = (sql: string) => sql.slice(sql.indexOf("WHERE")).replace(/\s+/g, " ");
  assert.ok(where(count.sql).startsWith(where(rows.sql).split(" ORDER BY")[0]));
});

test("total counts the matching rows and says whether it counted them all", async () => {
  const q = new DashboardQueries(stub([], (sql) => (sql.includes("count(*)") ? [{ n: 137 }] : [{ id: 1 }])));
  const out = await q.list(parseFilters(new URLSearchParams("")));
  assert.equal(out.total, 137);
  assert.equal(out.capped, false);
});

test("a count that reaches the cap reports itself as a floor", async () => {
  const q = new DashboardQueries(stub([], (sql) => (sql.includes("count(*)") ? [{ n: COUNT_CAP }] : [{ id: 1 }])));
  const out = await q.list(parseFilters(new URLSearchParams("")));
  assert.equal(out.total, COUNT_CAP);
  assert.equal(out.capped, true, "the page renders this as \"5,000+\"");
});

// The two queries run concurrently and share no snapshot, so an insert landing between them
// can return a count smaller than the page it is about to be printed under. "Showing 51–100
// of 84" is a number the reader cannot unsee.
test("total never falls below the rows the caller is already holding", async () => {
  const stale = PAGE_SIZE * 2 - 3; // a count taken before the rows this page is about to show
  const q = new DashboardQueries(
    stub([], (sql) =>
      sql.includes("count(*)") ? [{ n: stale }] : Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })))
  );
  const out = await q.list(parseFilters(new URLSearchParams("page=2")));
  assert.equal(out.total, PAGE_SIZE * 2, "one page of offset plus a full page of rows");
});

test("with no pool the list reports an empty, uncapped page instead of throwing", async () => {
  const out = await new DashboardQueries(null).list(parseFilters(new URLSearchParams("")));
  assert.deepEqual(out, { rows: [], hasMore: false, total: 0, capped: false });
});

// ---------- post-remediation verdicts ----------

// `status` is what the MCP call returned; `verdict` is what the cluster did about it. The
// dashboard could only ever see the first, which is how a restart that returned 200 and fixed
// nothing counted as a success.
test("detail joins each remediation to its verification check", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls, (sql) => (sql.includes("FROM incidents") ? [{ id: 7 }] : [])));
  await q.detail(7);

  const rem = calls.find((c) => c.sql.includes("FROM remediations"));
  assert.ok(rem, "no remediation query");
  assert.match(rem.sql, /LEFT JOIN remediation_checks/, "an inner join hides unapproved remediations");
  assert.match(rem.sql, /c\.verdict/);
  assert.match(rem.sql, /c\.detail AS verdict_detail/);
  // status and verdict must both survive — merging them is the bug this exists to prevent
  assert.match(rem.sql, /r\.status/);
});

test("overview counts what the checks concluded, over the same window", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).overview();
  const checks = calls.find((c) => c.sql.includes("FROM remediation_checks"));
  assert.ok(checks, "the verdicts are never queried");
  assert.deepEqual(checks.params, ["30 days"]);
  // NULL is kept as its own group rather than coalesced: a check still waiting is not a
  // verdict, and folding it into "inconclusive" reports an answer that was never given.
  assert.doesNotMatch(checks.sql, /coalesce\(verdict/);
});

test("a pending check is counted as pending, never as a verdict", async () => {
  const q = new DashboardQueries(
    stub([], (sql) =>
      sql.includes("FROM remediation_checks")
        ? [
            { verdict: "recovered", n: 4 },
            { verdict: "worse", n: 1 },
            { verdict: null, n: 3 },
          ]
        : []
    )
  );
  const o = await q.overview();
  assert.deepEqual(o.verdicts, { recovered: 4, worse: 1 });
  assert.equal(o.verdictsPending, 3);
  assert.equal(o.verdicts.null, undefined, "a NULL verdict must not become a bucket named null");
});

// ---------- the rail's badge count ----------

// Deliberately not the overview's "Open" figure: that one is bounded by the selected range,
// and a badge that shrank when someone switched to 24h would be reporting the control rather
// than the cluster.
test("the open count is every unresolved incident, whenever it fired", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls, () => [{ n: 17 }])).openIncidents();
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /resolved_at IS NULL/);
  assert.doesNotMatch(calls[0].sql, /interval/, "the badge is not bounded by the overview's range");
});

// An exact count over a growing table is a scan on the same 3-connection pool that serves
// alerts, and four digits in a nav badge is not a number anyone reads.
test("the open count is bounded", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).openIncidents();
  assert.match(calls[0].sql, new RegExp(`LIMIT ${NAV_COUNT_CAP + 1}`));
});

// It is asked for on EVERY page render, not just the overview — so it gets its own slot rather
// than riding along with a query that only the overview runs.
test("the open count is cached apart from the overview", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls, () => [{ n: 3 }]));
  assert.equal(await q.openIncidents(), 3);
  const after = calls.length;
  assert.equal(await q.openIncidents(), 3);
  assert.equal(calls.length, after, "a second call inside the TTL must issue no query");
});

test("with no pool the badge count is zero rather than a throw", async () => {
  assert.equal(await new DashboardQueries(null).openIncidents(), 0);
});

// A verdict belongs to a remediation's CHECK, two joins away from the incident. It is an
// EXISTS rather than a join on the outer query: an incident with three remediations must
// appear once, and joining would return it three times and break the page and the count in
// the same stroke.
test("the verdict filter is an EXISTS, not a join that would duplicate rows", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams("verdict=worse")));
  const rows = calls[0];
  assert.match(rows.sql, /EXISTS \(/);
  assert.match(rows.sql, /JOIN remediation_checks rc ON rc\.remediation_id = r\.id/);
  assert.doesNotMatch(rows.sql, /FROM incidents\s+JOIN/, "an outer join would duplicate an incident per remediation");
  assert.equal(rows.params[6], "worse", "the verdict is bound, never interpolated");
});

// The page and its count must filter identically or the summary describes a different set
// from the rows under it. One predicate, both queries.
test("the verdict reaches the count query too", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams("verdict=recovered")));
  const [rows, count] = calls;
  assert.match(count.sql, /EXISTS \(/);
  assert.equal(rows.params[6], "recovered");
  assert.equal(count.params[6], "recovered");
});

// LIMIT and OFFSET moved to $8/$9 when the verdict took $7. They stay last, which is what the
// pagination tests read them off.
test("adding the verdict did not disturb the limit and offset binds", async () => {
  const calls: Call[] = [];
  await new DashboardQueries(stub(calls)).list(parseFilters(new URLSearchParams("page=2")));
  assert.equal(calls[0].params.at(-2), PAGE_SIZE + 1);
  assert.equal(calls[0].params.at(-1), PAGE_SIZE);
  assert.match(calls[0].sql, /LIMIT \$8 OFFSET \$9/);
});
