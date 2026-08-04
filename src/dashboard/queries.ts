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
    this.cache = { at: Date.now(), value: deepFreeze(value) };
    return this.cache.value;
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
