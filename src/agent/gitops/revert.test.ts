import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRevertCommit } from "./revert.js";
import { DevOpsAgent } from "../index.js";
import { buildRemediationCard } from "../../utils/slack/remediation-card.js";

const c = (sha: string, at: string, helmRelease: string) => ({ sha, at, author: "a", message: "m", url: "u", paths: ["p"], helmRelease });
const specAt = (rev: string, at: string) => ({ at, source: "rollout", kind: "spec-change", workload: "Deployment/api", revision: rev, diff: [{ field: "api.env.MODE", from: "a", to: "b" }] });
const T = (commits: ReturnType<typeof c>[], changes: ReturnType<typeof specAt>[] = [specAt("2", "2026-10-09T03:30:00Z")]) => ({ namespace: "apps", window: { from: "", to: "" }, changes, commits, unread: [], subjects: [] });

test("pickRevertCommit: the newest commit for that HelmRelease, from the timeline only", () => {
  const t = T([c("old1111", "2026-10-09T01:00:00Z", "api"), c("new2222", "2026-10-09T03:00:00Z", "api"), c("oth3333", "2026-10-09T04:00:00Z", "web")]);
  assert.equal(pickRevertCommit(t, "api")?.sha, "new2222");
  assert.equal(pickRevertCommit(t, "missing"), null);
  assert.equal(pickRevertCommit(null, "api"), null);
});

const preview = { gitOpsPrEligible: true, source: "flux", helmRelease: { name: "api", namespace: "flux-app" }, workload: "deployment/apps/api", action: "rollback", changes: [], message: "managed by Flux" };
const proposal = { action: "k8s_rollout_undo", namespace: "apps", name: "api", reason: "r", summary: "roll back deployment `apps/api` to revision 1", toolParams: { namespace: "apps", name: "api", kind: "deployment", to_revision: 1, sha: "evil999" } };

