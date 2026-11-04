import type { Pool } from "pg";

// Postgres side of the VM agent (migrations/018). No pool: every read is empty and every write a
// no-op — the agent without incident memory has no VM actions either.
export type VmStatus = "succeeded" | "failed" | "refused";

export class VmStore {
  constructor(private readonly pool: Pool | null) {}

  async heartbeat(host: string, units: string[], version: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO vm_hosts (name, units, version, last_seen) VALUES ($1, $2, $3, now())
       ON CONFLICT (name) DO UPDATE SET units = EXCLUDED.units, version = EXCLUDED.version, last_seen = now()`,
      [host, units, version]
    );
  }

  /** The VM's allowlist while it is alive (a heartbeat within 5 minutes), else null. */
  async registered(host: string): Promise<{ units: string[] } | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`SELECT units FROM vm_hosts WHERE name = $1 AND last_seen > now() - interval '5 minutes'`, [host]);
    return rows[0] ? { units: rows[0].units as string[] } : null;
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
