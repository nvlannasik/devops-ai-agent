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

// ---- Is this mention worth a proposal call at all? ----
//
// Every mention used to trigger one. "status check" on a healthy cluster therefore burned a
// heavy LLM call to arrive at {"action": null} — and on the day the heavy chain was down to
// one working backend it produced a page of stack traces instead. The alert path never asks
// this question: an alert firing IS the evidence.
//
// Deliberately asymmetric. A false positive costs exactly what today costs — one call that
// answers null — while a false negative silently drops a legitimate fix. So every rule below
// is a reason to SPEND the call, and skipping is only what's left when none of them fire.

// Verbs that ask for a change, English and Indonesian in one pattern because that is how the
// humans here type. An explicit request is sufficient evidence on its own (buildProposalPrompt
// says as much), so it has to survive this gate even on a perfectly healthy cluster.
// The Indonesian half matches STEMS with up to four leading characters, because the affixes
// carry the request: "perbaiki" arrives as "diperbaiki", "ganti" as "mengganti".
const ACTION_INTENT =
  /\b(restart|rollout|redeploy|deploy|scale|rollback|roll back|revert|delete|remove|patch|set|change|switch|update|upgrade|downgrade|increase|decrease|raise|lower|bump|resize|fix|apply|reconcile)\b|\b\w{0,4}(ganti|ubah|hapus|naik|turun|tambah|kurang|perbaik|kembali|nyala|matikan|terap|jalan)\w*/i;

// A clean bill of health mentions the same vocabulary a broken one does — the healthy reply
// that motivated this gate says "no alerts firing" and "0 restarts in the last hour". Negated
// forms come out before anything is matched, or the gate would never skip anything.
//
// The keyword group repeats (`+`) because one negation covers a whole list: "No alerts are
// firing and nothing is pending" has to lose `firing` too, not just `alerts`. The window
// between them stops at a contrastive conjunction so "no logs, but it is in CrashLoopBackOff"
// keeps its evidence — that clause is not a negation of the thing after "but".
const NEGATED =
  /\b(no|zero|0|none|nothing|neither|not|never|without)\b(?:(?:(?!\b(?:but|however|though|although|except|while)\b)[^.;\n]){0,30}?\b(?:alerts?|firing|restarts?|errors?|failures?|issues?|problems?|crash\w*|oom\w*|unhealthy|pending|failed|failing|unavailable|degraded|down)\b)+/gi;

// What's left has to be an actual negative state. Most of these are Kubernetes reason strings
// the agent quotes verbatim out of tool output, which is exactly why they're matched literally.
const FAULT_EVIDENCE =
  /\b(crashloop\w*|oomkill\w*|out of memory|imagepull\w*|errimagepull|createcontainer\w*|runcontainer\w*|invalidimagename|failedscheduling|unschedulable|evicted|backoff|node ?notready|not ready|unhealthy|degraded|unavailable|failing|failed|erroring|crashing|restarting|flapping|stuck|wedged|throttl\w*|saturat\w*|exhaust\w*|starv\w*|firing|disk pressure|memory pressure|timed out)\b/i;

// "ya" / "oke" / "go ahead" — how a person actually approves something already on the table.
// Anchored at the start so it is the message's whole point, not a word buried in a sentence.
const AFFIRMATIVE =
  /^(ya|iya|yoi|ok|oke|okay|sip|siap|boleh|setuju|lanjut|lanjutkan|gas|jalankan|yes|yep|yeah|sure|proceed|go|go ahead|do it)\b/i;

// Any of these anywhere in the message and it is not an approval, whatever it opened with:
// "ya tapi jangan sekarang" agrees with the diagnosis, not with doing the thing.
const DISSENT = /\b(jangan|tidak|nggak|ngga|gak|belum|batal|tunggu|nanti|cancel|no|don'?t|do not|stop|hold|wait)\b/i;

const isApproval = (text: string): boolean => AFFIRMATIVE.test(text.trim()) && !DISSENT.test(text);

/**
 * `isRca` is the strongest signal there is: the agent only reaches for the incident template
 * when it found something to diagnose.
 *
 * `previousReply` is what the agent said in the turn BEFORE this one, and it exists for the
 * case this gate used to miss entirely: the agent proposes a concrete change in prose, the
 * person answers "ya", and nothing happens — because "ya" names no action and the agent's own
 * confirmation ("Siap, nanti ada kardus approval...") carries no fault vocabulary either. The
 * intent lived across two turns and the gate only ever looked at one.
 *
 * Deliberately narrow: a bare approval opens the gate ONLY when the previous turn actually put
 * a change on the table. An "ok thanks" after a status report still proposes nothing.
 */
export function worthProposing(
  userText: string,
  reply: string,
  isRca: boolean,
  previousReply = ""
): { propose: boolean; reason: string } {
  if (isRca) return { propose: true, reason: "RCA response — a fault was diagnosed" };
  if (ACTION_INTENT.test(userText)) return { propose: true, reason: "the user asked for a change" };
  if (isApproval(userText) && ACTION_INTENT.test(previousReply)) {
    return { propose: true, reason: "the user approved the change proposed in the previous turn" };
  }
  const hit = reply.replace(NEGATED, " ").match(FAULT_EVIDENCE);
  if (hit) return { propose: true, reason: `fault evidence in the answer ("${hit[0]}")` };
  return { propose: false, reason: "read-only question, no fault evidence in the answer" };
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
