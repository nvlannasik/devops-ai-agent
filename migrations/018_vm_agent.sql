-- The VM agent (spec docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md, Part B).
-- vm_hosts: what each VM last said it allows (its own config's `units`), and when it last spoke —
-- a VM is "registered" while last_seen is within 5 minutes. vm_actions: approved restarts waiting
-- for their VM to pull them. A pending row older than 15 minutes expires and never runs; a claimed
-- row is never handed out again (VmStore.claim is one UPDATE … RETURNING).
CREATE TABLE IF NOT EXISTS vm_hosts (
  name       TEXT PRIMARY KEY,
  units      TEXT[] NOT NULL DEFAULT '{}',
  version    TEXT,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vm_actions (
  id              BIGSERIAL PRIMARY KEY,
  host            TEXT NOT NULL,
  unit            TEXT NOT NULL,
  action          TEXT NOT NULL DEFAULT 'restart',
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | succeeded | failed | refused | expired
  remediation_id  BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  result          JSONB
);
CREATE INDEX IF NOT EXISTS vm_actions_pending ON vm_actions (host, id) WHERE status = 'pending';
