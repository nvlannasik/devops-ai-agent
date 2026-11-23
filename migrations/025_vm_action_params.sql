-- A VM action's parameters (vm-agent version 5, 2026-11-24): the `journal` read carries how many
-- lines and how far back. NULL for a restart, which has none. Sent to the VM with the claim.
ALTER TABLE vm_actions ADD COLUMN IF NOT EXISTS params JSONB;
