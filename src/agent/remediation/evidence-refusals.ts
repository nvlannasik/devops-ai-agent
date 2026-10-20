import { type Proposal } from "./proposal.js";
import { type Message } from "../llm/types.js";

/**
 * The idle-evidence test for a scale-to-zero, as a pure function so it can be tested without a
 * Redis, an LLM or a thread. `observed` is the thread's tool output (lowercased by
 * `observedText`), or null when the run has no conversation to read at all.
 *
 * Returns the refusal sentence, or null to let the proposal through.
 *
 * One exact substring, not a set of loose ANDed tests: `IdleWorkload.key` exists on the MCP
 * server for precisely this and appears in no other tool output. The context compactor may have
 * truncated the result, and a truncated result FAILS the match — the safe direction, costing a
 * re-run rather than an outage.
 */
export function quarantineRefusal(proposal: Proposal, observed: string | null): string | null {
  if (!proposal.quarantine) return null;
  const target = `${proposal.namespace}/${proposal.name}`;
  if (observed === null) {
    return `Scaling \`${target}\` to zero needs an idle measurement, and this run has no conversation to read one from.`;
  }
  // parseProposal already lowercased namespace/name/kind; the toLowerCase is belt and braces.
  const kind = String(proposal.toolParams.kind ?? "deployment");
  const key = `${proposal.namespace}/${kind}/${proposal.name}`.toLowerCase();
  if (observed.includes(key)) return null;
  return (
    `Scaling \`${target}\` to zero is refused: no \`k8s_recommend_resources\` result in this thread ` +
    `lists it under \`idleWorkloads\`. Run it with \`window: "24h"\` first — a workload that has not been ` +
    `measured idle is a workload nobody has checked, and taking it offline on a hunch is an outage.`
  );
}

/**
 * The orphan-evidence test for a delete, same shape and same fail-closed rule as
 * `quarantineRefusal` above. `observed` is the thread's tool output, or null when there is no
 * conversation to read.
 *
 * Demands that a `k8s_find_unused_resources` run IN THIS THREAD put this exact object in
 * `orphanKeys` — the scan's list of findings nothing declares. That is a narrower claim than
 * "it appeared in the findings": a Flux-declared object appears there too, and deleting one is
 * both futile and evidence the finding was wrong.
 *
 * This gate is about GROUNDING, not about safety — the MCP server re-reads the live object and
 * refuses on provenance, ownership, replicas and age at execution time, which is the check that
 * matters. What this stops is the other failure: a model naming an object no scan ever flagged,
 * which is the same class of invention `groundingGaps` exists for and which no server-side check
 * can catch, because an invented name can still resolve to a real object.
 */
export function orphanDeleteRefusal(proposal: Proposal, observed: string | null): string | null {
  if (proposal.action !== "k8s_delete_orphan") return null;
  const target = `${proposal.namespace}/${proposal.name}`;
  if (observed === null) {
    return `Deleting \`${target}\` needs an unused-resource scan to have flagged it, and this run has no conversation to read one from.`;
  }
  const kind = String(proposal.toolParams.kind ?? "");
  const key = `${proposal.namespace}/${kind}/${proposal.name}`.toLowerCase();
  if (observed.includes(key)) return null;
  return (
    `Deleting \`${target}\` is refused: no \`k8s_find_unused_resources\` result in this thread lists it under ` +
    `\`orphanKeys\`. Run the scan on that namespace first. If it IS in the findings but not in \`orphanKeys\`, ` +
    `something declares it — Flux or Helm — and the cluster is not where it gets removed.`
  );
}

/**
 * A card for a workload nothing ever saw.
 *
 * `groundingGaps` catches an invented name in the RCA TEXT and posts a warning beside it. The
 * proposal is the same invention one step further on, where it stops being a sentence and becomes
 * a button. Benchmark C06, 2026-09-23, all three attempts: the model answered "check the logs for
 * api" with a fabricated deployment `bench-api` — the namespace holds `api-gateway`,
 * `payments-api` and `api-worker` — and proposed a rolling restart of it. The dry-run would have
 * refused that one (no such object), but only after the model had been told its target was real
 * by everything upstream, and a NAME THAT RESOLVES is the dangerous version: `orders-api` for
 * `orders-api-svc` is a real object and the wrong one.
 *
 * Grounded means the workload's name appears in this thread's tool output, or in the alert labels
 * that named the subject in the first place. Fails open on a run with no thread at all.
 */
