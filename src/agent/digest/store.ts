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

  /** The Slack message the day became, and its text — the dashboard's /digests archive (migrations/026). */
  async posted(day: string, ts: string, text: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`UPDATE daily_digests SET ts = $2, text = $3 WHERE day = $1`, [day, ts, text]);
  }

  /** Top-level investigations started in the last `hours`, by alert group; `minCount` keeps only the repeaters. */
  async incidentCounts(hours: number, minCount = 1): Promise<IncidentCount[] | null> {
    if (!this.pool) return null;
    // How long each lasted (alert start → resolve), how many cleared within 30 min, and how many
    // ended in an applied fix — what agent/digest/build.ts tuningHint reads (C3).
    const top = TOP_LEVEL.replace(/\b(parent_id|rca)\b/g, "i.$1");
    const { rows } = await this.pool.query(
      `SELECT i.alertname, i.namespace, i.cluster, count(DISTINCT i.id)::int AS n,
              (count(DISTINCT i.id) FILTER (WHERE i.resolved_at IS NULL))::int AS open,
              (count(DISTINCT i.id) FILTER (WHERE i.resolved_at IS NOT NULL))::int AS resolved,
              (count(DISTINCT i.id) FILTER (WHERE i.resolved_at - COALESCE(i.alert_started_at, i.created_at) < interval '30 minutes'))::int AS quick,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.resolved_at - COALESCE(i.alert_started_at, i.created_at)) / 60) AS median_min,
              count(DISTINCT r.incident_id)::int AS acted
         FROM incidents i LEFT JOIN remediations r ON r.incident_id = i.id AND r.status = 'succeeded'
        WHERE i.created_at > now() - make_interval(hours => $1) AND ${top}
        GROUP BY i.alertname, i.namespace, i.cluster HAVING count(DISTINCT i.id) >= $2
        ORDER BY n DESC, i.alertname LIMIT 20`,
      [hours, minCount]
    );
    return rows.map((r: Record<string, unknown>) => ({
      alertname: String(r.alertname),
      namespace: (r.namespace as string | null) ?? null,
      cluster: (r.cluster as string | null) ?? null,
      count: Number(r.n),
      open: Number(r.open),
      resolved: Number(r.resolved),
      quick: Number(r.quick),
      medianMinutes: r.median_min === null || r.median_min === undefined ? null : Math.round(Number(r.median_min)),
      acted: Number(r.acted),
    }));
  }

  async openTotal(): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM incidents WHERE resolved_at IS NULL AND ${TOP_LEVEL}`);
    return Number(rows[0]?.n ?? 0);
  }
}
