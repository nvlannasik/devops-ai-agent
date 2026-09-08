// Where a score goes to outlive the terminal.
//
// Git, not Postgres. A table needed a migration run against a cluster before a score could be
// seen, and the runner already lives in a checkout — so the repo is both the store and the
// history, and the dashboard reads the same file the image was built with. One less moving
// part than a database that has to be reachable from wherever the bench happened to run.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
 * The RCA text is NOT in here — it belongs in the transcript the runner already writes. What
 * a reader wants from git is the number, what produced it, and what went wrong.
 */
export function appendHistory(
  path: string,
  input: {
    meta: RunMeta;
    rates: { tasks: number; k: number; pass1: number; passK: number; passHatK: number };
    axes: Record<string, [number, number]>;
    runs: TaskRun[];
  }
): void {
  // `marks` and `failures` are the two parts of the transcript small enough to keep. A run's
  // RCA text is tens of kilobytes and stays out; five failure reasons are about five hundred
  // bytes, and without them the history says a score dropped but not what dropped it — which
  // is the only question anyone opens it to answer.
  //
  // marks is one character per attempt, in order: "xxxx." and ".xxxx" are a flaky case that
  // landed and a good case that broke, and the rate alone cannot tell them apart.
  const marks: Record<string, string> = {};
  const failures: Array<{ case: string; attempt: number; reasons: string[] }> = [];
  for (const r of input.runs) {
    marks[r.task] = r.attempts.map((a) => (a.pass ? "." : "x")).join("");
    r.attempts.forEach((a, i) => {
      if (!a.pass) failures.push({ case: r.task, attempt: i + 1, reasons: a.reasons });
    });
  }

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
    marks,
    failures,
  });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}

/**
 * Commit the history line and push it, so a score reaches the repo without a second step.
 *
 * Scoped to ONE path. `git commit -- <path>` commits that file from the working tree whatever
 * else is staged, which matters because the bench is usually run from a dirty checkout: the
 * whole reason to measure is that something changed.
 *
 * Every failure here is a warning, never a throw. The score is already printed and on disk by
 * the time this runs; no remote, no credentials, a detached HEAD or a protected branch are all
 * reasons to keep the run, not to lose it.
 */
export function publishHistory(path: string): void {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    if (git("status", "--porcelain", "--", path) === "") {
      logger.info("[bench] history unchanged — nothing to publish");
      return;
    }
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch === "HEAD") {
      logger.warn("[bench] detached HEAD — the history line is written but not committed");
      return;
    }
    const line = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
    git("add", "--", path);
    git("commit", "-m", `chore(bench): pass^${line.attempts} ${Math.round(line.passHatK * 100)}% on ${line.cases} case(s)\n\n${JSON.stringify(line)}`, "--", path);
    // Rebase before pushing: the file is append-only and two appends never touch the same
    // line, so a concurrent run elsewhere resolves without a decision from anyone.
    git("pull", "--rebase", "--autostash", "origin", branch);
    git("push", "origin", `HEAD:${branch}`);
    logger.info(`[bench] score committed and pushed to ${branch}`);
  } catch (err) {
    logger.warn(`[bench] could not publish the score (it is still in ${path}): ${errDetail(err)}`);
  }
}