// Kubernetes' pod-template-hash alphabet (rand.SafeEncodeString: no vowels, no 0, 1 or 3).
const TEMPLATE_HASH = /-([bcdfghjklmnpqrstvwxz2456789]{6,10})$/;

/**
 * A ReplicaSet's name given as a Deployment's. The grounding rule below lets a Deployment be seen
 * through its pods' prefix, and a ReplicaSet's name is a longer prefix of the same pods — so live on
 * 2026-09-28 (A01) a resize of deployment `payments-api-c5ccb5f74` passed as grounded, and in an
 * allowed namespace the dry-run would have answered it with NotFound. The pods tell them apart: a
 * ReplicaSet's are its name plus FIVE characters; a Deployment's carry the template hash first.
 */
function replicaSetAsDeployment(proposal: Proposal, name: string, observed: string): string | null {
  if (String(proposal.toolParams.kind ?? "deployment").toLowerCase() !== "deployment") return null;
  const hash = TEMPLATE_HASH.exec(name);
  if (!hash) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`${escaped}-[a-z0-9]{5}(?![a-z0-9])`).test(observed)) return null;
  const deployment = proposal.name.slice(0, -hash[0].length);
  return (
    `\`${proposal.namespace}/${proposal.name}\` is a ReplicaSet, not a Deployment: its pods are named ` +
    `\`${proposal.name}-xxxxx\`, and \`-${hash[1]}\` is the pod template's hash. The Deployment is ` +
    `\`${proposal.namespace}/${deployment}\` — a change aimed at the ReplicaSet's name finds nothing to patch.`
  );
}

/**
 * The latest result of one tool in a thread, or null. A `tool_result` block carries no tool name,
 * so it is paired to its `tool_use` by id. For the cluster tour, whose tables are built from the
 * inventory the tool returned rather than from the model's prose (utils/slack/tour-tables).
 */
export function lastToolResultIn(history: Message[], tool: string): string | null {
  const ids = new Set<string>();
  for (const m of history) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use" && b.name === tool && b.id) ids.add(b.id);
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!.content;
    if (typeof c === "string") continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j]!;
      if (b.type === "tool_result" && b.tool_use_id && ids.has(b.tool_use_id) && typeof b.content === "string") return b.content;
    }
  }
  return null;
}

export function ungroundedTargetRefusal(
  proposal: Proposal,
  observed: string | null,
  labels: Record<string, string> = {}
): string | null {
  if (observed === null) return null;
  const name = proposal.name.toLowerCase();
  if (!name) return null;
  const replicaSet = replicaSetAsDeployment(proposal, name, observed.toLowerCase());
  if (replicaSet) return replicaSet;
  // A target named after its own namespace is in every result as the NAMESPACE (bench C01,
  // 2026-10-07: restart `bench-c01/bench-c01` when the only workload was `web`). Then only a
  // workload-shaped sighting counts: an object `"name":"<it>"` or its pods' `<it>-` prefix — and
  // the namespace label is not one.
  if (name === proposal.namespace.toLowerCase()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asWorkload = new RegExp(`"name"\\s*:\\s*"${escaped}"|(?<![a-z0-9-])${escaped}-[a-z0-9]`, "i");
    if (asWorkload.test(observed)) return null;
    if (Object.entries(labels).some(([k, v]) => k !== "namespace" && typeof v === "string" && v.toLowerCase().includes(name))) return null;
  } else {
    if (observed.toLowerCase().includes(name)) return null;
    if (Object.values(labels).some((v) => typeof v === "string" && v.toLowerCase().includes(name))) return null;
  }
  return (
    `\`${proposal.namespace}/${proposal.name}\` appears in no tool result from this investigation and in ` +
    `no alert label, so the target was written rather than found. Name a workload that showed up in what ` +
    `you actually read — if the request named something ambiguous, list the candidates and ask which one.`
  );
}

