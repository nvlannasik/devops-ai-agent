-- Host silence (app/host-watch, 2026-11-24): a host whose devops-vm-agent stopped heartbeating is
-- announced once in Slack, and its return is posted in the same thread. `silent_since` is the last
-- heartbeat before the silence that was announced (NULL = not announced); setting it IS the claim,
-- so with several replicas exactly one posts. 2026-11-21..23: the three VMs (two of them control
-- planes, etcd lost quorum) were silent for 66 h and the only alert was FluxControllerDown.
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS silent_since TIMESTAMPTZ;
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS silent_channel TEXT;
ALTER TABLE vm_hosts ADD COLUMN IF NOT EXISTS silent_ts TEXT;
