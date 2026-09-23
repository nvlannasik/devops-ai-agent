import { Pool } from "pg";
import logger from "../../utils/logger/index.js";

// Guarded Remediation store (schema: migrations/002). The remediations row doubles as
// the idempotency lock: status flips are atomic UPDATE ... WHERE status=... — under
// multi-pod delivery or a double-click, exactly one caller wins.

const EXPIRY_MINUTES = 15; // approval window — checked at click time, and by pendingFor

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
  /**
   * A card already waiting for a human, for this exact action and target — in ANY incident.
   *
   * `one_active_remediation` is unique on `incident_id`, which is the right guard for one alert
   * investigated twice and no guard at all for the case measured on 2026-09-22: one armed fault
   * tripped four rules, each became its own incident, and orders-api collected two identical
   * "scale to 3 replicas" cards (85, 88) while checkout-gateway collected two identical restarts
   * (86, 87). Every one of them was legal by incident. None was a second decision to make.
   *
   * Matched on `params.target`, written by all three store sites, so a GitOps PR card and a
   * direct-patch card for the same workload still collide — the human sees one question either way.
   *
   * WITHIN THE APPROVAL WINDOW, and that clause is the whole difference between a guard and a
   * deadlock. `status` only leaves `proposed` when somebody clicks: `claimForExecution` marks a
   * late click `rejected (expired)`, so a card nobody ever touched stays `proposed` forever. Left
   * unbounded, this query would let five stale cards from 2026-09-22 block every future proposal
   * for those workloads — permanently, and silently, since the refusal names a card whose buttons
   * no longer do anything. A card past its window is not a decision anyone still has to make.
   */
  async pendingFor(target: string): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT id FROM remediations
        WHERE status = 'proposed'
          AND params->>'target' = $1
          AND created_at > now() - interval '${EXPIRY_MINUTES} minutes'
        ORDER BY id DESC LIMIT 1`,
      [target]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

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

  /** Remember where the card was posted, so `expireStale` can close the message too. */
  async recordCard(id: number, channel: string, ts: string): Promise<void> {
    if (!this.pool) return;
    await this.pool
      .query(`UPDATE remediations SET card_channel = $2, card_ts = $3 WHERE id = $1`, [id, channel, ts])
      .catch((e) => logger.error(`[remediation] could not record the card message for ${id}: ${e instanceof Error ? e.message : e}`));
  }

  /**
   * Close out every card whose approval window has passed, and say where its message is.
   *
   * `claimForExecution` expires a card when somebody finally clicks it — which is exactly the
   * card that does NOT need expiring, because a human is looking at it. The ones that matter are
   * the ones nobody touched: they stay `proposed` for ever, they keep an Approve button that now
   * refuses, and since 3f12910 they also block every later proposal for the same target.
   *
   * One UPDATE, so under multi-pod delivery exactly one replica gets each row and posts one
   * message about it.
   */
  async expireStale(): Promise<Array<{ id: number; channel: string | null; ts: string | null; summary: string }>> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `UPDATE remediations
            SET status = 'rejected', result = 'expired (approval window passed)'
          WHERE status = 'proposed' AND created_at <= now() - interval '${EXPIRY_MINUTES} minutes'
      RETURNING id, card_channel, card_ts, coalesce(params->>'summary', action) AS summary`
      );
      return rows.map((r) => ({ id: Number(r.id), channel: r.card_channel, ts: r.card_ts, summary: r.summary }));
    } catch (err) {
      logger.error(`[remediation] expiry sweep failed: ${err instanceof Error ? err.message : err}`);
      return [];
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

  /**
   * Stores the manifest of an object `k8s_delete_orphan` removed, on the row that authorised it.
   *
   * Not in `result`: that column is truncated to 2000 chars above, which is fine for a sentence
   * and useless for a manifest — a half-stored backup is worse than none, because it looks like
   * one. `params` is JSONB and untruncated, the row is never pruned (this table has no retention),
   * and the id is printed on the approval card, so the restore path is "look up remediation N".
   *
   * Merged into the existing params rather than replacing them: the tool input has to stay intact
   * for the audit trail to say what was actually run.
   *
   * Best-effort like the rest of the store — but the caller posts the same manifest into the
   * Slack thread, and that copy is the one that survives losing this database.
   */
  async saveBackup(id: number, manifest: unknown): Promise<void> {
    if (!this.pool) return;
    await this.pool
      .query(`UPDATE remediations SET params = params || jsonb_build_object('backupManifest', $2::jsonb) WHERE id = $1`, [
        id,
        JSON.stringify(manifest),
      ])
      .catch((e) => logger.error(`[remediation] backup save failed for ${id}: ${e instanceof Error ? e.message : e}`));
  }

  // Agent memory: past executed remediations for the same alert (joined via the incident),
  // so a recurring incident recalls what was actually done about it before (+ the PR/result).
  //
  // The verdict from the post-remediation check (migrations/006) rides along, and it is the
  // half that matters most: `status = 'succeeded'` only means the MCP call returned cleanly.
  // Whether the alert actually went away is `verdict`, and a `succeeded` + `unchanged` pair
  // is the negative prior — proof the agent already tried this and it didn't work. The join
  // is 1:1 (one_check_per_remediation), so it can't fan the row set out.
  async recallForAlert(
    alertname: string,
    namespace: string | undefined,
    limit = 3
  ): Promise<Array<{ summary: string; status: string; result: string; createdAt: string; verdict: string | null; detail: string | null }>> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT r.params->>'summary' AS summary, r.status, r.result, r.created_at,
                c.verdict, c.detail
           FROM remediations r
           JOIN incidents i ON r.incident_id = i.id
           LEFT JOIN remediation_checks c ON c.remediation_id = r.id AND c.verdict IS NOT NULL
          WHERE i.alertname = $1 AND i.namespace IS NOT DISTINCT FROM $2
            AND r.status IN ('succeeded', 'failed')
          ORDER BY r.created_at DESC LIMIT $3`,
        [alertname, namespace ?? null, limit]
      );
      return rows.map((r: { summary: string | null; status: string; result: string | null; created_at: string; verdict: string | null; detail: string | null }) => ({
        summary: r.summary ?? "(remediation)",
        status: r.status,
        result: r.result ?? "",
        createdAt: r.created_at,
        verdict: r.verdict ?? null, // no check row yet = never verified, which recall says out loud
        detail: r.detail ?? null,
      }));
    } catch (err) {
      logger.error(`[remediation] recallForAlert failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }
}
