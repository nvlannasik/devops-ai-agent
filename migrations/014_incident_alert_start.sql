-- 013 was edited after its first version had already run in production (2026-10-13), so the
-- columns it gained later never reached that database. This file carries them idempotently:
-- a no-op where the edited 013 ran, the missing piece where the original did.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS alert_started_at timestamptz;
ALTER TABLE incidents ALTER COLUMN parent_id TYPE bigint;
