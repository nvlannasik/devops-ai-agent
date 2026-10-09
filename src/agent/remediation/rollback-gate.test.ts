import { test } from "node:test";
import assert from "node:assert/strict";
import { rollbackRefusal, staleRollbackRefusal } from "./rollback-gate.js";
import type { ChangeTimeline } from "../changes/index.js";
import { DevOpsAgent } from "../index.js";
import { parseProposal } from "./proposal.js";

const undo = (to: number, ns = "bench-a14") => ({ action: "k8s_rollout_undo", namespace: ns, name: "invoice-worker", reason: "r", summary: "s", toolParams: { namespace: ns, name: "invoice-worker", kind: "deployment", to_revision: to } }) as never;
const T = (changes: ChangeTimeline["changes"], unread: string[] = []): ChangeTimeline => ({ namespace: "bench-a14", window: { from: "", to: "" }, changes, commits: [], unread, subjects: [] });
const spec = (rev: string, at: string) => ({ at, source: "rollout", kind: "spec-change", workload: "Deployment/invoice-worker", revision: rev, diff: [{ field: "worker.env.QUEUE_MODE", from: "batch", to: "streaming" }] });
const twoChanges = () => T([spec("2", "2026-10-09T01:00:00Z"), spec("4", "2026-10-09T03:00:00Z")]);

test("the revision before the newest spec-change passes", () => {
  assert.equal(rollbackRefusal(undo(1), T([spec("2", "2026-10-09T01:00:00Z")])), null);
  assert.equal(rollbackRefusal(undo(3), twoChanges()), null, "rev 4 is the newest change, so 3 is the target");
});

test("any other revision is refused, naming the right one", () => {
  assert.match(rollbackRefusal(undo(1), twoChanges()) ?? "", /to_revision: 3/);
  assert.match(rollbackRefusal(undo(4), twoChanges()) ?? "", /to_revision: 3/);
});

test("no timeline, an unread rollout source, or only a restart: refused (fail closed)", () => {
  assert.match(rollbackRefusal(undo(1), null) ?? "", /no change timeline/);
  assert.match(rollbackRefusal(undo(1), T([spec("2", "2026-10-09T01:00:00Z")], ["rollout: 403 forbidden"])) ?? "", /could not be read/);
  assert.match(rollbackRefusal(undo(1), T([spec("2", "2026-10-09T01:00:00Z")], ["cluster: timeout"])) ?? "", /could not be read/);
  assert.match(rollbackRefusal(undo(1), T([{ ...spec("2", "2026-10-09T01:00:00Z"), kind: "restart", diff: undefined }])) ?? "", /no change to/);
  assert.match(rollbackRefusal(undo(1), T([{ ...spec("2", "2026-10-09T01:00:00Z"), workload: "Deployment/other" }])) ?? "", /no change to/);
  assert.match(rollbackRefusal(undo(1), T([spec("1", "2026-10-09T01:00:00Z")])) ?? "", /first/);
});

test("every other action passes through untouched", () => {
  assert.equal(rollbackRefusal({ action: "k8s_rollout_restart" } as never, null), null);
});

// Finding 1: the gate matched only the workload name, so a proposal for `staging/invoice-worker`
// passed on a timeline collected for a DIFFERENT namespace's alert (same workload name, different
// cluster tenant) — the revision numbers it reasoned about were never this namespace's.
test("the proposal's namespace must match the timeline's, naming both", () => {
  const r = rollbackRefusal(undo(1, "staging"), T([spec("2", "2026-10-09T01:00:00Z")]));
  assert.match(r ?? "", /staging/);
  assert.match(r ?? "", /bench-a14/);
});

// Finding 2: a rollback that reuses an old ReplicaSet bumps the revision number but keeps that
// ReplicaSet's original creationTimestamp, so sorting by `at` picks an earlier revision as
// "newest". The MCP server's own notion of "current" is the highest revision number, not the
// latest timestamp — the gate has to agree with it.
test("newest is the highest revision number, not the latest timestamp", () => {
  const reused = T([spec("2", "2026-10-09T01:00:00Z"), spec("3", "2026-10-09T02:00:00Z"), spec("4", "2026-10-09T00:30:00Z")]);
  assert.equal(rollbackRefusal(undo(3), reused), null, "revision 4 is newest by number despite the earliest timestamp");
  assert.match(rollbackRefusal(undo(2), reused) ?? "", /to_revision: 3/);
});

