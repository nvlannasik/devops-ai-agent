import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRun, type TraceEvent } from "./trace.js";

// One thread, as /api/trace returns it (insert order): an alert run with a delegate and a
// proposal, a standalone post-run gate, then a follow-up mention with its own delegate.
const ev = (thread_ts: string, run: string | null, kind: string, extra: Record<string, unknown> = {}): TraceEvent => ({
  thread_ts, seq: 0, kind, name: null, outcome: null, payload: { run, ...extra },
});
const T = "1.1";
const events: TraceEvent[] = [
  ev(`${T}/sub-1`, "d1", "start", { phase: "investigate" }),
  ev(`${T}/sub-1`, "d1", "end"),
  ev(T, "a", "start", { phase: "investigate" }),
  ev(T, "a", "llm"),
  ev(T, "a", "end"),
  ev(T, null, "gate"), // rca-structure, written after the run
  ev(T, "p", "start", { phase: "proposal" }),
  ev(T, "p", "end"),
  ev(`${T}/sub-1`, "d2", "start", { phase: "investigate" }),
  ev(`${T}/sub-1`, "d2", "end"),
  ev(T, "b", "start", { phase: "investigate" }),
  ev(T, "b", "end"),
];
const runs = (t: { events: TraceEvent[] }) => [...new Set(t.events.map((e) => e.payload.run))];

test("the latest investigation is the default, with only its own delegate", () => {
  const t = selectRun(events);
  assert.equal(t.thread, T);
  assert.deepEqual(runs(t), ["d2", "b"]);
});

test("an earlier run brings its delegate and its proposal, and nothing of the later run", () => {
  const t = selectRun(events, "a");
  assert.deepEqual(runs(t), ["d1", "a", "p"]);
  assert.ok(!t.events.some((e) => e.payload.run === null), "standalone gate rows are not part of a run");
});

test("an unknown run id or a trace with no investigation is an error, not an empty replay", () => {
  assert.throws(() => selectRun(events, "nope"), /nope/);
  assert.throws(() => selectRun([ev(T, "p", "start", { phase: "proposal" })]), /no investigation/);
});
