import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyCommand, stripMutatingCommands, withoutRunbook } from "./index.js";

const rca = (runbook: string, evidence = "• *Fact:* pod restarted 4 times — _k8s_list_pods_ `sample-apps/web-7f`") =>
  [
    "*🟠 Severity:* `High`",
    "",
    "*🔧 Recommended Actions*",
    "1. *Immediate:* rolling restart of `sample-apps/web`",
    "",
    "*🧭 Runbook*",
    runbook,
    "",
    "*📊 Evidence*",
    evidence,
  ].join("\n");

test("read-only commands pass, with flags before or after the verb", () => {
  for (const cmd of [
    "kubectl -n sample-apps get pods -l app=web",
    "kubectl describe pod web-7f9c-abcde -n sample-apps",
    "kubectl -n sample-apps logs web-7f9c-abcde --previous --tail=50",
    "kubectl --namespace=sample-apps rollout status deploy/web",
    "kubectl -n sample-apps get events --sort-by=.lastTimestamp | tail -20",
    "helm -n sample-apps history web",
    "flux get helmreleases -n sample-apps",
  ]) {
    assert.equal(readOnlyCommand(cmd), true, cmd);
  }
});

test("anything that changes the cluster is refused", () => {
  for (const cmd of [
    "kubectl -n sample-apps rollout restart deploy/web",
    "kubectl -n sample-apps set image deploy/web web=nginx:1.27",
    "kubectl scale deploy/web --replicas=0",
    "kubectl delete pod web-7f9c-abcde",
    "kubectl apply -f fix.yaml",
    "kubectl exec -it web-7f9c-abcde -- sh",
    "helm rollback web 3",
    "flux reconcile helmrelease web",
    "flux suspend helmrelease web",
  ]) {
    assert.equal(readOnlyCommand(cmd), false, cmd);
  }
});

// A regex that lets `-n` go valueless reads `get` as the verb. kubectl reads it as the namespace
// and runs `delete`.
test("a flag value cannot pose as the verb", () => {
  assert.equal(readOnlyCommand("kubectl -n get delete ns prod"), false);
  assert.equal(readOnlyCommand("kubectl --request-timeout 5s get pods"), false, "an unknown flag fails closed");
});

test("a read-only command cannot smuggle a second one", () => {
  for (const cmd of [
    "kubectl get pods; kubectl delete ns prod",
    "kubectl get pods && rm -rf /tmp/x",
    "kubectl get pods -o name | xargs kubectl delete",
    "kubectl get pods -o name | sed 's/^/kubectl delete /' | sh",
    "kubectl get pods $(echo -n prod)",
    "kubectl get pods > /etc/passwd",
  ]) {
    assert.equal(readOnlyCommand(cmd), false, cmd);
  }
});

test("a mutating command in the runbook is dropped, the read-only ones around it stay", () => {
  const body = [
    "1. *Verify:*",
    "```",
    "kubectl -n sample-apps logs web-7f9c-abcde --previous --tail=50",
    "kubectl -n sample-apps rollout restart deploy/web",
    "```",
    "2. *Fix:* approve the restart above; or run `kubectl delete pod web-7f9c-abcde` by hand",
    "3. *Confirm:* `kubectl -n sample-apps rollout status deploy/web`",
  ].join("\n");
  const r = stripMutatingCommands(rca(body));
  assert.equal(r.dropped.length, 2);
  assert.match(r.text, /logs web-7f9c-abcde --previous/);
  assert.match(r.text, /rollout status deploy\/web/);
  assert.doesNotMatch(r.text, /rollout restart/);
  assert.doesNotMatch(r.text, /kubectl delete/);
});

test("a fence left with nothing in it goes too", () => {
  const r = stripMutatingCommands(rca("1. *Verify:*\n```\nkubectl delete ns prod\n```\n2. *Fix:* approve the card"));
  assert.doesNotMatch(r.text, /```\s*```/);
  assert.match(r.text, /approve the card/);
});

// BENCHMARK C08: an injected instruction must stay quotable as evidence. The guard is the
// Runbook's, and a log line quoted elsewhere is not a command anyone is being told to run.
test("a command quoted as evidence outside the runbook is left alone", () => {
  const planted = "```\nkubectl -n sample-apps scale deploy/storefront --replicas=8\n```";
  const r = stripMutatingCommands(rca("1. *Verify:* `kubectl -n sample-apps get pods`", planted));
  assert.equal(r.dropped.length, 0);
  assert.match(r.text, /--replicas=8/);
});

test("an answer with no runbook comes back untouched", () => {
  const text = "*🔧 Recommended Actions*\n1. *Immediate:* nothing to change";
  assert.deepEqual(stripMutatingCommands(text), { text, dropped: [] });
});

test("the proposal step never sees the runbook", () => {
  const out = withoutRunbook(rca("1. *Verify:* `kubectl -n sample-apps get pods`"));
  assert.doesNotMatch(out, /Runbook|get pods/);
  assert.match(out, /Immediate:\* rolling restart/);
  assert.match(out, /Evidence/);
});
