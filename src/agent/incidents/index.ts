import { Pool } from "pg";
import { parseConfidence } from "../confidence/index.js";
import logger from "../../utils/logger/index.js";

// Durable cross-incident memory (Postgres). Unlike conversation memory (Redis, 24h TTL,
// cache semantics), this is a system-of-record: resolved RCAs persist so the agent can
// recognize recurring incidents instead of re-diagnosing from scratch every time.
// Schema is owned by migrations/ (see src/db/migrate.ts), not created here.
export class IncidentMemory {
  constructor(private readonly pool: Pool | null) {}

  // Recall prior knowledge for the same alert (+ namespace when present), in two trust
  // tiers that must never be flattened: human-CONFIRMED feedback (strong prior) and
  // agent hypotheses (verify before reuse). ponytail: exact (alertname, namespace)
  // match — no embeddings. Add similarity search only if label match proves too coarse.
  async recall(labels: Record<string, string>, limit = 3): Promise<string> {
    if (!this.pool) return "";
    const alertname = labels.alertname;
    if (!alertname) return ""; // nothing to key on (e.g. ad-hoc mention)
    const namespace = labels.namespace ?? null;

    const [hypo, confirmed] = await Promise.all([
      this.pool.query(
        `SELECT created_at, severity, confidence, root_cause
           FROM incidents
          WHERE alertname = $1 AND ($2::text IS NULL OR namespace = $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [alertname, namespace, limit]
      ),
      this.pool.query(
        `SELECT f.created_at, f.confirmed_root_cause, f.action_taken, f.outcome
           FROM incident_feedback f
           JOIN incidents i ON i.id = f.incident_id
          WHERE i.alertname = $1 AND ($2::text IS NULL OR i.namespace = $2)
          ORDER BY f.created_at DESC
          LIMIT $3`,
        [alertname, namespace, limit]
      ),
    ]);

    const sections: string[] = [];

    if (confirmed.rows.length > 0) {
      const lines = confirmed.rows.map((r: any) => {
        const date = new Date(r.created_at).toISOString().slice(0, 10);
        const parts = [
          r.confirmed_root_cause ? `root cause: ${String(r.confirmed_root_cause).slice(0, 300)}` : null,
          r.action_taken ? `action: ${String(r.action_taken).slice(0, 300)}` : null,
          `outcome: ${r.outcome || "unknown"}`,
        ].filter(Boolean);
        return `- ${date} — ${parts.join("; ")}`;
      });
      sections.push(
        [
          `## Previously CONFIRMED by on-call — same alert${namespace ? ` in namespace ${namespace}` : ""}`,
          ...lines,
          `These were confirmed by a human. Treat them as a strong prior, but verify the current state still matches before reusing.`,
        ].join("\n")
      );
    }

    if (hypo.rows.length > 0) {
      const lines = hypo.rows.map((r: any) => {
        const date = new Date(r.created_at).toISOString().slice(0, 10);
        const cause = (r.root_cause || "").slice(0, 300) || "(no root cause recorded)";
        return `- ${date} (severity ${r.severity || "?"}, confidence ${r.confidence || "?"}): ${cause}`;
      });
      sections.push(
        [
          `## Prior similar incidents — same alert${namespace ? ` in namespace ${namespace}` : ""}`,
          ...lines,
          `These are hypotheses from earlier investigations, NOT ground truth. Confirm with fresh evidence before reusing a root cause.`,
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  // Map a Slack thread back to its incident (threads are linked since migration 002).
  async findIncidentByThread(channel: string, threadTs: string): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT id FROM incidents WHERE channel = $1 AND thread_ts = $2 ORDER BY created_at DESC LIMIT 1`,
      [channel, threadTs]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  // Store human-confirmed feedback (the trusted tier). Idempotent per (incident_id,
  // trigger_key) via the unique index — a duplicate trigger is reported, not an error.
  async storeFeedback(
    incidentId: number,
    fb: {
      slackUser: string;
      triggerKey: string;
      rawExcerpt: string;
      confirmed_root_cause: string | null;
      action_taken: string | null;
      outcome: string;
    }
  ): Promise<"stored" | "duplicate" | "failed"> {
    if (!this.pool) return "failed";
    try {
      await this.pool.query(
        `INSERT INTO incident_feedback
           (incident_id, slack_user, confirmed_root_cause, action_taken, outcome, raw_excerpt, trigger_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [incidentId, fb.slackUser, fb.confirmed_root_cause, fb.action_taken, fb.outcome, fb.rawExcerpt, fb.triggerKey]
      );
      return "stored";
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return "duplicate"; // unique_violation
      logger.error(`[incidents] storeFeedback failed: ${err instanceof Error ? err.message : err}`);
      return "failed";
    }
  }

  // Store a completed RCA. Best-effort — a storage failure must never break the investigation.
  // Returns the new incidents.id so remediations/feedback can link to it (null when
  // disabled, unkeyed, or failed). channel/thread_ts let thread replies map back here.
  async store(
    labels: Record<string, string>,
    rca: string,
    slack?: { channel: string; threadTs: string }
  ): Promise<number | null> {
    if (!this.pool) return null;
    const alertname = labels.alertname;
    if (!alertname) return null;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO incidents (alertname, namespace, severity, confidence, root_cause, rca, channel, thread_ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          alertname,
          labels.namespace ?? null,
          parseSeverity(rca),
          parseConfidence(rca),
          extractRootCause(rca),
          rca,
          slack?.channel ?? null,
          slack?.threadTs ?? null,
        ]
      );
      return Number(rows[0].id); // pg returns BIGSERIAL as string
    } catch (err) {
      logger.error(`[incidents] store failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Cheap reachability check for /health. true when disabled (nothing to be unhealthy about)
  // or when a SELECT 1 succeeds.
  async ping(): Promise<boolean> {
    if (!this.pool) return true;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

// matches the RCA format: "*🔴 Severity:* `critical`" style label
export function parseSeverity(rca: string): string | null {
  const m = rca.match(/\*[^*]*Severity[^*]*\*[^`]*`\[?([^\]`]+)\]?`/i);
  return m ? m[1].trim().toLowerCase() : null;
}

// pull the "📍 Root Cause" section up to the next emoji section header
export function extractRootCause(rca: string): string | null {
  const idx = rca.search(/Root Cause/i);
  if (idx === -1) return null;
  let rest = rca.slice(idx).replace(/^Root Cause[*`:\s]*\n?/i, "");
  const next = rest.search(/[\n\r][^\n]*[📊🚫🔧⚠️📈]/u);
  if (next !== -1) rest = rest.slice(0, next);
  const cleaned = rest.replace(/\s+/g, " ").trim().slice(0, 1000);
  return cleaned || null;
}
