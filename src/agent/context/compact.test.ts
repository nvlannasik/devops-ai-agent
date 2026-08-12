import { test } from "node:test";
import assert from "node:assert/strict";
import { compactToolResult, MAX_TOOL_RESULT_CHARS } from "./compact.js";

test("a result under the cap comes back byte-identical", () => {
  const json = JSON.stringify({ pods: [{ name: "api-7f", restarts: 12 }] });
  assert.equal(compactToolResult(json), json);
});

test("a long run of near-identical lines collapses to one line and a count", () => {
  const line = (i: number) => `2026-08-12T14:0${i % 10}:11Z ERROR connection refused to db:5432`;
  const log = Array.from({ length: 400 }, (_, i) => line(i)).join("\n");
  assert.ok(log.length > MAX_TOOL_RESULT_CHARS);

  const out = compactToolResult(log);
  assert.ok(out.length < MAX_TOOL_RESULT_CHARS, `still ${out.length} chars`);
  assert.match(out, /connection refused to db:5432/);
  assert.match(out, /\.\.\. ×399 more like this/);
});

// Global dedupe would merge two phases of an incident. The same error at 14:02 and again at
// 14:31 with recovery in between is the signal, not the noise.
test("two separated runs of the same line stay separate", () => {
  const err = "ERROR connection refused";
  const log = [
    ...Array(5).fill(err),
    "INFO recovered, serving traffic",
    ...Array(5).fill(err),
  ].join("\n");

  const out = compactToolResult(log.padEnd(MAX_TOOL_RESULT_CHARS + 1, "\nINFO tail line"));
  assert.equal([...out.matchAll(/ERROR connection refused/g)].length, 2);
});

test("a run shorter than three lines is left alone", () => {
  const log = ["a", "a", "b"].join("\n").padEnd(MAX_TOOL_RESULT_CHARS + 1, "\nc");
  const out = compactToolResult(log);
  assert.match(out, /^a\na\nb/);
});

// The differentiator has to survive normalize(), so it is spelled in letters. A line numbered
// `line 0`…`line 2999` does NOT work: DIGIT_RUN masks every run of two or more digits, so from
// `line 10` on every line normalizes to the same key, 2990 of them collapse into one, and the
// result lands far under the cap — this test would then pass through the collapse path and never
// reach the truncation it is named after. The doesNotMatch below is what pins that shut.
const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const word = (i: number): string =>
  ALPHA[i % 26]! + ALPHA[Math.floor(i / 26) % 26]! + ALPHA[Math.floor(i / 676) % 26]!;

test("head and tail survive when collapsing is not enough", () => {
  const log = Array.from({ length: 3000 }, (_, i) => `line ${word(i)} unique content ${"x".repeat(20)}`).join("\n");
  const out = compactToolResult(log);
  assert.doesNotMatch(out, /more like this/, "nothing should have collapsed — every line is distinct");
  assert.ok(out.startsWith("line aaa "), "head lost");
  assert.match(out, /\.\.\.\[truncated \d+ chars\]\.\.\./);
  assert.ok(out.trimEnd().endsWith("x".repeat(20)), "tail lost");
});
