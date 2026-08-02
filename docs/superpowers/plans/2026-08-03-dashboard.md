# Incident Dashboard (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, server-rendered incident dashboard on a second HTTP port inside the existing agent process, plus durable per-call LLM token accounting.

**Architecture:** A `src/dashboard/` module with no coupling to `SlackApp`, serving three pages from its own small Postgres pool. Everything renders to HTML strings from TypeScript template literals — no build step, no client framework, no new dependency. A separate `UsageStore` records one row per LLM call so cost history starts accumulating now, even though the cost view is phase 2.

**Tech Stack:** Node 24, TypeScript ESM (NodeNext), `node:http`, `pg` (already a dependency), `node:test` + tsx.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-03-dashboard-design.md`:

- **Zero new dependencies.** Server-rendered HTML from TypeScript template literals. No build step, no client framework.
- **All interpolated values must be HTML-escaped.** `rca` and `root_cause` are LLM output; `alertname` / `namespace` come from Alertmanager labels. Rendering either raw is XSS whose source is our own model.
- **The dashboard gets a dedicated `Pool` with `max: 3`**, not the agent's. Sharing the pool means one slow dashboard query can starve `storeIncident` of connections.
- **`statement_timeout = 3s`** on the dashboard pool's connections.
- **Mandatory `LIMIT` on every query. Page size 50, hard maximum 200.**
- **60-second in-memory TTL cache** for the aggregate numbers.
- **The dashboard is exempt from the "a config mistake must stop the pod" rule.** If the port fails to bind or no database is configured, log at `error` and continue startup.
- **Usage writes are best-effort**: a failed insert or backfill is logged and swallowed. Losing a cost data point must never fail an investigation.
- **All routes are `GET` and read-only.** No mutation endpoints in phase 1.
- `DASHBOARD_ENABLED` defaults to `false`; `DASHBOARD_PORT` defaults to `3001`.
- Node 24 required. Run `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH` before any npm command.
- Docs are written in English. Don't commit or push unless the task says to.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/004_llm_usage.sql` | The `llm_usage` table and its indexes |
| `src/agent/usage/index.ts` | `UsageStore` — records one row per LLM call, backfills `incident_id` |
| `src/agent/usage/index.test.ts` | Tests for the above against a stub pool |
| `src/dashboard/html.ts` | `esc()`, `fmtDate()`, `fmtPct()`, `fmtDuration()` — pure presentation primitives |
| `src/dashboard/html.test.ts` | Escaping (the security-relevant test) and formatters |
| `src/dashboard/svg.ts` | `barChart()` — inline SVG, no chart library |
| `src/dashboard/svg.test.ts` | Empty series, single point, normal series |
| `src/dashboard/filters.ts` | `parseFilters()` — query string → typed filter object, with the page-size clamp |
| `src/dashboard/filters.test.ts` | Defaults, clamping, malformed input |
| `src/dashboard/styles.ts` | The design system as one exported CSS string — tokens, type scale, components |
| `src/dashboard/views.ts` | `layout()` plus `overviewPage()`, `listPage()`, `detailPage()`, `errorPage()` |
| `src/dashboard/views.test.ts` | Renders on empty data, escapes RCA, emits the Slack deep link |
| `src/dashboard/queries.ts` | `DashboardQueries` — owns the dashboard pool, all SQL, the TTL cache |
| `src/dashboard/queries.test.ts` | SQL parameters and the LIMIT clamp, against a stub pool |
| `src/dashboard/server.ts` | `DashboardServer` — the listener, route matching, error handling |
| `src/dashboard/server.test.ts` | Route matching as a pure function |
| `index.ts` | Wire the dashboard into startup and shutdown |
| `src/config/index.ts` | `dashboard: { enabled, port }` |
| `src/agent/llm/types.ts` | `LLMResponse` gains optional `backend` and `route` |
| `src/agent/llm/router.ts` | Sets those two fields |
| `src/agent/index.ts` | Records usage per call; hands `UsageStore` to the incident store |
| `src/agent/incidents/index.ts` | Backfills `incident_id` after `store()` |

---

### Task 1: LLM usage persistence

Records one row per LLM call so cost history exists before the phase-2 cost view is built. Time-series data cannot be backfilled, which is why this ships in phase 1.

**Files:**
- Create: `migrations/004_llm_usage.sql`
- Create: `src/agent/usage/index.ts`
- Create: `src/agent/usage/index.test.ts`
- Modify: `src/agent/llm/types.ts` (add `backend`/`route` to `LLMResponse`)
- Modify: `src/agent/llm/router.ts` (set them on a successful response)
- Modify: `src/agent/index.ts` (record per call)
- Modify: `src/agent/incidents/index.ts` (backfill after insert)

**Interfaces:**
- Produces: `class UsageStore { constructor(pool: Pool | null); record(row: UsageRow): Promise<void>; linkToIncident(incidentId: number, threadTs: string): Promise<void> }` and `interface UsageRow { threadTs: string | null; backend: string | null; route: "light" | "heavy" | null; model: string | null; usage: TokenUsage }`
- Consumes: `TokenUsage` from `src/agent/llm/types.ts`, `Pool` from `pg`.

- [ ] **Step 1: Write the migration**

Create `migrations/004_llm_usage.sql`:

```sql
-- Per-call LLM token accounting. One row per chat() call, not per incident: the router
-- made "which backend costs what" a real question, and per-incident totals structurally
-- cannot answer it. incident_id is NULL at insert time (the incident row does not exist
-- yet) and is backfilled by IncidentMemory.store(); rows for conversation-mode replies
-- and failed runs stay NULL forever, which is correct rather than a gap.
CREATE TABLE IF NOT EXISTS llm_usage (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  incident_id            BIGINT REFERENCES incidents(id),
  thread_ts              TEXT,
  backend                TEXT,
  route                  TEXT,
  model                  TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_time    ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_backend ON llm_usage (backend, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_thread  ON llm_usage (thread_ts) WHERE incident_id IS NULL;
```

- [ ] **Step 2: Write the failing test**

Create `src/agent/usage/index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageStore } from "./index.js";

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

test("no pool configured is a no-op, not a crash", async () => {
  await assert.doesNotReject(() =>
    new UsageStore(null).record({
      threadTs: "t", backend: null, route: null, model: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
  );
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
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/agent/usage/index.ts`:

```ts
import type { Pool } from "pg";
import type { TokenUsage } from "../llm/types.js";
import logger, { errDetail } from "../../utils/logger/index.js";

export interface UsageRow {
  threadTs: string | null;
  backend: string | null;              // router backend name; null for the other providers
  route: "light" | "heavy" | null;
  model: string | null;
  usage: TokenUsage;
}

// One row per LLM call. Every method is best-effort: losing a cost data point must never
// fail the investigation that produced it, so nothing here throws.
export class UsageStore {
  constructor(private readonly pool: Pool | null) {}

  async record(row: UsageRow): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO llm_usage
           (thread_ts, backend, route, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.threadTs, row.backend, row.route, row.model,
          row.usage.inputTokens, row.usage.outputTokens,
          row.usage.cacheReadTokens, row.usage.cacheCreationTokens,
        ]
      );
    } catch (err) {
      logger.warn(`[usage] insert failed (cost data point lost, investigation unaffected): ${errDetail(err)}`);
    }
  }

  // Called after IncidentMemory.store() — the usage rows are written DURING the
  // investigation, the incident row only exists after it. `incident_id IS NULL` keeps a
  // second incident in the same Slack thread from claiming the first one's rows.
  async linkToIncident(incidentId: number, threadTs: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `UPDATE llm_usage SET incident_id = $1 WHERE thread_ts = $2 AND incident_id IS NULL`,
        [incidentId, threadTs]
      );
    } catch (err) {
      logger.warn(`[usage] backfill failed for incident ${incidentId}: ${errDetail(err)}`);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 6: Add attribution to `LLMResponse`**

In `src/agent/llm/types.ts`, extend the interface (additive — the other three clients are untouched):

```ts
export interface LLMResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
  // Which registered backend answered, and on which chain. Set only by RouterLLMClient —
  // the direct providers leave these undefined, and llm_usage stores NULL for them.
  backend?: string;
  route?: "light" | "heavy";
}
```

- [ ] **Step 7: Have the router set them**

In `src/agent/llm/router.ts`, inside `chat()`, the success branch currently reads:

```ts
        if (!failure) {
          // sticky only when we actually crossed into the heavy tier, not on a lateral hop
          if (route === "light" && i >= this.light.length && ctx) ctx.escalated = true;
          return res;
        }
