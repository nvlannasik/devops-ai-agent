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
// The Deployment's spec-changes, newest FIRST by revision NUMBER — never by timestamp. A
// rollback that reuses an existing ReplicaSet (scaling an old one back up) bumps the revision
// but keeps that ReplicaSet's original creationTimestamp, so a time sort can pick an earlier
// revision as "newest". The MCP server's own notion of "current" is the highest revision number,
// and this gate has to agree with it or it names the wrong target.
const specChangesOf = (timeline: ChangeTimeline, name: string) =>
  timeline.changes
    .filter((c) => c.workload === `Deployment/${name}` && c.kind === "spec-change" && Number.isFinite(Number(c.revision)))
    .sort((a, b) => Number(b.revision) - Number(a.revision));

export function rollbackRefusal(proposal: Proposal, timeline: ChangeTimeline | null): string | null {
  if (proposal.action !== "k8s_rollout_undo") return null;
  const { namespace, name, to_revision } = proposal.toolParams as { namespace: string; name: string; to_revision: number };
  if (!timeline) return `There is no change timeline for this thread, and a rollback needs the change it undoes. Investigate the alert first — the timeline is collected then.`;
  // A timeline is collected per-namespace (agent/changes), so one matching `name` in a DIFFERENT
  // namespace is a different cluster tenant's workload — the revision numbers below are not its.
  if (timeline.namespace !== namespace) {
    return `This thread's change timeline is for \`${timeline.namespace}\`, not \`${namespace}\` — it cannot ground a rollback of \`${namespace}/${name}\`.`;
  }
  const unread = timeline.unread.filter((u) => /^(rollout|cluster):/.test(u));
  if (unread.length > 0) return `The rollout history could not be read for this thread (${unread.join("; ")}), so there is no recorded change to roll back.`;
  const changes = specChangesOf(timeline, name);
  if (changes.length === 0) return `The change timeline records no change to \`${namespace}/${name}\` to undo — a rollback is only for a recent spec change that caused the fault.`;
  const newest = changes[0];
  const allowed = Number(newest.revision) - 1;
  if (allowed < 1) return `\`${namespace}/${name}\` revision ${newest.revision} is its first; there is no earlier revision to roll back to.`;
  if (to_revision === allowed) return null;
  return `The newest change to \`${namespace}/${name}\` is revision ${newest.revision} (${newest.at}); the revision before it is ${allowed}. Propose it again with to_revision: ${allowed}.`;
}

// The gate above is tool-free, so it can only reason from the timeline collected BEFORE the
// investigation started. A "roll it back" mention hours later can find the Deployment has moved
// — a fix-forward, or someone else's rollout — and the timeline has no way to see that. Checked
// AFTER the mandatory dry-run succeeds (never inside the tool-free gate itself, so recorded
// replay cases still cannot diverge on rollbackRefusal): the dry-run result is the one piece of
// LIVE evidence in this whole flow, and `fromRevision` is read from it.
//
// Returns null — not a refusal — when `fromRevision` is missing or unparseable, e.g. a GitOps
// preview (a structured PR diff, not a plain rollout dry-run): that shape is a different path's
// problem, and this function only has an opinion when it actually has the number.
export function staleRollbackRefusal(proposal: Proposal, timeline: ChangeTimeline | null, dryRunResult: string): string | null {
  if (proposal.action !== "k8s_rollout_undo") return null;
  const { namespace, name } = proposal.toolParams as { namespace: string; name: string };
  let fromRevision: number | null = null;
  try {
    const parsed = JSON.parse(dryRunResult) as { fromRevision?: unknown };
    const n = Number(parsed.fromRevision);
    if (Number.isFinite(n)) fromRevision = n;
  } catch {
    // not JSON — leave it to the other paths
  }
  if (fromRevision === null || !timeline) return null;
  const changes = specChangesOf(timeline, name);
  if (changes.length === 0) return null;
  const newest = Number(changes[0]!.revision);
  if (fromRevision === newest) return null;
  return `\`${namespace}/${name}\` is now at revision ${fromRevision}, past the timeline's newest recorded change (revision ${newest}) — the timeline is stale; re-investigate before rolling back.`;
}
