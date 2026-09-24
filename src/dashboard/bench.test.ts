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

// ---- aggregation ----------------------------------------------------------------------------

import { byCase, byConfig, spotChecks, suiteRuns } from "./bench.js";

const mk = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    at: "2026-09-08T05:00:00.000Z", sha: "a", provider: "router", backends: "cfg-1",
    maxTokens: 8096, cases: 2, attempts: 5, pass1: 0, passK: 1, passHatK: 0,
    axes: {}, marks: {}, failures: [], ...over,
  });

// The ordering is the borrowed idea, not the table: sorted best-first a benchmark tells you
// what already works.
test("cases are ranked worst first, across every run", () => {
  const p = write(
    mk({ marks: { hard: "xxxxx", easy: "....." } }),
    mk({ at: "2026-09-09T05:00:00.000Z", marks: { hard: "x...x", easy: "....." } }),
  );
  const rows = byCase(loadBenchHistory(20, p));
  assert.deepEqual(rows.map((r) => r.id), ["hard", "easy"]);
  assert.deepEqual({ ...rows[0] }, { id: "hard", passed: 3, attempts: 10, runs: 2, excluded: 0 });
  assert.deepEqual({ ...rows[1] }, { id: "easy", passed: 10, attempts: 10, runs: 2, excluded: 0 });
});

test("a tie between two cases still renders in a stable order", () => {
  const rows = byCase(loadBenchHistory(20, write(mk({ marks: { zebra: "..", alpha: ".." } }))));
  assert.deepEqual(rows.map((r) => r.id), ["alpha", "zebra"]);
});

test("configurations rank best first and count clean runs separately", () => {
  const p = write(
    mk({ backends: "slow", marks: { a: "xxxx." }, passHatK: 0 }),
    mk({ at: "2026-09-09T05:00:00.000Z", backends: "fast", marks: { a: "....." }, passHatK: 1 }),
    mk({ at: "2026-09-10T05:00:00.000Z", backends: "fast", marks: { a: "...x." }, passHatK: 0 }),
  );
  const rows = byConfig(loadBenchHistory(20, p));
  assert.deepEqual(rows.map((r) => r.backends), ["fast", "slow"]);
  assert.deepEqual(
    { runs: rows[0]!.runs, passed: rows[0]!.passed, attempts: rows[0]!.attempts, cleanRuns: rows[0]!.cleanRuns },
    { runs: 2, passed: 9, attempts: 10, cleanRuns: 1 },
  );
  assert.equal(rows[0]!.lastAt, "2026-09-10T05:00:00.000Z", "lastAt is the newest run, not the first seen");
});

test("a run with no backends recorded is grouped, not dropped", () => {
  const rows = byConfig(loadBenchHistory(20, write(mk({ backends: null, marks: { a: "." } }))));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.backends, "(unrecorded)");
});

// The 2026-09-11 run: three C03 attempts died with `429 You have no credits remaining`, and they
// counted against the case for ever — the hardest case on the board, made to look worse by a
// billing problem that was fixed the same day.
test("attempts that threw are excluded from a case's lifetime rate, and counted separately", () => {
  const history = [
    {
      at: "2026-09-11T09:07:00.000Z", attempts: 3, marks: { "C03-evidence-missing-no-logs": "xxx" },
      failures: [1, 2, 3].map((attempt) => ({
        case: "C03-evidence-missing-no-logs", attempt,
        reasons: ["attempt threw: all LLM backends failed — 429 You have no credits remaining"],
      })),
    },
    {
      at: "2026-09-23T03:49:00.000Z", attempts: 3, marks: { "C03-evidence-missing-no-logs": ".xx" },
      failures: [{ case: "C03-evidence-missing-no-logs", attempt: 2, reasons: ["proposed k8s_set_resources, but the correct answer is no proposal"] }],
    },
  ] as unknown as BenchRun[];

  const [c03] = byCase(history);
  assert.equal(c03!.attempts, 3, "only the run that actually ran counts");
  assert.equal(c03!.passed, 1);
  assert.equal(c03!.excluded, 3, "the three that never reached the model are reported, not hidden");
  assert.equal(c03!.runs, 2, "both runs still touched this case");
  // and the configuration rate agrees with it
  assert.equal(byConfig(history)[0]!.attempts, 3);
});

// A subset run's pass@1 is not comparable to a suite's, and the first answer to that was to not
// record it at all — which also threw away six real attempts of B04 and C08 on 2026-09-24. The
// split is per VIEW now: the leaderboard compares runs, so it may read whole-suite ones only; the
// per-case rate asks what a case has ever been given, and a filtered attempt is as real as any.
test("a spot check counts toward its cases and never toward the leaderboard", () => {
  const history = [
    { at: "2026-09-23T03:49:00.000Z", attempts: 3, backends: "cfg", marks: { B04: "xxx" }, filter: null },
    { at: "2026-09-24T09:29:00.000Z", attempts: 3, backends: "cfg", marks: { B04: ".x." }, filter: "^(B04|C08)" },
  ] as unknown as BenchRun[];

  const [b04] = byCase(history);
  assert.equal(b04!.attempts, 6, "the spot check's attempts count for the case");
  assert.equal(b04!.passed, 2);
  assert.equal(b04!.runs, 2);

  const cfg = byConfig(history);
  assert.equal(cfg[0]!.attempts, 3, "the leaderboard sees the suite run only");
  assert.equal(cfg[0]!.passed, 0);

  assert.deepEqual(suiteRuns(history).map((r) => r.at), ["2026-09-23T03:49:00.000Z"]);
  assert.deepEqual(spotChecks(history).map((r) => r.filter), ["^(B04|C08)"]);
});

// Every line written before the field existed is a whole-suite run, and reading them as spot
// checks would empty the leaderboard of its entire history in one deploy.
test("a history line with no filter field is a suite run", () => {
  const rows = loadBenchHistory(20, write(mk({ marks: { a: "." } })));
  assert.equal(rows[0]!.filter, null);
  assert.equal(suiteRuns(rows).length, 1);
});

test("a run with no failures at all is unaffected", () => {
  const history = [{ at: "2026-09-23T03:49:00.000Z", attempts: 2, marks: { "A02-oomkilled-at-limit": ".." } }] as unknown as BenchRun[];
  const [a02] = byCase(history);
  assert.equal(a02!.attempts, 2);
  assert.equal(a02!.excluded, 0);
});
