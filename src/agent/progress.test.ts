import { test } from "node:test";
import assert from "node:assert/strict";
import { reportProgress } from "./index.js";

const swallowed: unknown[] = [];
const onError = (err: unknown) => swallowed.push(err);

test("the reported round is the one about to run, not the one already counted", () => {
  // toolRounds is incremented AFTER the tools return, so at the call site it still holds the
  // count of COMPLETED rounds. Reporting it verbatim would tell an on-call reader that round
  // 0 is running on the first pass, and would always be one behind after that.
  const seen: number[] = [];
  reportProgress((round) => seen.push(round), 0, [{ name: "k8s_list_pods" }], onError);
  reportProgress((round) => seen.push(round), 2, [{ name: "k8s_list_pods" }], onError);
  assert.deepEqual(seen, [1, 3]);
});

test("the names are de-duplicated so a fan-out reads as one tool", () => {
  // Five pods' logs is five tool_use blocks with one name. Listing it five times says
  // nothing and is what pushes the line past Slack's width.
  let names: string[] = [];
  reportProgress(
    (_r, tools) => (names = tools),
    1,
    [{ name: "k8s_get_pod_logs" }, { name: "k8s_get_pod_logs" }, { name: "prometheus_query" }],
    onError
  );
  assert.deepEqual(names, ["k8s_get_pod_logs", "prometheus_query"]);
});

test("a nameless block is dropped rather than reported as an empty tool", () => {
  let names: string[] = [];
  reportProgress((_r, tools) => (names = tools), 1, [{ name: "k8s_describe_pod" }, {}], onError);
  assert.deepEqual(names, ["k8s_describe_pod"]);
});

test("an empty round still reports — a round that runs nothing is worth seeing", () => {
  // Every call can be refused by the scope lock, leaving `executable` empty. That round still
  // costs an LLM call and still takes its tens of seconds, so it must not go unreported.
  let called = false;
  reportProgress((round, tools) => {
    called = true;
    assert.equal(round, 2);
    assert.deepEqual(tools, []);
  }, 1, [], onError);
  assert.ok(called);
});

test("a callback that throws is swallowed, not propagated into the loop", () => {
  // The whole reason this is a function. A Slack outage during round three must not discard
  // three rounds of gathered evidence.
  const boom = new Error("slack rate limited");
  const before = swallowed.length;
  assert.doesNotThrow(() =>
    reportProgress(() => {
      throw boom;
    }, 1, [{ name: "k8s_list_pods" }], onError)
  );
  assert.equal(swallowed.length, before + 1);
  assert.equal(swallowed.at(-1), boom);
});

test("no callback means no work and no error", () => {
  assert.doesNotThrow(() => reportProgress(undefined, 1, [{ name: "k8s_list_pods" }], onError));
});
