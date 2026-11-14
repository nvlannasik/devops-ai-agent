import { VM_RESTART_TOOL } from "../vm/tools.js";

/**
 * Node actions need the node to say what the action is for. Bench, 2026-11-14 (cases C12, A16):
 * the most expensive cards this agent can raise had no gate of their own. A stale
 * `WorkerNodeIsNotReady` for a node that was Ready, schedulable and under no pressure produced
 * a `k8s_cordon` of it — "falsely reporting as Ready" — and in two more attempts a
 * `vm_restart_service` of `kubelet` on it, a VM action aimed at a Kubernetes node, in a run with no
 * VM agent configured at all. The dry-run would have caught neither: cordoning a healthy node is a
 * perfectly valid operation.
 *
 * The node is read live (`k8s_describe_node`), the same way the replacement guard reads pods: the
 * claim is about its state now, and the thread may hold a stale snapshot. Anything unreadable
 * returns null — this may only add a refusal.
 */
export interface NodeDetail {
  name?: string;
  conditions?: Array<{ type?: string; status?: string }>;
  unschedulable?: boolean;
}

export function parseNodeDetail(raw: string): NodeDetail | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const d = JSON.parse(raw.slice(start, end + 1)) as NodeDetail;
    return d && typeof d === "object" && Array.isArray(d.conditions) ? d : null;
  } catch {
    return null;
  }
}

/** What is wrong with the node, in its own words; empty when nothing is. */
export function nodeFaults(d: NodeDetail): string[] {
  const out: string[] = [];
  for (const c of d.conditions ?? []) {
    if (c.type === "Ready" && c.status !== "True") out.push(`Ready=${c.status ?? "Unknown"}`);
    if (c.type !== "Ready" && c.status === "True") out.push(String(c.type));
  }
  return out;
}

/**
 * - cordon / drain: refused while the node has no fault — Ready, no pressure — unless a human asked
 *   (maintenance is a reason the node cannot show; bench C11 is that request). A cordon of a node
 *   already cordoned is refused either way: it changes nothing.
 * - uncordon: refused when the node is not cordoned (a no-op) and, for the model's own proposal,
 *   while the node still has a fault — lifting a cordon that a fault explains puts pods back on it.
 */
export function nodeActionRefusal(action: string, node: string, d: NodeDetail, userRequested: boolean): string | null {
  const faults = nodeFaults(d);
  const cordoned = d.unschedulable === true;
  if (action === "k8s_cordon" && cordoned) {
    return `\`${node}\` is already cordoned — a cordon changes nothing. If pods must leave it, that is a drain.`;
  }
  if ((action === "k8s_cordon" || action === "k8s_drain") && !userRequested && faults.length === 0) {
    return (
      `\`${node}\` is Ready with no pressure condition, read live just now — nothing on the node is failing, so ` +
      `there is nothing a ${action === "k8s_drain" ? "drain" : "cordon"} would protect pods from. An alert that says ` +
      `otherwise is stale or flapping; say that, and what was checked. A cordon or a drain for maintenance is a ` +
      `human's call, made by asking for it.`
    );
  }
  if (action === "k8s_uncordon") {
    if (!cordoned) return `\`${node}\` is not cordoned — an uncordon changes nothing.`;
    if (!userRequested && faults.length > 0) {
      return (
        `\`${node}\` is cordoned and still reports ${faults.join(", ")} — the cordon is explained by a fault that ` +
        `is not gone, and lifting it puts pods back on a failing node.`
      );
    }
  }
  return null;
}

/**
 * A VM action needs a VM. `vm_restart_service` exists only when VM agents are configured
 * (`withVmTools`), and its host is never a Kubernetes node: restarting a node's kubelet or
 * runtime is below Kubernetes and a non-goal of the node-ops design. Production's dry-run would
 * refuse an unregistered host; the benchmark has no dry-run, so this is said here too.
 */
export function vmActionRefusal(action: string, host: string, toolNames: readonly string[], isKubernetesNode: boolean): string | null {
  if (action !== VM_RESTART_TOOL) return null;
  if (!toolNames.includes(VM_RESTART_TOOL)) {
    return `No VM agent is configured here, so \`${VM_RESTART_TOOL}\` has nothing to run on — \`${host}\` is not a registered VM.`;
  }
  if (isKubernetesNode) {
    return (
      `\`${host}\` is a Kubernetes node, not a registered VM. Restarting a node's kubelet or container runtime is ` +
      `below what this agent does; the node actions are cordon, uncordon and drain.`
    );
  }
  return null;
}
