import { test } from "node:test";
import assert from "node:assert/strict";
import { postmortemIntent } from "./intent.js";

test("asks for a postmortem, in English and Indonesian", () => {
  for (const t of ["postmortem", "write a postmortem for this", "post-mortem please", "incident review", "bikin postmortem dong", "buat post-mortem untuk insiden ini"]) assert.equal(postmortemIntent(t), "postmortem", t);
});
test("a deferral or refusal is declined", () => {
  for (const t of ["postmortem nanti aja", "jangan bikin postmortem dulu", "no postmortem needed", "skip the postmortem", "postmortem later"]) assert.equal(postmortemIntent(t), "declined", t);
});
test("a negated phrase around postmortem is not a decline", () => {
  for (const t of ["jangan lupa bikin postmortem dong", "don't forget the postmortem"]) assert.equal(postmortemIntent(t), "postmortem", t);
});
test("an unrelated mention is not a postmortem request", () => {
  for (const t of ["why is checkout slow?", "learn", "restart orders-api", "resolved"]) assert.equal(postmortemIntent(t), null, t);
});

// Final-fix item 2: the trigger is anchored to the START of the mention — "postmortem" merely
// appearing somewhere in a sentence about something else must not fire. These three are new
// requirements from the fix brief. "don't skip the root cause section in the postmortem" moved
// here from the NEUTRALIZE group above: "postmortem" sits at the very end of that sentence, not
// the start, so under the anchor it genuinely is not a postmortem request — a reasonable reading
// of a reply that's commenting on an EXISTING draft, not asking to start one. Reported per the
// brief's own escape valve rather than widening the anchor to keep the old (wrong) answer.
test("a mention is anchored to the START — passing mentions of the word don't trigger it", () => {
  for (const t of [
    "investigate why the pod restarted; we'll do the postmortem later",
    "is the root cause in the postmortem right? check rollout history",
    "can you write up why the checkout pod restarts?",
    "don't skip the root cause section in the postmortem",
  ]) {
    assert.equal(postmortemIntent(t), null, t);
  }
});
test("a decline word elsewhere in the sentence, not anchoring the ask itself, does not decline it", () => {
  // "jangan" here declines "sebut nama orang" (don't name people), not the postmortem ask that
  // precedes it — only "jangan" directly before the verb/ask word is a decline (see the other test).
  assert.equal(postmortemIntent("bikin postmortem, jangan sebut nama orang"), "postmortem");
});

test("Indonesian verb suffixes and lead-ins still ask", () => {
  for (const t of ["tolong buatkan postmortem", "bikinin postmortem", "buatin postmortem ya", "bisa bikin postmortem?", "minta postmortem", "mohon dibuatkan postmortem"]) assert.equal(postmortemIntent(t), "postmortem", t);
});
