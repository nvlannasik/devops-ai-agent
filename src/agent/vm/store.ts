import type { Pool } from "pg";
import logger, { errDetail } from "../../utils/logger/index.js";
import { historyPoint, type StoredPoint } from "./history.js";

// Postgres side of the VM agent (migrations/018). No pool: every read is empty and every write a
// no-op — the agent without incident memory has no VM actions either.
export type VmStatus = "succeeded" | "failed" | "refused";

/** Where a host says it sits (vm-agent version 4+): its cluster and Kubernetes node name, or nulls. */
export interface HostPlace {
  cluster: string | null;
  node: string | null;
}

export interface VmHostRow extends HostPlace {
  name: string;
  units: string[];
  version: string | null;
  lastSeenSeconds: number;
  snapshot: Record<string, unknown> | null;
  snapshotAgeSeconds: number | null;
}

export interface SnapshotCandidate extends HostPlace {
  name: string;
  snapshot: Record<string, unknown> | null;
  ageSeconds: number | null;
  version: string | null;
}

export interface VmActionRow {
  id: number;
  host: string;
  unit: string;
  action: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  exitCode: number | null;
}

export class VmStore {
  constructor(private readonly pool: Pool | null) {}

  /** A heartbeat without a snapshot (an agent before version 3) keeps the last one it sent. Its
   *  place (version 4+) is overwritten each time: an older agent sends none and is placed by name. */
  async heartbeat(host: string, units: string[], version: string, snapshot: object | null = null, place: HostPlace = { cluster: null, node: null }): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO vm_hosts (name, units, version, last_seen, snapshot, snapshot_at, cluster, node)
       VALUES ($1, $2, $3, now(), $4::jsonb, CASE WHEN $4::jsonb IS NULL THEN NULL ELSE now() END, $5, $6)
       ON CONFLICT (name) DO UPDATE SET units = EXCLUDED.units, version = EXCLUDED.version, last_seen = now(),
         snapshot = COALESCE(EXCLUDED.snapshot, vm_hosts.snapshot),
         snapshot_at = COALESCE(EXCLUDED.snapshot_at, vm_hosts.snapshot_at),
         cluster = EXCLUDED.cluster, node = EXCLUDED.node`,
      [host, units, version, snapshot === null ? null : JSON.stringify(snapshot), place.cluster, place.node]
    );
    if (snapshot !== null) await this.recordHistory(host, snapshot as Record<string, unknown>);
  }

  /**
   * One history point per host per 5 minutes (migrations/021), pruned past 7 days in the same breath —
   * no cron job. 290 s, not 300: heartbeats come every ~60 s, so the fifth one after a point is the next.
   * A failure here costs the point, never the heartbeat: the latest snapshot is already stored.
   */
  private async recordHistory(host: string, snapshot: Record<string, unknown>): Promise<void> {
    const point = historyPoint(snapshot);
    if (!this.pool || !point) return;
    try {
      const r = await this.pool.query(
        `INSERT INTO vm_host_history (host, point)
         SELECT $1, $2::jsonb WHERE NOT EXISTS (SELECT 1 FROM vm_host_history WHERE host = $1 AND at > now() - interval '290 seconds')`,
        [host, JSON.stringify(point)]
      );
      if (r.rowCount) await this.pool.query(`DELETE FROM vm_host_history WHERE host = $1 AND at < now() - interval '7 days'`, [host]);
    } catch (err) {
      logger.warn(`[vm] history point for ${host} not stored: ${errDetail(err)}`);
    }
  }

  /** A host's history points in the last `hours`, oldest first — what node_host_history summarizes. */
  async history(host: string, hours: number): Promise<StoredPoint[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT at, point FROM vm_host_history WHERE host = $1 AND at > now() - make_interval(hours => $2) ORDER BY at`,
      [host, hours]
    );
    return rows.map((r: { at: Date | string; point: StoredPoint["point"] }) => ({ at: new Date(r.at), point: r.point }));
  }

  /** Every host whose Kubernetes node name (or, without one, whose own name) is `node`, with its
   *  latest snapshot — several when two clusters share a node name. agent/vm/tools picks among them. */
  async snapshotCandidates(node: string): Promise<SnapshotCandidate[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT name, cluster, node, snapshot, version, extract(epoch FROM now() - snapshot_at)::int AS age
         FROM vm_hosts WHERE COALESCE(node, name) = $1 OR name = $1 ORDER BY name`,
      [node]
    );
    return rows.map((r: Record<string, unknown>) => ({
      name: String(r.name),
      cluster: (r.cluster as string | null) ?? null,
      node: (r.node as string | null) ?? null,
      snapshot: (r.snapshot as Record<string, unknown> | null) ?? null,
      ageSeconds: r.age === null ? null : Number(r.age),
      version: (r.version as string | null) ?? null,
    }));
  }

  /** The VM's allowlist while it is alive (a heartbeat within 5 minutes), else null. */
  async registered(host: string): Promise<{ units: string[] } | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT units FROM vm_hosts WHERE name = $1 AND last_seen > now() - interval '5 minutes'`, [host]);
    return rows[0] ? { units: rows[0].units as string[] } : null;
  }

  /** Every VM alive now (a heartbeat within 5 minutes) — what a mention can name. */
  async registeredHosts(): Promise<Array<{ host: string; units: string[] }>> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(`SELECT name, units FROM vm_hosts WHERE last_seen > now() - interval '5 minutes' ORDER BY name`);
    return rows.map((r: { name: string; units: string[] }) => ({ host: r.name, units: r.units }));
  }

  /** Every host that ever heartbeated, with its latest snapshot and ages — the dashboard's /nodes. */
  async hosts(): Promise<VmHostRow[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT name, units, version, snapshot, cluster, node,
              extract(epoch FROM now() - last_seen)::int AS seen_age,
              extract(epoch FROM now() - snapshot_at)::int AS snapshot_age
         FROM vm_hosts ORDER BY name`
    );
    return rows.map((r: Record<string, unknown>) => ({
      name: String(r.name),
      cluster: (r.cluster as string | null) ?? null,
      node: (r.node as string | null) ?? null,
      units: (r.units as string[]) ?? [],
      version: (r.version as string | null) ?? null,
      lastSeenSeconds: Number(r.seen_age),
      snapshot: (r.snapshot as Record<string, unknown> | null) ?? null,
      snapshotAgeSeconds: r.snapshot_age === null ? null : Number(r.snapshot_age),
    }));
  }

  /** The newest VM actions, any host — what was asked of the hosts and what they answered. */
  async recentActions(limit = 30): Promise<VmActionRow[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT id, host, unit, action, status, created_at, finished_at, result->>'exitCode' AS exit_code
         FROM vm_actions ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      host: String(r.host),
      unit: String(r.unit),
      action: String(r.action),
      status: String(r.status),
      createdAt: r.created_at as Date,
      finishedAt: (r.finished_at as Date | null) ?? null,
      exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    }));
  }

  async enqueue(host: string, unit: string, remediationId: number | null): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`INSERT INTO vm_actions (host, unit, remediation_id) VALUES ($1, $2, $3) RETURNING id`, [host, unit, remediationId]);
    return Number(rows[0].id);
  }

  /** The next approved action for `host`, taken exactly once; stale ones expire first and never run. */
  async claim(host: string): Promise<{ id: number; unit: string; action: "restart" } | null> {
    if (!this.pool) return null;
    await this.pool.query(
      `UPDATE vm_actions SET status = 'expired', finished_at = now()
        WHERE host = $1 AND status = 'pending' AND created_at <= now() - interval '15 minutes'`,
      [host]
    );
    const { rows } = await this.pool.query(
      `UPDATE vm_actions SET status = 'claimed', claimed_at = now()
        WHERE id = (SELECT id FROM vm_actions
                     WHERE host = $1 AND status = 'pending' AND created_at > now() - interval '15 minutes'
                     ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, unit, action`,
      [host]
    );
    return rows[0] ? { id: Number(rows[0].id), unit: rows[0].unit, action: "restart" } : null;
  }

  /** Records the VM's report on ITS claimed action; null when the id is not that host's claim. */
  async finish(id: number, host: string, status: VmStatus, result: object): Promise<{ remediationId: number | null } | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `UPDATE vm_actions SET status = $3, result = $4, finished_at = now()
        WHERE id = $1 AND host = $2 AND status = 'claimed' RETURNING remediation_id`,
      [id, host, status, JSON.stringify(result)]
    );
    return rows[0] ? { remediationId: rows[0].remediation_id === null ? null : Number(rows[0].remediation_id) } : null;
  }
}
