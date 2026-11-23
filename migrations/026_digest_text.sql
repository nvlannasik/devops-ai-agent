-- The digest's own text (2026-11-24), so the dashboard's /digests can show past days: Slack is not an
-- archive. NULL for a day claimed before this column, or whose post failed.
ALTER TABLE daily_digests ADD COLUMN IF NOT EXISTS text TEXT;
