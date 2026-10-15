import { test } from "node:test";
import assert from "node:assert/strict";
import { timelineOf, numbersOf, renderFacts } from "./facts.js";
import { FIXTURE as F } from "./fixtures.js";

test("timelineOf orders every source ascending, the earlier change first", () => {
  const t = timelineOf(F);
  assert.deepEqual(t.map((e) => Date.parse(e.at)), [...t.map((e) => Date.parse(e.at))].sort((a, b) => a - b));
  assert.match(t[0].event, /Deployment\/checkout-gateway/);
  assert.ok(t.some((e) => /approved by U1/.test(e.event)));
  assert.ok(t.some((e) => /recovered/.test(e.event)));
  assert.ok(t.some((e) => /resolved/i.test(e.event)));
});
test("numbersOf: time to RCA, to mitigation (first recovered), duration", () => {
  const n = numbersOf(F);
  assert.equal(n.timeToRcaMs, 4 * 60_000);
  assert.equal(n.timeToMitigationMs, 8 * 60_000);
  assert.equal(n.durationMs, 20 * 60_000);
  assert.equal(n.relatedAlerts, 1);
  assert.equal(n.remediations, 1);
});
test("no real alert start: all three durations are null, and the fallback event reads 'incident recorded'", () => {
  const f = { ...F, incident: { ...F.incident, alertStartedAt: null } };
  const n = numbersOf(f);
  assert.equal(n.timeToRcaMs, null);
  assert.equal(n.timeToMitigationMs, null);
  assert.equal(n.durationMs, null);

  const t = timelineOf(f);
  const fallbackEvent = t.find((e) => e.at === f.incident.createdAt);
  assert.equal(fallbackEvent?.event, "incident recorded");
});
test("an open incident and missing sources give nulls, never a guess", () => {
  const n = numbersOf({ ...F, incident: { ...F.incident, resolvedAt: null }, investigation: null, remediations: [] });
  assert.equal(n.durationMs, null);
  assert.equal(n.timeToRcaMs, null);
  assert.equal(n.timeToMitigationMs, null);
});
test("renderFacts escapes table cells and carries the two fixed headings", () => {
  const md = renderFacts({ ...F, remediations: [{ ...F.remediations[0], summary: "a | b\nc" }] });
  assert.match(md, /^## Timeline\n/);
  assert.match(md, /\n## Numbers\n/);
  assert.match(md, /a \\\| b c/);
});
