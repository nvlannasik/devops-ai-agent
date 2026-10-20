import test from "node:test";
import assert from "node:assert/strict";
import { newRunState, type RunCtx } from "./run-state.js";
import { finalizeAnswer } from "./finalize.js";
import { TraceRecorder } from "../trace/index.js";

const ctx = (onComplete: RunCtx["opts"]["onComplete"]): RunCtx => ({
  threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 1000, startedAt: Date.now() - 5, tools: [], systemPrompt: "", opts: { onComplete },
});
const recorder = () => new TraceRecorder(null, { source: "prod", sha: "t" });

// done() read the loop's counters when it was CALLED. The state object must keep that: a copy
// taken before the last round would report the footer one round short.
test("finalizeAnswer reports the state as it is when called, not when the run began", () => {
  const s = newRunState([]);
  let meta: { rounds: number; toolCalls: number } | undefined;
  const c = ctx((m) => (meta = m));
  s.iterations = 3;
  s.totalToolCalls = 7;
  finalizeAnswer(c, s, recorder(), "plain answer");
  assert.deepEqual({ rounds: meta!.rounds, toolCalls: meta!.toolCalls }, { rounds: 3, toolCalls: 7 });
});

test("finalizeAnswer strips the [OFFER] line, as done() did", () => {
  const out = finalizeAnswer(ctx(undefined), newRunState([]), recorder(),
    "The Service has no endpoints.\n[OFFER] delete `default/Service/unsueddd`");
  assert.equal(out, "The Service has no endpoints.");
});