/**
 * Resizing needs a fault that resizing addresses, read from the cluster.
 *
 * On the 2026-09-23 run `k8s_set_resources` was the model's default reach when it could not place
 * a cause: A01 (a missing ConfigMap key), B04 (a wrong DATABASE_URL), C03 (a container that
 * crashes logging nothing), C08 (an injected log line) — four proposals to resize four workloads
 * whose faults are not size. Each would reach a human as a card to approve.
 *
 * A guard of this shape existed once and was measured OUT: it required the namespace's EVENTS to
 * name a resource fault, and A02 went from 5/5 to 0, because a real OOMKill lives in the
 * container's `lastState.terminated.reason` and a pod settled into CrashLoopBackOff need not have
 * an event for it at all. This reads the whole of what the investigation gathered instead of one
 * tool's output, which is the difference the old note asks for — and it is measured the same way
 * before it is trusted.
 *
 * Fails open with no thread to read. Skipped for a human's own request, like the replacement guard.
 */
// NOT `nodes are available`: every FailedScheduling message opens with "0/3 nodes are available:",
// whatever the reason, so that phrase made an unbound PVC and a node-selector mismatch count as
// resource faults — A07 carded a resize for a claim that never bound (bench, 2026-09-29). The
// reason that a resize fixes, `insufficient cpu|memory`, is matched on its own.
const RESOURCE_FAULT =
  /\b(oomkill\w*|out of memory|exit code 137|memory limit|memory pressure|cpu pressure|throttl\w*|insufficient (?:cpu|memory)|evicted|didn'?t have free ports|over.?provision\w*|under.?provision\w*|no_requests|oom_risk|cpu_throttled)\b/i;

export function resourceFaultRefusal(proposal: Proposal, observed: string | null): string | null {
  if (proposal.action !== "k8s_set_resources") return null;
  if (observed === null || RESOURCE_FAULT.test(observed)) return null;
  return (
    `resizing \`${proposal.namespace}/${proposal.name}\` is refused: nothing this investigation read ` +
    `shows a fault that a different request or limit would address — no OOMKill, no throttling, no ` +
    `scheduling pressure. A container that crashes on its config, a wrong connection string and an ` +
    `unreadable log all survive a resize unchanged. Name the fault you did find, or say it could not ` +
    `be determined.`
  );
}

/**
 * A proposal that wandered off its own offer.
 *
 * Bench case C09, attempt 1: the agent offered `[OFFER] delete
 * \`bench-c09/Service/bench-c09-cache\`` — the object the human had just named — and the proposal
 * call came back with `default/unsueddd`, a different orphan from the same cluster-wide scan.
 * Grounded (a real object, in the tool output), refused by nothing, and not what anybody agreed
 * to. The `[OFFER]` line exists precisely so the target stops being inferred from prose; letting
 * the proposal disagree with it would put the guessing back one step later.
 *
 * Only when the offer names an object: an offer is free text otherwise, and this compares names.
 */
export function offerMismatchRefusal(proposal: Proposal, offer: string | null): string | null {
  if (!offer) return null;
  const named = offer.match(/`([^`\n]*\/[^`\n]*)`/)?.[1];
  if (!named) return null;
  const parts = named.toLowerCase().split("/").filter(Boolean);
  const target = parts[parts.length - 1];
  if (!target || target === proposal.name.toLowerCase()) return null;
  return (
    `the card would act on \`${proposal.namespace}/${proposal.name}\`, but what was offered and agreed to ` +
    `was \`${named}\`. Propose the object that was actually discussed, or say why it is the wrong one — a ` +
    `human approving "yes" is approving the thing they were shown.`
  );
}

/** What "the same card" means: the action and the object it acts on, never the parameters. */
export const targetKey = (action: string, namespace: string, name: string): string =>
  `${action}:${namespace}/${name}`.toLowerCase();

/**
 * Scaling OUT needs something in this thread to have measured the workload as saturated.
 *
 * Measured 2026-09-22, one armed `GATEWAY_TIMEOUT_MS`: four cards proposed more replicas for
 * checkout-gateway and orders-api. The only throttling anywhere in that thread belonged to
 * `loadgen`, which is the traffic generator. Latency and 5xx are what a dependency fault and a
 * config fault look like too, and for those, replicas copy the fault rather than relieve it.
 *
 * Evidence is the thread's tool output: the workload's own name within 300 characters of a
 * saturation word. Deliberately NOT a pod-state read — the guard that had to do that (events
 * before `k8s_set_resources`) took benchmark A02 from 5/5 to 0 and was removed. This one reads
 * what the investigation already gathered, or it refuses.
 *
 * Skipped for `replicas: 0` (the quarantine gate owns that one) and for a human's own request.
 */
const SATURATION =
  /\b(throttl\w*|saturat\w*|cpu limit|memory limit|backlog|queue depth|oldest_job|not draining|pending pods?|unschedulable|hpa|maxreplicas|resource pressure|capacity)\b/i;

export function scaleOutRefusal(proposal: Proposal, observed: string | null): string | null {
  if (proposal.action !== "k8s_scale") return null;
  const replicas = proposal.toolParams.replicas;
  if (typeof replicas !== "number" || replicas === 0) return null;
  const target = `\`${proposal.namespace}/${proposal.name}\``;
  const refusal =
    `Scaling ${target} to ${replicas} is refused: nothing in this investigation measures that workload as ` +
    `saturated — no throttling, queue backlog or scheduling pressure of its own. Latency and 5xx look the ` +
    `same when the fault is in a dependency or in configuration, and replicas copy that fault instead of ` +
    `relieving it. Measure the workload first, or fix what it is waiting on.`;
  if (observed === null) return refusal;

  // ponytail: line-scoped, because a character window is not proximity in tool output — the pod
  // list that motivated this guard puts loadgen's throttling and orders-api's healthy row 40
  // characters apart. A single-line JSON array holding both would still pass; widen only if that
  // is ever observed, since the failure direction here is an extra refusal, not an extra card.
  const name = proposal.name.toLowerCase();
  return observed.split("\n").some((line) => line.toLowerCase().includes(name) && SATURATION.test(line))
    ? null
    : refusal;
}

/**
 * An image change must name an image something in this thread actually showed — a tool result,
 * or the person asking.
 *
 * Live 2026-09-22, SampleAppHighLatency: a correct RCA (orders-api's response shape changed,
 * checkout-gateway cannot parse it) became a GitOps PR card setting checkout-gateway to
 * `registry.example.com/checkout-gateway:v1.2`. No tool had ever returned that registry; `v1.2` is
 * the example in buildProposalPrompt's own text. The dry-run cannot catch it — writing a string
 * into a values file is a perfectly valid operation — and a merged PR would have been an
 * ImagePullBackOff.
 *
 * Grounded when the full image appears in the evidence, or when the user named the TAG in words
 * ("change the tag to v1.3") on a repository the cluster already runs. The Docker Hub prefixes are
 * dropped before comparing, because listings and people disagree about whether to write them. NOT
 * skipped for a user request: a person who names an image passes through the user-text half of the
 * rule.
 */
export function unseenImageRefusal(proposal: Proposal, observed: string | null, userText: string): string | null {
  if (proposal.action !== "k8s_set_image") return null;
  const image = String(proposal.toolParams.image ?? "");
  if (!image) return null;
  // `library/` matters as much as `docker.io/`, and leaving it out cost a benchmark case a pass.
  // Measured A03 attempt 2, 2026-09-25: a tool result showed `nginx:alpine`, the model correctly
  // found it and wrote the canonical long form `docker.io/library/nginx:alpine`, and this guard
  // refused it as invented — because dropping only `docker.io/` leaves `library/nginx` to be
  // matched against a `nginx` that was genuinely observed. The more correctly the model spelled a
  // Docker Hub official image, the more certainly it was refused, which made ImagePullBackOff on an
  // official image — the single most common incident in this cluster — unfixable by the agent.
  //
  // Both passes are anchored on a delimiter, so a registry path that merely CONTAINS the segment
  // (`myregistry.com/library/foo`) is untouched: there the `library/` follows a `/`, which is not in
  // the character class. Order matters — the combined prefix has to go first, or `docker.io/library/x`
  // would only lose its front half and still fail to match.
  const bare = (v: string) =>
    v
      .replace(/(^|[\s"'`(=])(?:(?:index\.)?docker\.io\/)?library\//g, "$1")
      .replace(/(^|[\s"'`(=])(?:index\.)?docker\.io\//g, "$1");
  const seen = bare(`${observed ?? ""}\n${userText}`);
  const target = bare(image);
  if (seen.includes(target)) return null;

  const colon = target.lastIndexOf(":");
  if (colon > target.lastIndexOf("/")) {
    const repo = target.slice(0, colon);
    const tag = target.slice(colon + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (bare(observed ?? "").includes(repo) && new RegExp(`(^|[^\\w.-])${tag}($|[^\\w.-])`).test(userText)) return null;
  }
  return (
    `Setting the image to \`${image}\` is refused: no tool result in this thread shows that image and nobody ` +
    `asked for it by name, so it was invented rather than found. Name the exact image, or find the last ` +
    `good one in the workload's rollout history.`
  );
}

/**
 * Pulls `backupManifest` out of a `k8s_delete_orphan` result.
 *
 * Returns null on anything unexpected rather than throwing: this runs AFTER the object has
 * already been deleted, so a parse failure here must not turn a successful delete into a failed
 * remediation — it costs the backup, which is bad enough to log and not worth compounding.
 * Exported for the test.
 */
export function backupFrom(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as { backupManifest?: unknown };
    const m = parsed?.backupManifest;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The image-pull gate: an answer that names the BROKEN image and no working one.
 *
 * Benchmark A03, measured at five attempts: the two that named `nginx:alpine` beside the failing
 * `nginx:no-such-tag-9f2c` produced the correct `k8s_set_image`, and the three that named only the
 * failing tag answered `{"action": null}` — which is the RIGHT answer with no value to propose.
 * The fault is upstream of the proposal and the proposal step cannot repair it: `buildProposalPrompt`
 * is handed the RCA, and the working tag was never in it. One attempt had even CALLED
 * `k8s_list_replicasets` and still did not carry the tag into the answer.
 *
 * `imagepullbackoff.md` says to recover it and name it. That held two times in five, which is the
 * second failure of the rule and the point where it stops being a prompt rule.
 *
 * Driven by the EVIDENCE, not by guessing what looks like an image: the failing reference is read
 * out of tool output that also carries a pull failure, and the gate only fires when the answer
 * names no other tag for that same repository. A registry port (`registry:5000/app:v2`) is why the
 * repo is split at the last colon AFTER the last slash.
 */
const PULL_FAILURE = /imagepullbackoff|errimagepull|invalidimagename|manifest unknown|manifest for \S+ not found/i;

const IMAGE_REF = /"image"\s*:\s*"([^"\s]+:[^"\s]+)"|\bimage[:=]?\s+([a-z0-9][^\s"',)]*:[a-zA-Z0-9._-]+)/gi;

const repoOf = (ref: string): string => {
  const colon = ref.lastIndexOf(":");
  return colon > ref.lastIndexOf("/") ? ref.slice(0, colon) : ref;
};

/** The repository whose only named tag is the broken one, or null when the answer is fine. */
export function imageGapRepo(answer: string, observed: string): string | null {
  if (!PULL_FAILURE.test(observed)) return null;
  const failing = new Set<string>();
  for (const m of observed.matchAll(IMAGE_REF)) {
    const ref = m[1] ?? m[2];
    if (ref) failing.add(ref);
  }
  for (const ref of failing) {
    const repo = repoOf(ref);
    if (repo === ref) continue; // no tag to compare
    const tags = new Set(
      [...answer.matchAll(new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([a-zA-Z0-9._-]+)`, "g"))].map((t) => t[1])
    );
    // Names the broken tag and nothing else for that repo — including naming no tag at all.
    if (tags.size <= 1 && !([...tags].some((t) => `${repo}:${t}` !== ref))) return repo;
  }
  return null;
}

export const IMAGE_GAP_NOTICE =
  "[EVIDENCE GAP — you named the image that is FAILING and no image that works, so there is nothing " +
  "for a remediation to set. The working tag is almost certainly still on this cluster: a rollout to a " +
  "bad tag does not delete the ReplicaSet it replaced. Call `k8s_list_replicasets` for this workload and " +
  "read the image off the one whose pods are still running, or `k8s_get_resource` on the HelmRelease if " +
  "it is Flux-managed. Then name that tag in the answer in full `registry/repo:tag` form. If you look and " +
  "the previous ReplicaSet is gone, say so — that is a finding, and it is why no rollback target exists.]";
