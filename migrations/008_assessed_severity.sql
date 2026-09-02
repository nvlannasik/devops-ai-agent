-- Split the two things `incidents.severity` was holding at once.
--
-- Why: the column had two writers with incompatible vocabularies. Alertmanager labels say
-- `critical`/`warning`/`info`; the agent's own Severity Guidelines say Critical/High/Medium/Low.
-- `store()` preferred whatever it could parse out of the RCA text, so an alert that fired as
-- `warning` and drew a `Critical` RCA was stored as `critical` — contradicting the Slack card,
-- which renders the label straight from Alertmanager. The dashboard already assumed the label
-- vocabulary (its filter offers exactly critical/warning/info), so rows written in the agent's
-- vocabulary were unreachable from it, and `recall()` fed the wrong level back into the next
-- investigation of the same alert.
--
-- After this: `severity` is the fact (the Alertmanager label, NULL for ad-hoc mentions with no
-- alert behind them) and `assessed_severity` is the agent's impact judgement. They answer
-- different questions and disagreeing is meaningful — a `warning` assessed Critical is exactly
-- the signal worth keeping.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS assessed_severity TEXT;

-- Existing rows: anything in the agent's vocabulary can only have come from an RCA, so move it
-- across. `critical` is ambiguous (either writer could have produced it) — copy rather than move,
-- leaving `severity` intact where it is already label-shaped. Rows whose true label was `warning`
-- or `info` but were overwritten with `critical` cannot be recovered from this column; where the
-- webhook stored group_labels (migration 007 onward) the label is still there, so prefer it.
UPDATE incidents
   SET assessed_severity = severity
 WHERE assessed_severity IS NULL
   AND lower(severity) IN ('critical', 'high', 'medium', 'low');

UPDATE incidents
   SET severity = lower(group_labels->>'severity')
 WHERE group_labels->>'severity' IS NOT NULL
   AND lower(severity) IS DISTINCT FROM lower(group_labels->>'severity');

-- No label to recover (group_labels absent, or present without a severity key) and a value
-- that only the agent's vocabulary has: it was never a label, so stop presenting it as one.
-- `critical` is left alone even here — it may well be the real label.
UPDATE incidents
   SET severity = NULL
 WHERE group_labels->>'severity' IS NULL
   AND lower(severity) IN ('high', 'medium', 'low');