test("proposeRevertPr takes the sha from the timeline, dry-runs first, and stores a revert card", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let stored: Record<string, unknown> | null = null;
  const fake = {
    gitops: { request: async (b: Record<string, unknown>) => { sent.push(b); return { ok: true, op: "revert_pr", dryRun: true, paths: ["p"], diff: "d" }; } },
    timelineFor: async () => T([c("new2222", "2026-10-09T03:00:00Z", "api")]),
    resolveOverlayPath: async () => "apps/dev/applications",
    remediations: { propose: async (_i: unknown, _a: unknown, params: Record<string, unknown>) => { stored = params; return 7; } },
  };
  const out = await (DevOpsAgent.prototype as never as { proposeRevertPr: Function }).proposeRevertPr.call(fake, 1, proposal, preview, "thread");
  assert.equal(out.id, 7);
  assert.deepEqual({ op: sent[0].op, sha: sent[0].sha, dryRun: sent[0].dryRun }, { op: "revert_pr", sha: "new2222", dryRun: true });
  assert.equal(stored!.revert, true);
  assert.equal(stored!.sha, "new2222");
  assert.deepEqual(out.gitOps, { path: "p", valuesKey: `revert ${"new2222".slice(0, 7)}`, helmRelease: preview.helmRelease });
  assert.equal(out.dryRunSummary, "d");

  const blocks = buildRemediationCard(7, out.proposal, out.dryRunSummary, [], out.gitOps);
  const text = (blocks[0] as { text: { text: string } }).text.text;
  assert.match(text, /```diff/);
  assert.match(text, /Approve opens a PR/);
});

test("proposeRevertPr with no commit for the HelmRelease refuses and never calls the worker", async () => {
  let called = false;
  const fake = { gitops: { request: async () => { called = true; return {}; } }, timelineFor: async () => T([]), resolveOverlayPath: async () => undefined, remediations: { propose: async () => 1 } };
  const out = await (DevOpsAgent.prototype as never as { proposeRevertPr: Function }).proposeRevertPr.call(fake, 1, proposal, preview, "thread");
  assert.match(out.refused, /nothing to revert/);
  assert.equal(called, false);
});

// Final review, finding 1: the newest commit for the HelmRelease is not necessarily the one behind
// the broken rollout — a later, unrelated commit to the same release would be reverted instead.
test("pickRevertCommit with `before`: the newest commit at or before that time", () => {
  const t = T([c("old1111", "2026-10-09T01:00:00Z", "api"), c("mid2222", "2026-10-09T03:00:00Z", "api"), c("new3333", "2026-10-09T05:00:00Z", "api")]);
  assert.equal(pickRevertCommit(t, "api", "2026-10-09T03:00:00Z")?.sha, "mid2222", "at == before counts");
  assert.equal(pickRevertCommit(t, "api", "2026-10-09T02:00:00Z")?.sha, "old1111");
  assert.equal(pickRevertCommit(t, "api", "2026-10-09T00:00:00Z"), null);
  assert.equal(pickRevertCommit(t, "api")?.sha, "new3333", "no bound: the newest");
});

const revertFake = (timeline: ReturnType<typeof T>) => {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    gitops: { request: async (b: Record<string, unknown>) => { sent.push(b); return { ok: true, op: "revert_pr", dryRun: true, paths: ["p"], diff: "d" }; } },
    timelineFor: async () => timeline,
    resolveOverlayPath: async () => undefined,
    remediations: { propose: async () => 9 },
  };
};
const callRevert = (fake: object) => (DevOpsAgent.prototype as never as { proposeRevertPr: Function }).proposeRevertPr.call(fake, 1, proposal, preview, "thread");

test("proposeRevertPr refuses when a commit for the HelmRelease is newer than the broken rollout", async () => {
  const fake = revertFake(T([c("bad1111", "2026-10-09T03:00:00Z", "api"), c("later22", "2026-10-09T04:00:00Z", "api")]));
  const out = await callRevert(fake);
  assert.equal(out.refused, "the GitOps repo moved past the rollout that broke `apps/api` (commit later22 at 2026-10-09T04:00:00Z is newer than revision 2) — re-investigate before reverting");
  assert.equal(fake.sent.length, 0, "the worker is never asked");
});

test("proposeRevertPr picks the commit before the spec-change; another release's newer commit does not count", async () => {
  const fake = revertFake(T([c("older00", "2026-10-09T01:00:00Z", "api"), c("bad1111", "2026-10-09T03:00:00Z", "api"), c("web4444", "2026-10-09T06:00:00Z", "web")]));
  const out = await callRevert(fake);
  assert.equal(out.id, 9);
  assert.equal(fake.sent[0].sha, "bad1111");
});

test("proposeRevertPr with no spec-change on record refuses — nothing to revert", async () => {
  const fake = revertFake(T([c("bad1111", "2026-10-09T03:00:00Z", "api")], []));
  const out = await callRevert(fake);
  assert.match(out.refused, /nothing to revert/);
  assert.equal(fake.sent.length, 0);
});

// Final review, finding 5d: the two routing branches, through the real methods.
test("executeRemediation on a stored revert card sends revert_pr with dryRun false and never calls MCP", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let mcpCalled = false;
  const finished: unknown[] = [];
  const fake = {
    remediations: {
      claimForExecution: async () => ({ action: "k8s_rollout_undo", params: { gitops: true, revert: true, helmRelease: preview.helmRelease, sha: "bad1111", pathPrefix: "apps/dev", summary: "s", reason: "r", target: "t" } }),
      finish: async (...a: unknown[]) => { finished.push(a); },
    },
    gitops: { request: async (b: Record<string, unknown>) => { sent.push(b); return { ok: true, op: "revert_pr", dryRun: false, prUrl: "https://ghe/pr/1" }; } },
    mcp: { callTool: async () => { mcpCalled = true; return "{}"; } },
  };
  (fake as Record<string, unknown>).executeGitOpsPr = (DevOpsAgent.prototype as never as { executeGitOpsPr: Function }).executeGitOpsPr;
  const out = await DevOpsAgent.prototype.executeRemediation.call(fake as never, 5, "U1");
  assert.match(out.text, /Revert PR opened/);
  assert.deepEqual({ op: sent[0].op, sha: sent[0].sha, dryRun: sent[0].dryRun, pathPrefix: sent[0].pathPrefix }, { op: "revert_pr", sha: "bad1111", dryRun: false, pathPrefix: "apps/dev" });
  assert.equal(mcpCalled, false);
});

// proposeRemediationRun end to end on a fake `this`: the model answers a rollout_undo, the MCP
// dry-run answers whatever `dryRun` holds, every gate is open.
const runFake = (dryRun: string, timeline: unknown) => {
  const calls = { revert: 0, gitops: 0, stored: null as Record<string, unknown> | null };
  const fake = {
    calls,
    mcp: { getTools: () => [{ name: "k8s_rollout_undo", description: "[WRITE] roll back" }], callTool: async () => dryRun },
    llm: { chat: async () => ({ content: [] }) },
    recordUsage: () => {},
    extractText: () => JSON.stringify({ action: "k8s_rollout_undo", namespace: "apps", workload: "api", kind: "deployment", to_revision: 1, reason: "bad env" }),
    refusalFor: async () => null,
    trace: { gate: () => {} },
    remediations: { pendingFor: async () => null, propose: async (_i: unknown, _a: unknown, params: Record<string, unknown>) => { calls.stored = params; return 11; } },
    timelineFor: async () => timeline,
    proposeRevertPr: async () => { calls.revert++; return { refused: "routed" }; },
    proposeGitOpsPr: async () => { calls.gitops++; return null; },
  };
  return fake;
};
const run = (fake: object) => (DevOpsAgent.prototype as never as { proposeRemediationRun: Function }).proposeRemediationRun.call(fake, 1, {}, "rca", { threadId: "t" });
const tl = T([], [specAt("2", "2026-10-09T03:30:00Z")]);

test("proposeRemediationRun sends a rollback preview to proposeRevertPr, not the values-PR flow", async () => {
  const fake = runFake(JSON.stringify({ ...preview, toRevision: 1, fromRevision: 2 }), tl);
  const out = await run(fake);
  assert.deepEqual(out, { refused: "routed" });
  assert.deepEqual({ revert: fake.calls.revert, gitops: fake.calls.gitops }, { revert: 1, gitops: 0 });
});

test("proposeRemediationRun: the stale check refuses a Flux preview whose fromRevision is past the timeline", async () => {
  const fake = runFake(JSON.stringify({ ...preview, toRevision: 1, fromRevision: 3 }), tl);
  const out = await run(fake);
  assert.match(out.refused, /now at revision 3, past the timeline's newest recorded change \(revision 2\)/);
  assert.equal(fake.calls.revert, 0);
});

test("proposeRemediationRun stores the dry-run's fromRevision as from_revision, and a readable summary", async () => {
  const dry = { action: "rollout_undo", workload: "deployment/apps/api", fromRevision: 2, toRevision: 1, diff: [{ field: "api.env.MODE", from: "b", to: "a" }], dryRun: true, result: "validated" };
  const fake = runFake(JSON.stringify(dry), tl);
  const out = await run(fake);
  assert.equal(out.id, 11);
  assert.equal(fake.calls.stored!.from_revision, 2);
  assert.equal(fake.calls.stored!.to_revision, 1);
  assert.equal(out.dryRunSummary, "revision 2 → 1\napi.env.MODE: b → a");
});
