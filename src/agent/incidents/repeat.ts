// A recurrence (2026-11-24): the same alert on the same subject, resolved within the last day, is
// investigated again starting from what that incident concluded, with half the iterations. Read
// from 14 days of llm_usage: about half the tokens went to alerts whose subject had just been
// investigated — KubernetesNodeMemoryPressure 30 incidents on 2 nodes (25 %), FluxControllerDown 7
// on 1. The cap is on ITERATIONS, not tool rounds: the tool-budget notice is conversation mode's and
// forbids the RCA format, the iteration ceiling's leaves the alert path's RCA shape alone.

/**
 * The workload a pod belongs to, from its name — evicted and replaced pods come back under new
 * names (2026-11-14: node-exporter-4hq4p, -mmlwv, -fflnp… all one DaemonSet). Deployment
 * `<name>-<rs hash>-<5>`, DaemonSet/Job `<name>-<5>`, StatefulSet `<name>-<ordinal>`. The hashes
 * are Kubernetes' SafeEncodeString alphabet — no vowels, no 0/1/3 — which is what keeps
 * `node-exporter` and a static pod's `-raspi` from reading as one.
 */
const H = "[bcdfghjklmnpqrstvwxz2456789]";
const DEPLOYMENT_POD = new RegExp(`^(.+)-${H}{6,10}-${H}{5}$`);
const GENERATED_POD = new RegExp(`^(.+)-${H}{5}$`);
export function workloadOf(pod: string): string {
  const m = DEPLOYMENT_POD.exec(pod) ?? GENERATED_POD.exec(pod) ?? /^(.+)-\d+$/.exec(pod);
  return m ? m[1]! : pod;
}

/**
 * What "the same subject" means for a recurrence: the node for a node alert; the services the
 * group names (agent/correlation's distinctSubjects); else the pod's workload; else the namespace.
 * Null when there is nothing to tell one occurrence from another by.
 */
export function repeatKey(labels: Record<string, string | undefined>, subjects: string[] = []): string | null {
  const ns = labels.namespace ?? "";
  if (labels.node && !labels.pod) return `node:${labels.node}`;
  if (subjects.length) return `svc:${ns}/${[...subjects].sort().join(",")}`;
  if (labels.pod) return `workload:${ns}/${workloadOf(labels.pod)}`;
  return ns ? `ns:${ns}` : null;
}

export interface PriorIncident {
  id: number;
  createdAt: Date;
  resolvedAt: Date;
  rootCause: string;
}

const hoursAgo = (d: Date, now: Date) => Math.max(1, Math.round((now.getTime() - d.getTime()) / 3_600_000));

/** The notice that opens a recurrence's investigation — data about our own past answer, and how to use it. */
export function repeatNotice(prior: PriorIncident, now: Date, maxIterations: number): string {
  const cause = prior.rootCause.replace(/\s+/g, " ").trim().slice(0, 700);
  return (
    `[RECURRENCE — this alert, on the same subject, was investigated ${hoursAgo(prior.createdAt, now)} h ago (incident #${prior.id}) ` +
    `and resolved ${hoursAgo(prior.resolvedAt, now)} h ago. That investigation concluded:\n«${cause}»\n` +
    `It is a hypothesis from an earlier run, not evidence about now. Start from it: check with the fewest tool calls ` +
    `whether the same cause holds — the same component, the same kind of numbers — and cite what you read now. If it ` +
    `holds, say so plainly in Root Cause ("same cause as incident #${prior.id}"); if what you read contradicts it, say what ` +
    `changed. This run has at most ${maxIterations - 1} rounds of tool calls.]`
  );
}

/** The thread line that says why this investigation is shorter. */
export function repeatLine(prior: PriorIncident, now: Date, maxIterations: number): string {
  return (
    `♻️ *Recurrence* — the same alert on the same subject resolved ${hoursAgo(prior.resolvedAt, now)} h ago (incident #${prior.id}). ` +
    `Starting from that root cause and checking it still holds — at most ${maxIterations - 1} tool rounds instead of a full investigation.`
  );
}
