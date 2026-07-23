// Guarded Remediation — proposal generation (docs/DESIGN_guarded_remediation.md §6).
// One structured-output LLM call after the RCA proposes at most ONE whitelisted action;
// the output is validated here (shape + action whitelist) and again server-side by the
// MCP server (namespace allowlist + K8s dry-run). A bad proposal = no card = no execution.

import { z } from "zod";

export interface Proposal {
  action: string;
  namespace: string;
  name: string;
  reason: string;
  toolParams: Record<string, unknown>; // exact MCP tool input (dry_run added by callers)
  summary: string; // human-readable one-liner for the approval card / result messages
}

const s = z.string().min(1);
const kinds = z.enum(["deployment", "statefulset", "daemonset"]);

const RolloutRestart = z.object({ namespace: s, workload: s, kind: kinds.optional() });
const Scale = z.object({
  namespace: s,
  workload: s,
  kind: z.enum(["deployment", "statefulset"]), // daemonsets have no replicas
  replicas: z.number().int().min(1),
});
// container optional: the MCP server auto-resolves it for single-container workloads —
// a model that guesses a container name is worse than one that omits it
const SetImage = z.object({ namespace: s, workload: s, kind: kinds, container: s.optional(), image: s });
const DeletePod = z.object({ namespace: s, pod: s });
const SetResources = z
  .object({
    namespace: s,
    workload: s,
    kind: kinds,
    container: s.optional(),
    cpu_request: s.optional(),
    memory_request: s.optional(),
    cpu_limit: s.optional(),
    memory_limit: s.optional(),
  })
  .refine((o) => o.cpu_request || o.memory_request || o.cpu_limit || o.memory_limit);

export function parseProposal(text: string): Proposal | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  // K8s convention writes kinds capitalized ("Deployment") — a correct proposal was once
  // dropped over the D. Normalize before the case-sensitive zod enums.
  if (typeof raw.kind === "string") raw.kind = raw.kind.toLowerCase();
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "proposed by the agent after RCA";

  switch (raw.action) {
    case "k8s_rollout_restart": {
      const p = RolloutRestart.safeParse(raw);
      if (!p.success) return null;
      const kind = p.data.kind ?? "deployment";
      return {
        action: "k8s_rollout_restart",
        namespace: p.data.namespace,
        name: p.data.workload,
        reason,
        toolParams: { namespace: p.data.namespace, name: p.data.workload, kind },
        summary: `rolling restart of ${kind} \`${p.data.namespace}/${p.data.workload}\``,
      };
    }
    case "k8s_set_image": {
      const p = SetImage.safeParse(raw);
      if (!p.success) return null;
      const { namespace, workload, kind, container, image } = p.data;
      return {
        action: "k8s_set_image",
        namespace,
        name: workload,
        reason,
        toolParams: { namespace, name: workload, kind, ...(container ? { container } : {}), image },
        summary: `set image of ${container ? `container \`${container}\` in ` : ""}${kind} \`${namespace}/${workload}\` → \`${image}\``,
      };
    }
    case "k8s_scale": {
      const p = Scale.safeParse(raw);
      if (!p.success) return null;
      const { namespace, workload, kind, replicas } = p.data;
      return {
        action: "k8s_scale",
        namespace,
        name: workload,
        reason,
        toolParams: { namespace, name: workload, kind, replicas },
        summary: `scale ${kind} \`${namespace}/${workload}\` → ${replicas} replicas`,
      };
    }
    case "k8s_set_resources": {
      const p = SetResources.safeParse(raw);
      if (!p.success) return null;
      const { namespace, workload, kind, container, ...res } = p.data;
      const changes = Object.entries(res)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`);
      return {
        action: "k8s_set_resources",
        namespace,
        name: workload,
        reason,
        toolParams: { namespace, name: workload, kind, ...(container ? { container } : {}), ...res },
        summary: `update resources of ${container ? `container \`${container}\` in ` : ""}${kind} \`${namespace}/${workload}\` (${changes.join(", ")})`,
      };
    }
    case "k8s_delete_pod": {
      const p = DeletePod.safeParse(raw);
      if (!p.success) return null;
      const { namespace, pod } = p.data;
      return {
        action: "k8s_delete_pod",
        namespace,
        name: pod,
        reason,
        toolParams: { namespace, pod },
        summary: `delete pod \`${namespace}/${pod}\` (its controller recreates it)`,
      };
    }
    default:
      return null; // action null / unknown / non-whitelisted
  }
}

