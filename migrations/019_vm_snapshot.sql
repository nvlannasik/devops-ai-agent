-- The host snapshot each devops-vm-agent sends with its heartbeat (vm-agent snapshot(), version 3+):
-- memory, the largest processes by RSS with their systemd unit, memory per systemd service, the
-- kubepods cgroup and root disk. Only the latest is kept; snapshot_at says how old it is. NULL for
-- an agent older than version 3, which sends none.
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS snapshot JSONB;
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS snapshot_at TIMESTAMPTZ;
