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
