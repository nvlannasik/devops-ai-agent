-- Similarity recall: a third, weaker memory tier ("possibly related") for incidents whose
-- recorded root cause shares vocabulary with the alert under investigation. The two existing
-- tiers key on an exact (alertname, namespace) match, so the agent only ever remembers when
-- the identical alert fires in the identical namespace — a NodeMemoryPressure in `payments`
-- learns nothing from the KubePodOOMKilled it caused there last week.
--
-- Built-in full-text search, deliberately NOT pg_trgm and NOT pgvector:
--   * `CREATE EXTENSION` needs privileges the app role may not hold, and runMigrations()
--     runs inside DevOpsAgent.initialize() — a migration that throws stops the pod from
--     starting. to_tsvector is core Postgres and cannot fail that way.
--   * pgvector would also mean an embedding call per recall (cost + a new failure mode on
--     the read path). Lexical overlap is the weakest tier by design; it only has to be
--     good enough to be worth a look, and the prompt labels it as such.
--
-- to_tsvector(regconfig, text) is IMMUTABLE (the one-argument form is not — it depends on
-- default_text_search_config), so the two-argument form is what a generated column accepts.
-- Adding a STORED generated column rewrites the table; incidents is small (one row per
-- investigation) and this runs once.
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS root_cause_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(root_cause, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_incidents_root_cause_tsv ON incidents USING GIN (root_cause_tsv);
