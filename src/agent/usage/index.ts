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
