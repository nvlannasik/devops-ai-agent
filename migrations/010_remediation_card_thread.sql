-- The thread the card was posted into, so an expiry can be told to the AGENT as well as the human.
--
-- `noteInThread` is how the loop learns lifecycle facts it never sees itself — a card posted, a
-- card refused. An expiry had no such note, so a model asked "what happened to that card?" would
-- answer from the last thing it knew: that one was posted and a human had to click it.
ALTER TABLE remediations ADD COLUMN IF NOT EXISTS card_thread_ts TEXT;
