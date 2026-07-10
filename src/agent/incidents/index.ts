import { Pool } from "pg";
import { parseConfidence } from "../confidence/index.js";
import logger from "../../utils/logger/index.js";

// Durable cross-incident memory (Postgres). Unlike conversation memory (Redis, 24h TTL,
// cache semantics), this is a system-of-record: resolved RCAs persist so the agent can
// recognize recurring incidents instead of re-diagnosing from scratch every time.
// Schema is owned by migrations/ (see src/db/migrate.ts), not created here.
export class IncidentMemory {
  constructor(private readonly pool: Pool | null) {}

  // Recall recent resolved incidents matching the same alert (+ namespace when present).
  // ponytail: exact (alertname, namespace) match — no embeddings. Add similarity search
  // only if label match proves too coarse.
  async recall(labels: Record<string, string>, limit = 3): Promise<string> {
    if (!this.pool) return "";
    const alertname = labels.alertname;
    if (!alertname) return ""; // nothing to key on (e.g. ad-hoc mention)
    const namespace = labels.namespace ?? null;

    const { rows } = await this.pool.query(
      `SELECT created_at, severity, confidence, root_cause
         FROM incidents
        WHERE alertname = $1 AND ($2::text IS NULL OR namespace = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [alertname, namespace, limit]
    );
    if (rows.length === 0) return "";

    const lines = rows.map((r: any) => {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const cause = (r.root_cause || "").slice(0, 300) || "(no root cause recorded)";
      return `- ${date} (severity ${r.severity || "?"}, confidence ${r.confidence || "?"}): ${cause}`;
    });

    return [
      `## Prior similar incidents — same alert${namespace ? ` in namespace ${namespace}` : ""}`,
      ...lines,
      `These are hypotheses from earlier investigations, NOT ground truth. Confirm with fresh evidence before reusing a root cause.`,
    ].join("\n");
  }

  // Store a completed RCA. Best-effort — a storage failure must never break the investigation.
  async store(labels: Record<string, string>, rca: string): Promise<void> {
    if (!this.pool) return;
    const alertname = labels.alertname;
    if (!alertname) return;
    try {
      await this.pool.query(
        `INSERT INTO incidents (alertname, namespace, severity, confidence, root_cause, rca)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [alertname, labels.namespace ?? null, parseSeverity(rca), parseConfidence(rca), extractRootCause(rca), rca]
      );
    } catch (err) {
      logger.error(`[incidents] store failed: ${err instanceof Error ? err.message : err}`);
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
