import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forcedFinalAnswer,
  ITERATION_CEILING_NOTICE,
  MAX_ITERATIONS,
  TOOL_BUDGET_NOTICE,
} from "./index.js";

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

test("the notices say the two things the loop depends on", () => {
  for (const notice of [TOOL_BUDGET_NOTICE, ITERATION_CEILING_NOTICE]) {
    assert.match(notice, /tool calls are disabled/i, "the model is not told its tools are gone");
    assert.match(notice, /answer now|answer now from|final answer/i, "the model is not told to answer");
  }
  // The alert path's answer IS the RCA. A format rule here would suppress it.
  assert.doesNotMatch(ITERATION_CEILING_NOTICE, /do NOT use the RCA/i);
  assert.match(TOOL_BUDGET_NOTICE, /do NOT use the RCA/i);
});
