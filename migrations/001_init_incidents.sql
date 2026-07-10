-- Durable incident memory: one row per resolved RCA, recalled by (alertname, namespace).
-- IF NOT EXISTS kept so the file is also safe to apply by hand; schema_migrations
-- normally prevents re-running it.
CREATE TABLE IF NOT EXISTS incidents (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  alertname   TEXT NOT NULL,
  namespace   TEXT,
  severity    TEXT,
  confidence  TEXT,
  root_cause  TEXT,
  rca         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_lookup ON incidents (alertname, namespace, created_at DESC);
