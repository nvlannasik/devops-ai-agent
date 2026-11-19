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
  roles?: string[];
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

const CONTROL_PLANE_REFUSAL = " is a control-plane node — it is never cordoned or drained by this agent, whoever asks.";

const controlPlaneRefusal = (node: string): string =>
  `\`${node}\`${CONTROL_PLANE_REFUSAL} Its pods are ` +
  `the API server, scheduler and controller manager. Under pressure, the fix is the node's capacity (more memory ` +
  `or CPU for the machine) or moving workload pods off it; say that instead.`;

/**
 * The correction to post when the model proposed a cordon/drain of a control-plane node, the gate
 * refused it, and the RCA already in the thread tells a human to do exactly that — or null.
 *
 * A refusal of the model's own proposal is normally kept out of the thread (app/remediation.ts:
 * posting the gates' reasons buried on-call threads). This one is the exception because the text a
 * person acts on is wrong: on 2026-11-17 the RCA for master3-vm's MemoryPressure said "Immediate:
 * cordon master3-vm" in its TL;DR, actions table and runbook while the gate refused the card in
 * silence. A cordon frees no memory there and its pods are the control plane itself. Only when the
 * RCA names a cordon or drain of THAT node: a refusal with no such advice on screen stays hidden.
 */
export function controlPlaneCorrection(refused: string, rca: string): string | null {
  const m = new RegExp(`^\`([^\`]+)\`${CONTROL_PLANE_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(refused);
  if (!m) return null;
  const node = m[1]!;
  const n = node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "cordón" too: the model writes it with an accent now and then (the 2026-11-17 RCA did).
  const verb = "(?:cord[oó]n\\w*|drain\\w*)";
  const advises = rca.split("\n").some((line) => new RegExp(`${verb}[^\\n]{0,60}\\b${n}\\b|\\b${n}\\b[^\\n]{0,60}${verb}`, "i").test(line));
  if (!advises) return null;
  return (
    `:no_entry: *Do not cordon or drain \`${node}\`* — the analysis above suggests it, but \`${node}\` is a control-plane ` +
    `node: its pods are the API server, scheduler and controller manager, and a cordon frees no memory. The agent ` +
    `refuses this action whoever asks. Under pressure the fix is the machine's capacity (more memory or CPU) or ` +
    `moving workload pods off it.`
  );
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
  // The MCP server refuses these too, but only at the dry-run, where the refusal ends the card with
  // no re-ask. Production, 2026-11-14: a drain of control-plane `master3-vm` under MemoryPressure,
  // proposed twice in an hour and stopped both times only there. Said here, the one re-ask can turn
  // to what does help a control-plane node: its capacity.
  if ((action === "k8s_cordon" || action === "k8s_drain") && (d.roles ?? []).some((r) => r === "control-plane" || r === "master")) {
    return controlPlaneRefusal(node);
  }
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
