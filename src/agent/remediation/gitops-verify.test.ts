import test from "node:test";
import assert from "node:assert/strict";
import { Remediator } from "./remediator.js";
import { RemediationCheckStore, applyState, expectFromChanges, type RemediationCheck } from "./verify.js";

// GitOps PR remediations were never verified (2026-10-23): `succeeded` meant "the PR is open",
// no check was scheduled, and the agent never learned whether a Flux workload's fix worked. Now a
// PR leaves an `awaiting` check that watches the live object until it runs what the PR set — the
// merge plus the Flux sync — and only then starts the ordinary verification.

const deployment = (image: string, replicas = 1) =>
  JSON.stringify({ kind: "Deployment", spec: { replicas, template: { spec: { containers: [{ name: "app", image }, { name: "sidecar", image: "envoy:1" }] } } } });

// ---- what the PR set, and whether the cluster runs it ----

test("expectFromChanges keeps the image (with its container) and the replica count", () => {
  assert.deepEqual(expectFromChanges([{ field: "image", from: "repo:v1", to: "repo:v2" }], "app"), { image: "repo:v2", container: "app" });
  assert.deepEqual(expectFromChanges([{ field: "replicas", from: 1, to: 3 }]), { replicas: 3 });
  assert.equal(expectFromChanges([{ field: "api.env.MODE", from: "a", to: "b" }]), null, "nothing a live object can be read for");
});

test("applyState reads the live spec, compares images canonically, and says when it cannot tell", () => {
  assert.equal(applyState({ image: "docker.io/library/repo:v2", container: "app" }, deployment("repo:v2")), "applied");
  assert.equal(applyState({ image: "repo:v2", container: "app" }, deployment("repo:v1")), "not-yet");
  assert.equal(applyState({ image: "envoy:1", container: "app" }, deployment("repo:v1")), "not-yet", "only the named container counts");
  assert.equal(applyState({ replicas: 3 }, deployment("repo:v1", 3)), "applied");
  assert.equal(applyState({ replicas: 3 }, deployment("repo:v1", 1)), "not-yet");
  assert.equal(applyState({ replicas: 3 }, "Error: deployments.apps \"x\" not found"), "unknown");
});

// ---- the store ----

test("scheduleAwaiting writes an awaiting check with what to wait for and until when", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [{ id: 1 }] }; } } as any;
  const ok = await new RemediationCheckStore(pool).scheduleAwaiting(7, "C1", "1.1", { namespace: "ns", name: "app", kind: "Deployment" }, { replicas: 3 }, 60, 86_400);
  assert.equal(ok, true);
  assert.match(calls[0]!.sql, /'awaiting'/);
  assert.match(calls[0]!.sql, /apply_by/);
  assert.ok(calls[0]!.params.includes(JSON.stringify({ replicas: 3 })));
});

test("claimDue also hands back awaiting checks, without spending their attempts", async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [{ id: "3", remediation_id: "7", channel: "C1", thread_ts: "1.1", target: { namespace: "ns", name: "app" }, attempts: 0, status: "awaiting", expect: { replicas: 3 }, apply_by: new Date(Date.now() + 1000) }] }; } } as any;
  const [c] = await new RemediationCheckStore(pool).claimDue();
  assert.match(calls[0]!, /'awaiting'/);
  assert.match(calls[0]!, /CASE WHEN c\.status = 'awaiting'/);
  assert.equal(c!.status, "awaiting");
  assert.deepEqual(c!.expect, { replicas: 3 });
});

// ---- the poller ----

const awaiting = (over: Partial<RemediationCheck> = {}): RemediationCheck => ({
  id: 3, remediationId: 7, channel: "C1", threadTs: "1.1", alertname: "A", namespace: "ns",
  target: { namespace: "ns", name: "app", kind: "Deployment" }, before: null, attempts: 0,
  createdAt: new Date().toISOString(), status: "awaiting", expect: { image: "repo:v2", container: "app" },
  applyBy: new Date(Date.now() + 3_600_000).toISOString(), ...over,
});

