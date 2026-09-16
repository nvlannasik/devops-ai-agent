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
  /**
   * A scale-to-zero quarantine. Set here so the evidence gate upstream does not have to
   * re-derive "is this a quarantine?" from `toolParams.replicas === 0` at every call site —
   * one missed call site is a workload taken offline on no evidence.
   */
  quarantine?: boolean;
}

const s = z.string().min(1);
const kinds = z.enum(["deployment", "statefulset", "daemonset"]);

const RolloutRestart = z.object({ namespace: s, workload: s, kind: kinds.optional() });
// min(0), not min(1): zero is the reversible quarantine of a workload measured idle. It is not
// waved through here — `DevOpsAgent.quarantineRefusalFor` requires a k8s_recommend_resources run
// in the SAME thread to have listed this workload under `idleWorkloads`, the MCP server requires
// `quarantine: true`, the dry-run runs, and a human still clicks. This schema only stops zero
// being rejected before any of that can happen.
const Scale = z.object({
  namespace: s,
  workload: s,
  kind: z.enum(["deployment", "statefulset"]), // daemonsets have no replicas
  replicas: z.number().int().min(0),
});
// container optional: the MCP server auto-resolves it for single-container workloads —
// a model that guesses a container name is worse than one that omits it
const SetImage = z.object({ namespace: s, workload: s, kind: kinds, container: s.optional(), image: s });
const DeletePod = z.object({ namespace: s, pod: s });
// No secret, no persistentvolumeclaim, and that is a permanent exclusion rather than a first
// phase: a Secret's backup IS its credentials, and a PVC's manifest is not its data. Neither can
// be made reversible, and reversibility is the only thing that makes this action acceptable.
const DeleteOrphan = z.object({
  namespace: s,
  name: s,
  kind: z.enum(["configmap", "service", "serviceaccount", "deployment", "statefulset"]),
});
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
  // Same reasoning one step further out. Kubernetes object names are DNS-1123: lowercase only,
  // no exceptions anywhere in the API. So an uppercase letter in one of these fields is always
  // the model's, never the cluster's — benchmark A09 proposed `web-Frontend` against a Deployment
  // called `web-frontend`, a correct fix refused over the F. `image` is deliberately NOT in this
  // list: a registry path is lowercase by Docker's rules, but a TAG may legitimately carry
  // uppercase (`v1.2-RC1`), and lowercasing it would point the rollout at an image that does not
  // exist. `kind` is handled above because its allowed values are an enum, not a name.
  for (const k of ["namespace", "workload", "pod", "container"]) {
    const v = raw[k];
    if (typeof v === "string") raw[k] = v.toLowerCase();
  }
  // An explicit null is the model saying "not this field", and .optional() accepts undefined
  // but not null — so the whole proposal was rejected over a field it had declined to set.
  // Measured, not theorised: two of seven benchmark failures were this, and both carried a
  // correct action, namespace, workload, kind, container and memory_limit alongside
  // `"cpu_request": null, "cpu_limit": null`.
  //
  // Deleted rather than made nullable in each schema: null and absent have to mean the SAME
  // thing here, and toolParams goes straight to the MCP server — a null forwarded as a value
  // is a different bug one layer down. One place, all five action shapes.
  for (const [k, v] of Object.entries(raw)) if (v === null) delete raw[k];
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
      const quarantine = replicas === 0;
      return {
        action: "k8s_scale",
        namespace,
        name: workload,
        reason,
        // `quarantine` is sent to the tool only when it is one: the MCP server treats the flag
        // as the caller asserting intent, and asserting it on every scale would make the
        // assertion meaningless.
        toolParams: { namespace, name: workload, kind, replicas, ...(quarantine ? { quarantine: true } : {}) },
        ...(quarantine ? { quarantine: true } : {}),
        summary: quarantine
          ? `quarantine ${kind} \`${namespace}/${workload}\` → 0 replicas (reversible: scale back to restore)`
          : `scale ${kind} \`${namespace}/${workload}\` → ${replicas} replicas`,
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
    case "k8s_delete_orphan": {
      const p = DeleteOrphan.safeParse(raw);
      if (!p.success) return null;
      const { namespace, name, kind } = p.data;
      return {
        action: "k8s_delete_orphan",
        namespace,
        name,
        reason,
        toolParams: { namespace, name, kind },
        // The card has to say what the undo IS, not that one exists. "Reversible" with no
        // mechanism named reads as reassurance; a stored manifest is a fact.
        summary: `delete abandoned ${kind} \`${namespace}/${name}\` (manifest is backed up first — restore by re-applying it)`,
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
//
// BOTH LANGUAGES, because the agent answers in Indonesian and quotes the Kubernetes reason
// strings in English. "tanpa kejadian `Pending`, `Failed`" is a clean bill of health that an
// English-only negator list reads as fault evidence — it opened a remediation proposal on a
// healthy namespace, and the card landed in Slack with nothing to explain it. The negators
// are Indonesian, the words they negate stay English: those come out of tool output verbatim.
const NEGATED =
  /\b(no|zero|0|none|nothing|neither|not|never|without|tidak|tak|tanpa|bukan|belum|nihil|nol)\b(?:(?:(?!\b(?:but|however|though|although|except|while|tapi|tetapi|namun|meski|meskipun|walau|walaupun|kecuali|sedangkan)\b)[^.;\n]){0,30}?\b(?:alerts?|firing|restarts?|errors?|failures?|issues?|problems?|crash\w*|oom\w*|unhealthy|pending|failed|failing|unavailable|degraded|down|gagal|galat|masalah|kendala)\b)+/gi;

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
 * A cleanup or capacity QUESTION, in the user's own words.
 *
 * Its answer is a REVIEW LIST, and a review list is written in the same vocabulary a broken
 * cluster is: a Service with no endpoints reads "unavailable", an idle workload reads "not
 * ready", a rightsizing row reads "throttled" and "over-provisioned". None of that is a fault
 * anybody asked to have repaired.
 *
 * Observed live 2026-09-16: "ada resource yang ga kepake ga?" was answered with the unused scan
 * plus the rightsizing table, the fault-evidence branch below matched, and a GitOps PR approval
 * card appeared for a workload in a namespace the user had never mentioned. They asked whether
 * anything was unused and were handed a change to approve.
 *
 * Deliberately NOT the same vocabulary as `prompts/skills/resource-rightsizing.md`, which also
 * lists `oomkill`, `evicted` and `throttl` — those ARE faults and must keep proposing. This is
 * only the "what can we tidy up" half.
 */
const CAPACITY_QUESTION =
  /\b(unused|orphan\w*|unclaimed|idle|wasted|waste|clean ?up|cleanup|cost|right.?siz\w*|over.?provision\w*|optimi[sz]\w*)\b|\b\w{0,4}(terpakai|kepake|pake|nganggur|menganggur|boros|hemat|sisa|numpuk)\w*/i;

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
): { propose: boolean; reason: string; byUser: boolean } {
  // `byUser` is what separates "a person named this action" from "the agent's own answer carried
  // fault vocabulary". Only the first is a reason to skip the replacement guard, and this is the
  // only place that can tell them apart — by the time proposeRemediation runs, both look like an
  // RCA-shaped string. Deliberately NOT derived from the reason text: a wording change to a log
  // line must not silently disable a guard.
  if (isRca) return { propose: true, reason: "RCA response — a fault was diagnosed", byUser: false };
  if (ACTION_INTENT.test(userText)) return { propose: true, reason: "the user asked for a change", byUser: true };
  if (isApproval(userText) && ACTION_INTENT.test(previousReply)) {
    return { propose: true, reason: "the user approved the change proposed in the previous turn", byUser: true };
  }
  const hit = reply.replace(NEGATED, " ").match(FAULT_EVIDENCE);
  if (hit) {
    // The one inference this gate is no longer allowed to make: "the agent used fault vocabulary,
    // so something must be broken". After a cleanup question it is reporting, not diagnosing.
    //
    // The asymmetry note above says to widen rather than tighten, because a false positive costs
    // one LLM call that answers null. That was true when every proposable action was a repair.
    // It is not true here: this false positive reaches a human as an approval card for a change
    // to a workload they never named, and the cost of clicking it is the change.
    if (CAPACITY_QUESTION.test(userText)) {
      return {
        propose: false,
        reason: `capacity/cleanup question — "${hit[0]}" is a review finding, not a fault to repair`,
        byUser: false,
      };
    }
    return { propose: true, reason: `fault evidence in the answer ("${hit[0]}")`, byUser: false };
  }
  return { propose: false, reason: "read-only question, no fault evidence in the answer", byUser: false };
}

/**
 * Every action `parseProposal` will accept, and therefore every action the proposal prompt has
 * to OFFER. The two drifted on 2026-09-16 and the failure was silent in the worst way:
 * `k8s_delete_orphan` was added to the parser, the MCP server, the RBAC and
 * `prompts/system.md`, but not to `buildProposalPrompt` — which is a separate structured-output
 * call with its own action list. The model was asked to pick from five actions, none of which
 * was the one it needed, and answered `{"action": null}` twice. Nothing errored; the approval
 * card simply never appeared, and every log line looked healthy.
 *
 * The same edit also left clause 4 reading "never zero", so the scale-to-zero quarantine was
 * explicitly forbidden by the prompt that was supposed to offer it.
 *
 * `prompt-offers-every-parseable-action` in index.test.ts is what makes this list load-bearing.
 */
export const PROPOSABLE_ACTIONS = [
  "k8s_rollout_restart",
  "k8s_set_image",
  "k8s_set_resources",
  "k8s_scale",
  "k8s_delete_pod",
  "k8s_delete_orphan",
] as const;

export const PROPOSAL_SYSTEM =
  "You propose Kubernetes remediation actions after an incident investigation. Output ONLY a JSON object, no prose.";

export function buildProposalPrompt(labels: Record<string, string>, rca: string): string {
  // head+tail, not head-only: long RCAs put the concrete fix in Recommended Actions at
  // the END — a head-only slice cut it off and the model proposed nothing
  const ctx = rca.length <= 4000 ? rca : `${rca.slice(0, 2500)}\n...[truncated]...\n${rca.slice(-1500)}`;
  return (
    `An investigation just completed (alert-driven RCA, or a direct user request in Slack).\nAlert labels: ${JSON.stringify(labels)}\n\nContext:\n${ctx}\n\n` +
    'An explicit user request for one of these actions (e.g. "restart deployment X", "change the image tag to v1.2", "scale to 4 replicas") is sufficient on its own — propose it even without fault evidence; a human still approves it. Actions 6 and 7 are the exception: a request is never enough for them, because the user asking is not evidence that a workload is idle or that an object is abandoned — they are asking BECAUSE they are unsure. Those two need the tool result named beside them, in this context, or the answer is null. If the user gives only an image tag, keep the current image repository from the context and change only the tag.\n' +
    "If exactly ONE of these whitelisted actions would plausibly remediate the incident right now, output only its JSON:\n" +
    // THE SPEC TEST. Five of seven benchmark failures were k8s_rollout_restart proposed as a
    // generic gesture: on a missing config key, on a nonexistent image tag, on an OOM at the
    // limit, and on a namespace where every pod was Ready. The design doc predicted exactly
    // this ("the most likely failure mode of the proposal step"). The list below already said
    // "ONLY when" for the other four actions; restart said "plausibly", which is not a test —
    // so it became the answer whenever the model could not map the fault to a specific action.
    "FIRST, one test that decides most cases. A restart or a pod delete replaces a pod with an " +
    "IDENTICAL one, built from the same spec. If what is wrong lives in that spec — the image, " +
    "the resource limits, a missing config key, a Service selector — the replacement has it too " +
    "and the fault returns within seconds. Propose 1 or 5 ONLY when the spec is right and the " +
    "running process is wrong (a wedged process, a leaked connection pool, a stale in-memory " +
    "cache). Never as a generic gesture at a fault you cannot place.\n" +
    '1. {"action":"k8s_rollout_restart","namespace":"...","workload":"...","kind":"deployment|statefulset|daemonset","reason":"one line"}\n' +
    "   — ONLY when the spec is correct and the running process is not: the evidence shows a fault that a fresh identical pod would not reproduce\n" +
    '2. {"action":"k8s_set_image","namespace":"...","workload":"...","kind":"...","container":"...","image":"registry/repo:tag","reason":"..."}\n' +
    "   — when the RCA evidence shows the current image is wrong/nonexistent AND names a working image (e.g. the previously running tag), OR the user explicitly requested a specific image/tag. NEVER invent a tag yourself\n" +
    '3. {"action":"k8s_set_resources","namespace":"...","workload":"...","kind":"...","container":"...","memory_limit":"1Gi",...,"reason":"..."}\n' +
    "   — ONLY for OOMKilled / resource-exhaustion RCAs, or a Pending pod whose scheduler message says the REQUEST is larger than any node can satisfy (\"Insufficient cpu\"/\"Insufficient memory\") — that request is the fault and lowering it is the fix; propose modest values justified by the evidence (fields: cpu_request, memory_request, cpu_limit, memory_limit)\n" +
    // The fallacy three benchmark C03 attempts wrote almost word for word — "memory limit not
    // set ... adding limits aims to prevent unbounded memory usage and stabilize startup" —
    // against a container running `sleep 3; exit 1`. An absent limit is the DEFAULT, and it is
    // why the memory-ratio metric reads +Inf: there is no denominator.
    "   — A workload with NO limit set is not evidence of a resource fault. That is the default, and it is why the memory ratio reads +Inf: there is no denominator. \"Add limits to stabilize it\" is a hardening opinion about the spec, not a remediation for the incident in front of you, and the crash you are looking at happened without any limit being reached. Propose this ONLY when the evidence shows the container hit a limit (OOMKilled, exit code 137) or the scheduler refused the request\n" +
    '4. {"action":"k8s_scale","namespace":"...","workload":"...","kind":"deployment|statefulset","replicas":N,"reason":"..."}\n' +
    "   — ONLY when the RCA evidence shows under-capacity (load-driven saturation, HPA at max); propose a modest change from the current count. Zero is allowed for ONE case and it is not this one — see 6\n" +
    '6. {"action":"k8s_scale","namespace":"...","workload":"...","kind":"deployment|statefulset","replicas":0,"reason":"..."}\n' +
    "   — the QUARANTINE: a workload that is not broken, just doing nothing. ONLY when the context contains a `k8s_recommend_resources` result listing this exact workload under `idleWorkloads`. That list is the tool's own verdict over a 24h+ window, and it is the only thing that counts — \"it looks unused\", \"nobody mentions it\" and the user asking are all NOT evidence. Never propose zero for a workload that is failing: taking a broken thing offline is not a repair\n" +
    '5. {"action":"k8s_delete_pod","namespace":"...","pod":"...","reason":"..."}\n' +
    "   — ONLY when ONE specific pod is wedged while OTHER pods of the same workload are running fine. That comparison needs siblings to exist: a single-replica workload has no healthy sibling, so its one bad pod is evidence about the SPEC, not about that pod, and deleting it changes nothing. Use the exact pod name from the context; prefer k8s_rollout_restart when ALL pods of the workload are affected\n" +
    '7. {"action":"k8s_delete_orphan","namespace":"...","name":"...","kind":"configmap|service|serviceaccount|deployment|statefulset","reason":"..."}\n' +
    "   — removes an ABANDONED object. ONLY when the context contains a `k8s_find_unused_resources` result whose `orphanKeys` list holds `namespace/kind/name` for this exact object. `orphanKeys` is narrower than `findings`: it is the subset nothing declares. An object in `findings` with `managedBy` of `flux` or `helm` is NOT proposable — the cluster is not where it gets removed, and something declaring it on purpose is evidence the finding is wrong. Say that instead of proposing this\n" +
    "   — there is NO delete for a secret or a persistentvolumeclaim, and asking for one is not an option: a Secret's backup is its credentials and a PVC's manifest is not its data, so neither can be made reversible. Output null and say which of those two applies\n" +
    // "No action fits" was being treated as failure. It is the correct answer for a whole class
    // of real faults, and saying so is what stops the model reaching for a restart to have
    // something to say.
    'If the fix requires anything else, or you are not confident, output {"action": null}. That is a ' +
    'CORRECT and common answer, not a failure — a missing config key, a wrong Service selector, a ' +
    'bad RBAC rule and an absent pull secret are all real faults that none of these actions ' +
    'repairs. Proposing the nearest action anyway is worse than proposing nothing: a human is asked ' +
    'to approve a change that cannot work.\n' +
    // The mirror of the paragraph above, added after legitimising null cost two A03 attempts:
    // the model answered {"action": null} on a nonexistent image tag whose working predecessor
    // was sitting in the context. An escape hatch with no counterweight becomes the default.
    'Null is NOT a way out of a decision the context lets you make. If one of the actions above does ' +
    'fit and the value it needs is already in the context — the tag that was running before the ' +
    'failing rollout, the container name, the current replica count — propose it.\n' +
    '"workload" is the Deployment/StatefulSet/DaemonSet name — NOT a pod name (strip replicaset/pod hash suffixes like "-84fcf9b4db-r2ddw").\n' +
    '"container" is optional: include it ONLY if the container name literally appears in the context; otherwise omit it (single-container workloads are auto-resolved). NEVER guess a container name from the workload name.\n' +
    "Only use namespaces, workloads, containers, images, and values that appear in the context above — never invent them."
  );
}

// ---- One retry, when the model's own answer contradicts itself ----
//
// Two failures in the 16x3 benchmark run, one shape underneath: the model HAD the answer and
// did not put it in the fields. A05 emitted `k8s_set_resources` whose reason read "lower the
// orders-api CPU requests" and set no value, so the schema rejected it; A03 and A09 emitted
// {"action": null} with the tag that had been running before the failing rollout sitting in the
// context. Both are a prompt rule failing for the third time, which in this repo is when it
// stops being a prompt rule (worthProposing, the namespace scope lock, the log fan-out cap,
// the log-gap gate).
//
// One retry, never two. The notice is deliberately not a correction: six of sixteen benchmark
// cases END in a correct null — an absent pull secret, a bad RBAC rule, a wrong Service
// selector, a flap with nothing wrong — and a re-ask that reads as "you were wrong" buys A03
// by losing those. The dangerous direction is covered regardless: a model reaching for
// something to say reaches for a restart or a delete, and replace-guard.ts refuses both against
// a spec fault without asking the model anything.

const WHITELIST = ["k8s_rollout_restart", "k8s_set_image", "k8s_scale", "k8s_set_resources", "k8s_delete_pod"];

/** The action the model NAMED, whether or not the rest of the object validated. */
export function declaredAction(text: string): string | null {
  const m = text.match(/"action"\s*:\s*"([a-z0-9_]+)"/i);
  return m && WHITELIST.includes(m[1]) ? m[1] : null;
}

// What the schema above actually demands, in prose. Restating it beats "your JSON was invalid":
// the model cannot see the zod error, and the field it left out is the whole failure.
const REQUIRED: Record<string, string> = {
  k8s_rollout_restart: "namespace, workload, kind",
  k8s_set_image: "namespace, workload, kind, and image as a full registry/repo:tag",
  k8s_scale: "namespace, workload, kind, and replicas as an integer of at least 1",
  // The pointer at the end is not decoration. A05 named this action with no value, was asked
  // again, and answered {"action": null} — it took the escape hatch rather than read the number
  // off the context it already had. So the notice says where the number comes from.
  k8s_set_resources:
    'namespace, workload, kind, and AT LEAST ONE of cpu_request / memory_request / cpu_limit / memory_limit carrying a real Kubernetes quantity ("250m", "512Mi") — naming the action while leaving every value unset is what failed. The CURRENT request or limit is in the context above: for a Pending pod the scheduler could not fit, propose a value BELOW it; for an OOMKill, a limit ABOVE it',
  k8s_delete_pod: "namespace and pod, the exact pod name including its hash suffix",
};

export function retryNotice(raw: string): string {
  const action = declaredAction(raw);
  if (action) {
    return (
      `RETRY. Your previous answer named \`${action}\` but left its fields unusable, so it was ` +
      `discarded and nobody saw it. ${action} needs: ${REQUIRED[action]}. Emit that JSON again with ` +
      `every field set from the context above. If the context does not give you those values, answer ` +
      `{"action": null} instead — a named action with no values is the one answer that helps nobody.`
    );
  }
  return (
    `RETRY — a check, not a correction. Your previous answer proposed no action. That is frequently ` +
    `the right answer: a missing config key, a wrong Service selector, a bad RBAC rule and an absent ` +
    `pull secret are real faults none of the five actions repairs, and answering {"action": null} ` +
    `again is a correct outcome of this check. Before you do, re-read the Recommended Actions in the ` +
    `context. If they name a concrete change one of the five actions performs — an image tag that was ` +
    `running before this rollout, a resource value, a replica count — emit that action now with the ` +
    `values taken from the context. Decide from the context; never invent a value to have something to say.`
  );
}

/**
 * The proposal call, both attempts. `ask` is the caller's one LLM round-trip returning plain text
 * — the agent's routes it through the light chain and records usage, the benchmark's does not, and
 * neither concern belongs in here.
 *
 * The raw text of BOTH attempts is returned when it still fails, because the pair is the
 * diagnosis: "named an action twice and never filled it" and "held null under a re-ask" need
 * different fixes, and one text can only show one of them.
 */
export async function proposeWithRetry(
  labels: Record<string, string>,
  rca: string,
  ask: (prompt: string) => Promise<string>
): Promise<{ proposal: Proposal | null; raw: string }> {
  const prompt = buildProposalPrompt(labels, rca);
  const first = await ask(prompt);
  const parsed = parseProposal(first);
  if (parsed) return { proposal: parsed, raw: first };

  const second = await ask(`${prompt}\n\n${retryNotice(first)}`);
  const retried = parseProposal(second);
  return retried ? { proposal: retried, raw: second } : { proposal: null, raw: `${first}\n[retry] ${second}` };
}