export const PROPOSAL_SYSTEM =
  "You propose Kubernetes remediation actions after an incident investigation. Output ONLY a JSON object, no prose.";

export function buildProposalPrompt(labels: Record<string, string>, rca: string): string {
  // head+tail, not head-only: long RCAs put the concrete fix in Recommended Actions at
  // the END — a head-only slice cut it off and the model proposed nothing
  const ctx = rca.length <= 4000 ? rca : `${rca.slice(0, 2500)}\n...[truncated]...\n${rca.slice(-1500)}`;
  return (
    `An investigation just completed (alert-driven RCA, or a direct user request in Slack).\nAlert labels: ${JSON.stringify(labels)}\n\nContext:\n${ctx}\n\n` +
    'An explicit user request for one of these actions (e.g. "restart deployment X", "change the image tag to v1.2", "scale to 4 replicas") is sufficient on its own — propose it even without fault evidence; a human still approves it. If the user gives only an image tag, keep the current image repository from the context and change only the tag.\n' +
    "If exactly ONE of these whitelisted actions would plausibly remediate the incident right now, output only its JSON:\n" +
    '1. {"action":"k8s_rollout_restart","namespace":"...","workload":"...","kind":"deployment|statefulset|daemonset","reason":"one line"}\n' +
    "   — for transient faults where a clean rolling restart plausibly fixes it now\n" +
    '2. {"action":"k8s_set_image","namespace":"...","workload":"...","kind":"...","container":"...","image":"registry/repo:tag","reason":"..."}\n' +
    "   — when the RCA evidence shows the current image is wrong/nonexistent AND names a working image (e.g. the previously running tag), OR the user explicitly requested a specific image/tag. NEVER invent a tag yourself\n" +
    '3. {"action":"k8s_set_resources","namespace":"...","workload":"...","kind":"...","container":"...","memory_limit":"1Gi",...,"reason":"..."}\n' +
    "   — ONLY for OOMKilled / resource-exhaustion RCAs; propose modest values justified by the evidence (fields: cpu_request, memory_request, cpu_limit, memory_limit)\n" +
    '4. {"action":"k8s_scale","namespace":"...","workload":"...","kind":"deployment|statefulset","replicas":N,"reason":"..."}\n' +
    "   — ONLY when the RCA evidence shows under-capacity (load-driven saturation, HPA at max); propose a modest change from the current count, never zero\n" +
    '5. {"action":"k8s_delete_pod","namespace":"...","pod":"...","reason":"..."}\n' +
    "   — ONLY when ONE specific pod is wedged (stuck, crash-looping, not Ready) while its siblings are healthy — its controller recreates it fresh. Use the exact pod name from the context; prefer k8s_rollout_restart when ALL pods of the workload are affected\n" +
    'If the fix requires anything else, or you are not confident, output {"action": null}.\n' +
    '"workload" is the Deployment/StatefulSet/DaemonSet name — NOT a pod name (strip replicaset/pod hash suffixes like "-84fcf9b4db-r2ddw").\n' +
    '"container" is optional: include it ONLY if the container name literally appears in the context; otherwise omit it (single-container workloads are auto-resolved). NEVER guess a container name from the workload name.\n' +
    "Only use namespaces, workloads, containers, images, and values that appear in the context above — never invent them."
  );
}
