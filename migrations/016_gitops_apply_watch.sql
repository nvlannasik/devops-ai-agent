-- GitOps PR remediations get verified too (2026-10-23). Until now `succeeded` on a PR meant only
-- "the PR is open": no check was scheduled, so a Flux workload's fix never got a verdict and recall
-- never learned whether it worked. A PR now leaves a check in status 'awaiting' that the poller
-- re-reads every minute until the live object runs what the PR set (merge + Flux sync), then turns
-- 'pending' and runs the ordinary verification. Never applied by apply_by → 'expired', no verdict.
ALTER TABLE remediation_checks ADD COLUMN IF NOT EXISTS expect JSONB;          -- {image?, container?, replicas?}
ALTER TABLE remediation_checks ADD COLUMN IF NOT EXISTS apply_by TIMESTAMPTZ;  -- when an awaiting check gives up

-- The poller's partial index has to cover the new status, or every poll of an awaiting check is a scan.
DROP INDEX IF EXISTS idx_remediation_checks_due;
CREATE INDEX IF NOT EXISTS idx_remediation_checks_due ON remediation_checks (due_at)
  WHERE status IN ('pending', 'running', 'awaiting');
