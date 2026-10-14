// Postgres storage for postmortem drafts (migration 015). Spec
// docs/superpowers/specs/2026-10-14-postmortem-draft-design.md §4. `store`/`latest`/`exists`
// are the draft table itself; `facts` is the OTHER half — everything DevOpsAgent.postmortemFacts
// needs before it can hand the model a prompt, gathered here because it is all Postgres reads.
import type { Pool } from "pg";
import type { PostmortemFacts } from "./facts.js";
import type { ChangeTimeline } from "../changes/index.js";
import { cleanDeep } from "../trace/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";

export interface LatestDraft {
  id: number;
  createdAt: string;
  requestedBy: string | null;
  backend: string | null;
  markdown: string;
}

// A pg Date (or string, or null/undefined) → ISO string, never "Invalid Date" and never the
// RangeError `new Date(NaN).toISOString()` throws. Applied to every timestamp this module reads,
// per spec: a bad value becomes null rather than reaching Date.parse downstream (facts.ts) as NaN.
function toIso(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  const d = x instanceof Date ? x : new Date(x as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Only for columns the schema declares NOT NULL (incidents.created_at, remediations.created_at,
// incident_feedback.created_at): toIso's null case is unreachable there in practice, but the
// fallback keeps the return type honest without a second conversion helper.
const toIsoRequired = (x: unknown): string => toIso(x) ?? new Date(0).toISOString();

export class PostmortemStore {
  constructor(private readonly pool: Pool | null) {}

  async store(incidentId: number, requestedBy: string | null, markdown: string, backend: string | null): Promise<number | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO postmortems (incident_id, requested_by, backend, markdown) VALUES ($1, $2, $3, $4) RETURNING id`,
        // Same cleaner the trace recorder and incidents.store() use before a jsonb/text write:
        // a model's reply can carry a lone surrogate or \u0000 from upstream log text it quoted.
        [incidentId, requestedBy, backend, cleanDeep(markdown) as string]
      );
      return Number(rows[0].id);
    } catch (err) {
      logger.error(`[postmortem] store failed for incident ${incidentId}: ${errDetail(err)}`);
      return null;
    }
  }

  async latest(incidentId: number): Promise<LatestDraft | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        `SELECT id, created_at, requested_by, backend, markdown FROM postmortems
          WHERE incident_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [incidentId]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: Number(r.id),
        createdAt: toIsoRequired(r.created_at),
        requestedBy: r.requested_by ?? null,
        backend: r.backend ?? null,
        markdown: r.markdown,
      };
    } catch (err) {
      logger.error(`[postmortem] latest failed for incident ${incidentId}: ${errDetail(err)}`);
      return null;
    }
  }

  async exists(incidentId: number): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const { rows } = await this.pool.query(`SELECT 1 FROM postmortems WHERE incident_id = $1 LIMIT 1`, [incidentId]);
      return rows.length > 0;
    } catch (err) {
      logger.error(`[postmortem] exists failed for incident ${incidentId}: ${errDetail(err)}`);
      return false;
    }
  }

  /**
   * Everything the draft is built from, gathered best-effort: the incident row's own read is the
   * one failure that returns null outright (there is no draft without it); every other source
   * that fails is named in `unavailable` and the rest still comes back. `humans` is not this
   * module's to fill — the Slack thread is SlackApp's, not Postgres' (see DevOpsAgent.postmortemFacts).
   */
  async facts(incidentId: number): Promise<Omit<PostmortemFacts, "humans"> | null> {
    if (!this.pool) return null;

    let row: Record<string, any>;
    try {
      const { rows } = await this.pool.query(
        `SELECT id, alertname, namespace, severity, assessed_severity, alert_started_at, created_at,
                resolved_at, resolved_by, root_cause, rca, changes, thread_ts
           FROM incidents WHERE id = $1`,
        [incidentId]
      );
      if (rows.length === 0) return null;
      row = rows[0];
    } catch (err) {
      logger.warn(`[postmortem] incident row read failed for ${incidentId}: ${errDetail(err)}`);
      return null;
    }

    const unavailable: string[] = [];
    const [remediations, related, confirmed, investigation] = await Promise.all([
      this.remediationsOf(incidentId, unavailable),
      this.relatedOf(incidentId, unavailable),
      this.confirmedOf(incidentId, unavailable),
      this.investigationOf(row.thread_ts ?? null, unavailable),
    ]);

    // NULL on the row is not a failure (an incident with no namespace to scope a timeline to,
    // or no GitOps bridge — agent/changes/index.ts); only a value that cannot be read at all is.
    let changes: ChangeTimeline | null = null;
    try {
      changes = (row.changes ?? null) as ChangeTimeline | null;
    } catch {
      unavailable.push("change timeline");
    }

    return {
      incident: {
        id: Number(row.id),
        alertname: row.alertname,
        namespace: row.namespace ?? null,
        severity: row.severity ?? null,
        assessedSeverity: row.assessed_severity ?? null,
        alertStartedAt: toIso(row.alert_started_at),
        createdAt: toIsoRequired(row.created_at),
        resolvedAt: toIso(row.resolved_at),
        resolvedBy: row.resolved_by ?? null,
        rootCause: row.root_cause ?? null,
        rca: row.rca,
      },
      changes,
      remediations,
      related,
      confirmed,
      investigation,
      unavailable,
    };
  }

  private async remediationsOf(incidentId: number, unavailable: string[]): Promise<PostmortemFacts["remediations"]> {
    try {
      // Same remediation + verification JOIN the dashboard's detail() uses (src/dashboard/queries.ts),
      // narrowed to this incident and to the columns the draft needs.
      const { rows } = await this.pool!.query(
        `SELECT r.action, r.params->>'summary' AS summary, r.status, r.approved_by, r.created_at,
                r.executed_at, r.result, c.verdict
           FROM remediations r
           LEFT JOIN remediation_checks c ON c.remediation_id = r.id
          WHERE r.incident_id = $1 ORDER BY r.created_at LIMIT 50`,
        [incidentId]
      );
      return rows.map((r: any) => ({
        action: r.action,
        summary: r.summary ?? "(remediation)",
        status: r.status,
        approvedBy: r.approved_by ?? null,
        createdAt: toIsoRequired(r.created_at),
        executedAt: toIso(r.executed_at),
        verdict: r.verdict ?? null,
        result: r.result ?? null,
      }));
    } catch (err) {
      logger.warn(`[postmortem] remediations read failed for incident ${incidentId}: ${errDetail(err)}`);
      unavailable.push("remediations");
      return [];
    }
  }

  private async relatedOf(incidentId: number, unavailable: string[]): Promise<PostmortemFacts["related"]> {
    try {
      const { rows } = await this.pool!.query(
        `SELECT id, alertname, subjects, created_at, resolved_at FROM incidents
          WHERE parent_id = $1 ORDER BY created_at`,
        [incidentId]
      );
      return rows.map((r: any) => ({
        id: Number(r.id),
        alertname: r.alertname,
        subjects: r.subjects ?? [],
        createdAt: toIsoRequired(r.created_at),
        resolvedAt: toIso(r.resolved_at),
      }));
    } catch (err) {
      logger.warn(`[postmortem] related alerts read failed for incident ${incidentId}: ${errDetail(err)}`);
      unavailable.push("related alerts");
      return [];
    }
  }

  private async confirmedOf(incidentId: number, unavailable: string[]): Promise<PostmortemFacts["confirmed"]> {
    try {
      const { rows } = await this.pool!.query(
        `SELECT slack_user, confirmed_root_cause, action_taken, outcome, created_at
           FROM incident_feedback WHERE incident_id = $1 ORDER BY created_at`,
        [incidentId]
      );
      return rows.map((r: any) => ({
        by: r.slack_user ?? null,
        rootCause: r.confirmed_root_cause ?? null,
        action: r.action_taken ?? null,
        outcome: r.outcome ?? null,
        at: toIsoRequired(r.created_at),
      }));
    } catch (err) {
      logger.warn(`[postmortem] confirmed feedback read failed for incident ${incidentId}: ${errDetail(err)}`);
      unavailable.push("confirmed feedback");
      return [];
    }
  }

  // The first investigate run's start/end on this incident's OWN thread (never a delegate's
  // `<thread>/sub-N` — see agent/trace/index.ts). Matched by the run id every row in one run
  // shares (TraceRecorder.push), not by chronological nearness, because a re-investigated
  // incident's thread can carry more than one 'start'/'end' pair. No thread_ts (incident memory
  // on but no Slack thread behind this row) is an absence, not a failure: investigation stays
  // null and nothing is added to unavailable.
  private async investigationOf(threadTs: string | null, unavailable: string[]): Promise<PostmortemFacts["investigation"]> {
    if (!threadTs) return null;
    try {
      const { rows } = await this.pool!.query(
        `WITH first_start AS (
           SELECT payload->>'run' AS run, created_at
             FROM agent_events
            WHERE thread_ts = $1 AND kind = 'start' AND payload->>'phase' = 'investigate'
            ORDER BY id LIMIT 1
         )
         SELECT fs.created_at AS started_at, e.created_at AS ended_at
           FROM first_start fs
           LEFT JOIN agent_events e
             ON e.thread_ts = $1 AND e.kind = 'end' AND e.payload->>'run' = fs.run
          ORDER BY e.id LIMIT 1`,
        [threadTs]
      );
      if (rows.length === 0) return { startedAt: null, endedAt: null };
      return { startedAt: toIso(rows[0].started_at), endedAt: toIso(rows[0].ended_at) };
    } catch (err) {
      logger.warn(`[postmortem] investigation trace read failed for thread ${threadTs}: ${errDetail(err)}`);
      unavailable.push("investigation trace");
      return null;
    }
  }
}
