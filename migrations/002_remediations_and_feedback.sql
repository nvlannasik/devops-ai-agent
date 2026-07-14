-- Shared prerequisites for Guarded Remediation (docs/DESIGN_guarded_remediation.md §5.4)
-- and On-call Feedback Learning (docs/DESIGN_oncall_feedback_learning.md §5.3).
-- IF NOT EXISTS kept so the file is also safe to apply by hand (same convention as 001).

-- (a) Link incidents to their Slack thread so on-call replies and remediation cards
--     can be mapped back to the incident they belong to.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS thread_ts TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS channel   TEXT;
CREATE INDEX IF NOT EXISTS idx_incidents_thread ON incidents (thread_ts);

-- (b) Remediation audit trail (1:N per incident). Also serves as the idempotency lock:
--     execution flips status via UPDATE ... WHERE status='approved' — only one wins.
CREATE TABLE IF NOT EXISTS remediations (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  BIGINT REFERENCES incidents(id),
  action       TEXT NOT NULL,               -- e.g. "k8s_rollout_restart"
  params       JSONB NOT NULL,              -- {namespace, workload, ...}
  status       TEXT NOT NULL,               -- proposed | approved | rejected | executing | succeeded | failed
  proposed_by  TEXT,                        -- 'agent'
  approved_by  TEXT,                        -- Slack user id
  result       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at  TIMESTAMPTZ
);

-- Duplicate-card guard: at most one active remediation per incident. SELECT-then-INSERT
-- is not atomic across pods (TOCTOU); this partial unique index is the real guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_remediation ON remediations (incident_id)
  WHERE status IN ('proposed', 'approved', 'executing');

-- (c) Human-confirmed knowledge tier (on-call feedback) — kept separate from the
--     agent-hypothesis tier (incidents.rca) so trust levels never get flattened.
CREATE TABLE IF NOT EXISTS incident_feedback (
  id                   BIGSERIAL PRIMARY KEY,
  incident_id          BIGINT REFERENCES incidents(id),
  source               TEXT NOT NULL DEFAULT 'human',
  slack_user           TEXT,                -- who confirmed
  confirmed_root_cause TEXT,
  action_taken         TEXT,
  outcome              TEXT,                -- resolved | mitigated | unresolved | unknown
  raw_excerpt          TEXT,                -- provenance: thread text the extraction came from
  trigger_key          TEXT,                -- idempotency key (reaction/message ts)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same trigger must not store twice (multi-pod delivery, double-react).
CREATE UNIQUE INDEX IF NOT EXISTS one_feedback_per_trigger
  ON incident_feedback (incident_id, trigger_key);
