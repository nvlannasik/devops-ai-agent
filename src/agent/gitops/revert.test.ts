import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRevertCommit } from "./revert.js";
import { DevOpsAgent } from "../index.js";

const c = (sha: string, at: string, helmRelease: string) => ({ sha, at, author: "a", message: "m", url: "u", paths: ["p"], helmRelease });
const T = (commits: ReturnType<typeof c>[]) => ({ namespace: "n", window: { from: "", to: "" }, changes: [], commits, unread: [], subjects: [] });

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
});

test("proposeRevertPr with no commit for the HelmRelease refuses and never calls the worker", async () => {
  let called = false;
  const fake = { gitops: { request: async () => { called = true; return {}; } }, timelineFor: async () => T([]), resolveOverlayPath: async () => undefined, remediations: { propose: async () => 1 } };
  const out = await (DevOpsAgent.prototype as never as { proposeRevertPr: Function }).proposeRevertPr.call(fake, 1, proposal, preview, "thread");
  assert.match(out.refused, /nothing to revert/);
  assert.equal(called, false);
});
