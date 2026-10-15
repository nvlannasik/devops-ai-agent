import { test } from "node:test";
import assert from "node:assert/strict";
import { postmortemSlackText } from "./slack.js";
import { assemblePostmortem } from "./draft.js";
import { FIXTURE as F } from "./fixtures.js";

const NARRATIVE = [
  "## Summary", "`checkout-gateway` timed out after a **spec change**.",
  "## Impact", "Checkout failed for 20 minutes.",
  "## Root cause", "Not confirmed by a human; the agent's hypothesis was: `TIMEOUT_MS` 2000 → 50.",
  "## What went well", "- fast rollback",
  "## What went poorly", "- no review",
  "## Action items", "- Bound `TIMEOUT_MS` in the chart schema. _(draft — needs an owner)_", "- Alert on gateway timeouts. _(draft — needs an owner)_",
].join("\n");
const MD = assemblePostmortem(F, NARRATIVE, new Date("2026-10-14T10:25:00Z"));

test("the Slack card is laid out like the RCA: emoji section headers, Numbers from data, numbered actions, a link", () => {
  const t = postmortemSlackText(F, MD, "https://dash.example/incidents/7/postmortem");
  const order = ["*📝 Postmortem draft*", "*⏱️ Numbers*", "*⚡ Summary*", "*📍 Root cause*", "*🔧 Action items*", "🔗 <https://dash.example/incidents/7/postmortem|Full draft on the dashboard>"];
  let at = -1;
  for (const s of order) {
    const i = t.indexOf(s);
    assert.ok(i > at, `${s} missing or out of order`);
    at = i;
  }
  assert.match(t, /`SampleAppHighLatency` · `sample-apps` · ✅ Resolved/);
  // Numbers are numbersOf's, formatted the way renderFacts formats them — never model text
  assert.match(t, /Time to RCA: `4m` · Time to mitigation: `8m` · Duration: `20m`/);
  assert.match(t, /1\. Bound `TIMEOUT_MS` in the chart schema\.\n2\. Alert on gateway timeouts\./);
  assert.doesNotMatch(t, /needs an owner\)_/, "the per-item suffix is noise in Slack; the footer says it once");
  assert.match(t, /\*spec change\*/, "Markdown bold becomes Slack bold");
  assert.doesNotMatch(t, /What went (well|poorly)|Impact/, "Slack carries the summary, not the whole document");
});

test("an open incident, missing numbers, and no public URL", () => {
  const open = { ...F, incident: { ...F.incident, resolvedAt: null, alertStartedAt: null } };
  const t = postmortemSlackText(open, assemblePostmortem(open, NARRATIVE, new Date()), "/incidents/7/postmortem");
  assert.match(t, /🔥 Not marked resolved/);
  assert.match(t, /Time to RCA: `—`/);
  assert.match(t, /Full draft: `\/incidents\/7\/postmortem`/);
});

test("not stored: no link, and the card says so", () => {
  const t = postmortemSlackText(F, MD, null);
  assert.doesNotMatch(t, /🔗/);
  assert.match(t, /not stored — the dashboard will not have it/);
});

test("a section the model did not write still renders a placeholder, not a bare header", () => {
  const md = assemblePostmortem(F, "## Summary\nonly this", new Date());
  const t = postmortemSlackText(F, md, null);
  assert.match(t, /\*🔧 Action items\*\n_Not drafted/);
});
