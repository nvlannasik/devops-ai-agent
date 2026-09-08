import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchHistory } from "./bench.js";

const write = (...lines: string[]): string => {
  const p = join(mkdtempSync(join(tmpdir(), "hist-")), "history.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};
const run = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    at: "2026-09-08T05:00:00.000Z", sha: "abc123", provider: "router", backends: "x (m)",
    maxTokens: 8096, cases: 1, attempts: 5, pass1: 0, passK: 1, passHatK: 0,
    axes: { proposal: [1, 5] }, marks: { "A02": "xxxx." }, failures: [], ...over,
  });

test("newest first, because the question is whether the last run moved", () => {
  const p = write(run({ at: "2026-09-01T00:00:00.000Z" }), run({ at: "2026-09-08T00:00:00.000Z" }));
  assert.deepEqual(loadBenchHistory(20, p).map((r) => r.at), [
    "2026-09-08T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
  ]);
});

// This file is appended to by every run on every machine. One truncated write must not take out
// the page that shows the other fifty.
test("a malformed line is skipped, not thrown on", () => {
  const p = write(run(), "{not json", "", run({ at: "2026-09-09T00:00:00.000Z" }));
  const rows = loadBenchHistory(20, p);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.at, "2026-09-09T00:00:00.000Z");
});

test("a line missing its timestamp is not a run", () => {
  assert.deepEqual(loadBenchHistory(20, write(JSON.stringify({ passHatK: 1 }))), []);
});

test("missing fields fall back rather than rendering NaN or undefined", () => {
  const [r] = loadBenchHistory(20, write(JSON.stringify({ at: "2026-09-08T05:00:00.000Z" })));
  assert.equal(r!.passHatK, 0);
  assert.equal(r!.cases, 0);
  assert.equal(r!.sha, null);
  assert.deepEqual(r!.axes, {});
  assert.deepEqual(r!.marks, {});
  assert.deepEqual(r!.failures, []);
});

test("no file at all is an empty page, not an error", () => {
  assert.deepEqual(loadBenchHistory(20, join(tmpdir(), "definitely-not-here", "history.jsonl")), []);
});

test("the cap applies to the newest, not the oldest", () => {
  const p = write(...[1, 2, 3, 4, 5].map((d) => run({ at: `2026-09-0${d}T00:00:00.000Z` })));
  assert.deepEqual(loadBenchHistory(2, p).map((r) => r.at.slice(8, 10)), ["05", "04"]);
});
