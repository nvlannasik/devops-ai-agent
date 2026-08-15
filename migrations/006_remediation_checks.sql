-- Post-remediation verification. What this replaces was a setTimeout in whichever pod
-- handled the approval click: lost on restart, and it answered the wrong question — it
-- dumped the namespace's pod list into the thread instead of saying whether the problem
-- went away. One row here = one scheduled "did that actually fix it?", with the verdict
-- kept so a later investigation can read it as a prior.
--
-- The schedule is durable and the poller is not tied to the pod that created the row:
-- any replica claims whatever is due. due_at doubles as the lease — claiming pushes it
-- forward, so a pod that dies mid-check releases the row on its own instead of stranding
-- it in 'running' (the visibility-timeout idea the SQS queues already use here).
CREATE TABLE IF NOT EXISTS remediation_checks (
  id             BIGSERIAL PRIMARY KEY,
  remediation_id BIGINT NOT NULL REFERENCES remediations(id),
  incident_id    BIGINT REFERENCES incidents(id),
  channel        TEXT NOT NULL,       -- where the verdict gets posted
  thread_ts      TEXT NOT NULL,
  alertname      TEXT,                -- NULL for mention-driven remediations: no alert to re-check
  namespace      TEXT,
  target         JSONB NOT NULL,      -- {namespace, name} of the remediated workload
  before_state   JSONB,               -- pod health at approval time — the baseline "worse" compares against
  due_at         TIMESTAMPTZ NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | abandoned
  verdict        TEXT,                -- recovered | unchanged | worse | inconclusive
  detail         TEXT,                -- the evidence the verdict was read from
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at     TIMESTAMPTZ
);

-- One verdict per remediation. The approve path is already idempotent (claimForExecution),
-- but a retry after a partial failure must not schedule a second check for the same action —
-- and the recall join below relies on this being at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS one_check_per_remediation ON remediation_checks (remediation_id);

-- The poller's only query: what is due, oldest first. Partial so finished checks — which is
-- eventually all of them — never widen it.
CREATE INDEX IF NOT EXISTS idx_remediation_checks_due ON remediation_checks (due_at)
  WHERE status IN ('pending', 'running');
