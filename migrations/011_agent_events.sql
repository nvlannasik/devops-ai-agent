-- One row per event of an investigation run: what the model said (llm), what a tool returned RAW
-- (tool), what a gate decided (gate), bracketed by start/end. Written in one batch when the run
-- ends (agent/trace). Two consumers: the dashboard's Harness page aggregates kind='gate'; replay
-- (docs/superpowers/specs/2026-10-01-harness-trace-design.md) rebuilds a run from all of them.
-- Retention is enforced by TraceStore.prune(): 30 days for run bodies, 180 for gate rows.
CREATE TABLE IF NOT EXISTS agent_events (
  id          BIGSERIAL PRIMARY KEY,
  thread_ts   TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  kind        TEXT        NOT NULL,
  name        TEXT,
  outcome     TEXT,
  payload     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_events_thread ON agent_events (thread_ts, seq);
CREATE INDEX IF NOT EXISTS agent_events_gate   ON agent_events (kind, name, created_at);
