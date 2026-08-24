-- Incident status reconciliation + on-call status feedback.
--
-- Why: `resolved_at` had exactly one writer — the Alertmanager resolved webhook. That POST
-- is never repeated (repeat_interval covers firing only; a resolved group is dropped after
-- its notification) and the agent acks it with 200 BEFORE processing it, so any failure
-- downstream of the ack loses the resolved event permanently. The incident then reads as
-- firing forever AND its dedup claim is never released, which suppresses the next real
-- firing of the same alert for the claim's whole TTL.

-- The exact group identity the alert was claimed under (Alertmanager commonLabels, which is
-- usually richer than group_by). Needed to release the dedup claim from anywhere other than
-- the webhook — alertname+namespace alone hashes to a different fingerprint.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS group_labels JSONB;

-- Who closed it: 'alertmanager' (webhook), 'reconciler' (the sweeper below), or a Slack
-- user id when on-call said so. An auto-closed incident and a human-closed one are not the
-- same evidence, and until now nothing recorded which had happened.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- The reconciler requires an alert to read as cleared on two separate passes before it
-- closes anything. This is where the first sighting is remembered, so the confirmation
-- survives a pod restart and works across replicas.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cleared_seen_at TIMESTAMPTZ;

-- The sweeper's only query: oldest-first over unresolved incidents.
CREATE INDEX IF NOT EXISTS incidents_unresolved_idx ON incidents (created_at) WHERE resolved_at IS NULL;
