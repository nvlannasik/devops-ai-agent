import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory } from "./store.js";
import { scoreProposal, scoreGrounding, combine, passRates, parseQuantity, type Expectation, type TaskRun, scoreRca } from "./score.js";
import type { Proposal } from "../agent/remediation/proposal.js";

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  action: "k8s_set_resources",
  namespace: "webapp-backend",
  name: "backend-api",
  reason: "OOMKilled at the 128Mi limit",
  toolParams: { namespace: "webapp-backend", workload: "backend-api", kind: "deployment", memory_limit: "512Mi" },
  summary: "raise memory limit",
  ...over,
});

const oom: Expectation = {
  action: "k8s_set_resources",
  namespace: "webapp-backend",
  target: "backend-api",
  params: { kind: "deployment" },
  changed: { memory_limit: "128Mi" },
};

test("the right action on the right workload with a raised limit passes", () => {
  assert.deepEqual(scoreProposal(oom, proposal()), { pass: true, reasons: [], axes: { proposal: true } });
});

test("every miss says what it was, because a bare number does not tell you where to look", () => {
  const s = scoreProposal(oom, proposal({ action: "k8s_rollout_restart", namespace: "default", name: "frontend" }));
  assert.equal(s.pass, false);
  assert.equal(s.reasons.length, 3);
  assert.match(s.reasons.join("\n"), /action k8s_rollout_restart, expected k8s_set_resources/);
  assert.match(s.reasons.join("\n"), /namespace default/);
  assert.match(s.reasons.join("\n"), /target frontend/);
});

// The point of `changed`: "raise the limit" has no single right answer, so pinning one would
// score the model's taste. Echoing the broken value back is still a miss.
test("re-proposing the broken value is a miss, any other value passes", () => {
  assert.equal(scoreProposal(oom, proposal({ toolParams: { ...proposal().toolParams, memory_limit: "128Mi" } })).pass, false);
  assert.equal(scoreProposal(oom, proposal({ toolParams: { ...proposal().toolParams, memory_limit: "256Mi" } })).pass, true);
});

test("a field the fix has to change, left unset, is a miss", () => {
  const p = proposal({ toolParams: { namespace: "webapp-backend", workload: "backend-api", kind: "deployment", cpu_limit: "1" } });
  assert.match(scoreProposal(oom, p).reasons.join(), /memory_limit not set/);
});

test("params compare as strings, so a numeric replicas still matches", () => {
  const e: Expectation = { action: "k8s_scale", params: { replicas: "3" } };
  assert.equal(scoreProposal(e, proposal({ action: "k8s_scale", toolParams: { replicas: 3 } })).pass, true);
  assert.equal(scoreProposal(e, proposal({ action: "k8s_scale", toolParams: { replicas: 2 } })).pass, false);
});

// The failure mode this system has actually shipped: a proposal for a healthy namespace. A
// benchmark with no negative tasks scores that bug perfectly.
test("a task whose right answer is silence fails when the agent proposes anything", () => {
  const quiet: Expectation = { action: null };
  assert.equal(scoreProposal(quiet, null).pass, true);
  const s = scoreProposal(quiet, proposal());
  assert.equal(s.pass, false);
  assert.match(s.reasons[0]!, /but the correct answer is no proposal/);
});

test("no proposal where one was expected names the action that was missing", () => {
  assert.match(scoreProposal(oom, null).reasons[0]!, /no proposal; expected k8s_set_resources/);
});

// ---- pass rates ---------------------------------------------------------------------------

const run = (task: string, ...passes: boolean[]): TaskRun => ({
  task,
  attempts: passes.map((pass) => ({ pass, reasons: pass ? [] : ["x"] })),
});

test("pass@1 reads the first attempt, pass@k any, pass^k all", () => {
  const r = passRates([
    run("a", true, true, true),   // consistent
    run("b", false, true, false), // lucky
    run("c", true, false, false), // first-attempt only
    run("d", false, false, false),
  ]);
  assert.equal(r.tasks, 4);
  assert.equal(r.k, 3);
  assert.equal(r.pass1, 2 / 4, "pass@1 counts a and c");
  assert.equal(r.passK, 3 / 4, "pass@k counts a, b and c");
  assert.equal(r.passHatK, 1 / 4, "only a passed every attempt");
});

