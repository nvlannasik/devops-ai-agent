import type { ChangeTimeline } from "../changes/index.js";
import type { Proposal } from "./proposal.js";

// A rollback undoes a change, so the change has to be ON RECORD: the thread's change timeline
// (agent/changes, assembled before the investigation from the cluster's ReplicaSets) must show a
// `spec-change` on this Deployment, and the target must be the revision just before the newest
// one. Fails CLOSED, like the quarantine gate: no timeline, or a rollout source that could not be
// read, means no card — a rollback to a revision nobody saw is a guess with a rolling update
// attached. A `restart` never qualifies: every image here is `:latest` with pull policy Always, so
// undoing a restart reverts one annotation and pulls the same image again. No tool calls, so
// recorded replay cases cannot diverge on it.
export function rollbackRefusal(proposal: Proposal, timeline: ChangeTimeline | null): string | null {
  if (proposal.action !== "k8s_rollout_undo") return null;
  const { namespace, name, to_revision } = proposal.toolParams as { namespace: string; name: string; to_revision: number };
  if (!timeline) return `There is no change timeline for this thread, and a rollback needs the change it undoes. Investigate the alert first — the timeline is collected then.`;
  const unread = timeline.unread.filter((u) => /^(rollout|cluster):/.test(u));
  if (unread.length > 0) return `The rollout history could not be read for this thread (${unread.join("; ")}), so there is no recorded change to roll back.`;
  const changes = timeline.changes
    .filter((c) => c.workload === `Deployment/${name}` && c.kind === "spec-change" && Number.isFinite(Number(c.revision)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (changes.length === 0) return `The change timeline records no change to \`${namespace}/${name}\` to undo — a rollback is only for a recent spec change that caused the fault.`;
  const newest = changes[0];
  const allowed = Number(newest.revision) - 1;
  if (allowed < 1) return `\`${namespace}/${name}\` revision ${newest.revision} is its first; there is no earlier revision to roll back to.`;
  if (to_revision === allowed) return null;
  return `The newest change to \`${namespace}/${name}\` is revision ${newest.revision} (${newest.at}); the revision before it is ${allowed}. Propose it again with to_revision: ${allowed}.`;
}