// Finding 3: staleRollbackRefusal — the gate above is tool-free and reasons only from the
// timeline collected before the investigation started. A "roll it back" mention hours later can
// find the Deployment has moved past that timeline (a fix-forward, or someone else's rollout) —
// the mandatory dry-run's own `fromRevision` is the one piece of LIVE evidence available, and
// this is checked after the dry-run succeeds, never inside the tool-free gate itself.
test("staleRollbackRefusal: the dry-run's live revision has moved past the timeline", () => {
  const t = T([spec("4", "2026-10-09T01:00:00Z")]);
  const r = staleRollbackRefusal(undo(3), t, JSON.stringify({ fromRevision: 5 }));
  assert.match(r ?? "", /revision 5/);
  assert.match(r ?? "", /revision 4/);
});

test("staleRollbackRefusal: the dry-run's live revision matches the timeline's newest — passes", () => {
  const t = T([spec("4", "2026-10-09T01:00:00Z")]);
  assert.equal(staleRollbackRefusal(undo(3), t, JSON.stringify({ fromRevision: 4 })), null);
});

test("staleRollbackRefusal: unparseable or absent fromRevision (a GitOps preview, non-JSON) passes — left to the other paths", () => {
  const t = T([spec("4", "2026-10-09T01:00:00Z")]);
  assert.equal(staleRollbackRefusal(undo(3), t, "not json"), null);
  assert.equal(staleRollbackRefusal(undo(3), t, JSON.stringify({ ok: true, op: "dry_run" })), null);
});

test("staleRollbackRefusal: every other action passes through untouched", () => {
  assert.equal(staleRollbackRefusal({ action: "k8s_rollout_restart" } as never, null, "{}"), null);
});

// Fix round 2, finding: a rollout restart creates a revision too, recorded as `kind: "restart"`
// rather than `"spec-change"` — "the restart didn't help, roll it back" is the normal case, and
// a live revision that matches a recorded restart must NOT read as a stale timeline. The target
// revision is still chosen from spec-changes only (specChangesOf) — a restart is never proposed
// as the thing being undone.
const restart = (rev: string, at: string) => ({ ...spec(rev, at), kind: "restart", diff: undefined });

test("staleRollbackRefusal: a recorded restart counts as the newest rollout entry, not just spec-changes", () => {
  const t = T([spec("4", "2026-10-09T01:00:00Z"), restart("5", "2026-10-09T02:00:00Z")]);
  // The gate's TARGET still comes from the spec-change (rev 4 → allowed 3), proving the restart
  // never became the thing being undone.
  assert.equal(rollbackRefusal(undo(3), t), null);
  // The live revision (5) matches the recorded restart, so the timeline is NOT stale.
  assert.equal(staleRollbackRefusal(undo(3), t, JSON.stringify({ fromRevision: 5 })), null);
});

test("staleRollbackRefusal: a live revision past the recorded restart is still stale", () => {
  const t = T([spec("4", "2026-10-09T01:00:00Z"), restart("5", "2026-10-09T02:00:00Z")]);
  const r = staleRollbackRefusal(undo(3), t, JSON.stringify({ fromRevision: 6 }));
  assert.match(r ?? "", /revision 6/);
  assert.match(r ?? "", /revision 5/);
});

// Finding 4 (wiring gap): refusalFor must run the rollback gate even for a user's own request —
// "roll it back" names an intent, not a revision, so userRequested cannot skip it the way it
// skips the replacement guard. Every other gate ahead of it in the chain is stubbed open, the
// same pattern resource-fault.test.ts uses for the resource-fault gate's wiring test.
const fakeForRollback = (timeline: ChangeTimeline | null) =>
  ({
    kindRefusalFor: async () => null,
    threadEvidence: async () => null,
    quarantineRefusalFor: async () => null,
    orphanRefusalFor: async () => null,
    timelineFor: async () => timeline,
  }) as unknown as DevOpsAgent;

test("refusalFor runs the rollback gate even when the user asked for it themselves", async () => {
  const proposal = parseProposal(
    JSON.stringify({ action: "k8s_rollout_undo", namespace: "bench-a14", workload: "invoice-worker", kind: "deployment", to_revision: 1 })
  )!;
  const timeline = T([spec("3", "2026-10-09T01:00:00Z")]); // allowed target is 2, proposal asks for 1
  const r = await DevOpsAgent.prototype.refusalFor.call(fakeForRollback(timeline), proposal, {
    userRequested: true,
    threadId: "t",
    offer: null,
    labels: {},
    rca: "",
  });
  assert.equal(r?.gate, "rollback gate");
  assert.match(r?.reason ?? "", /to_revision: 2/);
});