test("a task with no attempts is not consistent", () => {
  const r = passRates([{ task: "skipped", attempts: [] }]);
  assert.equal(r.passHatK, 0, "vacuous truth would report a task that never ran as perfect");
});

test("no tasks is zero, not a division by zero", () => {
  assert.deepEqual(passRates([]), { pass1: 0, passK: 0, passHatK: 0, k: 0, tasks: 0 });
});

// ---- quantities ---------------------------------------------------------------------------

test("Kubernetes quantities parse, and binary is not decimal", () => {
  assert.equal(parseQuantity("128Mi"), 128 * 2 ** 20);
  assert.equal(parseQuantity("1Gi"), 2 ** 30);
  // 1M is 1000000 and 1Mi is 1048576. Treating them alike passes a proposal that is 5% short.
  assert.notEqual(parseQuantity("1M"), parseQuantity("1Mi"));
  assert.equal(parseQuantity("500m"), 0.5);
  assert.equal(parseQuantity("2"), 2);
  assert.equal(parseQuantity("1.5Gi"), 1.5 * 2 ** 30);
  assert.equal(parseQuantity("lots"), null);
  assert.equal(parseQuantity("128Xi"), null, "an unknown suffix must not silently mean 1");
});

// docs/BENCHMARK_agent_stack.md A02: "memory_limit strictly greater than the observed peak
// working set. A proposal at or below peak is a fail even though the action type is right."
test("greaterThan fails a limit that differs from the broken value but still OOMs", () => {
  const e: Expectation = { action: "k8s_set_resources", changed: { memory_limit: "128Mi" }, greaterThan: { memory_limit: "150Mi" } };
  const at = (v: string) => proposal({ toolParams: { ...proposal().toolParams, memory_limit: v } });
  assert.equal(scoreProposal(e, at("512Mi")).pass, true);
  assert.equal(scoreProposal(e, at("129Mi")).pass, false, "129Mi differs from 128Mi and still OOMs at 150Mi");
  assert.match(scoreProposal(e, at("150Mi")).reasons.join(), /not above 150Mi/, "the bound is strict");
  assert.match(scoreProposal(e, at("big")).reasons.join(), /not a valid quantity/);
  assert.match(scoreProposal(e, proposal({ toolParams: { workload: "x" } })).reasons.join(), /has to exceed 150Mi/);
});

test("an unparseable bound in the case file is the harness's bug and throws", () => {
  assert.throws(
    () => scoreProposal({ action: "a", greaterThan: { memory_limit: "biggish" } }, proposal({ action: "a" })),
    /is not a Kubernetes quantity/,
  );
});

// ---- grounding axis -----------------------------------------------------------------------

test("grounding passes on an empty gap list and hard-fails on any invented name", () => {
  assert.deepEqual(scoreGrounding([]), { pass: true, reasons: [], axes: { grounding: true } });
  const s = scoreGrounding(["order-service", "payments-cache"]);
  assert.equal(s.pass, false);
  assert.match(s.reasons[0]!, /names 2 resource\(s\) no tool result contained — order-service, payments-cache/);
  assert.deepEqual(s.axes, { grounding: false });
});

test("a correct proposal does not redeem an ungrounded RCA", () => {
  // The doc makes an invented resource a hard fail, and this is why: the proposal is checked by
  // a dry-run before anything executes, but the RCA text goes to Slack and to
  // incidents.root_cause unchallenged, then comes back as recall for the next investigation.
  const good = scoreProposal({ action: "k8s_rollout_restart" }, proposal({ action: "k8s_rollout_restart" }));
  assert.equal(good.pass, true);
  const combined = combine(good, scoreGrounding(["order-service"]));
  assert.equal(combined.pass, false);
  assert.deepEqual(combined.axes, { proposal: true, grounding: false });
  assert.equal(combined.reasons.length, 1, "a passing axis contributes no reason");
});

test("combine keeps every axis's reasons and reports each axis separately", () => {
  const c = combine(scoreProposal({ action: "k8s_scale" }, null), scoreGrounding(["ghost-svc"]));
  assert.equal(c.pass, false);
  assert.deepEqual(c.axes, { proposal: false, grounding: false });
  assert.equal(c.reasons.length, 2);
});

test("combine of nothing is a pass, so a run with no axes cannot fail silently", () => {
  assert.deepEqual(combine(), { pass: true, reasons: [], axes: {} });
});

