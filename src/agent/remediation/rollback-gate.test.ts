import { test } from "node:test";
import assert from "node:assert/strict";
import { rollbackRefusal } from "./rollback-gate.js";
import type { ChangeTimeline } from "../changes/index.js";

const undo = (to: number) => ({ action: "k8s_rollout_undo", namespace: "bench-a14", name: "invoice-worker", reason: "r", summary: "s", toolParams: { namespace: "bench-a14", name: "invoice-worker", kind: "deployment", to_revision: to } }) as never;
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
