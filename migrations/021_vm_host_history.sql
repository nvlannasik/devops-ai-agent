-- Host snapshot history (B1): one compact point per host every 5 minutes, kept 7 days, so the agent
-- can answer "what grew?" (etcd 250 -> 360Mi over two days) — vm_hosts.snapshot holds only the
-- latest. A point is NOT the raw snapshot: memory totals, the kubepods cgroup, memory per systemd
-- unit, RSS per process name (summed, with where it runs) and root disk — about 1 KB, against the
-- raw snapshot's several. Written by VmStore.heartbeat, pruned there too (no cron job).
CREATE TABLE IF NOT EXISTS vm_host_history (
  host  TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  point JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS vm_host_history_host_at ON vm_host_history (host, at);
