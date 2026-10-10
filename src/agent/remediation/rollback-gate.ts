import { short, type ChangeTimeline } from "../changes/index.js";
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
export const specChangesOf = (timeline: ChangeTimeline, name: string) =>
  timeline.changes
    .filter((c) => c.workload === `Deployment/${name}` && c.kind === "spec-change" && Number.isFinite(Number(c.revision)))
    .sort((a, b) => Number(b.revision) - Number(a.revision));

// Every rollout entry for this Deployment, any KIND — a restart creates a revision too (it is
// recorded as `kind: "restart"`, never `"spec-change"`), and "the restart didn't help, roll it
// back" is the common case. staleRollbackRefusal asks "does the timeline know about the live
// revision at all", which a restart answers just as well as a spec-change; only the TARGET
// (specChangesOf, above) must stay spec-changes-only, so a restart is never proposed as the
// thing being undone.
const newestRolloutRevisionOf = (timeline: ChangeTimeline, name: string): number | null => {
  const revisions = timeline.changes
    .filter((c) => c.source === "rollout" && c.workload === `Deployment/${name}` && Number.isFinite(Number(c.revision)))
    .map((c) => Number(c.revision));
  return revisions.length > 0 ? Math.max(...revisions) : null;
};

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

// The live revision a k8s_rollout_undo dry-run reports (cluster path and Flux preview alike), or
// undefined when the result is not JSON or carries no number.
export function rolloutFromRevision(dryRunResult: string): number | undefined {
  try {
    const n = Number((JSON.parse(dryRunResult) as { fromRevision?: unknown }).fromRevision);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

// The gate above is tool-free, so it can only reason from the timeline collected BEFORE the
// investigation started. A "roll it back" mention hours later can find the Deployment has moved
// — a fix-forward, or someone else's rollout — and the timeline has no way to see that. Checked
// AFTER the mandatory dry-run succeeds (never inside the tool-free gate itself, so recorded
// replay cases still cannot diverge on rollbackRefusal): the dry-run result is the one piece of
// LIVE evidence in this whole flow, and `fromRevision` is read from it — the Flux `rollback`
// preview carries it too, so a revert PR is checked the same way.
//
// Returns null — not a refusal — when `fromRevision` is missing or unparseable (an older MCP
// server, non-JSON): this function only has an opinion when it actually has the number. The
// cluster path fails closed on a missing number separately, in proposeRemediationRun.
export function staleRollbackRefusal(proposal: Proposal, timeline: ChangeTimeline | null, dryRunResult: string): string | null {
  if (proposal.action !== "k8s_rollout_undo") return null;
  const { namespace, name } = proposal.toolParams as { namespace: string; name: string };
  const fromRevision = rolloutFromRevision(dryRunResult);
  if (fromRevision === undefined || !timeline) return null;
  // ALL rollout kinds, not just spec-change: a restart is recorded too, and a live revision that
  // matches a recorded restart is not stale — "restart didn't help, roll it back" is the normal
  // case this must not refuse. specChangesOf stays the one used to pick the TARGET revision.
  const newest = newestRolloutRevisionOf(timeline, name);
  if (newest === null) return null;
  if (fromRevision === newest) return null;
  return `\`${namespace}/${name}\` is now at revision ${fromRevision}, past the timeline's newest recorded change (revision ${newest}) — the timeline is stale; re-investigate before rolling back.`;
}

// The approval card's dry-run line for a cluster-path rollback: the raw tool JSON cut at 400 chars
// showed the approver a fragment of `diff`, so the card is built from its fields instead. An
// empty diff is said out loud — diffPodTemplates compares containers only (image/env/args/
// resources/probes), and a rollback that changes none of those changes something it cannot show.
export function rollbackDryRunSummary(dryRunResult: string): string {
  const d = JSON.parse(dryRunResult) as { fromRevision?: unknown; toRevision?: unknown; diff?: Array<{ field: string; from: string; to: string }> };
  const diff = d.diff ?? [];
  const lines = diff.length
    ? diff.map((x) => `${x.field}: ${short(String(x.from), 120)} → ${short(String(x.to), 120)}`)
    : ["no container image/env/args/resources/probes difference — the change is elsewhere in the pod template; review the ReplicaSets before approving"];
  return [`revision ${d.fromRevision} → ${d.toRevision}`, ...lines].join("\n");
}
