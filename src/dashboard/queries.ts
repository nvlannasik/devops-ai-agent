import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { DEFAULT_RANGE, PAGE_SIZE, type Filters, type Range } from "./filters.js";

export interface IncidentRow {
  id: number; created_at: Date; resolved_at: Date | null;
  alertname: string; namespace: string | null;
  severity: string | null; confidence: string | null; root_cause: string | null;
}
export interface IncidentDetail extends IncidentRow {
  rca: string; channel: string | null; thread_ts: string | null;
}
// `status` and `verdict` are two different facts and the page must never merge them.
//
//   status  — what the MCP call returned. "succeeded" means the API did not error.
//   verdict — what the CLUSTER did about it, read back minutes later by the durable
//             post-remediation check (agent/remediation/verify.ts, migrations/006).
//
// A restart that returns 200 and changes nothing is `status: succeeded, verdict: unchanged`,
// and before this the dashboard only ever showed the first half of that sentence.
//
// verdict is NULL while the check is still pending or running — genuinely "not known yet",
// which is distinct from `inconclusive` ("we looked and the evidence says nothing either
// way"). An abandoned check is written as inconclusive by finish(), so a NULL here always
// means the answer is still coming.
export interface RemediationRow {
  action: string; params: Record<string, unknown>; status: string;
  approved_by: string | null; result: string | null;
  created_at: Date; executed_at: Date | null;
  verdict: string | null;
  /** The evidence the verdict was read from — alert state and pod readiness, as a sentence. */
  verdict_detail: string | null;
  /** pending | running | done | abandoned, or NULL when no check was ever scheduled. */
  check_status: string | null;
  checked_at: Date | null;
  /** When an unfinished check is next due, so a pending row can say when to look again. */
  due_at: Date | null;
}
export interface FeedbackRow {
  slack_user: string | null; confirmed_root_cause: string | null;
  action_taken: string | null; outcome: string | null; created_at: Date;
}
// llm_usage holds one row per chat() call, not per incident (see migrations/004) — which is
// what makes "what does each backend cost us" answerable at all under the router. The totals
// are a separate query rather than a sum of `byBackend`: that list is capped, so adding it up
// would quietly under-report the moment a 21st backend/model pair appears.
export interface TokenLine {
  backend: string; model: string; calls: number;
  input: number; output: number; cacheRead: number; cacheCreation: number;
}
export interface Tokens {
  calls: number;
  input: number; output: number; cacheRead: number; cacheCreation: number;
  byBackend: TokenLine[];
}
// `total` is what the pager numbers itself from, and it is BOUNDED (see COUNT_CAP): past the
// cap it stops counting and `capped` says so, which the page renders as "5,000+". An exact
// count over a filtered table is a full scan on the same event loop that handles alerts, and
// nobody clicks to page 400 — the ceiling buys a flat cost and gives up a number no one reads.
export interface IncidentPage {
  rows: IncidentRow[];
  hasMore: boolean;
  total: number;
  capped: boolean;
}
// What the same four figures looked like over the PREVIOUS window of equal length. This is the
// only reason the page can print a delta at all — a KPI without one says "17 open" and leaves
// the reader to remember what it said yesterday. Nothing else on the page needs the past, so
// the previous window is four numbers rather than a second Overview.
//
// mttrMs is null, not 0, when nothing resolved in the window: zero minutes to resolve is a
// claim, and "nothing resolved yet" is the truth. A delta against a null previous is omitted
// rather than rendered as a full-height improvement.
export interface Previous {
  totalIncidents: number;
  openIncidents: number;
  mttrMs: number | null;
  feedbackTotal: number;
}
export interface Overview {
  // The window every figure below is measured over, echoed back so the page can mark which
  // step of the range control is current without re-parsing the URL.
  range: Range;
  weekly: { label: string; value: number }[];
  // What one point of `weekly` covers — "per hour" or "per day". The series bucket follows the
  // range, so the chart's caption cannot be a constant.
  seriesUnit: string;
  recurring: { alertname: string; namespace: string | null; n: number; last_seen: Date }[];
  totalIncidents: number; resolvedIncidents: number;
  // Mean time to resolve, over the incidents in this window that HAVE resolved. Null when none
  // have — see Previous above.
  mttrMs: number | null;
  // The window's incidents by severity, for the donut. Ordered by count so the largest arc is
  // drawn first and the legend reads in the same order as the ring.
  severity: { severity: string; n: number }[];
  remediationSucceeded: number; remediationFailed: number;
  // What the post-remediation checks concluded, over the same window. Keyed by verdict —
  // recovered | unchanged | worse | inconclusive — and counting only checks that REACHED one;
  // a pending check is not a zero, it is an answer that has not arrived.
  verdicts: Record<string, number>;
  /** How many checks in the window are still waiting for their verdict. */
  verdictsPending: number;
  feedback: Record<string, number>;
  tokens: Tokens;
  prev: Previous;
}

