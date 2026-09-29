import { test } from "node:test";
import assert from "node:assert/strict";
import { needsEvidence, fabricatesEvidence, ungroundedTargetRefusal, offerMismatchRefusal, FABRICATED_EVIDENCE_NOTICE } from "./index.js";
import { parseProposal } from "./remediation/proposal.js";

// Verbatim from benchmark C06 attempt 1, 2026-09-23: one LLM call, zero tool calls, twelve
// invented log lines for a deployment that does not exist.
const fabricated =
  "no deployment named exactly `api` here — using `bench-api`, the only api workload in namespace `bench-c06`\n\n" +
  "```\n" +
  '2026-09-23T03:12:45.123Z {"level":"error","service":"bench-api","msg":"failed to process request: context deadline exceeded"}\n' +
  '2026-09-23T03:15:10.567Z {"level":"error","service":"bench-api","msg":"database connection pool exhausted"}\n' +
  "```";

// C07, three attempts out of three: a correct tool-free refusal that must never be nudged.
const outOfScope = "That's outside what I do — I investigate this cluster's workloads, incidents and deploys.";

test("a tool-free answer that quotes logs it never fetched is sent back", () => {
  assert.equal(fabricatesEvidence(fabricated), true);
  assert.equal(needsEvidence({ mode: "conversation", toolRounds: 0, nudged: false, toolsDisabled: false, answer: fabricated }), true);
});

// The re-run after the first fix: no invented log lines, a LogQL query in the fence — and still
// `bench-api`, a workload it never looked up, asserted with zero tool calls behind it.
test("a tool-free answer that merely names a resource is sent back too", () => {
  const named =
    "no deployment named exactly `api` here — using `bench-api`, the only api workload in this namespace\n\n" +
    '```\n{namespace="bench-c06", app="bench-api"} | json\n```';
  assert.equal(fabricatesEvidence(named), true);
});

test("the correct tool-free refusal is still left alone", () => {
  assert.equal(fabricatesEvidence(outOfScope), false);
  assert.equal(needsEvidence({ mode: "conversation", toolRounds: 0, nudged: false, toolsDisabled: false, answer: outOfScope }), false);
  // a fenced block that is not tool output — a manifest snippet — is not a claim to have read anything
  assert.equal(fabricatesEvidence("Set it in the chart:\n```yaml\nreplicaCount: 3\n```"), false);
});

test("the alert rule is unchanged, and neither rule fires twice or without tools", () => {
  assert.equal(needsEvidence({ mode: "alert", toolRounds: 0, nudged: false, toolsDisabled: false }), true);
  assert.equal(needsEvidence({ mode: "conversation", toolRounds: 1, nudged: false, toolsDisabled: false, answer: fabricated }), false);
  assert.equal(needsEvidence({ mode: "conversation", toolRounds: 0, nudged: true, toolsDisabled: false, answer: fabricated }), false);
  assert.equal(needsEvidence({ mode: "conversation", toolRounds: 0, nudged: false, toolsDisabled: true, answer: fabricated }), false);
});

test("the notice names the failure and offers the ambiguous-name way out", () => {
  assert.match(FABRICATED_EVIDENCE_NOTICE, /have not called a single tool/);
  assert.match(FABRICATED_EVIDENCE_NOTICE, /ask which one/);
});

// --- the same invention, one step on: the proposal's target ---

const restart = (name: string) =>
  parseProposal(JSON.stringify({ action: "k8s_rollout_restart", namespace: "bench-c06", workload: name }))!;
const listing = JSON.stringify([{ name: "api-gateway" }, { name: "payments-api" }, { name: "api-worker" }]);

test("a proposal for a workload no tool result ever showed is refused", () => {
  assert.match(ungroundedTargetRefusal(restart("bench-api"), listing) ?? "", /appears in no tool result/);
});

test("a workload the tools returned, or the alert labels named, passes", () => {
  assert.equal(ungroundedTargetRefusal(restart("payments-api"), listing), null);
  // the alert names the subject even when this run's tools listed pods only
  assert.equal(ungroundedTargetRefusal(restart("checkout"), "no pods found", { deployment: "checkout" }), null);
  // a workload seen only as its pods' prefix is still seen
  assert.equal(ungroundedTargetRefusal(restart("api-worker"), "api-worker-7d9f4c5b8-zx8k2  Running"), null);
});

// Live, 2026-09-28 (A01): the re-ask proposed a resize of deployment `payments-api-c5ccb5f74` —
// the ReplicaSet. It passed because its name is the prefix of the pod `payments-api-c5ccb5f74-w46rd`,
// the same rule that lets a Deployment be "seen" through its pods. In an allowed namespace that is a
// card the dry-run answers with NotFound. The pod suffix decides: a ReplicaSet's pods are its name
// plus FIVE characters; a Deployment's carry a template hash first.
test("a ReplicaSet named as a Deployment is refused, and the Deployment is named instead", () => {
  const pods = "payments-api-c5ccb5f74-w46rd   0/1   CrashLoopBackOff";
  const refused = ungroundedTargetRefusal(restart("payments-api-c5ccb5f74"), pods) ?? "";
  assert.match(refused, /ReplicaSet/);
  assert.match(refused, /`bench-c06\/payments-api`/);
  assert.equal(ungroundedTargetRefusal(restart("payments-api"), pods), null, "the Deployment itself still passes");
  assert.equal(
    ungroundedTargetRefusal(restart("svc-bcdfgh"), "svc-bcdfgh-7d9f8b6c5-x2x9k   Running"),
    null,
    "a Deployment whose own name ends in something hash-like has pods with a second hash"
  );
});

test("with no thread to read, it refuses nothing", () => {
  assert.equal(ungroundedTargetRefusal(restart("bench-api"), null), null);
});

// Bench case C09 attempt 1: the offer named `bench-c09/Service/bench-c09-cache`, and the proposal
// came back with `default/unsueddd` — a real orphan from the same cluster-wide scan, and not the
// thing the human said yes to.
test("a proposal that wanders off its own offer is refused", () => {
  const wrong = parseProposal('{"action":"k8s_delete_orphan","namespace":"default","name":"unsueddd","kind":"service"}')!;
  const right = parseProposal('{"action":"k8s_delete_orphan","namespace":"bench-c09","name":"bench-c09-cache","kind":"service"}')!;
  const offer = "delete `bench-c09/Service/bench-c09-cache`";
  assert.match(offerMismatchRefusal(wrong, offer) ?? "", /what was offered and agreed to/);
  assert.equal(offerMismatchRefusal(right, offer), null);
  assert.equal(offerMismatchRefusal(wrong, null), null, "no offer, nothing to disagree with");
  assert.equal(offerMismatchRefusal(wrong, "clean up the stale things"), null, "an offer naming no object");
});
