-- Per-call LLM token accounting. One row per chat() call, not per incident: the router
-- made "which backend costs what" a real question, and per-incident totals structurally
-- cannot answer it. incident_id is NULL at insert time (the incident row does not exist
-- yet) and is backfilled by IncidentMemory.store(); rows for conversation-mode replies
-- and failed runs stay NULL forever, which is correct rather than a gap.
CREATE TABLE IF NOT EXISTS llm_usage (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  incident_id            BIGINT REFERENCES incidents(id),
  thread_ts              TEXT,
  backend                TEXT,
  route                  TEXT,
  model                  TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_time    ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_backend ON llm_usage (backend, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_thread  ON llm_usage (thread_ts) WHERE incident_id IS NULL;
