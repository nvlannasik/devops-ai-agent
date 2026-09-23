-- Where the approval card was posted, so a card can be closed by something other than a click.
--
-- The message `ts` only ever existed inside the button payload, which means it was known at
-- CLICK time and nowhere else. A card nobody clicks keeps its Approve button for ever while the
-- row behind it has been past EXPIRY_MINUTES for days — the buttons lie, and the sweeper that
-- would fix the row could not reach the message to say so.
ALTER TABLE remediations ADD COLUMN IF NOT EXISTS card_channel TEXT;
ALTER TABLE remediations ADD COLUMN IF NOT EXISTS card_ts      TEXT;
