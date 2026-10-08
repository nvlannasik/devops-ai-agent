-- What changed in the alert's namespace in the 24h before it fired (agent/changes): rollouts with
-- their pod-template diff, HelmRelease upgrades, ConfigMap updates, GitOps commits, and the
-- sources that could not be read. Stored because the ReplicaSets and the repo move on — the
-- postmortem and the dashboard read the timeline as it was when the alert fired.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS changes jsonb;
