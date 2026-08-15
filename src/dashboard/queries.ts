import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { PAGE_SIZE, type Filters } from "./filters.js";

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
export interface Overview {
  weekly: { label: string; value: number }[];
  recurring: { alertname: string; namespace: string | null; n: number; last_seen: Date }[];
  totalIncidents: number; resolvedIncidents: number;
  remediationSucceeded: number; remediationFailed: number;
  feedback: Record<string, number>;
  tokens: Tokens;
}

const CACHE_TTL_MS = 60_000;
// How far the row count will walk before it gives up and reports "this many or more".
export const COUNT_CAP = 5000;

// One predicate, two queries. The page and its count MUST filter identically — a drifted
// copy shows a page of rows under a total that does not include them — so there is one copy
// and both interpolate it. It is a module constant with no input in it; $1..$6 are bound.
const INCIDENT_WHERE = `WHERE ($1::timestamptz IS NULL OR created_at >= $1)
            AND ($2::timestamptz IS NULL OR created_at <  $2)
            AND ($3::text IS NULL OR alertname = $3)
            AND ($4::text IS NULL OR namespace = $4)
            AND ($5::text IS NULL OR severity  = $5)
            AND ($6::boolean IS NULL OR (resolved_at IS NOT NULL) = $6)`;

// passed as a bound parameter ($1::interval), never interpolated into the SQL text —
// it is a constant today, and keeping it parameterised means it cannot become an
// injection the day someone makes the window configurable
const WINDOW = "30 days";

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
  private cache: { at: number; value: Overview } | null = null;

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
      this.pool = createPool(3, 5000);
      this.pool.on("error", (err: Error) => logger.error(`[dashboard] pool error: ${err.message}`));
      // enforced by Postgres, so a runaway query dies at the server rather than
      // occupying the event loop that also handles alerts
      this.pool.on("connect", (c) => {
        void c.query("SET statement_timeout = 3000").catch((err: unknown) =>
          logger.warn(
            `[dashboard] SET statement_timeout failed — connection has no statement_timeout: ${errDetail(err)}`
          )
        );
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
      tokens: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byBackend: [] },
    };
    if (!this.pool) return empty;

    const [weekly, recurring, totals, remediation, feedback, tokens, tokenLines] = await Promise.all([
      this.pool.query(
        `SELECT to_char(date_trunc('week', created_at), 'MM-DD') AS label, count(*)::int AS n
           FROM incidents WHERE created_at >= now() - interval '12 weeks'
          GROUP BY 1 ORDER BY 1 LIMIT 12`
      ),
      this.pool.query(
        `SELECT alertname, namespace, count(*)::int AS n, max(created_at) AS last_seen
           FROM incidents WHERE created_at >= now() - $1::interval
          GROUP BY alertname, namespace ORDER BY n DESC, last_seen DESC LIMIT 10`,
        [WINDOW]
      ),
      this.pool.query(
        // no GROUP BY — this aggregate is always exactly one row. The LIMIT is
        // redundant here but present anyway: a rule you have to re-derive at each
        // call site is a rule that erodes; one you can grep for does not.
        `SELECT count(*)::int AS total, count(resolved_at)::int AS resolved
           FROM incidents WHERE created_at >= now() - $1::interval
          LIMIT 1`,
        [WINDOW]
      ),
      this.pool.query(
        // `status` is plain TEXT with no CHECK constraint, so nothing in the schema
        // bounds how many distinct values GROUP BY can return. 20 is far above any
        // realistic status vocabulary (succeeded/failed/pending/...) but still caps
        // the worst case of a runaway/garbage value column.
        `SELECT status, count(*)::int AS n FROM remediations
          WHERE created_at >= now() - $1::interval GROUP BY status
          LIMIT 20`,
        [WINDOW]
      ),
      this.pool.query(
        // same reasoning as remediations.status: `outcome` is unconstrained TEXT.
        `SELECT coalesce(outcome, 'unknown') AS outcome, count(*)::int AS n
           FROM incident_feedback WHERE created_at >= now() - $1::interval GROUP BY 1
          LIMIT 20`,
        [WINDOW]
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
        [WINDOW]
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
        [WINDOW]
      ),
    ]);

    const byStatus = Object.fromEntries(remediation.rows.map((r: any) => [r.status, r.n]));
    const t = tokens.rows[0];
    const value: Overview = {
      weekly: weekly.rows.map((r: any) => ({ label: r.label, value: r.n })),
      recurring: recurring.rows,
      totalIncidents: totals.rows[0]?.total ?? 0,
      resolvedIncidents: totals.rows[0]?.resolved ?? 0,
      remediationSucceeded: byStatus.succeeded ?? 0,
      remediationFailed: byStatus.failed ?? 0,
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
    };
    this.cache = { at: Date.now(), value: deepFreeze(value) };
    return this.cache.value;
  }

  async list(f: Filters): Promise<IncidentPage> {
    if (!this.pool) return { rows: [], hasMore: false, total: 0, capped: false };
    // over-fetch by one: tells us whether a next page exists without trusting the count below
    const limit = PAGE_SIZE + 1;
    const offset = (f.page - 1) * PAGE_SIZE;
    const args = [f.from, f.to, f.alertname, f.namespace, f.severity, f.resolved];
    // The rows query goes first and stays first: three tests read calls[0] for the filter
    // parameters, the LIMIT and the OFFSET.
    const [page, count] = await Promise.all([
      this.pool.query(
        `SELECT id, created_at, resolved_at, alertname, namespace, severity, confidence, root_cause
           FROM incidents
          ${INCIDENT_WHERE}
          ORDER BY created_at DESC
          LIMIT $7 OFFSET $8`,
        [...args, limit, offset]
      ),
      this.pool.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM incidents ${INCIDENT_WHERE} LIMIT $7) c`,
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
