import type { Pool } from "pg";
import logger, { errDetail } from "../../utils/logger/index.js";

export interface EventRow {
  threadTs: string;
  seq: number;
  kind: "start" | "llm" | "tool" | "gate" | "end";
  name: string | null;
  outcome: string | null;
  payload: Record<string, unknown>;
}

/** Rows per INSERT: seven parameters each keeps one statement far under Postgres' 65535 limit. */
export const INSERT_CHUNK = 500;
export const RUN_RETENTION_DAYS = 30;
export const GATE_RETENTION_DAYS = 180;
/** Rows deleted per kind per pass — a backlog is worked off over passes, never one long lock. */
const PRUNE_LIMIT = 5000;
/**
 * The poller ticks every 30s, and neither DELETE can use an index (`kind <> 'gate'`), so each
 * pass is a sequential scan. Retention is measured in days; an hour between passes loses nothing.
 */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

// Best-effort like UsageStore: losing a trace must never fail the investigation it describes.
export class TraceStore {
  private lastPrune = 0;

  constructor(private readonly pool: Pool | null) {}

  async insert(rows: EventRow[]): Promise<void> {
    if (!this.pool || rows.length === 0) return;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [];
      const values = chunk.map((r, j) => {
        params.push(r.threadTs, r.seq, r.kind, r.name, r.outcome, JSON.stringify(r.payload), null);
        const b = j * 7;
        // The 7th slot overrides created_at and is always NULL here → now(). It is a slot so a
        // replay import can keep original timestamps later without a second statement shape.
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, COALESCE($${b + 7}::timestamptz, now()))`;
      });
      try {
        await this.pool.query(
          `INSERT INTO agent_events (thread_ts, seq, kind, name, outcome, payload, created_at) VALUES ${values.join(", ")}`,
          params
        );
      } catch (err) {
        logger.warn(`[trace] insert of ${chunk.length} event(s) for ${chunk[0]!.threadTs} failed (trace lost, investigation unaffected): ${errDetail(err)}`);
      }
    }
  }

  /** Retention (spec §4.3). Returns rows deleted; 0 on any failure. */
  async prune(): Promise<number> {
    if (!this.pool || Date.now() - this.lastPrune < PRUNE_EVERY_MS) return 0;
    this.lastPrune = Date.now();
    try {
      const runs = await this.pool.query(
        `DELETE FROM agent_events WHERE id IN (
           SELECT id FROM agent_events
            WHERE kind <> 'gate' AND created_at < now() - interval '${RUN_RETENTION_DAYS} days' LIMIT ${PRUNE_LIMIT})`
      );
      const gates = await this.pool.query(
        `DELETE FROM agent_events WHERE id IN (
           SELECT id FROM agent_events
            WHERE kind = 'gate' AND created_at < now() - interval '${GATE_RETENTION_DAYS} days' LIMIT ${PRUNE_LIMIT})`
      );
      return (runs.rowCount ?? 0) + (gates.rowCount ?? 0);
    } catch (err) {
      logger.warn(`[trace] prune failed: ${errDetail(err)}`);
      return 0;
    }
  }
}