test("a null proposal reports what the model actually returned", () => {
  // Four "no proposal" lines in the first live run said nothing about WHY. These are the three
  // causes, and they need three different fixes.
  const declined = scoreProposal({ action: "k8s_scale" }, null, '{"action": null}');
  assert.match(declined.reasons[0]!, /model returned 16 chars: "\{\\"action\\": null\}"/);

  const prose = scoreProposal({ action: "k8s_scale" }, null, "I would scale it, but I am not sure.");
  assert.match(prose.reasons[0]!, /I would scale it/);

  assert.match(scoreProposal({ action: "k8s_scale" }, null, "   ").reasons[0]!, /model returned nothing/);
  assert.match(scoreProposal({ action: "k8s_scale" }, null).reasons[0]!, /model returned nothing/);
});

// ---- history line -------------------------------------------------------------------------

test("a history line is one JSON object per run, with what produced the number", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bench-")), "history.jsonl");
  const meta = { gitSha: "abc123-dirty", provider: "router", backends: "a (m1), b (m2)", maxTokens: 8096 };
  const rates = { tasks: 2, k: 5, pass1: 1 / 3, passK: 1, passHatK: 0 };
  const runs: TaskRun[] = [
    { task: "A02", attempts: [
      { pass: false, reasons: ["no proposal; expected k8s_set_resources"] },
      { pass: false, reasons: ["no proposal; expected k8s_set_resources"] },
      { pass: true, reasons: [] },
    ] },
    { task: "C01", attempts: [{ pass: true, reasons: [] }, { pass: true, reasons: [] }, { pass: true, reasons: [] }] },
  ];
  appendHistory(path, { meta, rates, axes: { proposal: [6, 10] }, runs });
  appendHistory(path, { meta, rates: { ...rates, passHatK: 1 }, axes: { proposal: [10, 10] }, runs });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "appends must not rewrite the file — that is what makes it merge-safe");
  const first = JSON.parse(lines[0]!);
  assert.equal(first.sha, "abc123-dirty");
  assert.equal(first.backends, "a (m1), b (m2)");
  assert.equal(first.maxTokens, 8096);
  assert.equal(first.pass1, 0.333, "rates are rounded, or a float tail makes every diff noisy");
  assert.deepEqual(first.axes, { proposal: [6, 10] });
  assert.equal(JSON.parse(lines[1]!).passHatK, 1);
  // marks is one character per attempt, in order — "xxxx." and ".xxxx" are different problems
  // and the rate alone cannot tell them apart.
  assert.deepEqual(first.marks, { A02: "xx.", C01: "..." });
  assert.equal(first.failures.length, 2);
  assert.deepEqual(first.failures[0], { case: "A02", attempt: 1, reasons: ["no proposal; expected k8s_set_resources"] });
  // The RCA text is deliberately absent: one run is tens of kilobytes of it.
  assert.ok(!("detail" in first) && !("rca" in first));
  assert.ok(lines[0]!.length < 700, "a history line has to stay small enough to read in a diff");

  // The unbounded part is a reason that quotes the model's raw output.
  const long = join(mkdtempSync(join(tmpdir(), "bench-")), "history.jsonl");
  appendHistory(long, { meta, rates, axes: {}, runs: [
    { task: "A02", attempts: [{ pass: false, reasons: ["x".repeat(5000)] }] },
  ] });
  const only = JSON.parse(readFileSync(long, "utf8").trim());
  assert.ok(only.failures[0].reasons[0].length < 200, "an unbounded reason has to be cut, or the line stops being diffable");
});

// ---- scoreRca (the third axis) ----

test("the RCA axis fails a right-symptom-wrong-cause answer, and declares no axis when unused", () => {
  const rca = "The image `nginx:no-such-tag` cannot be pulled: the tag does not exist on the registry.";
  const spec = { must: ["401|unauthorized|pull secret"], mustNot: ["tag does not exist|no such tag"] };
  const s = scoreRca(spec, rca);
  assert.equal(s.pass, false);
  assert.equal(s.axes?.rca, false);
  assert.equal(s.reasons.length, 2); // one for the missing fact, one for the forbidden one
  assert.match(s.reasons[1]!, /tag does not exist/);

  assert.deepEqual(scoreRca({ must: ["tag does not exist"] }, rca).axes, { rca: true });
  // A case with no rca block must not collect a free point: no axis at all.
  assert.deepEqual(scoreRca(undefined, rca), { pass: true, reasons: [] });
});
