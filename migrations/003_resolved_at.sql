-- D. Resolved-alert loop: when Alertmanager reports an alert resolved, the newest
-- matching incident records it and the Slack thread gets a ✅ update.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
