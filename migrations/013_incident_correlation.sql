-- Cross-group correlation (agent/correlation/topology.ts): an alert group that hits the same
-- service as an open incident, or one call edge away, is stored as a CHILD of it — same Slack
-- thread, `parent_id` set, rca "Merged into …". `subjects` is the service-level identity both
-- sides are matched on. Children are never parents and never recalled (TOP_LEVEL filter).
-- `alert_started_at` is the alert's own start (Alertmanager's startsAt), not when the row was
-- inserted — relatedIncident's 30-minute window is measured against it, via openRelatable.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS subjects jsonb;
-- bigint, not integer: incidents.id is BIGSERIAL, and a foreign key narrower than the column it
-- references silently caps at 2^31 rows rather than erroring on the cast.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS parent_id bigint REFERENCES incidents(id);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS alert_started_at timestamptz;
CREATE INDEX IF NOT EXISTS incidents_open_by_namespace ON incidents (namespace, created_at) WHERE resolved_at IS NULL;
