import { test } from "node:test";
import assert from "node:assert/strict";
import { needsEvidence, NO_EVIDENCE_NOTICE } from "./index.js";

const base = { mode: "alert" as const, toolRounds: 0, nudged: false, toolsDisabled: false };

// A03 #2 and A04 #1: a full RCA from one LLM call and zero tool calls, both wrong on the fact
// they could not have known.
test("an alert answered with no tool call is sent back to look", () => {
  assert.equal(needsEvidence(base), true);
});

test("an alert that called anything at all is left alone", () => {
  assert.equal(needsEvidence({ ...base, toolRounds: 1 }), false);
});

// C07 declines an out-of-scope request with no tools, three times out of three. Nudging it would
// be telling it to go and do the thing it just correctly refused.
test("conversation and investigation modes are never nudged for this", () => {
  assert.equal(needsEvidence({ ...base, mode: "conversation" }), false);
  assert.equal(needsEvidence({ ...base, mode: "investigation" }), false);
});

test("spent once, and never when the tools are already gone", () => {
  assert.equal(needsEvidence({ ...base, nudged: true }), false);
  assert.equal(needsEvidence({ ...base, toolsDisabled: true }), false);
});

test("the notice says the payload is not evidence and the evidence wins", () => {
  assert.match(NO_EVIDENCE_NOTICE, /without calling a single tool/);
  assert.match(NO_EVIDENCE_NOTICE, /starting point of an investigation rather than its evidence/);
  assert.match(NO_EVIDENCE_NOTICE, /the answer was wrong and the evidence wins/);
});
