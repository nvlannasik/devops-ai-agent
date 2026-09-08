-- Benchmark results, so a score has a history instead of a terminal it scrolled off.

-- Why a table rather than the JSON files the runner already writes: the bench runs wherever a
-- kubeconfig and an LLM key happen to be — a laptop, a worker node — and the dashboard runs in
-- the cluster. Files on the runner's disk are not readable from the pod, and the whole point of
-- a score is comparing this run to the last one.
--
-- Deliberately its OWN table, not `incidents`. A benchmark case is a synthetic fault, and
-- writing one there would put it into recallIncidents() as prior history for the next real
-- alert, and into the dashboard's cost and severity figures. The design doc names this exact
-- hazard; the isolation is the point.
--
-- Metadata is not decoration here. A pass^k with no record of which backend, which model and
-- which commit produced it cannot be compared to anything — which is what the first three
-- result files on disk already demonstrate: same rates, no way to tell what changed.
CREATE TABLE IF NOT EXISTS bench_runs (
  id           SERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What was measured. git_sha is the agent's code; provider/backends/model is the router
  -- configuration the run actually resolved, not what someone meant to configure.
  git_sha      TEXT,
  provider     TEXT,
  backends     TEXT,
  max_tokens   INTEGER,

  -- Shape of the run.
  cases        INTEGER NOT NULL,
  attempts     INTEGER NOT NULL,

  -- The three rates, stored as fractions 0..1. REAL rather than NUMERIC: these are ratios of
  -- small integers displayed as whole percents, and no arithmetic downstream needs exactness.
  pass1        REAL NOT NULL,
  pass_k       REAL NOT NULL,
  pass_hat_k   REAL NOT NULL,

  -- Per-axis tallies ({"proposal":[6,10],"grounding":[9,10]}) and the full per-attempt record.
  -- jsonb because the axis list grows as the design doc's six get implemented, and a column
  -- per axis would need a migration each time to store a number the page only ever renders.
  axes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  detail       JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- The page reads newest-first and nothing else.
CREATE INDEX IF NOT EXISTS bench_runs_created_at_idx ON bench_runs (created_at DESC);