function poller(check: RemediationCheck, live: string | Error) {
  const done: string[] = [];
  const mcpCalls: Array<{ name: string; input: any }> = [];
  const checks = {
    enabled: true,
    claimDue: async () => [check],
    markApplied: async (id: number, before: unknown, delay: number) => { done.push(`applied ${id} before=${before ? "yes" : "no"} delay=${delay}`); },
    waitMore: async (id: number) => { done.push(`wait ${id}`); },
    expire: async (id: number) => { done.push(`expire ${id}`); },
    complete: async () => { done.push("complete"); },
    abandon: async () => { done.push("abandon"); },
  };
  const mcp = {
    callTool: async (name: string, input: any) => {
      mcpCalls.push({ name, input });
      if (name === "k8s_get_resource") { if (live instanceof Error) throw live; return live; }
      if (name === "k8s_list_pods") return JSON.stringify([{ name: "app-1", status: "Running", ready: true, restarts: 0 }]);
      return "[]";
    },
  };
  const r = new Remediator({ checks, mcp } as any);
  return { run: () => r.runDueRemediationChecks(), done, mcpCalls };
}

test("once the cluster runs what the PR set, the baseline is taken and verification starts", async () => {
  const p = poller(awaiting(), deployment("repo:v2"));
  const out = await p.run();
  assert.deepEqual(p.done, ["applied 3 before=yes delay=300"]);
  assert.deepEqual(p.mcpCalls[0], { name: "k8s_get_resource", input: { api_version: "apps/v1", kind: "Deployment", namespace: "ns", name: "app" } });
  assert.equal(out.length, 1);
  assert.match(out[0]!.text, /GitOps change applied/);
  assert.match(out[0]!.text, /ns\/app/);
});

test("while the PR is not merged yet, the check waits quietly", async () => {
  const p = poller(awaiting(), deployment("repo:v1"));
  assert.deepEqual(await p.run(), []);
  assert.deepEqual(p.done, ["wait 3"]);
});

test("an unreadable object is a wait, never a verdict", async () => {
  const p = poller(awaiting(), new Error("MCP timeout"));
  assert.deepEqual(await p.run(), []);
  assert.deepEqual(p.done, ["wait 3"]);
});

test("past apply_by without the change landing, the check expires once, with no verdict", async () => {
  const p = poller(awaiting({ applyBy: new Date(Date.now() - 1000).toISOString() }), deployment("repo:v1"));
  const out = await p.run();
  assert.deepEqual(p.done, ["expire 3"]);
  assert.equal(out.length, 1);
  assert.match(out[0]!.text, /not applied/i);
});

// ---- the approve path ----

function approve(params: Record<string, unknown>, workerReply: Record<string, unknown>) {
  const remediations = { claimForExecution: async () => ({ action: "k8s_set_image", params }), finish: async () => {} };
  const gitops = { request: async () => workerReply };
  return new Remediator({ remediations, gitops } as any).executeRemediation(7, "U1");
}

test("an opened PR hands back what to wait for", async () => {
  const res = await approve(
    { gitops: true, helmRelease: { name: "app", namespace: "flux" }, action: "set_image", container: "app", workload: "deployment/ns/app",
      changes: [{ field: "image", from: "repo:v1", to: "repo:v2" }], target: "k8s_set_image:ns/app", summary: "s" },
    { ok: true, op: "open_pr", prUrl: "https://ghe/pr/1" }
  );
  assert.match(res.text, /GitOps PR opened/);
  assert.equal(res.target, undefined, "nothing live to verify yet");
  assert.deepEqual(res.awaitApply, { target: { namespace: "ns", name: "app", kind: "Deployment" }, expect: { image: "repo:v2", container: "app" } });
});

test("a revert PR, or a PR with nothing readable to wait for, schedules nothing", async () => {
  const revert = await approve({ gitops: true, revert: true, helmRelease: { name: "a", namespace: "f" }, sha: "abc", summary: "s" }, { ok: true, op: "revert_pr", dryRun: false, prUrl: "u", paths: [] });
  assert.equal(revert.awaitApply, undefined);
  const env = await approve(
    { gitops: true, helmRelease: { name: "app", namespace: "flux" }, action: "set_env", workload: "deployment/ns/app", changes: [{ field: "env.MODE", from: "a", to: "b" }], target: "x:ns/app", summary: "s" },
    { ok: true, op: "open_pr", prUrl: "u" }
  );
  assert.equal(env.awaitApply, undefined);
});
