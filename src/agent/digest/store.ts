import type { Pool } from "pg";
import { TOP_LEVEL } from "../incidents/index.js";
import type { IncidentCount } from "./build.js";

// Postgres side of the daily digest (migrations/022): the per-day claim, and the incident counts it
// reports. No pool: no claim is ever won and every read is null — the digest then says "not read".
export class DigestStore {
  constructor(private readonly pool: Pool | null) {}

  get enabled(): boolean {
    return this.pool !== null;
  }

  /** Claims `day` for this replica. True for exactly one caller per day, ever. */
  async claim(day: string, channel: string): Promise<boolean> {
    if (!this.pool) return false;
    const r = await this.pool.query(`INSERT INTO daily_digests (day, channel) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING RETURNING day`, [day, channel]);
    return (r.rowCount ?? 0) > 0;
  }

  async posted(day: string, ts: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`UPDATE daily_digests SET ts = $2 WHERE day = $1`, [day, ts]);
  }

  /** Top-level investigations started in the last `hours`, by alert group; `minCount` keeps only the repeaters. */
  async incidentCounts(hours: number, minCount = 1): Promise<IncidentCount[] | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT alertname, namespace, cluster, count(*)::int AS n, (count(*) FILTER (WHERE resolved_at IS NULL))::int AS open
         FROM incidents WHERE created_at > now() - make_interval(hours => $1) AND ${TOP_LEVEL}
        GROUP BY alertname, namespace, cluster HAVING count(*) >= $2
        ORDER BY n DESC, alertname LIMIT 20`,
      [hours, minCount]
    );
    return rows.map((r: Record<string, unknown>) => ({
      alertname: String(r.alertname),
      namespace: (r.namespace as string | null) ?? null,
      cluster: (r.cluster as string | null) ?? null,
      count: Number(r.n),
      open: Number(r.open),
    }));
  }

  async openTotal(): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM incidents WHERE resolved_at IS NULL AND ${TOP_LEVEL}`);
    return Number(rows[0]?.n ?? 0);
  }
}