const CACHE_TTL_MS = 60_000;
// How far the row count will walk before it gives up and reports "this many or more".
export const COUNT_CAP = 5000;
// The ceiling on the rail badge's count. Smaller than COUNT_CAP because it bounds a different
// thing: not "how many rows match a filter" but "how many are open at once", and four digits
// in a nav badge is a number nobody reads as a number.
export const NAV_COUNT_CAP = 999;

// One predicate, two queries. The page and its count MUST filter identically — a drifted
// copy shows a page of rows under a total that does not include them — so there is one copy
// and both interpolate it. It is a module constant with no input in it; $1..$7 are bound.
//
// $7 is the only one that leaves the incidents table. A verdict belongs to a remediation's
// CHECK, two joins away, so it is an EXISTS rather than a join on the outer query — an
// incident with three remediations must appear once, and joining would return it three times
// and break both the page and the count in the same stroke.
const INCIDENT_WHERE = `WHERE ($1::timestamptz IS NULL OR created_at >= $1)
            AND ($2::timestamptz IS NULL OR created_at <  $2)
            AND ($3::text IS NULL OR alertname = $3)
            AND ($4::text IS NULL OR namespace = $4)
            AND ($5::text IS NULL OR severity  = $5)
            AND ($6::boolean IS NULL OR (resolved_at IS NOT NULL) = $6)
            AND ($7::text IS NULL OR EXISTS (
                  SELECT 1
                    FROM remediations r
                    JOIN remediation_checks rc ON rc.remediation_id = r.id
                   WHERE r.incident_id = incidents.id AND rc.verdict = $7))`;

// The window is now chosen per request (see parseRange in filters.ts), which is exactly the
// day the comment that used to stand here was written for: every one of these values is
// passed as a BOUND parameter, never interpolated into the SQL text.
//
// That includes `bucket` and `labelFormat`, which look like they would have to be spliced in
// and do not: date_trunc(text, timestamptz) and to_char(timestamptz, text) both take their
// field and their format as ordinary text arguments, so `date_trunc($2, created_at)` is legal
// and the whole statement stays a constant string. Two layers hold here rather than one — the
// parseRange allowlist means the key can only be one of three literals, and the binding means
// it would still not be executable if it were not.
interface RangeSpec {
  interval: string;
  bucket: string;
  labelFormat: string;
  /** What one point of the series covers, for the chart caption. */
  unit: string;
}
const RANGES: Record<Range, RangeSpec> = {
  // An hour is the smallest bucket that still groups anything: at a minute the series is 1440
  // points of mostly zero, which is a texture rather than a shape.
  "24h": { interval: "24 hours", bucket: "hour", labelFormat: "HH24:00", unit: "per hour" },
  "7d": { interval: "7 days", bucket: "day", labelFormat: "MM-DD", unit: "per day" },
  // Daily over a month, not weekly. Weekly was what the series used when the window was fixed
  // at 30 days, and four and a bit bars is a bar chart pretending to be a trend; thirty points
  // have a shape, and the axis already thins its own labels (see chart.ts).
  "30d": { interval: "30 days", bucket: "day", labelFormat: "MM-DD", unit: "per day" },
};
// How many buckets the series may return. One per hour over 24h, one per day over 30d — the
// cap is the larger of the two plus room for a partial bucket at each end.
const SERIES_LIMIT = 32;

