// Writing a run to Postgres, so the dashboard has something to read.
//
// Best-effort and OPTIONAL: the runner's job is to produce a score, and a database that is
// unreachable from wherever the bench happens to run must not cost you the run. The JSON
// transcript is always written; this is the copy that outlives the terminal.

import type { Pool } from "pg";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import type { TaskRun } from "./score.js";

export interface RunMeta {
  gitSha: string | null;
  provider: string;
  backends: string;
  maxTokens: number;
}

/**
 * What produced this score. A rate with no record of the backend, the model and the commit
 * cannot be compared to the next one — the three result files already on disk are the proof:
 * two of them disagree by 50 points and neither says what changed.
 *
 * The backends string is read from the RESOLVED registry rather than from the env, so it
 * describes what the router actually held rather than what someone meant to type.
 */
export function runMeta(backendNames: Array<{ name: string; model?: string }>): RunMeta {
  let gitSha: string | null = null;
  try {
    // --dirty, because a score from an edited tree is not a score for that commit, and
    // finding that out six weeks later is worse than a longer string now.
    gitSha = execFileSync("git", ["describe", "--always", "--dirty", "--abbrev=12"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a checkout, or no git — the run is still worth recording
  }
  return {
    gitSha,
    provider: config.llm.provider,
    backends: backendNames.map((b) => (b.model ? `${b.name} (${b.model})` : b.name)).join(", "),
    maxTokens: config.llm.maxTokens,
  };
}

/** Axis name -> [passed, seen]. Rendered as a fraction; kept as a pair so both halves survive. */
export function axisTally(runs: TaskRun[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const a of runs.flatMap((r) => r.attempts)) {
    for (const [axis, pass] of Object.entries(a.axes ?? {})) {
      const t = (out[axis] ??= [0, 0]);
      t[1] += 1;
      if (pass) t[0] += 1;
    }
  }
  return out;
}

export async function saveBenchRun(
  pool: Pool,
  input: {
    meta: RunMeta;
    rates: { tasks: number; k: number; pass1: number; passK: number; passHatK: number };
    axes: Record<string, [number, number]>;
    detail: unknown[];
  }
): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO bench_runs
         (git_sha, provider, backends, max_tokens, cases, attempts, pass1, pass_k, pass_hat_k, axes, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.meta.gitSha,
        input.meta.provider,
        input.meta.backends,
        input.meta.maxTokens,
        input.rates.tasks,
        input.rates.k,
        input.rates.pass1,
        input.rates.passK,
        input.rates.passHatK,
        JSON.stringify(input.axes),
        JSON.stringify(input.detail),
      ]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.error(`[bench] could not store the run (the JSON transcript is still written): ${errDetail(err)}`);
    return null;
  }
}

/**
 * One line per run, appended to a file that IS committed — the transcripts beside it are not.
 *
 * The dashboard answers "did the score move" for anyone with cluster access; this answers it
 * for anyone with the repo, survives the database, and ties a score to the commit that earned
 * it. `git log -p bench/results/history.jsonl` is the whole feature: it shows when the number
 * changed and, in the commits around it, what changed with it.
 *
 * JSONL rather than a table or a JSON array: appending is a one-line diff that never conflicts
 * with another append, which is what makes it safe for CI to write on a schedule while a human
 * writes from a laptop. A JSON array would rewrite the closing bracket on every run and
 * conflict on every parallel one.
 *
 * The transcript is NOT in here. A run's RCA text is tens of kilobytes and belongs in the file
 * the runner already writes; what a reader wants from git is the number and what produced it.
 */
export function appendHistory(path: string, input: { meta: RunMeta; rates: { tasks: number; k: number; pass1: number; passK: number; passHatK: number }; axes: Record<string, [number, number]> }): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    sha: input.meta.gitSha,
    provider: input.meta.provider,
    backends: input.meta.backends,
    maxTokens: input.meta.maxTokens,
    cases: input.rates.tasks,
    attempts: input.rates.k,
    pass1: Number(input.rates.pass1.toFixed(3)),
    passK: Number(input.rates.passK.toFixed(3)),
    passHatK: Number(input.rates.passHatK.toFixed(3)),
    axes: input.axes,
  });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}
