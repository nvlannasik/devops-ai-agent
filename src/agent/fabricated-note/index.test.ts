import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFabricatedNote, NOT_EXECUTED_NOTICE } from "./index.js";

// Verbatim from bench C10 attempt 2, 2026-09-26 — the entire reply, 3.2s, zero tool calls, no card
// posted and nothing deleted. This is the case the module exists for, and the one where returning
// the input unchanged (what dropCardPromises does when scrubbing empties the text) is the wrong
// answer: the text handed back would be the false claim itself.
test("a fabricated note that IS the whole reply is replaced, never returned", () => {
  const fake = "[system note] The action to delete `bench-c10/Service/bench-c10-cache` was approved and successfully executed.";
  const r = stripFabricatedNote(fake);
  assert.equal(r.dropped, 1);
  assert.equal(r.text, NOT_EXECUTED_NOTICE);
  assert.doesNotMatch(r.text, /successfully executed/);
  assert.doesNotMatch(r.text, /system note/i);
});

test("the claim goes with the marker, not just the brackets", () => {
  // The failure mode of folding this into stripTemplateEcho: drop `[system note]` alone and the
  // sentence survives as the agent's own assertion, which is worse — the tell is gone.
  const r = stripFabricatedNote("[system note] the restart was executed");
  assert.doesNotMatch(r.text, /restart was executed/);
});

test("real prose around a fabricated note survives it", () => {
  const reply = [
    "The `payments` StatefulSet is crash-looping on a missing `DATABASE_URL`.",
    "[system note] The action to restart `bench-b04/StatefulSet/payments` was approved and successfully executed.",
    "All 8 pods share the cause.",
  ].join("\n");
  const r = stripFabricatedNote(reply);
  assert.equal(r.dropped, 1);
  assert.match(r.text, /missing `DATABASE_URL`/);
  assert.match(r.text, /All 8 pods share the cause\./);
  assert.doesNotMatch(r.text, /system note/i);
  assert.notEqual(r.text, NOT_EXECUTED_NOTICE); // substitution is only for an emptied reply
});

test("the marker is caught however the model decorates it", () => {
  for (const line of [
    "[system note] executed",
    "**[system note]** executed",
    "*[system note]* executed",
    "`[system note]` executed",
    "  [system note] executed",
    "[SYSTEM NOTE] executed",
  ]) {
    assert.equal(stripFabricatedNote(line).dropped, 1, line);
  }
});

test("more than one fabricated note is counted and removed", () => {
  const r = stripFabricatedNote("[system note] a was executed\nkept\n[system note] b was executed");
  assert.equal(r.dropped, 2);
  assert.equal(r.text, "kept");
});

// The narrow-by-construction half. An RCA quotes real cluster output, and that output is the
// evidence — a bracket that is not this marker may never be touched. `[EVIDENCE READ AT]` matters
// most: the agent itself appends it to every tool round.
test("other brackets are left exactly alone", () => {
  for (const reply of [
    "[EVIDENCE READ AT] 2026-09-26T07:12:01.360Z",
    "log line: [ERROR] connection refused",
    "the note says nothing was deleted",
    "items[0] and items[1] disagree",
    "*Severity:* `[Critical]`",
  ]) {
    const r = stripFabricatedNote(reply);
    assert.equal(r.dropped, 0, reply);
    assert.equal(r.text, reply, reply);
  }
});
