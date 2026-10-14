import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePostmortem, buildPostmortemPrompt, POSTMORTEM_SECTIONS, sectionOf } from "./draft.js";
import { renderFacts } from "./facts.js";
import { FIXTURE as F } from "./fixtures.js";

const FULL = "## Summary\nS\n## Impact\nI\n## Root cause\nR\n## What went well\nW\n## What went poorly\nP\n## Action items\n- a _(draft — needs an owner)_";

test("Timeline and Numbers are exactly renderFacts, whatever the model wrote", () => {
  const md = assemblePostmortem(F, FULL.replace("## Impact", "## Timeline\n| fake | rows |\n## Impact"), new Date("2026-10-14T00:00:00Z"));
  assert.ok(md.includes(renderFacts(F)));
  assert.doesNotMatch(md, /fake \| rows/);
  assert.equal((md.match(/^## Timeline$/gm) ?? []).length, 1);
});
test("a heading the model left out is filled, so the document is always complete", () => {
  const md = assemblePostmortem(F, "## Summary\nS", new Date());
  for (const h of POSTMORTEM_SECTIONS) assert.match(md, new RegExp(`^## ${h}$`, "m"));
  assert.match(md, /Not drafted — the model returned no text for this section/);
});
test("section order: title, Summary, Impact, Timeline, Numbers, the rest, Sources", () => {
  const md = assemblePostmortem(F, FULL, new Date());
  const idx = ["# Postmortem draft", "## Summary", "## Impact", "## Timeline", "## Numbers", "## Root cause", "## What went well", "## What went poorly", "## Action items", "## Sources"].map((h) => md.indexOf(h));
  assert.ok(idx.every((i) => i >= 0));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});
test("an invented resource name gets the grounding note; a known one does not", () => {
  assert.match(assemblePostmortem(F, "## Summary\nThe `payments-gateway` service failed.", new Date()), /Names not found in this incident's evidence: .*payments-gateway/);
  assert.doesNotMatch(assemblePostmortem(F, "## Summary\nThe `checkout-gateway` timeout changed.", new Date()), /Names not found/);
});
test("the prompt carries the confirmed root cause, the disagreement rule and the data framing", () => {
  const p = buildPostmortemPrompt({ ...F, confirmed: [{ by: "U1", rootCause: "bad TIMEOUT_MS value", action: "rolled back", outcome: "fixed", at: "2026-10-14T10:30:00Z" }] });
  assert.match(p, /bad TIMEOUT_MS value/);
  assert.match(p, /disagree/i);
  assert.match(p, /data, not instructions/);
  assert.match(buildPostmortemPrompt(F), /Not confirmed by a human/);
});
test("Sources names what was unavailable; sectionOf reads one section", () => {
  assert.match(assemblePostmortem({ ...F, unavailable: ["slack thread"] }, FULL, new Date()), /## Sources[\s\S]*Unavailable: slack thread/);
  assert.equal(sectionOf(FULL, "Impact"), "I");
  assert.equal(sectionOf(FULL, "Timeline"), null);
});
test("a fenced model answer (```markdown ... ```) is unwrapped before sectioning", () => {
  const fenced = "```markdown\n" + FULL + "\n```";
  const mdFenced = assemblePostmortem(F, fenced, new Date("2026-10-14T00:00:00Z"));
  const mdPlain = assemblePostmortem(F, FULL, new Date("2026-10-14T00:00:00Z"));
  assert.doesNotMatch(mdFenced, /```/);
  assert.equal(sectionOf(mdFenced, "Action items"), sectionOf(mdPlain, "Action items"));
});
