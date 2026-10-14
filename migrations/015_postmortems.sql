-- Postmortem drafts (agent/postmortem, spec docs/superpowers/specs/2026-10-14-postmortem-draft-design.md
-- §4). One row per `@agent postmortem` regeneration, never overwritten — the dashboard and Slack
-- always read the newest by (incident_id, created_at DESC); older drafts stay for history.
CREATE TABLE IF NOT EXISTS postmortems (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES incidents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by TEXT,
  backend TEXT,
  markdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS postmortems_by_incident ON postmortems (incident_id, created_at DESC);
