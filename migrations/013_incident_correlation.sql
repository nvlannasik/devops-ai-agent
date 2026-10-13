-- Cross-group correlation (agent/correlation/topology.ts): an alert group that hits the same
-- service as an open incident, or one call edge away, is stored as a CHILD of it — same Slack
-- thread, `parent_id` set, rca "Merged into …". `subjects` is the service-level identity both
-- sides are matched on. Children are never parents and never recalled (TOP_LEVEL filter).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS subjects jsonb;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES incidents(id);
CREATE INDEX IF NOT EXISTS incidents_open_by_namespace ON incidents (namespace, created_at) WHERE resolved_at IS NULL;
