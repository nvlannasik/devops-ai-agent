-- The daily health digest (C1, agent/digest): one row per local day it was posted for. The INSERT
-- that creates the row IS the claim — with several replicas exactly one wins the day — and `ts` is
-- the Slack message it became (NULL while posting, or when the post failed after the claim).
CREATE TABLE IF NOT EXISTS daily_digests (
  day        DATE PRIMARY KEY,
  channel    TEXT NOT NULL,
  ts         TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
