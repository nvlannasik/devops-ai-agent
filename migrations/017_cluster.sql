-- Multi-cluster 2a (spec docs/superpowers/specs/2026-11-02-multi-cluster-routing-design.md §4).
-- The cluster an incident, a card and its verification check were about. Nullable on purpose:
-- NULL is every row written before multi-cluster, and it reads as the local cluster
-- (MCP_LOCAL_CLUSTER) — no data migration, all of dev's history stays valid. Remediations and
-- checks hold it directly: a mention's card has no incident, and the poller must not join for it.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cluster TEXT;
ALTER TABLE remediations ADD COLUMN IF NOT EXISTS cluster TEXT;
ALTER TABLE remediation_checks ADD COLUMN IF NOT EXISTS cluster TEXT;