// The cache stores one shared object and hands it to every caller. Freezing it (rather
// than e.g. structuredClone-ing on every read) means a consumer that mutates in place —
// sorts an array, annotates a field — gets a loud TypeError instead of silently
// corrupting what every other viewer sees for up to 60s. No per-request copy cost.
//
// Recurses into children before freezing the parent, with no cycle guard — assumes the
// object graph is acyclic. True for Overview today (plain data: arrays of records with
// no self-references); would recurse forever on a cyclic graph, so don't reuse this on
// a shape that isn't a tree.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// pg returns BIGINT as a string, because a bigint can exceed what a JS number holds exactly.
// Token counts cannot — a year of this agent's traffic is nine digits, and Number.MAX_SAFE_INTEGER
// is sixteen — so the conversion is safe here and nowhere near safe in general. NaN and null
// both land on 0 rather than propagating into a rendered "NaN".
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class DashboardQueries {
  private readonly pool: Pool | null;
  // Keyed by range, because the three ranges are three different answers and a single slot
  // would have each one evicting the others every time somebody moved the control. Three
  // entries, bounded by the Range union itself — nothing a URL can say adds a fourth.
  private cache = new Map<Range, { at: number; value: Overview }>();
  private navCache: { at: number; value: number } | null = null;

  // A pool of its own, max 3. Sharing the agent's pool means a slow dashboard query can
  // starve storeIncident of connections — the investigation finishes and the result is
  // silently lost. This bounds the worst case to "the dashboard is slow".
  //
  // pool?: Pool | null is deliberate, not sloppy: undefined means "build the real pool
  // from config", explicit null means "no database configured", and an object means
  // "use this one" — that three-way split is what lets tests inject a stub without
  // touching config.
  constructor(pool?: Pool | null) {
    if (pool !== undefined) {
      this.pool = pool;
    } else if (config.incidents.enabled) {
      // 5s slot wait: with max 3 and no auth in front, a burst otherwise queues waiters
      // with no timer at all, holding HTTP requests open indefinitely
      //
      // statement_timeout is enforced by Postgres, so a runaway query dies at the server
      // rather than occupying the event loop that also handles alerts. It is set in the
      // connection's startup packet (see createPool) rather than by a `SET` from a 'connect'
      // listener — that listener cannot be awaited, so the first query on each new connection
      // used to start before the SET landed, both raising pg's "client is already executing a
      // query" deprecation and leaving that first query unbounded.
      this.pool = createPool(3, 5000, 3000);
      this.pool.on("error", (err: Error) => logger.error(`[dashboard] pool error: ${err.message}`));
    } else {
      this.pool = null;
    }
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  async overview(range: Range = DEFAULT_RANGE): Promise<Overview> {
    const spec = RANGES[range] ?? RANGES[DEFAULT_RANGE];
    const hit = this.cache.get(range);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const empty: Overview = {
      range, seriesUnit: spec.unit,
      weekly: [], recurring: [], totalIncidents: 0, resolvedIncidents: 0,
      mttrMs: null, severity: [],
      remediationSucceeded: 0, remediationFailed: 0, verdicts: {}, verdictsPending: 0, feedback: {},
      tokens: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byBackend: [] },
      prev: { totalIncidents: 0, openIncidents: 0, mttrMs: null, feedbackTotal: 0 },
    };
    if (!this.pool) return empty;

    const W = spec.interval;
    const [weekly, recurring, totals, prev, severity, remediation, feedback, checks, tokens, tokenLines] =
      await Promise.all([
      this.pool.query(
        // The bucket and its label are bound, not spliced — date_trunc and to_char both take
        // text arguments, so the statement stays a constant. ORDER BY the truncated timestamp
        // rather than the formatted label: "HH24:00" sorts 00:00 before 23:00, which would put
        // midnight at the left edge of a window that started at noon.
        `SELECT to_char(date_trunc($2, created_at), $3) AS label,
                date_trunc($2, created_at) AS bucket,
                count(*)::int AS n
           FROM incidents WHERE created_at >= now() - $1::interval
          GROUP BY 1, 2 ORDER BY 2 LIMIT ${SERIES_LIMIT}`,
        [W, spec.bucket, spec.labelFormat]
      ),
      this.pool.query(
        `SELECT alertname, namespace, count(*)::int AS n, max(created_at) AS last_seen
           FROM incidents WHERE created_at >= now() - $1::interval
          GROUP BY alertname, namespace ORDER BY n DESC, last_seen DESC LIMIT 10`,
        [W]
      ),
      this.pool.query(
        // no GROUP BY — this aggregate is always exactly one row. The LIMIT is
        // redundant here but present anyway: a rule you have to re-derive at each
        // call site is a rule that erodes; one you can grep for does not.
        // The mean is over the incidents that HAVE resolved, which is what makes it a time to
        // resolve rather than a time-so-far. avg() over an empty set is NULL, and that NULL is
        // carried all the way to the page rather than coalesced to 0: "nothing resolved in this
        // window" and "resolved instantly" are opposite readings of the same tile.
        // epoch is seconds; the page works in ms like every other duration in this codebase.
        `SELECT count(*)::int AS total,
                count(resolved_at)::int AS resolved,
                extract(epoch FROM avg(resolved_at - created_at)) * 1000 AS mttr_ms
           FROM incidents WHERE created_at >= now() - $1::interval
          LIMIT 1`,
        [W]
      ),
      this.pool.query(
        // The window immediately before this one, of equal length — what every delta on the
        // page is measured against. Half-open on purpose: `>= 2W ago AND < 1W ago` shares no
        // row with the current window, so an incident is counted in exactly one of them.
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                extract(epoch FROM avg(resolved_at - created_at)) * 1000 AS mttr_ms,
                (SELECT count(*)::int FROM incident_feedback
                  WHERE created_at >= now() - ($1::interval * 2)
                    AND created_at <  now() - $1::interval) AS feedback_total
           FROM incidents
          WHERE created_at >= now() - ($1::interval * 2)
            AND created_at <  now() - $1::interval
          LIMIT 1`,
        [W]
      ),
      this.pool.query(
        // `severity` is unconstrained TEXT out of an Alertmanager label, so the same 20-row cap
        // the other grouped queries carry applies: nothing in the schema bounds how many
        // distinct values a misconfigured alert rule can produce.
        `SELECT coalesce(severity, 'unknown') AS severity, count(*)::int AS n
           FROM incidents WHERE created_at >= now() - $1::interval
          GROUP BY 1 ORDER BY n DESC
          LIMIT 20`,
        [W]
      ),
      this.pool.query(
        // `status` is plain TEXT with no CHECK constraint, so nothing in the schema
        // bounds how many distinct values GROUP BY can return. 20 is far above any
        // realistic status vocabulary (succeeded/failed/pending/...) but still caps
        // the worst case of a runaway/garbage value column.
        `SELECT status, count(*)::int AS n FROM remediations
          WHERE created_at >= now() - $1::interval GROUP BY status
          LIMIT 20`,
        [W]
      ),
      this.pool.query(
        // same reasoning as remediations.status: `outcome` is unconstrained TEXT.
        `SELECT coalesce(outcome, 'unknown') AS outcome, count(*)::int AS n
           FROM incident_feedback WHERE created_at >= now() - $1::interval GROUP BY 1
          LIMIT 20`,
        [W]
      ),
      this.pool.query(
        // What the checks concluded. Grouped on the verdict itself, with NULL kept as its own
        // bucket rather than coalesced into a value: a check still waiting is not a verdict of
        // any kind, and folding it into "inconclusive" would report an answer that was never
        // given. The window is the CHECK's own created_at — a check belongs to the window its
        // remediation ran in, which is what makes the figure comparable to the counts beside it.
        // 20 caps a column nothing in the schema bounds, like every other grouped query here.
        `SELECT verdict, count(*)::int AS n
           FROM remediation_checks WHERE created_at >= now() - $1::interval
          GROUP BY 1
          LIMIT 20`,
        [W]
      ),
      this.pool.query(
        // one row, same as the incident totals above — and the same redundant LIMIT, for
        // the same reason. sum() over INTEGER widens to BIGINT, which pg hands back as a
        // string; num() below is what turns it into a number rather than "12"+"7"="127".
        `SELECT count(*)::int AS calls,
                coalesce(sum(input_tokens), 0)::bigint          AS input,
                coalesce(sum(output_tokens), 0)::bigint         AS output,
                coalesce(sum(cache_read_tokens), 0)::bigint     AS cache_read,
                coalesce(sum(cache_creation_tokens), 0)::bigint AS cache_creation
           FROM llm_usage WHERE created_at >= now() - $1::interval
          LIMIT 1`,
        [W]
      ),
      this.pool.query(
        // backend AND model: one backend can be re-pointed at a new model mid-window, and
        // collapsing that hides exactly the change someone reading this page is looking for.
        // Both are nullable TEXT, so both are coalesced — a NULL group would render as a
        // blank row that looks like a bug. 20 caps a column nothing in the schema bounds.
        `SELECT coalesce(backend, 'unknown') AS backend,
                coalesce(model, 'unknown')   AS model,
                count(*)::int AS calls,
                coalesce(sum(input_tokens), 0)::bigint          AS input,
                coalesce(sum(output_tokens), 0)::bigint         AS output,
                coalesce(sum(cache_read_tokens), 0)::bigint     AS cache_read,
                coalesce(sum(cache_creation_tokens), 0)::bigint AS cache_creation
           FROM llm_usage WHERE created_at >= now() - $1::interval
          GROUP BY 1, 2
          ORDER BY sum(input_tokens) + sum(output_tokens) DESC
          LIMIT 20`,
        [W]
      ),
    ]);

    const byStatus = Object.fromEntries(remediation.rows.map((r: any) => [r.status, r.n]));
    const t = tokens.rows[0];
    const p0 = prev.rows[0];
    // NULL and "no rows at all" are the same reading here — nothing resolved — and both have to
    // survive as null rather than becoming 0. num() would flatten them, so avg() gets its own
    // conversion: a value only when Postgres actually returned a finite one.
    const ms = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const value: Overview = {
      range, seriesUnit: spec.unit,
      weekly: weekly.rows.map((r: any) => ({ label: r.label, value: r.n })),
      recurring: recurring.rows,
      totalIncidents: totals.rows[0]?.total ?? 0,
      resolvedIncidents: totals.rows[0]?.resolved ?? 0,
      mttrMs: ms(totals.rows[0]?.mttr_ms),
      severity: severity.rows.map((r: any) => ({ severity: r.severity, n: r.n })),
      remediationSucceeded: byStatus.succeeded ?? 0,
      remediationFailed: byStatus.failed ?? 0,
      // NULL is the pending bucket and is counted separately, never as a verdict.
      verdicts: Object.fromEntries(
        checks.rows.filter((r: any) => r.verdict !== null).map((r: any) => [r.verdict, r.n])
      ),
      verdictsPending: checks.rows.find((r: any) => r.verdict === null)?.n ?? 0,
      feedback: Object.fromEntries(feedback.rows.map((r: any) => [r.outcome, r.n])),
      tokens: {
        calls: t?.calls ?? 0,
        input: num(t?.input), output: num(t?.output),
        cacheRead: num(t?.cache_read), cacheCreation: num(t?.cache_creation),
        byBackend: tokenLines.rows.map((r: any) => ({
          backend: r.backend, model: r.model, calls: r.calls,
          input: num(r.input), output: num(r.output),
          cacheRead: num(r.cache_read), cacheCreation: num(r.cache_creation),
        })),
      },
      prev: {
        totalIncidents: p0?.total ?? 0,
        openIncidents: p0?.open ?? 0,
        mttrMs: ms(p0?.mttr_ms),
        feedbackTotal: p0?.feedback_total ?? 0,
      },
    };
    const frozen = deepFreeze(value);
    this.cache.set(range, { at: Date.now(), value: frozen });
    return frozen;
  }

  // How many incidents are firing RIGHT NOW, for the rail's badge. Deliberately not the
  // overview's "Open" figure: that one is bounded by the selected range, and a badge that
  // shrank when someone switched the range to 24h would be reporting the control rather than
  // the cluster. This is every unresolved incident, whenever it fired.
  //
  // Bounded like the list's count, and for the same reason — an exact count over a growing
  // table is a scan on the pool that also serves alerts. NAV_COUNT_CAP is far above any
  // plausible number of simultaneously-open incidents; past it the badge says "999+", which is
  // true, and a reader with a thousand open incidents does not need the exact digit.
  //
  // Its own cache slot, because it is asked for on EVERY page render rather than only on the
  // overview, and it is not part of the Overview shape.
  async openIncidents(): Promise<number> {
    if (!this.pool) return 0;
    const hit = this.navCache;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n
         FROM (SELECT 1 FROM incidents WHERE resolved_at IS NULL LIMIT ${NAV_COUNT_CAP + 1}) t`
    );
    const value = rows[0]?.n ?? 0;
    this.navCache = { at: Date.now(), value };
    return value;
  }

  async list(f: Filters): Promise<IncidentPage> {
    if (!this.pool) return { rows: [], hasMore: false, total: 0, capped: false };
    // over-fetch by one: tells us whether a next page exists without trusting the count below
    const limit = PAGE_SIZE + 1;
    const offset = (f.page - 1) * PAGE_SIZE;
    const args = [f.from, f.to, f.alertname, f.namespace, f.severity, f.resolved, f.verdict];
    // The rows query goes first and stays first: three tests read calls[0] for the filter
    // parameters, the LIMIT and the OFFSET.
    const [page, count] = await Promise.all([
      this.pool.query(
        `SELECT id, created_at, resolved_at, alertname, namespace, severity, confidence, root_cause
           FROM incidents
          ${INCIDENT_WHERE}
          ORDER BY created_at DESC
          LIMIT $8 OFFSET $9`,
        [...args, limit, offset]
      ),
      this.pool.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM incidents ${INCIDENT_WHERE} LIMIT $8) c`,
        [...args, COUNT_CAP]
      ),
    ]);
    const hasMore = page.rows.length > PAGE_SIZE;
    const rows = hasMore ? page.rows.slice(0, PAGE_SIZE) : page.rows;
    // Never below what the caller is holding. The two queries are concurrent and share no
    // snapshot, so an insert landing between them can return a count smaller than the page
    // it is about to be printed under — "Showing 51–100 of 84" is a number the reader cannot
    // unsee. The floor costs nothing and makes the summary self-consistent by construction.
    const total = Math.max(num(count.rows[0]?.n), offset + rows.length);
    return { rows, hasMore, total, capped: total >= COUNT_CAP };
  }

  async detail(id: number) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      // filtered on the primary key, so this is already at most one row — the LIMIT
      // is redundant but present for the same reason as the totals query above.
      `SELECT id, created_at, resolved_at, alertname, namespace, severity, confidence,
              root_cause, rca, channel, thread_ts
         FROM incidents WHERE id = $1
        LIMIT 1`,
      [id]
    );
    if (rows.length === 0) return null;
    const [remediations, feedback] = await Promise.all([
      this.pool.query(
        // LEFT JOIN, not an inner one: a remediation that was proposed and never approved has
        // no check, and a remediation approved seconds ago has one that has not run. Both must
        // still appear in this table — the row is the action, the check is an annotation on it.
        // One check per remediation is guaranteed by the unique index in migrations/006, so
        // this cannot fan the row set out.
        `SELECT r.action, r.params, r.status, r.approved_by, r.result, r.created_at, r.executed_at,
                c.verdict, c.detail AS verdict_detail, c.status AS check_status,
                c.checked_at, c.due_at
           FROM remediations r
           LEFT JOIN remediation_checks c ON c.remediation_id = r.id
          WHERE r.incident_id = $1 ORDER BY r.created_at LIMIT 50`,
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
