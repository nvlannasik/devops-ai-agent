import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One row as `/api/trace/:thread` returns it (agent_events, migrations/011). Array order = insert order. */
export interface TraceEvent {
  thread_ts: string;
  seq: number;
  kind: string;
  name: string | null;
  outcome: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

/** One investigation run, its delegates' runs and its proposal run — what a replay plays back. */
export interface Trace {
  thread: string;
  events: TraceEvent[];
}

/** What a case expects of its replay (spec §8.1). Regexes are case-insensitive. */
export interface Expect {
  answer?: { must?: string[]; mustNot?: string[] };
  gates?: { must?: string[]; mustNot?: string[] };
  proposal?: { action: string | null };
  allowDiverge?: boolean;
}

const isSub = (thread: string): boolean => thread.includes("/sub-");

/**
 * Narrows a thread's events to ONE investigation run. A thread holds several (the alert, then
 * every follow-up mention), and each run's delegates and proposal are separate runs too, so the
 * association is by write order: a delegate's run is flushed before its parent's (runDelegates
 * finishes inside the parent's loop), and the proposal run is started after the parent's ended.
 * Rows with no run id — gates the app records after the run was flushed — belong to no run.
 */
export function selectRun(events: TraceEvent[], runId?: string): Trace {
  const parentStarts = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === "start" && !isSub(e.thread_ts) && e.payload.phase === "investigate");
  const chosen = runId ? parentStarts.find(({ e }) => e.payload.run === runId) : parentStarts.at(-1);
  if (!chosen) throw new Error(runId ? `no investigation run ${runId} in this trace` : "no investigation run in this trace");
  const run: string = chosen.e.payload.run;

  const own = events.map((e, i) => (e.payload.run === run ? i : -1)).filter((i) => i >= 0);
  const first = Math.min(...own);
  const last = Math.max(...own);

  // Delegates: sub-thread runs between the previous parent run and this one.
  let floor = -1;
  for (let i = first - 1; i >= 0; i--) {
    const e = events[i]!;
    if (!isSub(e.thread_ts) && e.payload.run && e.payload.run !== run) {
      floor = i;
      break;
    }
  }
  const keep = new Set<string>([run]);
  for (const e of events.slice(floor + 1, first)) if (isSub(e.thread_ts) && e.payload.run) keep.add(e.payload.run);

  // The proposal: the next parent run after this one, if it is a proposal and not the next investigation.
  const next = events.slice(last + 1).find((e) => e.kind === "start" && !isSub(e.thread_ts));
  if (next?.payload.phase === "proposal") keep.add(next.payload.run);

  return { thread: chosen.e.thread_ts, events: events.filter((e) => e.payload.run && keep.has(e.payload.run)) };
}

/** A regression case on disk: `replay/cases/<name>/{trace,expect}.json`. */
export function readCase(dir: string): { name: string; trace: Trace; expect: Expect } {
  const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8")) as Trace;
  const expect = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as Expect;
  return { name: dir.split("/").filter(Boolean).at(-1)!, trace, expect };
}