```

Replace the `return res;` line with:

```ts
          return { ...res, backend: name, route };
```

- [ ] **Step 8: Record usage per call**

In `src/agent/index.ts`, the `if (response.usage) { ... }` block near line 191 already computes everything. Add the recording call immediately after `totalUsage = addUsage(...)`:

```ts
      if (response.usage) {
        totalUsage = addUsage(totalUsage, response.usage);
        void this.usage.record({
          threadTs: threadId,
          backend: response.backend ?? null,
          route: response.route ?? null,
          model: config.llm.model ?? null,
          usage: response.usage,
        });
        logger.debug(
```

Declare the field alongside the other stores (`private usage: UsageStore;`), initialise it to `new UsageStore(null)` in the constructor next to `this.incidents = new IncidentMemory(null)`, and assign `this.usage = new UsageStore(pool)` in `initialize()` right after `this.remediations = new RemediationStore(pool)`.

- [ ] **Step 9: Backfill `incident_id`**

`IncidentMemory.store()` already returns the new id and receives `slack?: { channel, threadTs }`. It must not import `UsageStore` (that would invert the dependency); instead accept an optional linker. Change the constructor to:

```ts
  constructor(
    private readonly pool: Pool | null,
    private readonly onStored?: (incidentId: number, threadTs: string) => void
  ) {}
```

and immediately before `store()` returns the id:

```ts
      const id = Number(rows[0].id);
      // fire-and-forget: links this investigation's llm_usage rows to the incident they
      // produced. Best-effort by contract — see UsageStore.
      if (slack?.threadTs) this.onStored?.(id, slack.threadTs);
      return id;
```

In `src/agent/index.ts`'s `initialize()`, wire them together:

```ts
      this.usage = new UsageStore(pool);
      this.incidents = new IncidentMemory(pool, (id, ts) => void this.usage.linkToIncident(id, ts));
```

- [ ] **Step 10: Build and run the whole suite**

```bash
npm run build && npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: build clean, `fail 0`.

- [ ] **Step 11: Commit**

```bash
git add migrations/004_llm_usage.sql src/agent/usage/ src/agent/llm/types.ts \
        src/agent/llm/router.ts src/agent/index.ts src/agent/incidents/index.ts
git commit -m "feat(usage): persist per-call LLM token usage

Time-series data cannot be backfilled, so the table starts collecting in
phase 1 even though the cost view is phase 2. Per-call rows rather than
per-incident columns because the router made per-backend cost a real
question that totals cannot answer.

incident_id is backfilled after storeIncident: usage rows are written during
the investigation, the incident row only exists once it finishes."
```

---

### Task 2: Presentation primitives — escaping, formatting, charts

The escaping helper is the security-relevant unit in this whole plan. Everything the dashboard renders passes through it.

**Files:**
- Create: `src/dashboard/html.ts`, `src/dashboard/html.test.ts`
- Create: `src/dashboard/svg.ts`, `src/dashboard/svg.test.ts`

**Interfaces:**
- Produces: `esc(v: unknown): string`, `fmtDate(d: Date | string | null): string`, `fmtPct(n: number, d: number): string`, `fmtInt(n: number): string`, and `barChart(points: { label: string; value: number }[], opts?: { width?: number; height?: number }): string`

- [ ] **Step 1: Write the failing tests**

Create `src/dashboard/html.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, fmtDate, fmtPct, fmtInt } from "./html.js";

// THE security test. `rca` and `root_cause` are LLM output — arbitrary text that can
// contain markup — and alertname/namespace come from Alertmanager labels. Rendering
// either raw is cross-site scripting whose source is our own model.
test("esc neutralises every character that can break out of HTML", () => {
  assert.equal(esc(`<script>alert(1)</script>`), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(esc(`" onmouseover="x`), "&quot; onmouseover=&quot;x");
  assert.equal(esc(`' & '`), "&#39; &amp; &#39;");
  // ampersand must be escaped FIRST or the other entities get double-escaped
  assert.equal(esc(`&lt;`), "&amp;lt;");
});

test("esc renders null and undefined as empty, never the string 'null'", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("fmtDate is readable and handles the missing case", () => {
  assert.equal(fmtDate(new Date("2026-07-28T23:48:28.872Z")), "2026-07-28 23:48");
  assert.equal(fmtDate("2026-07-28T23:48:28.872Z"), "2026-07-28 23:48");
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("not-a-date"), "—");
});

test("fmtPct never divides by zero", () => {
  assert.equal(fmtPct(3, 4), "75%");
  assert.equal(fmtPct(0, 0), "—");
  assert.equal(fmtPct(1, 3), "33%");
});

test("fmtInt groups thousands", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtInt(0), "0");
});
```

Create `src/dashboard/svg.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { barChart } from "./svg.js";

test("barChart renders one rect per point", () => {
  const svg = barChart([
    { label: "W1", value: 3 },
    { label: "W2", value: 7 },
    { label: "W3", value: 5 },
  ]);
  assert.equal((svg.match(/<rect/g) ?? []).length, 3);
  assert.match(svg, /<svg[^>]+viewBox=/);
});

// An empty series is the normal state of a fresh deployment, not an edge case.
test("barChart on an empty series renders a placeholder, not a broken SVG", () => {
  const svg = barChart([]);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(svg, /no data/i);
});

// A single point makes max === min; a naive scale divides by zero here.
test("barChart survives a single point and an all-zero series", () => {
  for (const points of [[{ label: "W1", value: 4 }], [{ label: "A", value: 0 }, { label: "B", value: 0 }]]) {
    const svg = barChart(points);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
});

test("barChart escapes its labels", () => {
  assert.match(barChart([{ label: `<b>`, value: 1 }]), /&lt;b&gt;/);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './html.js'`.

- [ ] **Step 3: Implement `html.ts`**

```ts
// Every value the dashboard interpolates goes through esc(). The RCA text is LLM output
// and the labels come from Alertmanager, so neither is trusted input.
const ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  // the character class puts & first only for readability — the regex replaces each
  // character exactly once, so double-escaping is impossible regardless of order
  return String(v).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = d instanceof Date ? d : new Date(d);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return "—";
  const iso = t.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function fmtPct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
```

- [ ] **Step 4: Implement `svg.ts`**

```ts
import { esc } from "./html.js";

export interface Point {
  label: string;
  value: number;
}

// A hand-rolled bar chart. Forty lines beats a charting dependency for one chart, and it
// renders server-side so the page needs no JavaScript at all.
export function barChart(points: Point[], opts: { width?: number; height?: number } = {}): string {
  const w = opts.width ?? 720;
  const h = opts.height ?? 180;
  const pad = { top: 8, right: 8, bottom: 22, left: 8 };
  const plotH = h - pad.top - pad.bottom;
  const plotW = w - pad.left - pad.right;

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="no data">` +
      `<text x="${w / 2}" y="${h / 2}" class="chart-empty" text-anchor="middle">no data yet</text></svg>`;
  }

  // max || 1 keeps an all-zero series (and therefore a fresh install) from dividing by zero
  const max = Math.max(...points.map((p) => p.value)) || 1;
  const slot = plotW / points.length;
  const barW = Math.max(2, slot * 0.62);

  const bars = points
    .map((p, i) => {
      const barH = Math.round((p.value / max) * plotH);
      const x = Math.round(pad.left + i * slot + (slot - barW) / 2);
      const y = pad.top + plotH - barH;
      return (
        `<rect x="${x}" y="${y}" width="${Math.round(barW)}" height="${barH}" rx="2" class="chart-bar">` +
        `<title>${esc(p.label)}: ${p.value}</title></rect>` +
        `<text x="${Math.round(x + barW / 2)}" y="${h - 6}" class="chart-label" text-anchor="middle">${esc(p.label)}</text>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="incidents per week">${bars}</svg>`;
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/html.ts src/dashboard/html.test.ts src/dashboard/svg.ts src/dashboard/svg.test.ts
git commit -m "feat(dashboard): HTML escaping, formatters and an inline SVG bar chart

esc() is the security boundary: RCA text is LLM output and the labels come
from Alertmanager, so nothing rendered is trusted input."
```

---

### Task 3: Query-string filters

**Files:**
- Create: `src/dashboard/filters.ts`, `src/dashboard/filters.test.ts`

**Interfaces:**
- Produces: `interface Filters { from: Date | null; to: Date | null; alertname: string | null; namespace: string | null; severity: string | null; resolved: boolean | null; page: number; pageSize: number }` and `parseFilters(params: URLSearchParams): Filters`, `PAGE_SIZE_MAX = 200`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/filters.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFilters, PAGE_SIZE_MAX } from "./filters.js";

const f = (qs: string) => parseFilters(new URLSearchParams(qs));

test("an empty query string yields the defaults", () => {
  const r = f("");
  assert.deepEqual(
    { from: r.from, to: r.to, alertname: r.alertname, namespace: r.namespace, severity: r.severity, resolved: r.resolved },
    { from: null, to: null, alertname: null, namespace: null, severity: null, resolved: null }
  );
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 50);
});

test("filters are read into typed fields", () => {
  const r = f("alertname=KubePodCrashLooping&namespace=prod&severity=critical&resolved=true");
  assert.equal(r.alertname, "KubePodCrashLooping");
  assert.equal(r.namespace, "prod");
  assert.equal(r.severity, "critical");
  assert.equal(r.resolved, true);
});

test("resolved distinguishes false from absent", () => {
  assert.equal(f("resolved=false").resolved, false);
  assert.equal(f("").resolved, null);
  assert.equal(f("resolved=").resolved, null);
});

// The hard cap is a safety rail, not a preference: without it a crafted URL runs an
// unbounded query on the same event loop that handles alerts.
test("pageSize is clamped to the hard maximum and never below 1", () => {
  assert.equal(f("pageSize=100000").pageSize, PAGE_SIZE_MAX);
  assert.equal(f("pageSize=0").pageSize, 1);
  assert.equal(f("pageSize=-5").pageSize, 1);
  assert.equal(f("pageSize=abc").pageSize, 50);
});

test("page is at least 1", () => {
  assert.equal(f("page=0").page, 1);
  assert.equal(f("page=-3").page, 1);
  assert.equal(f("page=abc").page, 1);
  assert.equal(f("page=7").page, 7);
});

// A malformed date must not become an Invalid Date that Postgres rejects at query time.
test("malformed dates are dropped, not passed through", () => {
  assert.equal(f("from=not-a-date").from, null);
  assert.equal(f("from=2026-07-01")!.from!.toISOString().slice(0, 10), "2026-07-01");
});

test("blank values are treated as absent", () => {
  const r = f("alertname=&namespace=%20%20");
  assert.equal(r.alertname, null);
  assert.equal(r.namespace, null);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './filters.js'`.

- [ ] **Step 3: Implement `filters.ts`**

```ts
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export interface Filters {
  from: Date | null;
  to: Date | null;
  alertname: string | null;
  namespace: string | null;
  severity: string | null;
  resolved: boolean | null;
  page: number;
  pageSize: number;
}

const str = (p: URLSearchParams, k: string): string | null => {
  const v = p.get(k)?.trim();
  return v ? v : null;
};

const date = (p: URLSearchParams, k: string): Date | null => {
  const v = str(p, k);
  if (!v) return null;
  const d = new Date(v);
  // an Invalid Date would reach Postgres and error at query time — drop it here instead
  return Number.isFinite(d.getTime()) ? d : null;
};

const int = (p: URLSearchParams, k: string, fallback: number): number => {
  const n = parseInt(p.get(k) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export function parseFilters(params: URLSearchParams): Filters {
  const resolved = str(params, "resolved");
  return {
    from: date(params, "from"),
    to: date(params, "to"),
    alertname: str(params, "alertname"),
    namespace: str(params, "namespace"),
    severity: str(params, "severity"),
    // absent means "either" — distinct from an explicit false
    resolved: resolved === null ? null : resolved === "true",
    page: Math.max(1, int(params, "page", 1)),
    // the clamp is a safety rail: an unbounded LIMIT runs on the same event loop as
    // alert handling, and there is no auth in front of this
    pageSize: Math.min(PAGE_SIZE_MAX, Math.max(1, int(params, "pageSize", PAGE_SIZE_DEFAULT))),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/filters.ts src/dashboard/filters.test.ts
git commit -m "feat(dashboard): typed query-string filters with a hard page-size cap"
```

---

### Task 4: The query layer

**Files:**
- Create: `src/dashboard/queries.ts`, `src/dashboard/queries.test.ts`

**Interfaces:**
- Consumes: `Filters` from `./filters.js`, `createPool` from `../db/pool.js`
- Produces:
  - `interface IncidentRow { id: number; created_at: Date; resolved_at: Date | null; alertname: string; namespace: string | null; severity: string | null; confidence: string | null; root_cause: string | null }`
  - `interface IncidentDetail extends IncidentRow { rca: string; channel: string | null; thread_ts: string | null }`
  - `interface RemediationRow { action: string; params: Record<string, unknown>; status: string; approved_by: string | null; result: string | null; created_at: Date; executed_at: Date | null }`
  - `interface FeedbackRow { slack_user: string | null; confirmed_root_cause: string | null; action_taken: string | null; outcome: string | null; created_at: Date }`
  - `interface Overview { weekly: { label: string; value: number }[]; recurring: { alertname: string; namespace: string | null; n: number; last_seen: Date }[]; totalIncidents: number; resolvedIncidents: number; remediationSucceeded: number; remediationFailed: number; feedback: Record<string, number> }`
  - `class DashboardQueries { constructor(pool?: Pool | null); get enabled(): boolean; overview(): Promise<Overview>; list(f: Filters): Promise<{ rows: IncidentRow[]; hasMore: boolean }>; detail(id: number): Promise<{ incident: IncidentDetail; remediations: RemediationRow[]; feedback: FeedbackRow[] } | null>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/queries.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './queries.js'`.

- [ ] **Step 3: Implement `queries.ts`**

```ts
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import type { Filters } from "./filters.js";

export interface IncidentRow {
  id: number; created_at: Date; resolved_at: Date | null;
  alertname: string; namespace: string | null;
  severity: string | null; confidence: string | null; root_cause: string | null;
}
export interface IncidentDetail extends IncidentRow {
  rca: string; channel: string | null; thread_ts: string | null;
}
export interface RemediationRow {
  action: string; params: Record<string, unknown>; status: string;
  approved_by: string | null; result: string | null;
  created_at: Date; executed_at: Date | null;
}
export interface FeedbackRow {
  slack_user: string | null; confirmed_root_cause: string | null;
  action_taken: string | null; outcome: string | null; created_at: Date;
}
export interface Overview {
  weekly: { label: string; value: number }[];
  recurring: { alertname: string; namespace: string | null; n: number; last_seen: Date }[];
  totalIncidents: number; resolvedIncidents: number;
  remediationSucceeded: number; remediationFailed: number;
  feedback: Record<string, number>;
}

const CACHE_TTL_MS = 60_000;
const WINDOW = "30 days";

export class DashboardQueries {
  private readonly pool: Pool | null;
  private cache: { at: number; value: Overview } | null = null;

  // A pool of its own, max 3. Sharing the agent's pool means a slow dashboard query can
  // starve storeIncident of connections — the investigation finishes and the result is
  // silently lost. This bounds the worst case to "the dashboard is slow".
  constructor(pool?: Pool | null) {
    if (pool !== undefined) {
      this.pool = pool;
    } else if (config.incidents.enabled) {
      this.pool = createPool(3);
      this.pool.on("error", (err: Error) => logger.error(`[dashboard] pool error: ${err.message}`));
      // enforced by Postgres, so a runaway query dies at the server rather than
      // occupying the event loop that also handles alerts
      this.pool.on("connect", (c) => {
        void c.query("SET statement_timeout = 3000").catch(() => {});
      });
    } else {
      this.pool = null;
    }
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  async overview(): Promise<Overview> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const empty: Overview = {
      weekly: [], recurring: [], totalIncidents: 0, resolvedIncidents: 0,
      remediationSucceeded: 0, remediationFailed: 0, feedback: {},
    };
    if (!this.pool) return empty;

    const [weekly, recurring, totals, remediation, feedback] = await Promise.all([
      this.pool.query(
        `SELECT to_char(date_trunc('week', created_at), 'MM-DD') AS label, count(*)::int AS n
           FROM incidents WHERE created_at >= now() - interval '12 weeks'
          GROUP BY 1 ORDER BY 1 LIMIT 12`
      ),
      this.pool.query(
        `SELECT alertname, namespace, count(*)::int AS n, max(created_at) AS last_seen
           FROM incidents WHERE created_at >= now() - interval '${WINDOW}'
          GROUP BY alertname, namespace ORDER BY n DESC, last_seen DESC LIMIT 10`
      ),
      this.pool.query(
        `SELECT count(*)::int AS total, count(resolved_at)::int AS resolved
           FROM incidents WHERE created_at >= now() - interval '${WINDOW}'`
      ),
      this.pool.query(
        `SELECT status, count(*)::int AS n FROM remediations
          WHERE created_at >= now() - interval '${WINDOW}' GROUP BY status`
      ),
      this.pool.query(
        `SELECT coalesce(outcome, 'unknown') AS outcome, count(*)::int AS n
           FROM incident_feedback WHERE created_at >= now() - interval '${WINDOW}' GROUP BY 1`
      ),
    ]);

    const byStatus = Object.fromEntries(remediation.rows.map((r: any) => [r.status, r.n]));
    const value: Overview = {
      weekly: weekly.rows.map((r: any) => ({ label: r.label, value: r.n })),
      recurring: recurring.rows,
      totalIncidents: totals.rows[0]?.total ?? 0,
      resolvedIncidents: totals.rows[0]?.resolved ?? 0,
      remediationSucceeded: byStatus.succeeded ?? 0,
      remediationFailed: byStatus.failed ?? 0,
      feedback: Object.fromEntries(feedback.rows.map((r: any) => [r.outcome, r.n])),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async list(f: Filters): Promise<{ rows: IncidentRow[]; hasMore: boolean }> {
    if (!this.pool) return { rows: [], hasMore: false };
    // over-fetch by one: tells us whether a next page exists without a second COUNT(*)
    const limit = f.pageSize + 1;
    const { rows } = await this.pool.query(
      `SELECT id, created_at, resolved_at, alertname, namespace, severity, confidence, root_cause
         FROM incidents
        WHERE ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at <  $2)
          AND ($3::text IS NULL OR alertname = $3)
          AND ($4::text IS NULL OR namespace = $4)
          AND ($5::text IS NULL OR severity  = $5)
          AND ($6::boolean IS NULL OR (resolved_at IS NOT NULL) = $6)
        ORDER BY created_at DESC
        LIMIT $7 OFFSET $8`,
      [f.from, f.to, f.alertname, f.namespace, f.severity, f.resolved, limit, (f.page - 1) * f.pageSize]
    );
    const hasMore = rows.length > f.pageSize;
    return { rows: hasMore ? rows.slice(0, f.pageSize) : rows, hasMore };
  }

  async detail(id: number) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT id, created_at, resolved_at, alertname, namespace, severity, confidence,
              root_cause, rca, channel, thread_ts
         FROM incidents WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return null;
    const [remediations, feedback] = await Promise.all([
      this.pool.query(
        `SELECT action, params, status, approved_by, result, created_at, executed_at
           FROM remediations WHERE incident_id = $1 ORDER BY created_at LIMIT 50`,
        [id]
      ),
      this.pool.query(
        `SELECT slack_user, confirmed_root_cause, action_taken, outcome, created_at
           FROM incident_feedback WHERE incident_id = $1 ORDER BY created_at LIMIT 50`,
        [id]
      ),
    ]);
    return {
      incident: rows[0] as IncidentDetail,
      remediations: remediations.rows as RemediationRow[],
      feedback: feedback.rows as FeedbackRow[],
    };
  }

  async close(): Promise<void> {
    try {
      await this.pool?.end();
    } catch (err) {
      logger.warn(`[dashboard] pool close failed: ${errDetail(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/queries.ts src/dashboard/queries.test.ts
git commit -m "feat(dashboard): query layer with its own capped pool and a 60s overview cache

Dedicated max-3 pool with a 3s statement_timeout: sharing the agent's pool
would let a slow dashboard query starve storeIncident of connections."
```

---

### Task 5: Design system and page rendering

This is the visual work. The stack is fixed by the spec — server-rendered HTML, no dependency — so the quality has to come from the CSS, which is specified concretely below rather than left to taste.

**Files:**
- Create: `src/dashboard/styles.ts`
- Create: `src/dashboard/views.ts`, `src/dashboard/views.test.ts`

**Interfaces:**
- Consumes: `esc`, `fmtDate`, `fmtPct`, `fmtInt` from `./html.js`; `barChart` from `./svg.js`; every row type from `./queries.js`; `Filters` from `./filters.js`
- Produces: `STYLES: string`, `layout(title: string, body: string): string`, `overviewPage(o: Overview, recent: IncidentRow[]): string`, `listPage(rows: IncidentRow[], f: Filters, hasMore: boolean): string`, `detailPage(d: { incident: IncidentDetail; remediations: RemediationRow[]; feedback: FeedbackRow[] }): string`, `errorPage(title: string, message: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/views.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage, overviewPage, errorPage, layout } from "./views.js";
import { parseFilters } from "./filters.js";
import type { IncidentDetail, IncidentRow, Overview } from "./queries.js";

const row: IncidentRow = {
  id: 1, created_at: new Date("2026-07-28T23:48:00Z"), resolved_at: null,
  alertname: "KubernetesContainerOomKiller", namespace: "metallb-system",
  severity: "warning", confidence: "high", root_cause: "container hit its memory limit",
};
const emptyOverview: Overview = {
  weekly: [], recurring: [], totalIncidents: 0, resolvedIncidents: 0,
  remediationSucceeded: 0, remediationFailed: 0, feedback: {},
};

test("layout emits a complete, self-contained document with inline styles", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/);
  // no build step and no CDN: every asset must be inline or the page breaks
  assert.doesNotMatch(html, /<script src=|<link[^>]+href="http/);
});

// The whole point of phase 1 is that a fresh deployment is the normal first experience.
test("every page renders on empty data without throwing", () => {
  assert.doesNotThrow(() => overviewPage(emptyOverview, []));
  assert.doesNotThrow(() => listPage([], parseFilters(new URLSearchParams("")), false));
  assert.match(listPage([], parseFilters(new URLSearchParams("")), false), /no incidents/i);
});

// THE security test at the render layer. rca is LLM output.
test("detailPage escapes the RCA instead of emitting it as markup", () => {
  const incident: IncidentDetail = {
    ...row, rca: `<img src=x onerror="alert(1)">`, channel: "C1", thread_ts: "1785282508.001",
  };
  const html = detailPage({ incident, remediations: [], feedback: [] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("detailPage escapes the alert labels too", () => {
  const incident: IncidentDetail = {
    ...row, alertname: `<b>X</b>`, rca: "fine", channel: null, thread_ts: null,
  };
  assert.doesNotMatch(detailPage({ incident, remediations: [], feedback: [] }), /<b>X<\/b>/);
});

// The dashboard complements Slack rather than replacing it; the link is the join.
test("detailPage links back to the Slack thread when it knows one", () => {
  const incident: IncidentDetail = { ...row, rca: "x", channel: "C123", thread_ts: "1785282508.001" };
  assert.match(
    detailPage({ incident, remediations: [], feedback: [] }),
    /slack\.com\/app_redirect\?channel=C123&amp;message_ts=1785282508\.001/
  );
});

test("detailPage omits the Slack link when the incident has no thread", () => {
  const incident: IncidentDetail = { ...row, rca: "x", channel: null, thread_ts: null };
  assert.doesNotMatch(detailPage({ incident, remediations: [], feedback: [] }), /app_redirect/);
});

test("listPage keeps the active filters in the form and in the pager link", () => {
  const f = parseFilters(new URLSearchParams("alertname=KubePodCrashLooping&page=2"));
  const html = listPage([row], f, true);
  assert.match(html, /value="KubePodCrashLooping"/);
  assert.match(html, /page=3/);
});

test("errorPage states the problem without leaking a stack trace", () => {
  const html = errorPage("Database unavailable", "connection refused");
  assert.match(html, /Database unavailable/);
  assert.match(html, /connection refused/);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './views.js'`.

- [ ] **Step 3: Implement `styles.ts` — the design system**

Design decisions, fixed here so they are not re-invented per page:

- **Type scale** 1.25 ratio off a 14px base. Dense tables need small type; the five headline numbers need to dominate.
- **Spacing** on a 4px grid. Every margin and padding is a multiple.
- **Colour** as semantic tokens, never literals in components. Severity colours match the Slack message emoji (critical red, warning amber, info blue) so the two surfaces read as one system.
- **Light and dark** via `prefers-color-scheme`. Ops screens are often dark; long RCA prose reads better light. Supporting both is a dozen lines.
- **System font stack** — zero network requests, which also keeps the page working with no egress.
- **Focus rings are never removed.** Keyboard navigation is a baseline, not a nicety.

```ts
// One stylesheet, inlined into every page. No build step and no CDN, so everything the
// page needs must be in the document. Components read only from the tokens at the top —
// never hard-code a colour below :root.
export const STYLES = `
:root {
  --fs-xs: .75rem; --fs-sm: .875rem; --fs-base: 1rem;
  --fs-lg: 1.25rem; --fs-xl: 1.75rem; --fs-metric: 2.5rem;
  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem;
  --sp-4: 1rem; --sp-6: 1.5rem; --sp-8: 2rem;
  --radius: 8px; --maxw: 1200px;

  --bg: #fbfbfd; --surface: #fff; --surface-2: #f4f4f7;
  --border: #e4e4e9; --text: #1a1a1f; --text-dim: #6b6b76;
  --accent: #3b5bdb;
  --critical: #d63939; --warning: #d99400; --info: #3b7cd6; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121216; --surface: #1a1a20; --surface-2: #22222a;
    --border: #2a2a33; --text: #e8e8ed; --text-dim: #9a9aa5;
    --accent: #7c93f5;
    --critical: #f06565; --warning: #e8b04b; --info: #6ba6f5; --ok: #4fc384;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font); font-size: var(--fs-sm); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

header.top {
  position: sticky; top: 0; z-index: 10;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: var(--sp-3) var(--sp-6);
  display: flex; align-items: baseline; gap: var(--sp-6);
}
header.top .brand { font-weight: 650; font-size: var(--fs-base); letter-spacing: -.01em; }
header.top nav { display: flex; gap: var(--sp-4); }
header.top nav a { color: var(--text-dim); font-weight: 500; }
header.top nav a:hover, header.top nav a[aria-current] { color: var(--text); text-decoration: none; }

main { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-8) var(--sp-6); }
h1 { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -.02em; margin: 0 0 var(--sp-6); }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: var(--sp-8) 0 var(--sp-4); }

.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--sp-4); }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4) var(--sp-4) var(--sp-3); }
.metric .label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); }
.metric .value { font-size: var(--fs-metric); font-weight: 620; letter-spacing: -.03em; line-height: 1.1; margin-top: var(--sp-2); font-variant-numeric: tabular-nums; }
.metric .sub { font-size: var(--fs-xs); color: var(--text-dim); }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); }

table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); font-weight: 600; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.num { font-variant-numeric: tabular-nums; }
td.when { color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

.pill { display: inline-block; font-size: var(--fs-xs); font-weight: 600; padding: 2px var(--sp-2); border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.pill.critical { color: var(--critical); }
.pill.warning  { color: var(--warning); }
.pill.info     { color: var(--info); }
.pill.ok, .pill.succeeded, .pill.resolved { color: var(--ok); }
.pill.failed, .pill.rejected { color: var(--critical); }
.pill.proposed, .pill.approved, .pill.executing { color: var(--text-dim); }

form.filters { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: end; margin-bottom: var(--sp-4); }
form.filters label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-dim); }
form.filters input, form.filters select {
  font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: var(--sp-2) var(--sp-3); min-width: 150px;
}
form.filters button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: #fff; border: 0;
  border-radius: 6px; padding: var(--sp-2) var(--sp-4);
}
form.filters button:hover { filter: brightness(1.08); }

.rca { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-sm); line-height: 1.65; }
code, .mono { font-family: var(--mono); font-size: .92em; }

.empty { text-align: center; color: var(--text-dim); padding: var(--sp-8); border: 1px dashed var(--border); border-radius: var(--radius); }
.pager { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); }
.meta { color: var(--text-dim); font-size: var(--fs-xs); }

.chart { width: 100%; height: auto; display: block; }
.chart-bar { fill: var(--accent); }
.chart-bar:hover { filter: brightness(1.15); }
.chart-label, .chart-empty { fill: var(--text-dim); font-size: 10px; font-family: var(--font); }
`;
```

- [ ] **Step 4: Implement `views.ts`**

```ts
import { esc, fmtDate, fmtInt, fmtPct } from "./html.js";
import { barChart } from "./svg.js";
import { STYLES } from "./styles.js";
import type { Filters } from "./filters.js";
import type { FeedbackRow, IncidentDetail, IncidentRow, Overview, RemediationRow } from "./queries.js";

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — DevOps AI Agent</title>
<style>${STYLES}</style>
</head><body>
<header class="top">
  <span class="brand">DevOps AI Agent</span>
  <nav><a href="/">Overview</a><a href="/incidents">Incidents</a></nav>
</header>
<main>${body}</main>
</body></html>`;
}

const severityPill = (s: string | null): string =>
  s ? `<span class="pill ${esc(s)}">${esc(s)}</span>` : `<span class="meta">—</span>`;

const statusPill = (s: string): string => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

const metric = (label: string, value: string, sub = ""): string =>
  `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>` +
  (sub ? `<div class="sub">${esc(sub)}</div>` : "") + `</div>`;

function incidentTable(rows: IncidentRow[]): string {
  if (rows.length === 0) return `<p class="empty">No incidents in this range yet.</p>`;
  const body = rows
    .map(
      (r) => `<tr>
      <td class="when">${esc(fmtDate(r.created_at))}</td>
      <td><a href="/incidents/${r.id}">${esc(r.alertname)}</a><div class="meta">${esc(r.root_cause ?? "")}</div></td>
      <td>${esc(r.namespace ?? "—")}</td>
      <td>${severityPill(r.severity)}</td>
      <td>${r.resolved_at ? `<span class="pill resolved">resolved</span>` : `<span class="meta">firing</span>`}</td>
    </tr>`
    )
    .join("");
  return `<table><thead><tr>
      <th>When</th><th>Alert</th><th>Namespace</th><th>Severity</th><th>State</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

export function overviewPage(o: Overview, recent: IncidentRow[]): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  const recurring =
    o.recurring.length === 0
      ? `<p class="empty">Nothing has recurred yet.</p>`
      : `<table><thead><tr><th>Alert</th><th>Namespace</th><th>Count</th><th>Last seen</th></tr></thead><tbody>` +
        o.recurring
          .map(
            (r) => `<tr><td>${esc(r.alertname)}</td><td>${esc(r.namespace ?? "—")}</td>` +
              `<td class="num">${fmtInt(r.n)}</td><td class="when">${esc(fmtDate(r.last_seen))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  return layout(
    "Overview",
    `<h1>Overview <span class="meta">· last 30 days</span></h1>
     <div class="metrics">
       ${metric("Incidents", fmtInt(o.totalIncidents))}
       ${metric("Resolved", fmtPct(o.resolvedIncidents, o.totalIncidents), `${o.resolvedIncidents} of ${o.totalIncidents}`)}
       ${metric("Remediation success", fmtPct(o.remediationSucceeded, remediationTotal), `${o.remediationSucceeded} of ${remediationTotal}`)}
       ${metric("Feedback received", fmtInt(feedbackTotal))}
       ${metric("Confirmed resolved", fmtInt(o.feedback.resolved ?? 0), "by on-call")}
     </div>
     <h2>Incidents per week</h2>
     <div class="card">${barChart(o.weekly)}</div>
     <h2>Most recurring</h2>
     ${recurring}
     <h2>Recent incidents</h2>
     ${incidentTable(recent)}`
  );
}

export function listPage(rows: IncidentRow[], f: Filters, hasMore: boolean): string {
  const qs = (page: number): string => {
    const p = new URLSearchParams();
    if (f.from) p.set("from", f.from.toISOString().slice(0, 10));
    if (f.to) p.set("to", f.to.toISOString().slice(0, 10));
    if (f.alertname) p.set("alertname", f.alertname);
    if (f.namespace) p.set("namespace", f.namespace);
    if (f.severity) p.set("severity", f.severity);
    if (f.resolved !== null) p.set("resolved", String(f.resolved));
    p.set("page", String(page));
    return `/incidents?${p.toString()}`;
  };

  const sel = (v: string, cur: string | null, label: string): string =>
    `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;

  return layout(
    "Incidents",
    `<h1>Incidents</h1>
     <form class="filters" method="get" action="/incidents">
       <label>From<input type="date" name="from" value="${esc(f.from ? f.from.toISOString().slice(0, 10) : "")}"></label>
       <label>To<input type="date" name="to" value="${esc(f.to ? f.to.toISOString().slice(0, 10) : "")}"></label>
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"></label>
       <label>Severity<select name="severity">
         ${sel("", f.severity, "any")}${sel("critical", f.severity, "critical")}${sel("warning", f.severity, "warning")}${sel("info", f.severity, "info")}
       </select></label>
       <label>State<select name="resolved">
         ${sel("", f.resolved === null ? "" : String(f.resolved), "any")}
         ${sel("true", f.resolved === null ? "" : String(f.resolved), "resolved")}
         ${sel("false", f.resolved === null ? "" : String(f.resolved), "firing")}
       </select></label>
       <button type="submit">Filter</button>
     </form>
     ${incidentTable(rows)}
     <div class="pager">
       ${f.page > 1 ? `<a href="${esc(qs(f.page - 1))}">← Previous</a>` : ""}
       ${hasMore ? `<a href="${esc(qs(f.page + 1))}">Next →</a>` : ""}
     </div>`
  );
}

export function detailPage(d: {
  incident: IncidentDetail;
  remediations: RemediationRow[];
  feedback: FeedbackRow[];
}): string {
  const i = d.incident;
  // app_redirect needs no workspace domain, so the deep link costs no configuration
  const slack =
    i.channel && i.thread_ts
      ? `<a href="${esc(`https://slack.com/app_redirect?channel=${i.channel}&message_ts=${i.thread_ts}`)}">Open the Slack thread →</a>`
      : "";

  const remediations =
    d.remediations.length === 0
      ? `<p class="empty">No remediation was proposed for this incident.</p>`
      : `<table><thead><tr><th>Action</th><th>Status</th><th>Approved by</th><th>Result</th><th>Executed</th></tr></thead><tbody>` +
        d.remediations
          .map(
            (r) => `<tr><td class="mono">${esc(r.action)}<div class="meta">${esc(JSON.stringify(r.params))}</div></td>` +
              `<td>${statusPill(r.status)}</td><td>${esc(r.approved_by ?? "—")}</td>` +
              `<td>${esc(r.result ?? "—")}</td><td class="when">${esc(fmtDate(r.executed_at))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  const feedback =
    d.feedback.length === 0
      ? `<p class="empty">No on-call feedback recorded.</p>`
      : `<table><thead><tr><th>From</th><th>Confirmed root cause</th><th>Action taken</th><th>Outcome</th><th>When</th></tr></thead><tbody>` +
        d.feedback
          .map(
            (r) => `<tr><td>${esc(r.slack_user ?? "—")}</td><td>${esc(r.confirmed_root_cause ?? "—")}</td>` +
              `<td>${esc(r.action_taken ?? "—")}</td><td>${r.outcome ? statusPill(r.outcome) : "—"}</td>` +
              `<td class="when">${esc(fmtDate(r.created_at))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  return layout(
    i.alertname,
    `<h1>${esc(i.alertname)}</h1>
     <div class="metrics">
       ${metric("Namespace", i.namespace ?? "—")}
       ${metric("Confidence", i.confidence ?? "—")}
       ${metric("Fired", fmtDate(i.created_at))}
       ${metric("Resolved", fmtDate(i.resolved_at))}
     </div>
     <p style="margin-top:var(--sp-4)">${severityPill(i.severity)} ${slack}</p>
     <h2>Root cause analysis</h2>
     <div class="rca">${esc(i.rca)}</div>
     <h2>Remediation</h2>
     ${remediations}
     <h2>On-call feedback</h2>
     ${feedback}`
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="empty">${esc(message)}</p>`);
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/styles.ts src/dashboard/views.ts src/dashboard/views.test.ts
git commit -m "feat(dashboard): design system and the three page renderers

Semantic colour tokens with light and dark, a 1.25 type scale on a 4px
spacing grid, and severity colours matching the Slack message emoji so the
two surfaces read as one system. Everything is inline — no build step, no
CDN, no network request."
```

---

### Task 6: The server, and wiring it into startup

**Files:**
- Create: `src/dashboard/server.ts`, `src/dashboard/server.test.ts`
- Modify: `src/config/index.ts`
- Modify: `index.ts`
- Modify: `.env.example`
- Modify: `MEMORY_BANK.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from tasks 3–5
- Produces: `matchRoute(pathname: string): Route` where `type Route = { kind: "overview" | "list" | "health" | "notfound" } | { kind: "detail"; id: number }`, and `class DashboardServer { constructor(queries?: DashboardQueries); start(): Promise<void>; stop(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/server.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute } from "./server.js";

test("matchRoute recognises the three pages and the probe", () => {
  assert.deepEqual(matchRoute("/"), { kind: "overview" });
  assert.deepEqual(matchRoute("/incidents"), { kind: "list" });
  assert.deepEqual(matchRoute("/healthz"), { kind: "health" });
  assert.deepEqual(matchRoute("/incidents/42"), { kind: "detail", id: 42 });
});

test("matchRoute tolerates a trailing slash", () => {
  assert.deepEqual(matchRoute("/incidents/"), { kind: "list" });
});

// A non-numeric id must not reach the query layer as text — it would be a type error at
// the database rather than a 404 here.
test("matchRoute rejects a non-numeric incident id", () => {
  assert.deepEqual(matchRoute("/incidents/abc"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/1;DROP TABLE incidents"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/-1"), { kind: "notfound" });
});

test("matchRoute returns notfound for anything else", () => {
  assert.deepEqual(matchRoute("/admin"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/../etc/passwd"), { kind: "notfound" });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Add the config block**

In `src/config/index.ts`, alongside the other sections:

```ts
  // Read-only incident dashboard on its own port. Off unless asked for — the agent must
  // be unchanged for anyone not using it. There is no auth: the port simply is not routed
  // by the Ingress (see docs/superpowers/specs/2026-08-03-dashboard-design.md §3.1).
  dashboard: {
    enabled: process.env.DASHBOARD_ENABLED === "true",
    port: parseInt(process.env.DASHBOARD_PORT ?? "3001"),
  },
```

- [ ] **Step 4: Implement `server.ts`**

```ts
import http from "node:http";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { DashboardQueries } from "./queries.js";
import { parseFilters } from "./filters.js";
import { detailPage, errorPage, listPage, overviewPage } from "./views.js";

export type Route =
  | { kind: "overview" | "list" | "health" | "notfound" }
  | { kind: "detail"; id: number };

export function matchRoute(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "" || p === "/") return { kind: "overview" };
  if (p === "/healthz") return { kind: "health" };
  if (p === "/incidents") return { kind: "list" };
  const m = /^\/incidents\/(\d+)$/.exec(p);
  if (m) return { kind: "detail", id: Number(m[1]) };
  return { kind: "notfound" };
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly queries: DashboardQueries;

  constructor(queries?: DashboardQueries) {
    this.queries = queries ?? new DashboardQueries();
  }

  async start(): Promise<void> {
    if (!config.dashboard.enabled) return;

    this.server = http.createServer((req, res) => void this.handle(req, res));

    // Deliberately NOT fatal, unlike the config validation at boot. That rule exists for
    // things that make the agent unable to do its job; a port conflict on a statistics
    // page does not. Killing the pod here would trade handled incidents for unhandled ones.
    this.server.on("error", (err) => {
      logger.error(`[dashboard] listener failed, dashboard disabled (agent unaffected): ${errDetail(err)}`);
      this.server = null;
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(config.dashboard.port, () => {
        logger.info(
          `[dashboard] listening on :${config.dashboard.port} ` +
          `(read-only, no auth — must not be routed by the Ingress)`
        );
        resolve();
      });
      this.server!.once("error", () => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    // read-only by contract: nothing here mutates, so nothing but GET is accepted
    if (req.method !== "GET") return send(405, errorPage("Method not allowed", "This dashboard is read-only."));

    const url = new URL(req.url ?? "/", `http://localhost:${config.dashboard.port}`);
    const route = matchRoute(url.pathname);

    if (route.kind === "health") return send(200, "ok", "text/plain; charset=utf-8");

    if (!this.queries.enabled) {
      return send(200, errorPage("No database configured", "Set DB_HOST to enable incident history."));
    }

    try {
      switch (route.kind) {
        case "overview": {
          const [o, recent] = await Promise.all([
            this.queries.overview(),
            this.queries.list(parseFilters(new URLSearchParams("pageSize=10"))),
          ]);
          return send(200, overviewPage(o, recent.rows));
        }
        case "list": {
          const f = parseFilters(url.searchParams);
          const { rows, hasMore } = await this.queries.list(f);
          return send(200, listPage(rows, f, hasMore));
        }
        case "detail": {
          const d = await this.queries.detail(route.id);
          if (!d) return send(404, errorPage("Not found", `No incident with id ${route.id}.`));
          return send(200, detailPage(d));
        }
        default:
          return send(404, errorPage("Not found", "No such page."));
      }
    } catch (err) {
      // never throw into the process: an unhandled rejection here would take down the
      // agent, and the agent's job is investigating alerts
      logger.error(`[dashboard] ${url.pathname} failed: ${errDetail(err)}`);
      return send(500, errorPage("Query failed", "The database did not answer in time."));
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.queries.close();
  }
}
```

- [ ] **Step 5: Wire it into `index.ts`**

```ts
import { DevOpsAgent } from "./src/agent/index.js";
import { SlackApp } from "./src/app/index.js";
import { DashboardServer } from "./src/dashboard/server.js";
import logger, { errDetail } from "./src/utils/logger/index.js";

async function main() {
  try {
    const agent = new DevOpsAgent();
    const slack = new SlackApp(agent);
    const dashboard = new DashboardServer();

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      await dashboard.stop();
      await slack.stop();
      await agent.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await agent.initialize();
    await slack.start();
    // last, and never fatal — see DashboardServer.start()
    await dashboard.start();
  } catch (err) {
    logger.error(`Failed to start: ${errDetail(err)}`);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 6: Document the new variables**

Append to `.env.example`:

```bash
# Read-only incident dashboard, served on its own port inside the agent process.
# There is NO authentication: access control is that this port is not routed by the
# Ingress. Do not expose it without putting an auth proxy in front.
DASHBOARD_ENABLED=false
DASHBOARD_PORT=3001
```

Add to the `## Gotchas` list in `CLAUDE.md`:

```markdown
- **Dashboard has no auth by design** (`src/dashboard/`, `DASHBOARD_ENABLED`): the second port is a *network* boundary, not an auth boundary — never add an Ingress rule for it without putting an auth proxy in front. It is also the one component exempt from "a config mistake stops the pod": a failed listener logs and the agent keeps investigating.
```

Add a section to `MEMORY_BANK.md` after the incident-memory section:

```markdown
### Incident Dashboard (`src/dashboard/`, phase 1)
Read-only, server-rendered, second HTTP listener in the agent process (`DASHBOARD_PORT`,
default 3001, off unless `DASHBOARD_ENABLED=true`). Design:
`docs/superpowers/specs/2026-08-03-dashboard-design.md`.

**Its own pool, `max: 3`, with `statement_timeout = 3s`.** Sharing the agent's pool would let
one slow dashboard query starve `storeIncident` of connections — the investigation finishes and
the result is silently lost. Every query carries a `LIMIT` (page size 50, hard cap 200) and the
overview aggregates are cached for 60s, because with no auth in front a held-down refresh key is
otherwise unthrottled load on the same event loop that handles alerts.

**Nothing rendered is trusted input.** `rca`/`root_cause` are LLM output and the labels come from
Alertmanager, so every interpolation goes through `esc()` in `html.ts`. That helper's test is the
security-relevant one in this module.

**`llm_usage`** (migration 004) records one row per LLM call, with the router's backend and route.
`incident_id` is NULL at insert — the usage rows are written during the investigation, the
incident row only exists after — and is backfilled by `IncidentMemory.store()` via the
`onStored` callback. Rows for conversation-mode replies stay NULL forever, which is correct.
```

- [ ] **Step 7: Build, test, and smoke-test the real server**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm run build && npm test 2>&1 | grep -E "^.\[34m. (tests|pass|fail)"
```

Expected: build clean, `fail 0`.

Then verify it serves without a database — the degraded path, which is what a reviewer
cannot check from the diff:

```bash
DASHBOARD_ENABLED=true DASHBOARD_PORT=3099 node --import tsx -e '
import { DashboardServer } from "./src/dashboard/server.ts";
const s = new DashboardServer();
await s.start();
const r = await fetch("http://127.0.0.1:3099/");
console.log("status:", r.status);
const body = await r.text();
console.log("has doctype:", body.startsWith("<!doctype html>"));
console.log("healthz:", (await fetch("http://127.0.0.1:3099/healthz")).status);
console.log("404:", (await fetch("http://127.0.0.1:3099/nope")).status);
console.log("405:", (await fetch("http://127.0.0.1:3099/", { method: "POST" })).status);
await s.stop();
'
```

Expected: `status: 200`, `has doctype: true`, `healthz: 200`, `404: 404`, `405: 405`.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts src/config/index.ts \
        index.ts .env.example CLAUDE.md MEMORY_BANK.md
git commit -m "feat(dashboard): HTTP listener, routing and startup wiring

Second listener in the agent process, off unless DASHBOARD_ENABLED=true.
Startup failure is logged and swallowed rather than fatal: the boot-guard
rule exists for things that stop the agent doing its job, and a port
conflict on a statistics page is not one."
```

---

### Task 7: Deploy to the dev overlay

**Files:**
- Modify: `gitops-devops-ai-manifest/apps/dev/applications/devops-ai-agent/release.yaml`

**Interfaces:**
- Consumes: `DASHBOARD_ENABLED` / `DASHBOARD_PORT` from Task 6.

> **Warning for the implementer:** this repo's `main` is what Flux reconciles on a
> one-minute poll with no PR gate, so **pushing it is deploying it**. Commit locally and
> stop. Do not push; the human decides when this goes out.

- [ ] **Step 1: Add the environment variables**

In `spec.values.extraEnvVars`, after the `MAX_CONCURRENT_INVESTIGATIONS` entry:

```yaml
      # Read-only dashboard on its own port. NO Ingress rule for 3001 — that absence is
      # the access control. See devops-ai-agent/docs/superpowers/specs/2026-08-03-dashboard-design.md §3.1
      - name: DASHBOARD_ENABLED
        value: "true"
      - name: DASHBOARD_PORT
        value: "3001"
```

- [ ] **Step 2: Verify the YAML parses and no Ingress rule was added**

```bash
cd /Users/annasik/riset/gitops-devops-ai-manifest
python3 -c "
import yaml
d = yaml.safe_load(open('apps/dev/applications/devops-ai-agent/release.yaml'))
env = {e['name']: e.get('value') for e in d['spec']['values']['extraEnvVars'] if 'value' in e}
assert env['DASHBOARD_ENABLED'] == 'true', env.get('DASHBOARD_ENABLED')
assert env['DASHBOARD_PORT'] == '3001', env.get('DASHBOARD_PORT')
assert 'ingress' not in d['spec']['values'] or not d['spec']['values']['ingress'].get('enabled')
print('YAML OK — dashboard enabled, no ingress')
"
```

Expected: `YAML OK — dashboard enabled, no ingress`.

- [ ] **Step 3: Commit locally, do not push**

```bash
git add apps/dev/applications/devops-ai-agent/release.yaml
git commit -m "feat(dev): enable the read-only incident dashboard on port 3001

No Ingress rule: the absence of a route is the access control."
git log --oneline -1
```

Then report to the human that the commit exists and is unpushed.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §2 scope, deferrals | Tasks 2–6 build only the browser + metrics; nothing builds live-ops or a control surface |
| §3 placement, second listener, module boundary | Task 6 |
| §3.1 no auth, consequences documented | Task 6 (config comment, `.env.example`, `CLAUDE.md`), Task 7 (no Ingress) |
| §3.2 own pool `max: 3`, `Pool \| null` degradation | Task 4 (`DashboardQueries` constructor), Task 6 (`enabled` check) |
| §4 `statement_timeout`, mandatory LIMIT, 60s cache | Task 4 |
| §5.1 existing tables, Slack deep link | Task 4 (`detail()`), Task 5 (`detailPage`) |
| §5.2 `llm_usage`, backfill, best-effort | Task 1 |
| §6 four routes, five numbers | Task 5 (pages), Task 6 (routing) |
| §7 SSR, zero deps, escaping | Tasks 2 and 5 |
| §8 non-fatal startup, error page | Task 6 |
| §9 pure tests: filters, escaping, SVG, empty states | Tasks 2, 3, 5 |
| §10 `DASHBOARD_ENABLED`/`DASHBOARD_PORT`, dev overlay only | Tasks 6 and 7 |

No gaps.

**2. Placeholder scan.** No "TBD", "add error handling", or "similar to Task N". Every code step carries the code.

**3. Type consistency.** `Filters` is produced in Task 3 and consumed unchanged in Tasks 4 and 5. `IncidentRow` / `IncidentDetail` / `RemediationRow` / `FeedbackRow` / `Overview` are declared in Task 4 and imported by name in Task 5. `UsageRow` and `TokenUsage` match `src/agent/llm/types.ts`. `matchRoute` returns the `Route` union that Task 6's switch consumes exhaustively. `esc` / `fmtDate` / `fmtPct` / `fmtInt` / `barChart` are declared in Task 2 and used with those exact names afterwards.

**One thing the implementer must not "fix":** `DashboardQueries`' constructor takes `pool?: Pool | null`, where `undefined` means "build the real pool" and explicit `null` means "no database". That three-way distinction is what lets the tests inject a stub without touching `config`. Collapsing it to `pool: Pool | null` breaks every test in Task 4.
