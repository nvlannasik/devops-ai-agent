-- A recurrence (app/alerts, agent/incidents/repeat.ts, 2026-11-24): the incident whose root cause a
-- shorter investigation started from. NULL for a full investigation. Set after the row is stored;
-- llm_usage joined on incident_id is how the saving is measured.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS repeat_of BIGINT REFERENCES incidents(id);
