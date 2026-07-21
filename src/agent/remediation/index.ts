import { Pool } from "pg";
import logger from "../../utils/logger/index.js";

// Guarded Remediation store (schema: migrations/002). The remediations row doubles as
// the idempotency lock: status flips are atomic UPDATE ... WHERE status=... — under
// multi-pod delivery or a double-click, exactly one caller wins.

const EXPIRY_MINUTES = 15; // approval window — checked at click time, not post time

export type ClaimResult =
  | { action: string; params: Record<string, unknown> }
  | "expired"
  | "taken"
  | null;

export class RemediationStore {
  constructor(private readonly pool: Pool | null) {}

  // Insert a proposed remediation. The partial unique index (one active remediation per
  // incident) makes a duplicate card impossible across pods — 23505 reports it cleanly.
  // incidentId is null for mention-driven investigations (no alert labels → no incident
  // row); note: NULLs are distinct in the unique index, so the duplicate-card guard only
  // applies to alert-driven remediations — mention ones are explicitly human-triggered.
  async propose(incidentId: number | null, action: string, params: Record<string, unknown>): Promise<number | "duplicate" | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO remediations (incident_id, action, params, status, proposed_by)
         VALUES ($1, $2, $3, 'proposed', 'agent')
         RETURNING id`,
        [incidentId, action, params]
      );
      return Number(rows[0].id);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return "duplicate";
      logger.error(`[remediation] propose failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Atomic approve+claim: proposed → executing in one statement, bounded by the expiry
  // window. 0 rows updated = someone else already handled it, or it expired.
  async claimForExecution(id: number, approvedBy: string): Promise<ClaimResult> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `UPDATE remediations SET status = 'executing', approved_by = $2, executed_at = now()
        WHERE id = $1 AND status = 'proposed' AND created_at > now() - interval '${EXPIRY_MINUTES} minutes'
        RETURNING action, params`,
      [id, approvedBy]
    );
    if (rows.length > 0) return { action: rows[0].action, params: rows[0].params };

    const { rows: cur } = await this.pool.query(`SELECT status FROM remediations WHERE id = $1`, [id]);
    if (cur.length === 0) return null;
    if (cur[0].status === "proposed") {
      // still proposed but the UPDATE didn't match → the window passed. Close it out.
      await this.pool.query(
        `UPDATE remediations SET status = 'rejected', result = 'expired (approval window passed)' WHERE id = $1 AND status = 'proposed'`,
        [id]
      );
      return "expired";
    }
    return "taken";
  }

  async reject(id: number, by: string): Promise<boolean> {
    if (!this.pool) return false;
    const res = await this.pool.query(
      `UPDATE remediations SET status = 'rejected', approved_by = $2 WHERE id = $1 AND status = 'proposed' RETURNING id`,
      [id, by]
    );
    return res.rows.length > 0;
  }

  async finish(id: number, ok: boolean, result: string): Promise<void> {
    if (!this.pool) return;
    await this.pool
      .query(`UPDATE remediations SET status = $2, result = $3 WHERE id = $1`, [id, ok ? "succeeded" : "failed", result.slice(0, 2000)])
      .catch((e) => logger.error(`[remediation] finish failed: ${e instanceof Error ? e.message : e}`));
  }
}
