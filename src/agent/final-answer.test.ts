import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATE_BUDGET_NOTICE,
  forcedFinalAnswer,
  ITERATION_CEILING_NOTICE,
  MAX_ITERATIONS,
  TOOL_BUDGET_NOTICE,
} from "./index.js";
import { DELEGATE_MARKER } from "./subagent/index.js";

// The alert path calls investigate() with no options, so maxToolRounds is Infinity and the
// tool-budget clause can never fire. The iteration ceiling is its ONLY stop.
const alert = (iterations: number, toolRounds = iterations) =>
  forcedFinalAnswer({ toolRounds, maxToolRounds: Infinity, iterations, maxIterations: MAX_ITERATIONS });

test("an alert investigation is forced to answer while it still has a turn left", () => {
  assert.equal(alert(MAX_ITERATIONS - 1), ITERATION_CEILING_NOTICE);
});

// The regression this file exists for: the run used to spend all ten rounds on tools, fall out
// of the loop, and throw every result away. Forcing must not depend on a finite tool budget.
test("an infinite tool budget does not disable the iteration ceiling", () => {
  const notice = alert(MAX_ITERATIONS - 1, 99);
  assert.notEqual(notice, null, "an alert run reached its last turn without being forced to answer");
  assert.equal(notice, ITERATION_CEILING_NOTICE);
});

test("the ceiling leaves exactly one turn to answer in", () => {
  // Forced at maxIterations - 1, so the `while (iterations < MAX_ITERATIONS)` check admits one
  // more pass — the tool-free call that produces the answer. Firing any later would be too late.
  assert.equal(alert(MAX_ITERATIONS), ITERATION_CEILING_NOTICE, "already past the ceiling");
  assert.equal(alert(MAX_ITERATIONS - 2), null, "forced a turn early, wasting a round of tools");
});

test("an alert investigation is not forced while rounds remain", () => {
  for (let i = 1; i <= MAX_ITERATIONS - 2; i++) {
    assert.equal(alert(i), null, `forced at iteration ${i} of ${MAX_ITERATIONS}`);
  }
});

test("conversation mode still stops at its tool budget", () => {
  const notice = forcedFinalAnswer({ toolRounds: 2, maxToolRounds: 2, iterations: 2, maxIterations: MAX_ITERATIONS });
  assert.equal(notice, TOOL_BUDGET_NOTICE);
  assert.equal(
    forcedFinalAnswer({ toolRounds: 1, maxToolRounds: 2, iterations: 1, maxIterations: MAX_ITERATIONS }),
    null
  );
});

// Both ceilings can be true at once. The budget notice carries conversation mode's format rule
// ("do NOT use the RCA incident format"); the ceiling notice deliberately carries none, so if the
// ceiling won here a plain mention could come back wearing an RCA.
test("the tool budget wins when both ceilings are reached together", () => {
  const notice = forcedFinalAnswer({
    toolRounds: 2,
    maxToolRounds: 2,
    iterations: MAX_ITERATIONS - 1,
    maxIterations: MAX_ITERATIONS,
  });
  assert.equal(notice, TOOL_BUDGET_NOTICE);
});

// A delegate runs with SUBAGENT_TOOL_ROUNDS (2) and SUBAGENT_MAX_ITERATIONS (3), so it reaches a
// ceiling routinely rather than exceptionally — and until 2026-08-31 it reached TOOL_BUDGET_NOTICE,
// written for a human in Slack. Observed live: sub-2 of a two-service delegation answered "Hey —
// here's what the data you provided shows, in plain Slack-friendly terms" with markdown bullets,
// 4796 chars, while its sibling — which finished inside its budget and so never saw the notice —
// returned "CONTRADICTED — ..." in 2220. The reader of both was the lead investigation.
const delegate = (toolRounds: number, iterations: number, maxToolRounds = 2, maxIterations = 3) =>
  forcedFinalAnswer({ toolRounds, maxToolRounds, iterations, maxIterations, depth: 1 });

test("a delegate out of tool budget is told to report a verdict, not to chat", () => {
  // sub-2's exact position: both rounds spent, one iteration in.
  assert.equal(delegate(2, 1), DELEGATE_BUDGET_NOTICE);
});

test("a delegate at its iteration ceiling gets the same notice, not the RCA-shaped one", () => {
  // The other way in. A delegate's reader never changes, so neither should the instruction.
  assert.equal(delegate(0, 2), DELEGATE_BUDGET_NOTICE);
});

test("a delegate with budget left is not forced", () => {
  assert.equal(delegate(1, 0), null);
});

test("depth 0 is unchanged — the lead investigation keeps both original notices", () => {
  assert.equal(forcedFinalAnswer({ toolRounds: 2, maxToolRounds: 2, iterations: 2, maxIterations: MAX_ITERATIONS, depth: 0 }), TOOL_BUDGET_NOTICE);
  assert.equal(alert(MAX_ITERATIONS - 1), ITERATION_CEILING_NOTICE, "omitting depth must still mean lead");
});

// The notice exists because DELEGATE_MARKER loses: it is history[0] while this is the last thing
// in the context. So it has to carry the marker's contract itself, not point at it.
test("the delegate notice restates the verdict contract the marker set", () => {
  for (const verdict of ["SUPPORTED", "CONTRADICTED", "UNPROVEN"]) {
    assert.ok(DELEGATE_MARKER.includes(verdict), `the marker no longer names ${verdict}`);
    assert.ok(DELEGATE_BUDGET_NOTICE.includes(verdict), `the notice does not restate ${verdict}`);
  }
  assert.match(DELEGATE_BUDGET_NOTICE, /tool calls are disabled/i);
  assert.match(DELEGATE_BUDGET_NOTICE, /do not use the RCA/i);
  // The two clauses that produced the observed regression, negated.
  assert.doesNotMatch(DELEGATE_BUDGET_NOTICE, /Slack mrkdwn/i, "a delegate is not writing to Slack");
  assert.match(DELEGATE_BUDGET_NOTICE, /not to a human/i);
  assert.match(DELEGATE_BUDGET_NOTICE, /do not offer to investigate/i, "the clause sub-2 obeyed");
  // Every ceiling ends in an answer, never an apology — UNPROVEN is the delegate's version.
  assert.match(DELEGATE_BUDGET_NOTICE, /answer UNPROVEN/);
});

test("the notices say the two things the loop depends on", () => {
  for (const notice of [TOOL_BUDGET_NOTICE, ITERATION_CEILING_NOTICE, DELEGATE_BUDGET_NOTICE]) {
    assert.match(notice, /tool calls are disabled/i, "the model is not told its tools are gone");
    assert.match(notice, /answer now|final answer|report now/i, "the model is not told to answer");
  }
  // The alert path's answer IS the RCA. A format rule here would suppress it.
  assert.doesNotMatch(ITERATION_CEILING_NOTICE, /do NOT use the RCA/i);
  assert.match(TOOL_BUDGET_NOTICE, /do NOT use the RCA/i);
});
