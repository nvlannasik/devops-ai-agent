// Reading the score history the benchmark commits.
//
// From the FILE, not from a table. bench/results/history.jsonl is in the repo and therefore in
// the image, so this page needs no migration, no database, and no second step after a run —
// which is the whole reason the score is kept in git rather than in Postgres.
//
// The consequence, stated on the page rather than hidden: this shows the history as of the
// IMAGE, not as of the repo's HEAD. A score pushed after this pod's image was built appears
// on the next build. Same contract as the prompt and skill pages, which read what this process
// is holding rather than what is on someone's disk.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import logger from "../utils/logger/index.js";

export interface BenchRun {
  at: string;
  sha: string | null;
  provider: string | null;
  backends: string | null;
  maxTokens: number | null;
  cases: number;
  attempts: number;
  pass1: number;
  passK: number;
  passHatK: number;
  axes: Record<string, [number, number]>;
  /** case id -> one character per attempt, in order: "." pass, "x" fail. */
  marks: Record<string, string>;
  failures: Array<{ case: string; attempt: number; reasons: string[] }>;
}

const HISTORY = join(process.cwd(), "bench", "results", "history.jsonl");

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Newest first, capped. A malformed line is SKIPPED rather than thrown on: this file is
 * appended to by every run on every machine, and one bad line from an interrupted write must
 * not take out the page that shows the other fifty.
 */
export function loadBenchHistory(limit = 20, path = HISTORY): BenchRun[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // no runs yet, which the page explains rather than erroring on
  }
  const out: BenchRun[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r.at !== "string") continue;
      out.push({
        at: r.at,
        sha: str(r.sha),
        provider: str(r.provider),
        backends: str(r.backends),
        maxTokens: typeof r.maxTokens === "number" ? r.maxTokens : null,
        cases: num(r.cases),
        attempts: num(r.attempts),
        pass1: num(r.pass1),
        passK: num(r.passK),
        passHatK: num(r.passHatK),
        axes: (r.axes && typeof r.axes === "object" ? r.axes : {}) as Record<string, [number, number]>,
        marks: (r.marks && typeof r.marks === "object" ? r.marks : {}) as Record<string, string>,
        failures: Array.isArray(r.failures) ? (r.failures as BenchRun["failures"]) : [],
      });
    } catch {
      logger.warn("[dashboard] skipped an unparseable line in the benchmark history");
    }
  }
  return out.reverse().slice(0, limit);
}

/**
 * Pass rate per CASE, across every run in the history, hardest first.
 *
 * Borrowed from k8s-ai-bench's task page, including the ordering, which is the part worth
 * borrowing: a benchmark sorted best-first tells you what already works. Sorted worst-first it
 * tells you what to do on Monday.
 *
 * The rate here is c/n over every attempt ever recorded — their "Overall Pass@1", and a
 * different question from the pass@1 on a run card. That one asks "did the first attempt of
 * that run pass"; this asks "of everything this case has ever been given, how much did it
 * get right". A case that is 1/10 across two runs is a case that does not work, however
 * flattering either run looked on its own.
 */
export interface CaseStat {
  id: string;
  passed: number;
  attempts: number;
  runs: number;
}

export function byCase(history: BenchRun[]): CaseStat[] {
  const acc = new Map<string, CaseStat>();
  for (const run of history) {
    for (const [id, marks] of Object.entries(run.marks ?? {})) {
      const c = acc.get(id) ?? { id, passed: 0, attempts: 0, runs: 0 };
      c.runs += 1;
      for (const m of marks) {
        c.attempts += 1;
        if (m !== "x") c.passed += 1;
      }
      acc.set(id, c);
    }
  }
  return [...acc.values()].sort((a, b) => {
    const ra = a.attempts ? a.passed / a.attempts : 0;
    const rb = b.attempts ? b.passed / b.attempts : 0;
    // Worst first; ties broken by name so the order is stable between renders.
    return ra !== rb ? ra - rb : a.id < b.id ? -1 : 1;
  });
}

/**
 * The same numbers grouped by what was measured, which is k8s-ai-bench's leaderboard.
 *
 * Theirs ranks models; ours ranks CONFIGURATIONS, because a router is not one model and the
 * thing that changes between runs here is usually the backend list, the ceiling, or the
 * commit. One row is not a leaderboard — it becomes one the first time a second backend is
 * measured, and until then it is an honest statement that only one thing has been tried.
 */
export interface ConfigStat {
  backends: string;
  provider: string | null;
  runs: number;
  passed: number;
  attempts: number;
  /** The strictest number this configuration has produced: runs where every attempt passed. */
  cleanRuns: number;
  lastAt: string;
}

export function byConfig(history: BenchRun[]): ConfigStat[] {
  const acc = new Map<string, ConfigStat>();
  for (const run of history) {
    const key = run.backends ?? "(unrecorded)";
    const c = acc.get(key) ?? {
      backends: key, provider: run.provider, runs: 0, passed: 0, attempts: 0, cleanRuns: 0, lastAt: run.at,
    };
    c.runs += 1;
    if (run.at > c.lastAt) c.lastAt = run.at;
    if (run.passHatK === 1) c.cleanRuns += 1;
    for (const marks of Object.values(run.marks ?? {})) {
      for (const m of marks) {
        c.attempts += 1;
        if (m !== "x") c.passed += 1;
      }
    }
    acc.set(key, c);
  }
  const rate = (c: ConfigStat) => (c.attempts ? c.passed / c.attempts : 0);
  return [...acc.values()].sort((a, b) => rate(b) - rate(a));
}
