import type { TaskRun } from "./score.js";

/**
 * `--resume <partial.json>` (2026-11-24): the full suite of that morning stopped at attempt 128 of 155
 * when the MCP port-forward timed out, and an aborted run records nothing — six hours, kept only in a
 * partial file. Resuming keeps every case the partial FINISHED (all its attempts, same `--attempts`)
 * and runs the rest; the case cut mid-way runs again from its first attempt. The history line says
 * `resumedFrom`, because the two halves may have run on different code.
 */
export function resumeFrom(partial: { runs?: TaskRun[]; detail?: Array<Record<string, unknown>> }, attempts: number): { runs: TaskRun[]; detail: Array<Record<string, unknown>> } {
  const runs = (partial.runs ?? []).filter((r) => Array.isArray(r.attempts) && r.attempts.length === attempts);
  const done = new Set(runs.map((r) => r.task));
  return { runs, detail: (partial.detail ?? []).filter((d) => done.has(String(d.task))) };
}

/** Runs back in the suite's own order, whichever half they came from. */
export const inTaskOrder = (runs: TaskRun[], order: string[]): TaskRun[] => [...runs].sort((a, b) => order.indexOf(a.task) - order.indexOf(b.task));
