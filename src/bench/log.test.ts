import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "./log.js";

const line = (over: Record<string, unknown> = {}) => ({
  at: "2026-09-11T09:07:49.771Z",
  sha: "3ef2f9b24912",
  backends: "chatgpt (gpt-5-nano)",
  maxTokens: 16384,
  cases: 2,
  attempts: 3,
  pass1: 0.75,
  passK: 0.88,
  passHatK: 0.56,
  axes: { rca: [21, 24] as [number, number] },
  marks: { "A08-running-never-ready": "xx.", "C01-flap": "..." },
  ...over,
});

test("an empty history says so rather than rendering an empty table", () => {
  assert.match(render([]), /no runs recorded yet/);
});

test("a case absent from a run is dashed to THAT run's attempt count", () => {
  // The five-attempt run is the widest in the window, so a naive renderer pads every absent
  // cell to five and a three-attempt absence reads as a five-attempt one.
  const out = render([line({ attempts: 5, marks: { "A08-running-never-ready": "xx..." } }), line()]);
  const row = out.split("\n").find((l) => l.startsWith("C01-flap"))!;
  assert.match(row, /-----/); // absent from the 5-attempt run
  assert.match(row, /\.\.\./); // present in the 3-attempt one
  assert.doesNotMatch(row, /------/); // and never wider than the run it belongs to
});

test("axes render as fractions, and a run with none says so", () => {
  assert.match(render([line()]), /rca 21\/24/);
  assert.match(render([line({ axes: {} })]), / -$/m);
});

test("the run number in the table heads the matching matrix column", () => {
  const out = render([line({ sha: "aaaaaaa" }), line({ sha: "bbbbbbb" })]);
  const rows = out.split("\n");
  assert.match(rows[1], /^\s+1\s/);
  assert.match(rows[2], /^\s+2\s/);
  const header = rows.find((l) => l.startsWith("case"))!;
  assert.match(header, /1\s+2/);
});
