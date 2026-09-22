import { createLLMClient } from "./llm/index.js";
import { SERIALIZED_BLOCKS, namesToolOnly } from "./llm/router.js";
import { parseRegistry } from "./llm/registry.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { IncidentMemory } from "./incidents/index.js";
import {
  alertsReadable,
  decideReconcile,
  type StatusCommand,
  type UnresolvedIncident,
} from "./incidents/reconcile.js";
import { UsageStore } from "./usage/index.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { buildStaticSystemPrompt, buildTimeContext } from "./prompts/system.js";
import { assembleRequest, sanitizeContentBlocks } from "./context/index.js";
import { resolveBudget } from "./context/resolve-budget.js";
import { estimateTokens, type Budget } from "./context/budget.js";
import { loadSkills, resolveSkillsDir, type Skill, type SkillRegistry } from "./skills/index.js";
import { namespacesOf, outOfScope } from "./scope/index.js";
import { groundingGaps, observedText } from "./grounding/index.js";
import { flagInjection } from "./injection/index.js";
import {
  DELEGATE_TOOL,
  DELEGATE_MARKER,
  capFanout,
  childDeadline,
  hypothesisOf,
  subThreadId,
  withDelegateTool,
} from "./subagent/index.js";
import { parseFeedbackJson, buildExtractionPrompt, EXTRACTION_SYSTEM } from "./feedback/index.js";
import { RemediationStore } from "./remediation/index.js";
import { proposeWithRetry, PROPOSAL_SYSTEM, stripOffer, type Proposal } from "./remediation/proposal.js";
import { parsePods, replacementRefusal, REPLACEMENT_ACTIONS } from "./remediation/replace-guard.js";
import { noOpImageRefusal, LISTING_FOR_KIND } from "./remediation/noop-guard.js";
import {
  RemediationCheckStore,
  summarizePods,
  alertState,
  decideVerdict,
  verdictMessage,
  maxAttemptsReached,
  type AlertState,
  type PodHealth,
  type RemediationCheck,
  type Verdict,
} from "./remediation/verify.js";
import { SqsGitOpsClient } from "./gitops/sqs.js";
import { parseGitOpsPreview, type GitOpsPreview } from "./gitops/preview.js";
import type { GitOpsDrift } from "./gitops/types.js";
import { FLUX_HELMRELEASE, FLUX_KUSTOMIZATION, kustomizeRefOf, fluxPathToPrefix } from "./gitops/overlay.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import type { LLMClient, LLMResponse, ContentBlock, Message, TokenUsage, ToolDefinition } from "./llm/types.js";
import { initRedis, pingRedis } from "../redis.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { withRoute, withTrace } from "../utils/trace/index.js";

// One incident the sweeper closed: what to say, and the label set whose dedup claim has to be
// released. channel/thread_ts are nullable on the row, so there may be nothing to post — the
// claim still has to go.
export type ReconciledIncident = {
  channel: string | null;
  threadTs: string | null;
  groupLabels: Record<string, string>;
  text: string;
};

// Rows stored before migrations/007 have no group_labels. alertname+namespace hashes to a
// different dedup fingerprint than the claim was taken under, so clearing it is best-effort
// on those — new incidents carry the exact identity.
const fallbackLabels = (alertname: string, namespace: string | null): Record<string, string> => ({
  alertname,
  ...(namespace ? { namespace } : {}),
});

export const MAX_ITERATIONS = 10;
// conversation mode: max distinct pods whose logs may be fetched in one round — a generic
// name matching many pods ("metallb" → 8) should produce a "which one?" question, not a dump
const MAX_LOG_FANOUT = 2;

/** Conversation mode: the tool budget is spent. Answer, and stay out of RCA format. */
export const TOOL_BUDGET_NOTICE =
  "[TOOL BUDGET REACHED — compose your final answer now from the data above. Tool calls are disabled. " +
  "Reply in plain Slack mrkdwn — do NOT use the RCA incident format. If something looked anomalous, " +
  "mention it in one line and offer to investigate.]";

/**
 * Shared by the two hard ceilings below. They are reached differently and say so in their
 * opening clause, but their reader is the same — the alert path, whose answer IS the RCA — so
 * the instruction has to be identical and is written once. Neither says anything about output
 * format: the system prompt and the response-mode marker keep deciding the shape.
 */
const FINAL_TURN_INSTRUCTION =
  "this is your final turn and tool calls are disabled. Write the answer now " +
  "from the evidence already gathered. Do not ask for more data and do not promise follow-up work. " +
  "Thin evidence is not a reason to withhold a conclusion: give your best root-cause hypothesis, and if " +
  "you are producing an RCA set Confidence to Low and name the one check that would confirm it.";

/** The iteration ceiling: ten LLM calls spent. */
export const ITERATION_CEILING_NOTICE = `[ITERATION LIMIT REACHED — ${FINAL_TURN_INSTRUCTION}]`;

/**
 * The wall-clock ceiling. Named separately from the iteration one because the reason is a
 * different thing to be told: a model that is out of TIME has no cheaper question available,
 * while a model that is out of ITERATIONS might otherwise try to economise its next call.
 *
 * This ceiling used to have no notice at all — see the deadline branch in runInvestigation for
 * what it did instead, and why a slow backend is what turned it from theory into a live bug.
 */
export const TIME_BUDGET_NOTICE = `[TIME BUDGET REACHED — ${FINAL_TURN_INSTRUCTION}]`;

/**
 * The tools whose RESULT is log lines, and the notice for an investigation that answered without
 * any of them.
 *
 * This is a prompt rule that did not hold, moved into code — the same move `worthProposing` and
 * the fan-out cap already made. `prompts/skills/crashloopbackoff.md` step 2 says to call
 * `k8s_get_pod_logs` with `previous: true`, and the playbook WAS selected: benchmark case B04
 * loaded it, called `k8s_describe_pod`, and then wrote *"Immediate: Retrieve previous-container
 * logs for all 8 pods"* into its own Recommended Actions — recommending to a human the tool call
 * it was holding. The crash message it never read said `FATAL: DATABASE_URL is not set`. Three
 * attempts out of three.
 *
 * A13 is the same gap one level in, and it is why "did we CALL a log tool" is not the test:
 * `loki_query_range` was called, with a `level="error"` filter the workload's output does not
 * carry, and an empty result was reported as "no errors in the window" for a pod printing
 * `cannot list resource "pods"` every fifteen seconds. So the test is whether any log tool
 * RETURNED anything.
 *
 * Only fires when a selected playbook names a log tool, which is what keeps it off the cases
 * that have no logs to read by construction — a Pending pod never started a container.
 */
export const LOG_TOOLS: ReadonlySet<string> = new Set(["k8s_get_pod_logs", "loki_query", "loki_query_range"]);

/**
 * ponytail: a length threshold, not a parse. An empty Loki response is a JSON envelope around an
 * empty array and lands around 35 characters (measured); a `previous: true` log fetch of a dead
 * container is hundreds. Parsing each tool's own empty shape would mean tracking three response
 * formats from another repo, and the cost of being wrong here is one extra LLM call.
 */
const LOG_RESULT_MIN_CHARS = 200;

export const LOG_GAP_NOTICE =
  "[EVIDENCE GAP — the playbook for this alert reads the container's own logs, and no log query has " +
  "returned any lines yet. Before you answer, call `k8s_get_pod_logs` (tail_lines: 200) on an affected " +
  "pod. Pick the instance from the pod's state, not from habit: if the container has RESTARTED or is " +
  "in CrashLoopBackOff, the crash message is in the dead instance, so pass `previous: true`; if the " +
  "pod is Running and has not restarted, there IS no previous instance — fetch the current logs. If a " +
  "`previous: true` call comes back empty or not-found, that is the answer to which instance to read, " +
  "so retry without it rather than reporting the logs as unavailable. If a log query came back empty, " +
  "that is a fact about the QUERY and not about the workload: drop the level/severity filter and widen " +
  "the selector, or read the pod logs directly instead of Loki. Only if the logs are genuinely " +
  "unavailable after that, say so explicitly in the answer and state what it leaves unconfirmed — and " +
  "lower the Confidence only if your conclusion actually depends on them. Finding a healthy workload " +
  "and quiet logs is a complete answer, not a thin one. Do not recommend that a human run a log query " +
  "you can run yourself.]";

/** Does any loaded playbook name a log tool? Read from the body, so a new playbook gets this free. */
export const demandsLogs = (skills: readonly Skill[]): boolean =>
  skills.some((s) => [...LOG_TOOLS].some((t) => s.body.includes(t)));

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
 * ("change the tag to v1.3") on a repository the cluster already runs. `docker.io/` is dropped
 * before comparing, because listings and people disagree about whether to write it. NOT skipped
 * for a user request: a person who names an image passes through the user-text half of the rule.
 */
export function unseenImageRefusal(proposal: Proposal, observed: string | null, userText: string): string | null {
  if (proposal.action !== "k8s_set_image") return null;
  const image = String(proposal.toolParams.image ?? "");
  if (!image) return null;
  const bare = (v: string) => v.replace(/(^|[\s"'`(=])docker\.io\//g, "$1");
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

/**
 * An alert answered without reading anything.
 *
 * Measured in a 57-attempt run: A03 #2 and A04 #1 each produced a full RCA from one LLM call and
 * ZERO tool calls — fifteen thousand output tokens describing a cluster neither had looked at.
 * Both failed, and on the fact they could not have known: A04 never said "pull secret", because
 * nothing had told it there was one missing.
 *
 * Deliberately alert-mode only. In conversation mode a tool-free answer is often the correct one —
 * benchmark C07 declines an out-of-scope request with no tools three times out of three, and
 * nudging it would be telling it to go and do the thing it just correctly refused.
 *
 * This is the gap the other gates leave open by construction: `logGapAction` requires
 * `toolRounds > 0` before it will nudge, and the budget and deadline ceilings fire when the model
 * ran out of room rather than when it never asked for any.
 */
export const NO_EVIDENCE_NOTICE =
  "[EVIDENCE GAP — you answered an alert without calling a single tool. Everything above is the " +
  "alert payload and what you already believed; none of it was read from the cluster. An alert " +
  "names a symptom and a subject, and it is the starting point of an investigation rather than its " +
  "evidence. Go and look: the pod's state and events, the workload's spec, the logs of whatever is " +
  "failing. If what you find contradicts the answer you just wrote, the answer was wrong and the " +
  "evidence wins. Say what you actually read.]";

/** Pure so it can be tested; the loop has no seam for the branch it guards. */
export function needsEvidence(s: {
  mode: RunMode;
  toolRounds: number;
  nudged: boolean;
  toolsDisabled: boolean;
}): boolean {
  return s.mode === "alert" && s.toolRounds === 0 && !s.nudged && !s.toolsDisabled;
}

export interface LogGapState {
  mode: RunMode;
  /** demandsLogs(skills) for the playbooks this run is carrying. */
  demandsLogs: boolean;
  sawLogLines: boolean;
  nudged: boolean;
  toolsDisabled: boolean;
  toolRounds: number;
  /** toolRounds at the moment the nudge fired; -1 while it has not. */
  toolRoundsAtNudge: number;
  /** Is an answer from before the nudge being held? */
  holdingAnswer: boolean;
}

/**
 * What to do with an answer the model just finished writing, from the log-gap gate's point of view.
 *
 * `restore` is the half that was missing and it is the expensive one. The nudge appends a notice
 * and loops, so whatever the model says next REPLACES the answer it interrupted — and on
 * 2026-09-15 a correct "no anomalies; 59 pods across 14 namespaces healthy" was replaced twice in
 * one thread by the scope-refusal boilerplate ("That's outside what I do — I'm a DevOps agent for
 * this cluster"). The first answer was complete, was never posted, and nothing in the log said it
 * had been thrown away. So: if the extra round ran no tools, it learned nothing, and the answer
 * it produced cannot be an improvement on the one it displaced.
 *
 * `nudge` is alert-mode only. `demandsLogs` reads the playbooks the THREAD is carrying, which on
 * a mention is whatever earlier turns accumulated; "apakah ada anomali di cluster 1 jam
 * kebelakang ini?" has no affected pod whose container logs could answer it.
 */
export function logGapAction(s: LogGapState): "answer" | "nudge" | "restore" {
  if (s.holdingAnswer && s.toolRounds === s.toolRoundsAtNudge) return "restore";
  if (
    s.mode === "alert" &&
    s.demandsLogs &&
    !s.sawLogLines &&
    !s.nudged &&
    !s.toolsDisabled &&
    s.toolRounds > 0
  ) {
    return "nudge";
  }
  return "answer";
}

/**
 * A delegate's ceiling. Neither notice above can serve it: the budget one carries conversation
 * mode's format rule and tells the model to "offer to investigate", the ceiling one says nothing
 * about format at all and leaves the shape to the system prompt, which describes an RCA.
 *
 * The observed failure, 2026-08-31: `SUBAGENT_TOOL_ROUNDS` is 2, so a delegate that spends both
 * rounds lands on TOOL_BUDGET_NOTICE and does exactly what it says — one sub-investigation came
 * back with "Hey — here's what the data you provided shows, in plain Slack-friendly terms" and
 * markdown bullets, addressed to a human who was never going to read it, at 4796 chars against
 * its sibling's 2220. Its actual reader is the lead investigation, which wanted a verdict.
 *
 * DELEGATE_MARKER already says all of this, but it sits in `history[0]` while the notice is the
 * last thing in the context — the same losing position the mention marker was in, and the reason
 * that one is restated every turn.
 *
 * One notice for BOTH ceilings, because a delegate's reader never changes: there is no budget-vs-
 * iteration distinction to draw when neither outcome is ever addressed to a human.
 */
export const DELEGATE_BUDGET_NOTICE =
  "[BUDGET REACHED — this is your final turn and tool calls are disabled. Report now to the lead " +
  "investigation that asked for this, NOT to a human in Slack: open with SUPPORTED, CONTRADICTED " +
  "or UNPROVEN, then the evidence behind that verdict, each claim naming the tool it came from. " +
  "Do not use the RCA incident format, do not address a reader, and do not offer to investigate " +
  "further — there is no one to offer it to. Running out of budget is not a reason to withhold a " +
  "verdict: answer UNPROVEN and name what you could not check.]";

/**
 * Both ceilings end a run the same way — one more LLM call with no tools — but they are reached
 * by different paths and say different things. Returns the notice to inject, or null to keep going.
 *
 * The iteration clause is the one that matters. It fires at `maxIterations - 1` so the loop always
 * keeps a turn in hand to spend on an answer. Without it an alert investigation (which passes no
 * tool budget, so `maxToolRounds` is Infinity and the first clause can never fire) ran its tenth
 * round of tools, fell out of the `while`, and discarded every result it had gathered in favour of
 * an apology — in an on-call thread that had never been shown a single finding.
 *
 * The tool budget wins when both apply: conversation mode has a format rule the ceiling must not
 * overwrite. `depth` outranks both — see DELEGATE_BUDGET_NOTICE. Exported with its notices so the
 * loop's exit contract is testable without the class.
 */
export function forcedFinalAnswer(state: {
  toolRounds: number;
  maxToolRounds: number;
  iterations: number;
  maxIterations: number;
  /** 0 = the lead investigation, 1 = a delegate. Defaults to lead. */
  depth?: number;
  /**
   * True once the wall-clock deadline has passed. The THIRD ceiling, and the one that was
   * never wired: it returned an apology and discarded the evidence, which is exactly the
   * regression the iteration clause above was added to fix. It stayed invisible while every
   * backend answered in seconds; a transport that takes 20-100s per call reaches it on an
   * ordinary investigation.
   */
  outOfTime?: boolean;
}): string | null {
  const reached =
    state.toolRounds >= state.maxToolRounds ||
    state.iterations >= state.maxIterations - 1 ||
    !!state.outOfTime;
  if ((state.depth ?? 0) > 0) return reached ? DELEGATE_BUDGET_NOTICE : null;
  if (state.toolRounds >= state.maxToolRounds) return TOOL_BUDGET_NOTICE;
  if (state.iterations >= state.maxIterations - 1) return ITERATION_CEILING_NOTICE;
  // Last of the three: the other two are known before the clock is consulted, and a run that
  // trips a countable ceiling on the same turn is better told the countable reason.
  if (state.outOfTime) return TIME_BUDGET_NOTICE;
  return null;
}

// Per-thread skill sets live in memory, like ConversationMemory's rcaThreads. Bounded so a
// long-running pod cannot accumulate one entry per thread it has ever seen; eviction is
// insertion-order, and a thread that outlives its entry simply re-selects from its next message.
export const MAX_TRACKED_THREADS = 500;

/**
 * Identity of a tool call, for the per-investigation memo in executeToolCalls.
 *
 * Scalars are stringified and object keys sorted, so `{"start":1788487759}` and
 * `{"start":"1788487759"}` are ONE call. That is not a nicety — it is the exact pair a live
 * investigation produced: the first round came back `[]`, the model read the empty result as
 * a sign it had got the argument TYPE wrong, and re-sent all four tools with the numbers
 * quoted. The repeat cost a whole round, which spent the last of a 2-round budget and forced
 * the answer out early. Type-blind matching is what makes that a memo hit rather than a
 * second identical query.
 */
export function toolCallKey(name: string | undefined, input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)])
      );
    }
    return String(v);
  };
  return `${name ?? ""}\u0000${JSON.stringify(norm(input))}`;
}

/**
 * The placeholders the prompt's example queries use — `{namespace="X", app="Y"}` — sent as if
 * they were values.
 *
 * Live 2026-09-22 on the heavy route (gpt-5-nano), two CPU-throttling alerts in `sample-apps`:
 * every Prometheus, Loki, k8s and tracing call went to namespace `X` / service `Y`. All came back
 * empty, the model read that as "no pods found in namespace sample-apps", and the second run
 * posted an approval card to restart `sample-apps/storefront` on it. The first run's RCA had
 * already reached incident memory, so the second opened with "I know X" — recall taught it the
 * placeholder was the namespace.
 *
 * Exact and safe to refuse: Kubernetes names are lowercase DNS-1123, so a bare `X` or `Y` can
 * never be one, and no label value in this cluster is a single capital letter. Returns the
 * offending fragment, or null.
 */
export function placeholderIn(input: unknown): string | null {
  const walk = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^[XY]$/.test(v)) return v;
      return v.match(/[=~]\s*"[XY]"/)?.[0] ?? null;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        const hit = walk(x);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(input);
}

const PLACEHOLDER_REFUSAL = (hit: string, namespace?: string) =>
  `Error: \`${hit}\` is a placeholder copied from the prompt's example queries, not a value — ` +
  `nothing in this cluster is called X or Y, so the call would return empty and prove nothing. ` +
  (namespace
    ? `Re-issue it with namespace \`${namespace}\`, which is what this alert's labels say. Do NOT ask ` +
      `the human which namespace to use — it is already in the alert in front of you.`
    : `Re-issue it with the real namespace / workload / service named in the alert or the user's message. ` +
      `Do NOT ask the human to supply it — read it from the message you were given.`) +
  ` A prior incident that mentions namespace "X" is a record of this same mistake, not evidence of a namespace.`;

// Loud on purpose. Handing back the same payload silently is what let the model try a third
// spelling; it has to be told the result is a property of the data, not of how it asked.
const REPEAT_NOTICE =
  "[repeat call] You already ran this exact tool with these exact arguments in this " +
  "investigation. The result below is that same result — calling it again, or with the " +
  "arguments spelled differently, returns this. If it is empty, the data does not exist: " +
  "query something else or answer with what you have.\n\n";
// Ceiling on the playbooks one investigation may accumulate. Selection runs again on every
// tool round (see runInvestigation), and each of those rounds may match up to
// MAX_MATCHED_SKILLS more — without a ceiling a long investigation ends up carrying the whole
// directory. Earliest wins: the alert's own playbook outranks one a later log line suggested.
export const MAX_THREAD_SKILLS = 5;

/**
 * How many matched playbooks a thread carries into its NEXT turn.
 *
 * MAX_THREAD_SKILLS alone is a one-way ratchet: `selectForThread` only ever adds, so a
 * conversation that reaches the cap is frozen on the playbooks it happened to pick up and no
 * later question can load its own. Measured on thread 1789488072 (2026-09-15): turn 5 filled all
 * five slots with `rca-format, pod-pending, pod-not-ready, multi-pod-one-cause,
 * resource-rightsizing`, and the seven turns after it — including "investigasi kenapa prometheus
 * query nya kosong" — ran on that same frozen set. Two of those turns also tripped the log-gap
 * gate, which reads `demandsLogs(skills)`: playbooks selected six questions ago were still
 * demanding container logs.
 *
 * Decay, not reset: a follow-up genuinely is about the turn before it ("and the logs?"), so the
 * most recent matches stay. Everything older is dropped and re-earned — a playbook that still
 * fits the new question matches again on the same text that matched it the first time.
 */
export const CARRIED_SKILLS = 2;

/**
 * The last four exist for sub-agent delegation: a delegate is the same loop run with a smaller
 * budget, a borrowed deadline, and no delegate tool of its own. They are options rather than a
 * second loop because the guards that matter — the [WRITE] filter, the namespace scope lock, the
 * log fan-out cap, the forced final answer — live in that loop, and a copy of it is a copy of
 * them that drifts.
 */
/**
 * Fires one progress report for a tool round.
 *
 * A four-line function with its own name because three things in it are worth pinning and
 * none of them is reachable from a test otherwise: the round number is off by one from
 * `toolRounds` (which is incremented after the tools run, not before), the names must be
 * the ones that will ACTUALLY run rather than the ones the model asked for — the scope
 * lock and the fan-out guard have already removed some — and a callback that throws must
 * be swallowed. The last one is the reason this is not inline: a Slack outage must not end
 * an investigation that is already three rounds deep in evidence.
 */
export function reportProgress(
  onProgress: ((round: number, tools: string[]) => void) | undefined,
  toolRounds: number,
  running: Array<{ name?: string }>,
  onError: (err: unknown) => void
): void {
  if (!onProgress) return;
  const names = [...new Set(running.map((t) => t.name).filter(Boolean))] as string[];
  try {
    onProgress(toolRounds + 1, names);
  } catch (err) {
    onError(err);
  }
}

/**
 * What kind of run this is. Three things read it and none of them can work it out alone:
 *
 * - `rca-format` loads only outside `conversation`. It used to be `when: always`, so the RCA
 *   template rode along on every casual mention and argued with the conversation-mode marker in
 *   the very same message. The small model sided with the skill.
 * - the log-gap gate fires only on `alert`. Its own notice says "the playbook for this alert";
 *   on a mention there is no alert and no affected pod, so demanding container logs for
 *   "any anomalies in the last hour?" is a demand nothing can satisfy.
 * - a delegate is `alert` because it is a slice of one.
 *
 * Not derivable from the other options: `maxToolRounds` is `Infinity` for BOTH the alert path
 * and an explicit investigation request, and `trigger` is set by the alert path only as an
 * accident of skill selection. Stating it is what stops the next reader guessing.
 */
export const RUN_MODES = ["alert", "investigation", "conversation"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** The tag `runInvestigation` puts at the head of the skill trigger. See skills/index MODE_TAG. */
export const modeTag = (mode: RunMode): string => `[mode:${mode}]`;

/** A skill that keys on the run mode describes the shape of the answer, not the fault. */
export const keysOnMode = (s: Skill): boolean =>
  s.when !== "always" && RUN_MODES.some((m) => [...modeTag(m).matchAll(s.when as RegExp)].length > 0);

export interface InvestigateOptions {
  maxToolRounds?: number;
  trigger?: string;
  /** Defaults to "alert" — the strictest of the three, so an unconverted caller loses nothing. */
  mode?: RunMode;
  /** Defaults to MAX_ITERATIONS. */
  maxIterations?: number;
  /** Absolute epoch ms. Defaults to now + config.investigationTimeoutMs. */
  deadline?: number;
  /** 0 = the lead investigation, 1 = a delegate. Only depth 0 is offered the delegate tool. */
  depth?: number;
  /**
   * The namespace the alert labels name, quoted back in the placeholder refusal.
   * Telling the model to "use the real namespace" was not enough — on 2026-09-22 it answered the
   * alert by asking the human which namespace to use. Naming it leaves nothing to ask.
   */
  namespace?: string;
  /**
   * Called once per tool round, before the tools run, with the round number and the tool
   * names that round will actually execute. Optional and fire-and-forget: the loop ignores
   * whatever it returns and never awaits it, because a progress update is not worth failing
   * an investigation over.
   *
   * It exists for perceived latency, not real latency. One round against a slow backend is
   * tens of seconds of nothing, and an alert thread that sits on a single static notice for
   * minutes is indistinguishable from an agent that has crashed — which is what an on-call
   * reader assumes. Only the alert path passes it; a delegate has no Slack message to update.
   */
  onProgress?: (round: number, tools: string[]) => void;
  /**
   * Run metadata for the Slack footer, delivered as a sink rather than a return value.
   * investigate() returns the reply text and a dozen call sites depend on that; a sink also
   * stays correct under INVESTIGATION_MAX_CONCURRENT, where a `lastRunMeta()` getter would
   * hand one thread another thread's numbers.
   */
  onComplete?: (meta: RunMeta) => void;
}

/** What the Slack footer reports. Every field is measured, never estimated. */
export interface RunMeta {
  durationMs: number;
  /** LLM calls, not tool rounds — the number that explains the latency. */
  rounds: number;
  toolCalls: number;
  /** From the LAST response: on a failover it is the backend that actually answered. */
  backend?: string;
  model?: string;
  route?: "light" | "heavy";
}

export type ThreadSkills = Map<string, Skill[]>;

/** What the dashboard renders. Strings only — no RegExp crosses this boundary. */
export interface SkillView {
  name: string;
  description: string;
  when: string;
  chars: number;
  body: string;
}

/**
 * Selects the skills for one incoming message and folds them into the thread's running set.
 * Exported for the wiring test — the class method is a thin caller.
 */
export function selectForThread(
  registry: SkillRegistry,
  tracked: ThreadSkills,
  threadId: string,
  trigger: string
): Skill[] {
  const known = tracked.get(threadId) ?? [];
  const { selected, overflow } = registry.select(trigger, new Set(known.map((s) => s.name)));
  if (overflow.length > 0) {
    logger.info(`[${threadId}] skills over the cap, not loaded: ${overflow.join(", ")}`);
  }
  const merged = selected.length > 0 ? [...known, ...selected].slice(0, MAX_THREAD_SKILLS) : known;
  const capped = [...known, ...selected].length - merged.length;
  if (capped > 0) {
    logger.info(`[${threadId}] ${capped} skill(s) past the per-thread cap of ${MAX_THREAD_SKILLS}, not loaded`);
  }

  tracked.delete(threadId); // re-insert so this thread becomes the most recent
  tracked.set(threadId, merged);
  while (tracked.size > MAX_TRACKED_THREADS) {
    const oldest = tracked.keys().next().value;
    if (oldest === undefined) break;
    tracked.delete(oldest);
  }
  return merged;
}

/**
 * Shrinks a thread's accumulated playbooks at the start of a NEW turn, and returns the names
 * dropped so the caller can log them — a playbook that vanishes silently is the bug this whole
 * mechanism was added to fix, one level up. See CARRIED_SKILLS for why.
 *
 * Only called between turns. Inside one investigation selection stays append-only: there the
 * alert's own playbook outranks one a later log line suggested, and decaying mid-loop would
 * throw away the playbook the run is actually following.
 *
 * Exported for the wiring test.
 */
export function decayThreadSkills(tracked: ThreadSkills, threadId: string, keep = CARRIED_SKILLS): string[] {
  const known = tracked.get(threadId);
  if (!known || known.length === 0) return [];
  // A mode-keyed skill is never inherited — it belongs to THIS turn's mode, and the caller
  // re-selects it from the tag on the very next line. Carried over, `rca-format` would follow an
  // alert thread into every follow-up mention it ever gets: the exact leak it was moved off
  // `when: always` to stop.
  // Insertion order is recency order — selectForThread appends — so the tail is the newest.
  const kept = known.filter((s) => !keysOnMode(s)).slice(-keep);
  if (kept.length === known.length) return [];
  tracked.set(threadId, kept);
  return known.filter((s) => !kept.includes(s)).map((s) => s.name);
}

/**
 * Resolves stored playbook names back to skills against the LIVE registry. A name that no longer
 * resolves is dropped rather than carried as a dangling string: `prompts/skills/` is editable
 * between two turns of the same thread, and a thread must never re-inject a skill the directory
 * no longer has. Order follows the stored list, so the alert's own playbook keeps its rank.
 *
 * Exported for the wiring test — the class method around it is a thin caller.
 */
export function resolveSkillNames(registry: SkillRegistry, names: readonly string[]): Skill[] {
  const byName = new Map(registry.all().map((s) => [s.name, s]));
  return names.map((n) => byName.get(n)).filter((s): s is Skill => s !== undefined);
}

/**
 * The text a tool round actually produced — tool_result payloads plus any synthesized notice.
 * Returned per block rather than joined: `select` truncates its trigger, and one long result
 * would otherwise push a later result's decisive line ("Failed to pull image") out of the
 * window entirely.
 */
export function evidenceTexts(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const text =
      b.type === "tool_result" && typeof b.content === "string"
        ? b.content
        : b.type === "text"
          ? (b.text ?? "")
          : "";
    // The evidence stamp is bookkeeping, not evidence — a playbook must never be selected by it.
    if (text.trim() && !text.startsWith(EVIDENCE_STAMP_PREFIX)) out.push(text);
  }
  return out;
}

/**
 * Stamps a tool round with the wall-clock time its results were read, appended to the same user
 * message the results ride in.
 *
 * A `tool_result` in the history carries no time of its own, and neither does the message around
 * it, so by turn 11 of a conversation the model is looking at a `k8s_cluster_health` snapshot
 * from 40 minutes earlier that is indistinguishable from one taken this second. It answers from
 * it. Measured on thread 1789488072 (2026-09-15): "cluster resource saat ini gimana?" at 16:44
 * was answered with `59 pods in 14 namespaces` — the output of a health scan run at 16:14 — with
 * zero tool calls that turn, and the grounding check flagged a namespace no tool result in the
 * thread had ever returned.
 *
 * In the history rather than in a side table so it survives a pod restart: the conversation comes
 * back from Redis and the stamp comes back with it.
 */
export const EVIDENCE_STAMP_PREFIX = "[EVIDENCE READ AT]";

export const evidenceStamp = (now: number = Date.now()): string =>
  `${EVIDENCE_STAMP_PREFIX} ${new Date(now).toISOString()} (unix ${Math.floor(now / 1000)})`;

/** Under this, the evidence is effectively current and the notice is noise. */
export const STALE_EVIDENCE_MINUTES = 2;

const STAMP_RE = /\[EVIDENCE READ AT\][^(\n]*\(unix (\d+)\)/g;

/**
 * Warns the NEXT turn that everything it can see was read in an earlier one. Empty when the
 * thread has no stamped evidence yet, or when the freshest is younger than STALE_EVIDENCE_MINUTES.
 *
 * Reads the newest stamp, not the oldest: it is the most generous number available, and the
 * claim has to stay true — anything older than the freshest result is older still.
 */
export function staleEvidenceNotice(history: readonly Message[], now: number = Date.now()): string {
  let newest = 0;
  for (const m of history) {
    const texts =
      typeof m.content === "string"
        ? [m.content]
        : m.content.map((b) => (b.type === "text" ? (b.text ?? "") : ""));
    for (const t of texts) {
      for (const match of t.matchAll(STAMP_RE)) {
        const unix = Number(match[1]);
        if (unix > newest) newest = unix;
      }
    }
  }
  if (newest === 0) return "";
  const minutes = Math.floor((now - newest * 1000) / 60000);
  if (minutes < STALE_EVIDENCE_MINUTES) return "";
  return (
    `[STALE EVIDENCE — the freshest tool result already in this conversation was read ${minutes} ` +
    `minutes ago, at ${new Date(newest * 1000).toISOString()}; everything else is older. Those ` +
    `results describe the cluster AS IT WAS THEN. If this question is about the state right now ` +
    `("saat ini", "sekarang", "now", "still", "already"), call the tools again and answer from ` +
    `the new result — do not restate counts, pod names or statuses from the old ones. A re-read ` +
    `costs one round; a stale "everything is healthy" costs an incident.]`
  );
}

const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

const addUsage = (acc: TokenUsage, u: TokenUsage): TokenUsage => ({
  inputTokens: acc.inputTokens + u.inputTokens,
  outputTokens: acc.outputTokens + u.outputTokens,
  cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
  cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
});

export class DevOpsAgent {
  private llm: LLMClient;
  private mcp: MCPClient;
  private memory: ConversationMemory;
  private incidents: IncidentMemory;
  private usage: UsageStore;
  private remediations: RemediationStore;
  private checks: RemediationCheckStore;
  private gitops: SqsGitOpsClient | null;
  private readonly skills: SkillRegistry;
  private readonly threadSkills: ThreadSkills = new Map();
  // threadId -> (tool call key -> in-flight or settled result). One entry per INVESTIGATION,
  // not per thread: a later turn must be free to re-fetch, because the cluster moved on.
  private readonly toolMemo = new Map<string, Map<string, Promise<string>>>();
  private budget: Budget;

  constructor() {
    this.llm = createLLMClient();
    this.mcp = new MCPClient();
    this.memory = new ConversationMemory(); // default in-memory; replaced in initialize() if Redis configured
    this.incidents = new IncidentMemory(null); // no-op until initialize() wires Postgres
    this.usage = new UsageStore(null); // no-op until initialize() wires Postgres
    this.remediations = new RemediationStore(null); // no-op until initialize() wires Postgres
    this.checks = new RemediationCheckStore(null); // no-op until initialize() wires Postgres
    this.gitops = config.gitops.enabled ? new SqsGitOpsClient() : null; // GitOps PR-flow bridge (opt-in)

    // Throws here rather than at first request: a malformed skill file must be a pod that
    // refuses to start. src/agent/skills/real.test.ts loads this same directory, so a bad file
    // fails npm test long before it reaches a cluster.
    this.skills = loadSkills(resolveSkillsDir());
    for (const s of this.skills.all()) {
      logger.info(`[skills] ${s.name} (${s.chars} chars, when=${s.when === "always" ? "always" : s.when.source}) — ${s.description}`);
    }
    // Provisional: tools are unknown until MCP connects, so initialize() recomputes it. The
    // registry is parsed here too, exactly as initialize() does — passing null instead made a
    // `router` deployment resolve its own provider name as a BackendKind, fall through windowOf's
    // last `??` to the 32k private-llm default, and throw at construction for any MAX_TOKENS at or
    // above 23448, naming a backend "router" that does not exist. Nothing reads this value (both
    // reads run after initialize()), so the only thing the null could still do was kill the pod.
    this.budget = resolveBudget({
      registry: config.llm.provider === "router" ? parseRegistry(process.env) : null,
      provider: config.llm.provider,
      maxTokens: config.llm.maxTokens, overheadTokens: estimateTokens(buildStaticSystemPrompt()),
    });
  }

  async initialize(): Promise<void> {
    await this.mcp.connect();
    const redis = await initRedis(); // shared by conversation memory + alert dedup; null if not configured
    if (redis) {
      this.memory = new ConversationMemory(redis);
    } else {
      logger.info("Memory backend: in-memory");
    }

    if (config.incidents.enabled) {
      const { host, port, database, sslMode } = config.incidents.db;
      const pool = createPool();
      pool.on("error", (err: Error) => logger.error(`Postgres pool error: ${err.message}`));
      await runMigrations(pool); // advisory-locked — safe under concurrent pod startup; fails fast if unreachable
      this.usage = new UsageStore(pool);
      this.incidents = new IncidentMemory(pool, (id, ts) => void this.usage.linkToIncident(id, ts));
      this.remediations = new RemediationStore(pool);
      this.checks = new RemediationCheckStore(pool);
      logger.info(`Incident memory: Postgres ${host}:${port}/${database} sslmode=${sslMode}`);
    } else {
      logger.info("Incident memory: disabled (set DB_HOST to enable)");
    }

    const tools = this.mcp.getTools();
    this.budget = resolveBudget({
      registry: config.llm.provider === "router" ? parseRegistry(process.env) : null,
      provider: config.llm.provider,
      maxTokens: config.llm.maxTokens,
      overheadTokens: estimateTokens(buildStaticSystemPrompt()) + estimateTokens(JSON.stringify(tools)),
    });
    logger.info(`[context] budget: ${this.budget.contextTokens} token window, ${this.budget.reserveTokens} reserved for output`);
  }

  // The tool list devops-mcp-server returned at connect, for the dashboard's dependency map.
  // Read-only and already in memory — this makes no call. Empty before initialize() and after
  // a failed connect, which is a state the dashboard renders rather than an error.
  mcpTools(): ToolDefinition[] {
    return this.mcp.getTools();
  }

  // The registered skills, for the dashboard's /context page. Read-only and already in memory —
  // this makes no call. Strings only: the dashboard never sees a RegExp.
  skillsView(): readonly SkillView[] {
    return this.skills.all().map((s) => ({
      name: s.name,
      description: s.description,
      when: s.when === "always" ? "always" : s.when.source,
      chars: s.chars,
      body: s.body,
    }));
  }

  // Readiness check for /health — reports each enabled dependency. ok=false (→ 503) if any
  // configured dependency is unreachable, so K8s stops routing to a pod that can't investigate.
  async healthCheck(): Promise<{ ok: boolean; checks: Record<string, "up" | "down"> }> {
    const checks: Record<string, "up" | "down"> = {
      mcp: (await this.mcp.ping()) ? "up" : "down",
    };
    if (config.incidents.enabled) checks.postgres = (await this.incidents.ping()) ? "up" : "down";
    if (config.memory.backend === "redis") checks.redis = (await pingRedis()) ? "up" : "down";
    return { ok: Object.values(checks).every((s) => s === "up"), checks };
  }

  // Durable cross-incident memory — recall returns "" when disabled or no prior match.
  // `queryText` (the alert body) unlocks the weakest tier, which matches on wording rather
  // than on the alert's identity; without it recall stays exact-match only.
  recallIncidents(labels: Record<string, string>, queryText?: string): Promise<string> {
    return this.incidents.recall(labels, { queryText });
  }

  // Recall what was actually DONE about this alert before (past remediations + their PRs/
  // outcomes) so the agent doesn't re-propose a fix that already ran. "" when none.
  async recallRemediations(labels: Record<string, string>): Promise<string> {
    const alertname = labels.alertname;
    if (!alertname) return ""; // keyed by alert; mention-driven flows have no labels
    const rows = await this.remediations.recallForAlert(alertname, labels.namespace, 3).catch(() => []);
    if (rows.length === 0) return "";
    const lines = rows.map((r) => {
      const date = new Date(r.createdAt).toISOString().slice(0, 10);
      const pr = r.result.startsWith("http") ? ` (PR: ${r.result})` : "";
      // The verdict is the part that says whether it WORKED — "succeeded" only means the
      // call didn't error. Unverified rows say so rather than reading as a silent success.
      const verdict = r.verdict ? ` → verified ${r.verdict}${r.detail ? ` (${r.detail})` : ""}` : " → never verified";
      return `- ${date}: ${r.summary} — ${r.status}${pr}${verdict}`;
    });
    const failed = rows.some((r) => r.verdict === "unchanged" || r.verdict === "worse");
    return [
      `## Previously remediated — same alert${labels.namespace ? ` in namespace ${labels.namespace}` : ""}`,
      ...lines,
      `These are prior actions taken for this recurring issue. Prefer confirming whether the same fix still applies over proposing a brand-new one.`,
      ...(failed
        ? [
            `A "verified unchanged" or "verified worse" entry is evidence the action did NOT fix this alert — the agent already ran it and re-checked afterwards. Do not propose that same action again unless you can state what is different this time; if the same fix keeps not holding, the root cause is upstream of it, and that is what to investigate.`,
          ]
        : []),
    ].join("\n");
  }

  storeIncident(
    labels: Record<string, string>,
    rca: string,
    channel?: string,
    threadTs?: string,
    /** The group's Alertmanager severity as the Slack card rendered it — see store(). */
    alertSeverity?: string | null
  ): Promise<number | null> {
    return this.incidents.store(labels, rca, channel && threadTs ? { channel, threadTs } : undefined, alertSeverity);
  }

  // Everything below runs inside the trace context so outbound SQS requests carry the
  // threadId — that is what lets you grep one id across the agent log, the llm-worker
  // log, and the Slack thread when an answer comes out wrong.
  investigate(threadId: string, userMessage: string, opts: InvestigateOptions = {}): Promise<string> {
    return withTrace(threadId, () => this.runInvestigation(threadId, userMessage, opts));
  }

  private async runInvestigation(threadId: string, userMessage: string, opts: InvestigateOptions = {}): Promise<string> {
    logger.info(`[${threadId}] Investigation started`);
    logger.debug(`[${threadId}] Issue: ${truncate(userMessage, 120)}`);
    const investigationStart = Date.now();

    // A fresh memo per investigation — a follow-up an hour later must be allowed to re-query.
    // Capped like threadSkills: a thread that never comes back would otherwise hold its
    // results for the life of the process.
    this.toolMemo.set(threadId, new Map());
    while (this.toolMemo.size > MAX_TRACKED_THREADS) {
      const oldest = this.toolMemo.keys().next().value;
      if (oldest === undefined) break;
      this.toolMemo.delete(oldest);
    }

    // Deterministic tool budget. Prompt-level scope rules alone don't hold: the model
    // kept chasing anomalies into other namespaces on plain data questions. Once the
    // budget is spent, the next LLM call gets NO tools — it must answer with what it has.
    const maxToolRounds = opts.maxToolRounds ?? Infinity;
    const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    const depth = opts.depth ?? 0;
    const mode = opts.mode ?? "alert";
    let toolRounds = 0;
    let toolsDisabled = false;
    let scopeNamespaces: Set<string> | null = null; // set by the first tool round (conversation mode)
    let sawLogLines = false;   // any log tool returned content — see LOG_GAP_NOTICE
    let logGapNudged = false;  // the nudge is spent once per investigation, never a loop
    let imageGapNudged = false; // same, for IMAGE_GAP_NOTICE — one hold slot serves every gate
    let noEvidenceNudged = false; // same, for NO_EVIDENCE_NOTICE
    // The answer the nudge interrupted, and the round count when it did. Kept so a nudge that
    // produces no new evidence cannot downgrade an answer that was already complete.
    let preNudgeSummary = "";
    let toolRoundsAtNudge = -1;

    const isFollowUp = await this.memory.hasRca(threadId);

    // Time context on EVERY turn now, not only the first. It used to ride the opening message
    // alone, so eleven turns later the newest statement of what "now" means was 50 minutes old
    // and sat at the far end of the window behind a wall of tool results — the same losing
    // position that made buildMentionMarker() restate itself every turn. Two lines of timestamps
    // per turn is a cheap price for the model knowing what day it is.
    //
    // The staleness line is the other half: the timestamp only helps if something also says when
    // the evidence was read. See staleEvidenceNotice.
    const staleness = staleEvidenceNotice(await this.memory.get(threadId));
    const messageToAppend = [
      buildTimeContext(),
      staleness,
      // for follow-up: explicit mode instruction so the LLM doesn't default to RCA format
      isFollowUp
        ? `[FOLLOW-UP — conversation mode, do NOT use RCA format. Out-of-scope requests (code, general questions) are still declined in one line per Scope of Work, even mid-thread.]\n${userMessage}`
        : userMessage,
    ]
      .filter(Boolean)
      .join("\n\n");

    await this.memory.append(threadId, { role: "user", content: messageToAppend });
    if (staleness) logger.debug(`[${threadId}] prior evidence is stale — warned the model to re-read`);

    // Matched on the alert text alone, not on userMessage: src/app/index.ts prepends recalled
    // prior incidents, and a previous incident's RCA must not select this one's playbook.
    // A thread outlives a pod: its conversation comes back from Redis, so its playbooks have to
    // as well or the follow-up answers with a different skill set than the turn it follows.
    await this.rehydrateThreadSkills(threadId);
    const decayed = decayThreadSkills(this.threadSkills, threadId);
    if (decayed.length > 0) {
      logger.info(`[${threadId}] playbooks aged out before this turn: ${decayed.join(", ")} (re-selected if they still match)`);
    }
    // The mode tag rides the trigger so a skill can declare its own mode condition in
    // frontmatter instead of the loop hardcoding a skill name — `rca-format` is `when:
    // mode:(alert|investigation)`. No playbook regex matches the tag itself; skills/real.test.ts
    // pins that, because a `when` that happened to contain "alert" would load on every run.
    let skills = selectForThread(this.skills, this.threadSkills, threadId, `${modeTag(mode)}\n${opts.trigger ?? userMessage}`);
    this.persistThreadSkills(threadId, skills);

    // SECURITY: [WRITE] tools never enter the agentic loop — the model must not be able
    // to execute state-changing actions on its own. Write tools are reachable only via
    // the proposal dry-run and the human-approved execution path (direct callTool).
    const tools = withDelegateTool(
      this.mcp.getTools().filter((t) => !t.description.startsWith("[WRITE]")),
      config.subagents,
      { depth, maxToolRounds }
    );
    const systemPrompt = buildStaticSystemPrompt();
    let iterations = 0;
    let totalToolCalls = 0;
    // The response that ANSWERED, not the first one tried: on a failover the backend that
    // finally worked is the one the footer must name.
    let lastResponse: LLMResponse | undefined;

    // Every exit from this loop goes through here, so the footer is never missing from the
    // paths that matter most — the timeout and the out-of-steps replies are exactly where a
    // reader wants to know how long it ran and on which model.
    //
    // The completion line is emitted HERE rather than where the model stops talking, and that is
    // a fix, not a tidy-up: it used to sit above the log-gap gate, so a run that took the extra
    // round logged "Investigation complete in 28451ms (2 LLM calls)" and then kept going, twice
    // in one thread on 2026-09-15. It also never fired at all on the deadline and out-of-steps
    // exits, which are the two a reader most wants the duration for.
    const done = (text: string): string => {
      const durationMs = Date.now() - investigationStart;
      opts.onComplete?.({
        durationMs,
        rounds: iterations,
        toolCalls: totalToolCalls,
        backend: lastResponse?.backend,
        model: lastResponse?.model,
        route: lastResponse?.route,
      });
      logger.info(
        `[${threadId}] Investigation complete in ${durationMs}ms (${iterations} LLM calls, ` +
        `${totalToolCalls} tool calls) | total tokens — ` +
        (totalUsage.inputTokens === 0 && totalUsage.outputTokens === 0
          // Not "zero tokens" — the agent-builder/Langflow envelope reports no counts at all
          // (devops-ai-agent-worker/src/agent-builder.ts), and printing in=0 out=0 cache_read=0
          // read as "prompt caching is broken" for weeks when the truth was "not measurable here".
          ? `not reported by ${lastResponse?.backend ?? "this backend"}`
          : `in=${totalUsage.inputTokens} out=${totalUsage.outputTokens} ` +
            `cache_read=${totalUsage.cacheReadTokens} cache_write=${totalUsage.cacheCreationTokens}`)
      );
      // The [OFFER] line is for the gate, never for a reader. Thread memory already holds the raw
      // reply (appended above), which is where app/index.ts reads it back — see parseOffer.
      return stripOffer(text);
    };
    let totalUsage = zeroUsage();

    // A delegate inherits a deadline instead of taking a fresh one: its whole point is to finish
    // inside the parent's budget, and config.investigationTimeoutMs would hand it the full 300s
    // the parent is already spending.
    const deadline = opts.deadline ?? investigationStart + config.investigationTimeoutMs;

    while (iterations < maxIterations) {
      if (Date.now() > deadline) {
        // The budget is the deadline, not the configured timeout: a delegate is given what is
        // left of its parent's, so naming config.investigationTimeoutMs here reported 300s at a
        // sub-thread that never had more than a fraction of it.
        const overBy = deadline - investigationStart;
        // The third ceiling, and it obeys the same rule as the other two now: end in an answer,
        // never an apology. It used to return the apology below immediately, throwing away every
        // tool result the run had gathered — the identical regression the iteration ceiling was
        // added to fix, left in place here because no backend was slow enough to reach it. One
        // that answers in 20-100s reaches it on an ordinary alert, so the evidence at stake is
        // real and this is where it was being discarded.
        //
        // Overrunning the deadline by one tool-free call is already this design's documented
        // behaviour ("~budget + one in-flight call" in MEMORY_BANK), so the answer turn costs
        // nothing that was not already promised. `toolsDisabled` doubles as the guard against
        // taking it twice: on the next pass we are still past the deadline, so a model that
        // spent its answer turn asking for more tools falls through to the apology, which by
        // then is the honest reply.
        const notice = forcedFinalAnswer({ toolRounds, maxToolRounds, iterations, maxIterations, depth, outOfTime: true });
        if (notice && !toolsDisabled && toolRounds > 0) {
          toolsDisabled = true;
          await this.memory.append(threadId, { role: "user", content: [{ type: "text", text: notice }] });
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${iterations} LLM calls ` +
            `and ${toolRounds} tool rounds — forcing a final answer from the evidence gathered`
          );
        } else {
          // Nothing gathered, or the answer turn is already spent. Either way there is no
          // finding to salvage and the apology is the truthful reply.
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${iterations} LLM calls ` +
            `(tool rounds: ${toolRounds}, answer turn ${toolsDisabled ? "already spent" : "not reachable"})`
          );
          return done("⚠️ Investigation exceeded its time budget. Please review the partial findings above and try a more specific query.");
        }
      }
      iterations++;

      const assembled = assembleRequest({
        history: await this.memory.get(threadId),
        systemPrompt,
        tools: toolsDisabled ? [] : tools,
        skills,
        budget: this.budget,
      });
      logger.debug(
        `[${threadId}] LLM call #${iterations} (history: ${assembled.messages.length} messages, ` +
        `-${assembled.messagesDropped} over budget, ~${assembled.estimatedTokens} tokens, ` +
        `skills: [${assembled.skillsUsed.join(", ") || "none"}]` +
        (assembled.skillsDropped.length > 0 ? `, dropped: [${assembled.skillsDropped.join(", ")}]` : "") + ")"
      );
      if (assembled.skillsDropped.length > 0) {
        logger.warn(`[${threadId}] context budget dropped skills: ${assembled.skillsDropped.join(", ")}`);
      }
      // The floor: the first and the most recent message are pinned unconditionally, so a single
      // enormous tool result can put the request over the window with nothing left to drop. Say so
      // and send it anyway — a visible 400 from the backend beats inventing a truncation that
      // hides which evidence went missing.
      const available = this.budget.contextTokens - this.budget.reserveTokens;
      if (assembled.estimatedTokens > available) {
        logger.warn(
          `[${threadId}] context over budget: ~${assembled.estimatedTokens} tokens vs ${available} ` +
          `available — pinned messages alone exceed the window, sending anyway`
        );
      }

      const llmStart = Date.now();
      let response;
      try {
        response = await this.llm.chat(assembled.messages, toolsDisabled ? [] : tools, assembled.systemPrompt);
        lastResponse = response;
      } catch (err) {
        // the LLM call is the one hop that leaves this process; without this line a
        // worker/queue failure surfaced only as a generic Slack error with no context
        logger.error(`[${threadId}] LLM call #${iterations} failed after ${Date.now() - llmStart}ms: ${errDetail(err)}`);
        throw err;
      }
      const llmMs = Date.now() - llmStart;

      // what the model actually produced — the missing piece when Slack shows garbage but
      // the logs only say "stop=end_turn"
      logger.debug(
        `[${threadId}] LLM #${iterations} content: [${response.content.map((c) => c.type).join(", ") || "empty"}]` +
        (this.extractText(response.content) ? ` text="${truncate(this.extractText(response.content), 200)}"` : "")
      );

      if (response.usage) {
        totalUsage = addUsage(totalUsage, response.usage);
        this.recordUsage(threadId, response);
        logger.debug(
          `[${threadId}] LLM #${iterations} ${llmMs}ms | ` +
          `in=${response.usage.inputTokens} out=${response.usage.outputTokens} ` +
          `cache_read=${response.usage.cacheReadTokens} cache_write=${response.usage.cacheCreationTokens} ` +
          `stop=${response.stopReason}`
        );
      } else {
        logger.debug(`[${threadId}] LLM responded in ${llmMs}ms, stop_reason: ${response.stopReason}`);
      }

      await this.memory.append(threadId, { role: "assistant", content: response.content });

      if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
        const summary = this.extractText(response.content);
        if (!summary) {
          // never return empty — Slack chat.postMessage rejects an empty text with `no_text`
          logger.warn(`[${threadId}] LLM returned an empty final response (stop=${response.stopReason})`);
          if (response.stopReason === "max_tokens") {
            // reasoning models can spend the entire output budget thinking and emit no text
            return done("⚠️ The model hit its output-token limit before writing the answer (its reasoning consumed the whole budget). Try again — or raise `LLM_MAX_TOKENS` / set `LLM_REASONING_EFFORT=low` on the llm-worker.");
          }
          return done("⚠️ The investigation finished but the model returned an empty response. Please re-run or rephrase the request.");
        }
        // A model that echoes our own content-block JSON as prose means its tool-call
        // channel is not working (see toOpenAIMessages in the OpenAI-compatible clients).
        // Log it here — otherwise the only symptom is a wall of JSON in Slack.
        if (SERIALIZED_BLOCKS.test(summary)) {
          logger.warn(
            `[${threadId}] final answer looks like a serialized content array — the backend is likely ` +
            `not emitting native tool_calls (check the LLM tool-call parser). Preview: ${truncate(summary, 200)}`
          );
        }
        // The other shape of the same fault: the model named the tool instead of calling it.
        // The router escalates on this, so with LLM_PROVIDER=router it is already handled by
        // the time we get here — this branch is the backstop for the single-backend providers,
        // which have nothing to fall up to. Logged, not rewritten: a canned reply would hide a
        // misconfigured tool-call parser behind a friendly sentence.
        if (namesToolOnly(summary, toolsDisabled ? [] : tools)) {
          logger.warn(
            `[${threadId}] final answer is just the tool name \`${summary.trim()}\` — the backend named a ` +
            `tool instead of calling it. Check its tool-call parser; on LLM_PROVIDER=router this escalates instead.`
          );
        }
        // Before every other gate: an alert answered with no tool call at all has not been
        // investigated, and whatever the other gates would ask about is downstream of that.
        if (needsEvidence({ mode, toolRounds, nudged: noEvidenceNudged, toolsDisabled })) {
          noEvidenceNudged = true;
          preNudgeSummary = summary;
          toolRoundsAtNudge = toolRounds;
          logger.warn(`[${threadId}] answered an alert with zero tool calls — one more round to go and look`);
          await this.memory.append(threadId, { role: "user", content: NO_EVIDENCE_NOTICE });
          continue;
        }
        // The last gate before an answer leaves — see logGapAction for all three outcomes.
        const gap = logGapAction({
          mode,
          demandsLogs: demandsLogs(skills),
          sawLogLines,
          nudged: logGapNudged,
          toolsDisabled,
          toolRounds,
          toolRoundsAtNudge,
          holdingAnswer: preNudgeSummary !== "",
        });
        if (gap === "restore") {
          // Gate-agnostic on purpose: both gates hold their answer in the same slot, so this
          // sentence has to be true of whichever one spent the round.
          logger.warn(
            `[${threadId}] the extra round fetched nothing — keeping the pre-nudge answer ` +
            `(${preNudgeSummary.length} chars) over the retry's ${summary.length}`
          );
          return done(preNudgeSummary);
        }
        if (gap === "nudge") {
          logGapNudged = true;
          preNudgeSummary = summary;
          toolRoundsAtNudge = toolRounds;
          logger.info(
            `[${threadId}] answered after ${toolRounds} tool round(s) with no log lines, while ` +
            `[${skills.map((s) => s.name).join(", ")}] read logs — one more round`
          );
          await this.memory.append(threadId, { role: "user", content: LOG_GAP_NOTICE });
          continue;
        }
        // Second gate, same hold slot: only one nudge may be outstanding, so this is reached only
        // when the log gap did not take the round. Evidence-driven, so it is safe in every mode —
        // the trigger is a pull failure in tool output, not a guess about the question.
        if (!imageGapNudged && !toolsDisabled && toolRounds > 0) {
          const repo = imageGapRepo(summary, observedText(await this.memory.get(threadId)));
          if (repo) {
            imageGapNudged = true;
            preNudgeSummary = summary;
            toolRoundsAtNudge = toolRounds;
            logger.info(`[${threadId}] answer names \`${repo}\` only as the image that failed to pull — one more round for the tag that works`);
            await this.memory.append(threadId, { role: "user", content: IMAGE_GAP_NOTICE });
            continue;
          }
        }
        return done(summary);
      }

      if (response.stopReason === "tool_use") {
        if (toolsDisabled) {
          // model emitted tool_use even though no tools were offered — keep the
          // tool_use/tool_result pairing intact with synthesized errors and loop again
          const synth = response.content
            .filter((c) => c.type === "tool_use")
            .map((t) => ({
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: "Error: tool budget exhausted — answer with the data already gathered.",
            }));
          await this.memory.append(threadId, { role: "user", content: synth });
          continue;
        }

        // Conversation-mode guards. Prompt rules alone did not stop the model from
        // (a) chasing anomalies into other namespaces and (b) dumping logs of every pod
        // matching a generic name — both are enforced here deterministically.
        let executable = response.content.filter((c) => c.type === "tool_use");
        const refusals: ContentBlock[] = [];

        // Delegation is intercepted here, before the conversation-mode guards below. The MCP
        // server has no such tool, and a delegate must not reach namespacesOf(): it carries no
        // namespace, so a first round of nothing but delegates would lock the scope to the empty
        // set — which is the case that disables the lock for the rest of the run.
        let delegateResults: ContentBlock[] = [];
        const delegateCalls = executable.filter((t) => t.name === DELEGATE_TOOL);
        if (delegateCalls.length > 0) {
          executable = executable.filter((t) => t.name !== DELEGATE_TOOL);
          const { run, refusals: overflow } = capFanout(delegateCalls, config.subagents.maxFanout);
          if (overflow.length > 0) {
            logger.info(
              `[${threadId}] ${delegateCalls.length} delegates requested, fan-out cap is ` +
              `${config.subagents.maxFanout} — ${overflow.length} refused`
            );
          }
          delegateResults = [...(await this.runDelegates(threadId, run, deadline)), ...overflow];
        }

        if (maxToolRounds !== Infinity) {
          // Namespace scope lock: the first tool round defines the question's namespaces.
          if (scopeNamespaces === null) {
            scopeNamespaces = namespacesOf(executable);
          } else {
            const drift = outOfScope(executable, scopeNamespaces);
            if (drift.length > 0) {
              const scopeList = [...scopeNamespaces].join(", ");
              logger.info(`[${threadId}] blocked ${drift.length} out-of-scope tool call(s) — question scope is [${scopeList}]`);
              refusals.push(
                ...drift.map((t) => ({
                  type: "tool_result" as const,
                  tool_use_id: t.id,
                  content: `Error: out of scope — this question is about namespace(s) ${scopeList}. Answer with the data you already have; if something outside that scope looks relevant, mention it in one line and ask the user before expanding.`,
                }))
              );
              executable = executable.filter((t) => !drift.includes(t));
            }
          }

          // Log fan-out guard: a generic name matching many pods → ask, don't dump.
          const logCalls = executable.filter((t) => t.name === "k8s_get_pod_logs");
          const logPods = new Set(logCalls.map((t) => (t.input as Record<string, unknown> | undefined)?.pod_name));
          if (logPods.size > MAX_LOG_FANOUT) {
            logger.info(`[${threadId}] log fan-out to ${logPods.size} pods blocked — steering to a confirmation question`);
            refusals.push(
              ...logCalls.map((t) => ({
                type: "tool_result" as const,
                tool_use_id: t.id,
                content: `Error: logs for ${logPods.size} different pods requested at once — ambiguous. List the matching pods (grouped by workload) and ask the user which one they want. Do not fetch all logs.`,
              }))
            );
            executable = executable.filter((t) => t.name !== "k8s_get_pod_logs");
          }
        }

        // Reported here rather than after the LLM call: this is the last point at which we
        // know what the round will really do — the scope lock, the fan-out guard and the
        // delegate split have all had their say, so the names below are the ones that run.
        reportProgress(opts.onProgress, toolRounds, [...executable, ...delegateCalls], (err) =>
          logger.debug(`[${threadId}] progress callback threw, ignored: ${errDetail(err)}`)
        );

        totalToolCalls += executable.length;
        const executed = executable.length > 0 ? await this.executeToolCalls(threadId, executable, opts.namespace) : [];
        if (!sawLogLines) {
          const logIds = new Set(executable.filter((t) => LOG_TOOLS.has(t.name ?? "")).map((t) => t.id));
          sawLogLines = executed.some(
            (r) => r.type === "tool_result" && logIds.has(r.tool_use_id) && String(r.content ?? "").length >= LOG_RESULT_MIN_CHARS
          );
        }
        const trimmedResults = sanitizeContentBlocks([...executed, ...delegateResults, ...refusals]);
        // Appended, never unshifted: Anthropic requires every tool_result block to come first in
        // its user message, and a text block ahead of them is a 400.
        if (executed.length > 0) trimmedResults.push({ type: "text", text: evidenceStamp() });

        toolRounds++;
        const notice = forcedFinalAnswer({ toolRounds, maxToolRounds, iterations, maxIterations, depth });
        if (notice) {
          toolsDisabled = true;
          trimmedResults.push({ type: "text", text: notice });
          logger.info(
            notice === TOOL_BUDGET_NOTICE
              ? `[${threadId}] tool budget (${maxToolRounds} rounds) reached — forcing final answer`
              : `[${threadId}] iteration ceiling (${maxIterations}) reached after ${toolRounds} tool rounds — forcing final answer`
          );
        }

        await this.memory.append(threadId, { role: "user", content: trimmedResults });

        // Playbooks are picked from the alert text, and a generic alert name says nothing about
        // which failure mode it is: "KubernetesPodNotHealthy" fires for an OOMKill, a failed
        // probe and an unpullable image alike, so none of their playbooks match and the model
        // investigates with the output format alone. The evidence is what names the failure —
        // the events say `ImagePullBackOff` — so match against that too, one result at a time
        // (each gets its own trigger window rather than sharing one truncated concatenation).
        // selectForThread keeps what is already loaded, so this only ever adds.
        for (const text of evidenceTexts(trimmedResults)) {
          const before = skills.length;
          skills = selectForThread(this.skills, this.threadSkills, threadId, text);
          const added = skills.slice(before).map((s) => s.name);
          if (added.length > 0) {
            this.persistThreadSkills(threadId, skills);
            logger.info(`[${threadId}] playbook matched from tool evidence, not the alert text: ${added.join(", ")}`);
          }
        }
      }
    }

    // Residual only: `forcedFinalAnswer` spends the second-to-last round disabling tools, so
    // reaching here means the model answered that turn with another tool_use instead of prose.
    // Nothing was posted to the thread, so don't tell the reader to review findings "above".
    logger.warn(`[${threadId}] Investigation hit max iterations (${maxIterations}) — model kept calling tools on its final, tool-free turn`);
    return done("⚠️ Investigation ran out of steps before the model wrote a conclusion. Nothing was lost — re-run it, or ask about one specific symptom to narrow the search.");
  }

  /**
   * Runs each delegated hypothesis as its own investigation, in parallel, and returns one
   * tool_result per call — including for the ones that could not run, because an unanswered
   * tool_use is a 400 from Anthropic rather than a smaller request.
   *
   * The delegates go through `investigate()` rather than `runInvestigation()` so each gets its
   * own trace context: the sub-thread id is prefixed with the parent's, so grepping the Slack
   * thread id still finds every child across the agent and llm-worker logs, and grepping the
   * sub id isolates one of them. They do NOT take a semaphore slot — that lives in app/index.ts
   * around the entry points, and a child waiting on a permit its own parent is holding is a
   * deadlock at MAX_CONCURRENT_INVESTIGATIONS.
   */
  private async runDelegates(threadId: string, calls: ContentBlock[], parentDeadline: number): Promise<ContentBlock[]> {
    const cutoff = childDeadline(parentDeadline);
    const block = (id: string | undefined, content: string): ContentBlock =>
      ({ type: "tool_result" as const, tool_use_id: id, content });

    return Promise.all(
      calls.map(async (call, i) => {
        const hypothesis = hypothesisOf(call);
        if (!hypothesis) {
          return block(call.id, "Error: delegate_investigation needs a non-empty `hypothesis` — state the claim to test.");
        }
        if (Date.now() >= cutoff) {
          logger.warn(`[${threadId}] delegate refused — less than the reserve left before the investigation deadline`);
          return block(
            call.id,
            "Error: not enough time left in this investigation's budget to delegate. Answer with the evidence already gathered."
          );
        }

        const sub = subThreadId(threadId, i + 1);
        const start = Date.now();
        logger.info(`[${threadId}] → delegate ${sub}: ${truncate(hypothesis, 160)}`);
        try {
          const findings = await this.investigate(sub, `${DELEGATE_MARKER}\n${hypothesis}`, {
            maxToolRounds: config.subagents.toolRounds,
            maxIterations: config.subagents.maxIterations,
            deadline: cutoff,
            depth: 1,
            // Playbooks are selected from the hypothesis, not from the parent's alert text: the
            // delegate is investigating one failure mode, and that is the text describing it.
            trigger: hypothesis,
          });
          logger.info(`[${threadId}] ← delegate ${sub} ok (${Date.now() - start}ms, ${findings.length} chars)`);
          return block(call.id, `[delegate: ${hypothesis}]\n${findings}`);
        } catch (e) {
          logger.error(`[${threadId}] ← delegate ${sub} failed (${Date.now() - start}ms): ${errDetail(e)}`);
          return block(call.id, `Error: this delegated investigation failed (${errDetail(e)}). Continue without it and say in your answer that this hypothesis was not tested.`);
        } finally {
          // A sub-thread is scratch space: nothing reads it after the findings come back, and
          // leaving it behind leaks one Redis key (24h TTL) and one threadSkills entry per
          // delegate against a Map capped at MAX_TRACKED_THREADS.
          await this.memory.clear(sub).catch((e) => logger.warn(`[${threadId}] delegate ${sub} memory cleanup failed: ${errDetail(e)}`));
          this.threadSkills.delete(sub);
          this.toolMemo.delete(sub);
        }
      })
    );
  }

  private async executeToolCalls(threadId: string, content: ContentBlock[], namespace?: string): Promise<ContentBlock[]> {
    const toolUses = content.filter((c) => c.type === "tool_use");
    const defs = this.mcp.getTools();
    // The MCP server's own tool names, which is what makes `run k8s_scale` distinguishable from
    // any other sentence in a log line — see agent/injection/.
    const toolNames = defs.map((t) => t.name);

    // This is the trust boundary: every string below was written by something in the cluster,
    // not by the operator. It is the ONLY place raw tool output enters the conversation (a
    // delegate's results come back through its own call to this method), so the injection frame
    // goes on here and nowhere else — refusals and delegate summaries are our own text.
    const guard = (raw: string, name: string | undefined): string => {
      const { content: framed, hits } = flagInjection(raw, toolNames);
      if (hits.length > 0) {
        logger.warn(`[${threadId}] possible prompt injection in ${name} result [${hits.join(", ")}] — framed as data, not blocked`);
      }
      return framed;
    };

    // run all tool calls in parallel — k8s/prometheus/loki calls are independent
    return Promise.all(
      toolUses.map(async (toolUse) => {
        const { id, name, input } = toolUse;
        // second layer of the write-tool exclusion (first: filtered from the tools list)
        const def = defs.find((t) => t.name === name);
        if (def?.description.startsWith("[WRITE]")) {
          logger.warn(`[${threadId}] blocked direct write-tool call: ${name}`);
          return {
            type: "tool_result" as const,
            tool_use_id: id,
            content: "Error: write tools require the human approval flow and cannot be called during an investigation.",
          };
        }
        const placeholder = placeholderIn(input);
        if (placeholder) {
          logger.warn(`[${threadId}] refused ${name}: placeholder ${placeholder} in its input`);
          return { type: "tool_result" as const, tool_use_id: id, content: PLACEHOLDER_REFUSAL(placeholder, namespace) };
        }
        // Repeat suppression. The memo holds the PROMISE, not the settled value, so two
        // identical calls in the same parallel round collapse onto one request as well.
        // Only successes stay memoised — a failure that is retried may genuinely succeed,
        // and pinning it would turn one transient error into a dead tool for the rest of
        // the investigation.
        const memo = this.toolMemo.get(threadId);
        const key = toolCallKey(name, input);
        const cached = memo?.get(key);
        if (cached) {
          try {
            const result = await cached;
            logger.info(`[${threadId}] ⟲ tool: ${name} repeat call — served from this investigation's memo (${result.length} chars), not re-run`);
            return { type: "tool_result" as const, tool_use_id: id, content: guard(REPEAT_NOTICE + result, name) };
          } catch {
            memo?.delete(key); // it failed; let this call have its own attempt
          }
        }

        const start = Date.now();
        logger.info(`[${threadId}] → tool: ${name} input: ${truncate(JSON.stringify(input))}`);
        const pending = this.mcp.callTool(name!, input as Record<string, unknown>);
        memo?.set(key, pending);
        try {
          const result = await pending;
          logger.info(`[${threadId}] ← tool: ${name} ok (${Date.now() - start}ms, ${result.length} chars)`);
          return { type: "tool_result" as const, tool_use_id: id, content: guard(result, name) };
        } catch (err) {
          memo?.delete(key);
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[${threadId}] ← tool: ${name} failed (${Date.now() - start}ms): ${errMsg}`);
          // Guarded too: an upstream error quotes what it choked on, so an annotation or a
          // container name can reach us inside a message we only appear to have written.
          return { type: "tool_result" as const, tool_use_id: id, content: guard(`Error: ${errMsg}`, name) };
        }
      })
    );
  }

  // One row per chat() call (per the llm_usage migration's own header comment) — every
  // this.llm.chat() call site must go through this, not just the investigation loop.
  // threadTs is null wherever the call site has no Slack thread to attribute to (proposal
  // drafting, learn extraction, the conversation-mode reformat) — never invent one.
  private recordUsage(threadTs: string | null, response: LLMResponse): void {
    if (!response.usage) return;
    void this.usage.record({
      threadTs,
      backend: response.backend ?? null,
      route: response.route ?? null,
      model: response.model ?? null,
      usage: response.usage,
    });
  }

  /**
   * The last thing the agent said in this thread. The remediation gate needs it: "ya" only
   * means "do it" when something was proposed to do. Read BEFORE the current turn runs —
   * afterwards this turn's own reply is the last assistant message.
   */
  async lastAssistantText(threadId: string): Promise<string> {
    const history = await this.memory.get(threadId).catch(() => []);
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      if (m.role !== "assistant") continue;
      const text = typeof m.content === "string" ? m.content : this.extractText(m.content);
      if (text.trim()) return text;
    }
    return "";
  }

  /**
   * The alert a Slack thread is anchored to, for the mention path's per-message marker.
   * Null whenever the thread was never an alert (a plain question) or incident memory is off.
   */
  async threadAlertIdentity(channel: string, threadTs: string): Promise<{ alertname: string; namespace: string | null } | null> {
    return this.incidents.threadAlertIdentity(channel, threadTs).catch((err) => {
      logger.warn(`[${threadTs}] could not read the thread's alert identity: ${errDetail(err)}`);
      return null;
    });
  }

  /**
   * Rebuilds this thread's accumulated playbooks from durable memory when this process has never
   * seen the thread — after a restart, a rollout, or on another replica. Names are resolved
   * against the live registry, so a skill deleted from `prompts/skills/` since simply does not
   * come back rather than resurrecting as a dangling name.
   */
  private async rehydrateThreadSkills(threadId: string): Promise<void> {
    if (this.threadSkills.has(threadId)) return; // this process already owns the thread's set
    const names = await this.memory.getSkills(threadId).catch((err) => {
      logger.warn(`[${threadId}] could not read stored playbooks — reselecting: ${errDetail(err)}`);
      return [] as string[];
    });
    const known = resolveSkillNames(this.skills, names);
    if (known.length === 0) return;
    this.threadSkills.set(threadId, known);
    logger.info(`[${threadId}] playbooks restored from memory: ${known.map((s) => s.name).join(", ")}`);
  }

  // Fire-and-forget, like recordUsage: losing a playbook name costs the next turn a reselection,
  // and blocking an investigation on a cache write would be the worse trade.
  private persistThreadSkills(threadId: string, skills: readonly Skill[]): void {
    void this.memory
      .setSkills(threadId, skills.map((s) => s.name))
      .catch((err) => logger.warn(`[${threadId}] could not store playbooks: ${errDetail(err)}`));
  }

  /**
   * Resource names the answer asserts that no tool result in this thread ever returned — see
   * agent/grounding/. Read AFTER the answer is produced and BEFORE the caller acts on it; the
   * dry-run guards a proposed action, this guards the claim, and the claim is what reaches Slack
   * and `incidents.root_cause` whether or not any action follows.
   */
  async ungroundedNames(threadId: string, answer: string, trigger = ""): Promise<string[]> {
    const history = await this.memory.get(threadId).catch(() => [] as Message[]);
    // `trigger` is the alert payload as Alertmanager sent it — buildGroupAlertText's output,
    // WITHOUT the recall block app/index.ts wraps around it before the model sees it. That
    // distinction is the whole reason it can be counted as evidence; see grounding/index.ts.
    //
    // The playbook NAMES ride along for the same reason: we put them in the model's context, so
    // quoting one back cannot be an invention. Observed on benchmark case A03 — the RCA said the
    // drift check would need "`gitops-drift` tooling", which is the playbook it had been handed,
    // and it was reported to the thread as a resource no tool result contained. All registered
    // names rather than this thread's, because a name we ship is never an invention whoever
    // loaded it.
    const given = [trigger, ...this.skills.all().map((s) => s.name)].join("\n");
    const gaps = groundingGaps(answer, history, given);
    if (gaps.length > 0) {
      logger.warn(
        `[${threadId}] answer names ${gaps.length} resource(s) absent from every tool result: ${gaps.join(", ")}`
      );
    }
    return gaps;
  }

  private extractText(content: ContentBlock[]): string {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
  }

  // ---- Guarded Remediation (docs/DESIGN_guarded_remediation.md) ----

  // Propose at most one whitelisted action after an RCA. Returns null when: write tools
  // aren't enabled on the MCP server (tool not discovered), the model proposes nothing,
  // or a card is already active for this incident. A dry-run refusal returns the server's
  // reason instead — the model DID want to act, and the human deserves to know why not
  // (GitOps guard, blocked namespace, bad target). No card in any non-id case.
  async proposeRemediation(
    incidentId: number | null, // null = mention-driven investigation (no alert labels)
    labels: Record<string, string>,
    rca: string,
    opts: { userRequested?: boolean; threadId?: string } = {}
  ): Promise<
    | { id: number; proposal: Proposal; dryRunSummary: string; gitOps?: { path: string; valuesKey: string; helmRelease: { name: string; namespace: string } } }
    | { refused: string }
    | null
  > {
    // write tools present at all? (server-side flag off = never propose)
    if (!this.mcp.getTools().some((t) => t.description.startsWith("[WRITE]"))) return null;

    // Light route, like reformatToConversation(): this is a constrained transform of an RCA
    // that already exists, not an investigation — no tools, one shape to emit — and it was
    // measured at 15.1s on the heavy chain, which is a self-hosted reasoning model spending
    // most of its output budget thinking about a form it has to fill in.
    //
    // Safe to downgrade because nothing downstream trusts the text: parseProposal() rejects
    // anything off-shape, the action must be a registered MCP tool, the dry-run exercises the
    // server's guardrails, and a human still approves the card. The router escalates into the
    // heavy chain on its own if the light backend fails deterministically.
    //
    // What it does NOT protect: a light backend that emits confident, well-formed prose that
    // simply is not a proposal. parseProposal() returns null and the incident silently gets no
    // card — the "[remediation] no actionable proposal from model" line below is the only
    // symptom, so that log is what to grep if approval cards stop appearing.
    //
    // Two calls at most, not one: proposeWithRetry re-asks once when the first answer named an
    // action it did not fill in, or answered null. See proposal.ts for why that is code here
    // rather than another paragraph in the prompt.
    const { proposal, raw } = await proposeWithRetry(labels, rca, async (prompt) => {
      const response = await withRoute("light", () => this.llm.chat([{ role: "user", content: prompt }], [], PROPOSAL_SYSTEM));
      this.recordUsage(null, response); // no Slack thread at this call site — never invent one
      return this.extractText(response.content);
    });
    if (!proposal) {
      logger.info(`[remediation] no actionable proposal from model: ${truncate(raw, 200)}`);
      return null;
    }
    // the specific proposed action must actually be registered on the server
    if (!this.mcp.getTools().some((t) => t.name === proposal.action)) {
      logger.info(`[remediation] proposed action ${proposal.action} is not registered on the MCP server`);
      return null;
    }

    // The replacement guard, before the dry-run: a restart or a delete against a fault that
    // lives in the spec is a change the MCP server will happily validate, because there is
    // nothing wrong with it as an operation — it just cannot work. See replace-guard.ts for why
    // this is code and not another paragraph in the prompt.
    //
    // Skipped when the human asked for the action in words. The guard exists to stop the MODEL
    // reaching for a gesture when it cannot place a fault; a person who types "restart the
    // payments deployment" has placed it themselves and may know something the pod list does not
    // show. Their request is already sufficient evidence per buildProposalPrompt.
    if (!opts.userRequested) {
      const refusal = await this.guardRefusalFor(proposal);
      if (refusal) {
        logger.info(`[remediation] replacement guard refused ${proposal.summary}: ${refusal}`);
        return { refused: refusal };
      }
    }

    // The quarantine gate, and unlike the replacement guard it is NOT skipped for a user
    // request. "Delete the unused mongodb endpoint" is exactly the sentence that produces a
    // quarantine proposal, and the user saying it is not evidence that the workload is idle —
    // they are asking BECAUSE they are unsure. Measurement is the only thing that settles it,
    // and this is where we insist on having done it.
    const idleRefusal = await this.quarantineRefusalFor(proposal, opts.threadId);
    if (idleRefusal) {
      logger.info(`[remediation] quarantine gate refused ${proposal.summary}: ${idleRefusal}`);
      return { refused: idleRefusal };
    }

    // Same rule, same reason, for the one action that cannot be undone from the cluster.
    const orphanRefused = await this.orphanRefusalFor(proposal, opts.threadId);
    if (orphanRefused) {
      logger.info(`[remediation] orphan gate refused ${proposal.summary}: ${orphanRefused}`);
      return { refused: orphanRefused };
    }

    // Replicas need a measurement of their own. Skipped for a user request, like the replacement
    // guard: a person who asks for more replicas has placed the need themselves.
    if (!opts.userRequested) {
      const scaleRefused = scaleOutRefusal(proposal, await this.threadEvidence(opts.threadId));
      if (scaleRefused) {
        logger.info(`[remediation] scale gate refused ${proposal.summary}: ${scaleRefused}`);
        return { refused: scaleRefused };
      }
    }

    // One pending card per action+target, across incidents — see RemediationStore.pendingFor.
    const pending = await this.remediations.pendingFor(targetKey(proposal.action, proposal.namespace, proposal.name)).catch(() => null);
    if (pending !== null) {
      logger.info(`[remediation] duplicate of pending card ${pending}: ${proposal.summary}`);
      return { refused: `An approval card for this exact action on \`${proposal.namespace}/${proposal.name}\` is already waiting (remediation ${pending}). Approve or reject that one — a second card is the same decision twice.` };
    }

    // And for images: never a card for an image nothing in the thread showed. Not skipped for a
    // user request either — a person who names the image satisfies it in their own words.
    const imageRefused = await this.imageRefusalFor(proposal, opts.threadId, rca);
    if (imageRefused) {
      logger.info(`[remediation] image gate refused ${proposal.summary}: ${imageRefused}`);
      return { refused: imageRefused };
    }

    // Mandatory dry-run before any card — validates the target AND exercises the MCP
    // server's namespace guardrails with zero side effects.
    const dryRun = await this.mcp.callTool(proposal.action, { ...proposal.toolParams, dry_run: true });
    if (dryRun.startsWith("Error:")) {
      logger.info(`[remediation] dry-run refused for ${proposal.summary}: ${truncate(dryRun, 200)}`);
      return { refused: dryRun.replace(/^Error:\s*/, "") };
    }

    // Flux HelmRelease-managed workloads return a structured PR preview (not a direct-patch
    // validation) — route to the GitOps PR flow instead of storing a direct-patch card.
    const preview = parseGitOpsPreview(dryRun);
    if (preview) return this.proposeGitOpsPr(incidentId, proposal, preview);

    // store the exact tool params + display fields — execution replays params verbatim
    const id = await this.remediations.propose(incidentId, proposal.action, {
      ...proposal.toolParams,
      target: targetKey(proposal.action, proposal.namespace, proposal.name),
      reason: proposal.reason,
      summary: proposal.summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }

    return { id, proposal, dryRunSummary: truncate(dryRun, 400) };
  }

  /**
   * Refuses a scale-to-zero unless a `k8s_recommend_resources` run IN THIS THREAD measured this
   * exact workload idle. Returns null for every other proposal.
   *
   * Fails CLOSED, which is the opposite of `guardRefusalFor` beside it and deliberate: that one
   * lets a proposal through when its evidence call fails, because its worst case is a restart
   * that does not help. This one's worst case is a workload taken offline, so no evidence means
   * no card.
   *
   * The test is one exact substring against the thread's tool output rather than a re-parse of
   * the JSON: `observedText` reads the same `tool_result` blocks the model saw, and the context
   * compactor may have truncated them. A truncated result fails the match, which is the safe
   * direction — it costs a re-run, not an outage.
   */
  private async quarantineRefusalFor(proposal: Proposal, threadId?: string): Promise<string | null> {
    if (!proposal.quarantine) return null;
    return quarantineRefusal(proposal, await this.threadEvidence(threadId));
  }

  private async orphanRefusalFor(proposal: Proposal, threadId?: string): Promise<string | null> {
    if (proposal.action !== "k8s_delete_orphan") return null;
    return orphanDeleteRefusal(proposal, await this.threadEvidence(threadId));
  }

  /**
   * Public because `bench/run.ts` applies it too. `rca` is the proposal context: on the mention
   * path it opens with "User request: <text>", which is the only human-written part of it.
   */
  async imageRefusalFor(proposal: Proposal, threadId: string | undefined, rca: string): Promise<string | null> {
    if (proposal.action !== "k8s_set_image") return null;
    const userText = rca.match(/^User request: ([\s\S]*?)\n\nAgent reply:/)?.[1] ?? "";
    return unseenImageRefusal(proposal, await this.threadEvidence(threadId), userText);
  }

  /** The thread's tool output for the grounding gates, or null when there is no thread at all. */
  private async threadEvidence(threadId?: string): Promise<string | null> {
    if (!threadId) return null;
    return observedText(await this.memory.get(threadId).catch(() => [] as Message[]));
  }

  /**
   * One `k8s_list_pods` call, spent only on the two actions that replace a pod with an identical
   * one. Any failure returns null and lets the proposal through: this guard may add a refusal,
   * never remove one, and an unreachable MCP server is the dry-run's problem one line down.
   *
   * Public because `bench/run.ts` calls it. That runner deliberately does not go through
   * proposeRemediation — no database, no write tools — so without this it would score a proposal
   * production refuses to card, and the guard would be invisible to the measurement that
   * motivated it. Calling the same method is what keeps the two in agreement.
   */
  /**
   * Every pre-dry-run guard, in one call, so the benchmark runner and production cannot drift.
   *
   * They did once: `replacementRefusalFor` was public and the runner called it behind its own copy
   * of the `REPLACEMENT_ACTIONS` check, so adding a guard meant remembering to add it in two
   * places. Which actions a guard applies to belongs to the guard, not to its callers.
   *
   * One guard today. A second one lived here briefly and was measured out again: it required the
   * namespace's EVENTS to name a resource fault before `k8s_set_resources` could become a card,
   * and benchmark A02 went from 5 passes out of 5 to 0 — a real OOMKill is recorded in the
   * container's `lastState.terminated.reason`, and the event log of a pod that has settled into
   * CrashLoopBackOff need not mention it at all. The case it was written for (C03) kept failing
   * anyway, on its RCA rather than its proposal, and one attempt simply switched to
   * `k8s_set_image` when the resource action was blocked. A guard that has to read pod state to
   * be correct is a bigger thing than the one failure it fixes.
   */
  async guardRefusalFor(proposal: Proposal): Promise<string | null> {
    if (REPLACEMENT_ACTIONS.has(proposal.action)) return this.replacementRefusalFor(proposal);
    if (proposal.action === "k8s_set_image") return this.noOpImageRefusalFor(proposal);
    return null;
  }

  /**
   * Is this image change writing back the image already in the spec? See `noop-guard.ts`.
   *
   * One listing call, chosen by the proposal's own kind. Fails open on anything it cannot read,
   * like the replacement guard — a guard that refuses on a failed tool call is a guess.
   */
  async noOpImageRefusalFor(proposal: Proposal): Promise<string | null> {
    const namespace = proposal.toolParams.namespace;
    const kind = typeof proposal.toolParams.kind === "string" ? proposal.toolParams.kind : "deployment";
    const tool = LISTING_FOR_KIND[kind];
    if (typeof namespace !== "string" || !namespace || !tool) return null;
    try {
      const raw = await this.mcp.callTool(tool, { namespace });
      return noOpImageRefusal(proposal.action, proposal.toolParams, raw);
    } catch (err) {
      logger.debug(`[remediation] no-op guard could not list ${kind}s in ${namespace}: ${errDetail(err)}`);
      return null;
    }
  }

  async replacementRefusalFor(proposal: Proposal): Promise<string | null> {
    const namespace = proposal.toolParams.namespace;
    if (typeof namespace !== "string" || !namespace) return null;
    try {
      const raw = await this.mcp.callTool("k8s_list_pods", { namespace });
      return replacementRefusal(proposal.action, proposal.toolParams, parsePods(raw));
    } catch (err) {
      logger.debug(`[remediation] replacement guard could not list pods in ${namespace}: ${errDetail(err)}`);
      return null;
    }
  }

  // Auto-detect the GitOps overlay path for a HelmRelease from Flux's own config: HR CR →
  // the Kustomization that applied it (kustomize.toolkit.fluxcd.io labels) → its spec.path
  // (e.g. "apps/dev/applications"). Reuses the read-only k8s_get_custom_resources MCP tool.
  // Best-effort: undefined on any miss → the worker falls back to its GITOPS_PATH_PREFIX.
  private async resolveOverlayPath(hr: { name: string; namespace: string }): Promise<string | undefined> {
    try {
      const hrRes = await this.mcp.callTool("k8s_get_custom_resources", { ...FLUX_HELMRELEASE, namespace: hr.namespace, name: hr.name });
      if (hrRes.startsWith("Error:")) {
        logger.info(`[remediation] overlay auto-detect: can't read HelmRelease ${hr.namespace}/${hr.name} — ${truncate(hrRes, 200)} (needs RBAC get on helm.toolkit.fluxcd.io/helmreleases)`);
        return undefined;
      }
      const ksRef = kustomizeRefOf(JSON.parse(hrRes));
      if (!ksRef) {
        logger.info(`[remediation] overlay auto-detect: HelmRelease ${hr.namespace}/${hr.name} has no kustomize.toolkit.fluxcd.io labels`);
        return undefined;
      }
      const ksRes = await this.mcp.callTool("k8s_get_custom_resources", { ...FLUX_KUSTOMIZATION, namespace: ksRef.namespace, name: ksRef.name });
      if (ksRes.startsWith("Error:")) {
        logger.info(`[remediation] overlay auto-detect: can't read Kustomization ${ksRef.namespace}/${ksRef.name} — ${truncate(ksRes, 200)} (needs RBAC get on kustomize.toolkit.fluxcd.io/kustomizations)`);
        return undefined;
      }
      const prefix = fluxPathToPrefix(JSON.parse(ksRes));
      if (!prefix) {
        logger.info(`[remediation] overlay auto-detect: Kustomization ${ksRef.namespace}/${ksRef.name} has no usable spec.path`);
        return undefined;
      }
      logger.info(`[remediation] overlay path auto-detected: ${prefix} (via Flux Kustomization ${ksRef.namespace}/${ksRef.name})`);
      return prefix;
    } catch (err) {
      logger.info(`[remediation] overlay path auto-detect failed for ${hr.namespace}/${hr.name}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  // GitOps PR branch of proposeRemediation: ask the worker (over SQS) to prepare the PR
  // (dry_run → diff), then store a PR-flavored remediation so the approve path opens it.
  private async proposeGitOpsPr(
    incidentId: number | null,
    proposal: Proposal,
    preview: GitOpsPreview
    // gitOps is absent on the drift branch: that proposes a Flux reconcile, not a PR
  ): Promise<{ id: number; proposal: Proposal; dryRunSummary: string; gitOps?: { path: string; valuesKey: string; helmRelease: { name: string; namespace: string } } } | { refused: string } | null> {
    if (!this.gitops) {
      return { refused: `${preview.message} (GitOps PR remediation is not enabled on the agent — set GITOPS_REMEDIATION_ENABLED=true)` };
    }
    const pathPrefix = await this.resolveOverlayPath(preview.helmRelease);
    let payload;
    try {
      payload = await this.gitops.request({ op: "dry_run", helmRelease: preview.helmRelease, action: preview.action, container: preview.container, component: preview.component, changes: preview.changes, pathPrefix });
    } catch (err) {
      logger.error(`[remediation] gitops dry-run failed: ${err instanceof Error ? err.message : err}`);
      return { refused: `couldn't prepare the GitOps PR: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!payload.ok) {
      // Drift is a finding, not a refusal: the repo DOES declare this key, the cluster just
      // isn't running it. A PR would write a value nobody declared; the repo is the source
      // of truth, so propose restoring it instead.
      if (payload.drift) return this.proposeFluxReconcile(incidentId, proposal, preview, payload.drift);
      logger.info(`[remediation] gitops dry-run refused: ${payload.reason}`);
      return { refused: payload.reason };
    }
    if (payload.op !== "dry_run") return null; // defensive: worker returned the wrong op

    const summary = `open a GitOps PR — ${proposal.summary} (\`${payload.valuesKey}\` in \`${payload.path}\`)`;
    const id = await this.remediations.propose(incidentId, proposal.action, {
      gitops: true,
      helmRelease: preview.helmRelease,
      action: preview.action,
      container: preview.container,
      component: preview.component,
      changes: preview.changes,
      pathPrefix, // replay the same overlay scope on open_pr
      path: payload.path,
      valuesKey: payload.valuesKey,
      target: targetKey(proposal.action, proposal.namespace, proposal.name),
      reason: proposal.reason,
      summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] gitops not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }
    return { id, proposal: { ...proposal, summary }, dryRunSummary: payload.diff, gitOps: { path: payload.path, valuesKey: payload.valuesKey, helmRelease: preview.helmRelease } };
  }

  // Cluster drifted from Git (someone patched the cluster directly). Propose a Flux
  // reconcile: it restores what the repo declares instead of encoding the drifted value.
  // Same approval card as everything else — a human still decides, because the drifted
  // value is occasionally the intended one (in which case they want a PR, not a reconcile).
  private async proposeFluxReconcile(
    incidentId: number | null,
    proposal: Proposal,
    preview: GitOpsPreview,
    drift: GitOpsDrift
  ): Promise<{ id: number; proposal: Proposal; dryRunSummary: string } | { refused: string } | null> {
    const target = this.workloadOf(preview.workload);
    if (!target) return { refused: `cluster/GitOps drift detected but the workload reference \`${preview.workload}\` could not be parsed.` };
    // an older MCP server won't have the tool — say so instead of proposing a dead action
    if (!this.mcp.getTools().some((t) => t.name === "flux_reconcile")) {
      return {
        refused:
          `cluster/GitOps drift: \`${drift.valuesKey}\` is \`${drift.gitValue}\` in \`${drift.path}\` but the cluster runs ` +
          `\`${drift.clusterValue}\`. Run \`flux reconcile helmrelease ${preview.helmRelease.namespace}/${preview.helmRelease.name} --force\` ` +
          `to restore the declared state (the agent's flux_reconcile tool is not available on this MCP server).`,
      };
    }

    const toolParams = { namespace: target.namespace, name: target.name, kind: target.kind };
    const dryRun = await this.mcp.callTool("flux_reconcile", { ...toolParams, dry_run: true });
    if (dryRun.startsWith("Error:")) {
      logger.info(`[remediation] flux_reconcile dry-run refused: ${truncate(dryRun, 200)}`);
      return { refused: dryRun.replace(/^Error:\s*/, "") };
    }

    const summary =
      `Flux reconcile \`${preview.helmRelease.namespace}/${preview.helmRelease.name}\` — restore \`${drift.valuesKey}\` ` +
      `to \`${drift.gitValue}\` (cluster drifted to \`${drift.clusterValue}\`)`;
    logger.warn(
      `[remediation] cluster/GitOps drift on ${preview.workload}: ${drift.valuesKey} git=${drift.gitValue} ` +
      `cluster=${drift.clusterValue} (${drift.path}) — proposing flux_reconcile`
    );
    const id = await this.remediations.propose(incidentId, "flux_reconcile", {
      ...toolParams,
      target: targetKey("flux_reconcile", target.namespace, target.name),
      reason: `cluster drifted from the GitOps repo: ${drift.valuesKey} is ${drift.gitValue} in ${drift.path}, cluster is running ${drift.clusterValue}`,
      summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] flux_reconcile not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }
    return {
      id,
      proposal: { ...proposal, action: "flux_reconcile", namespace: target.namespace, name: target.name, toolParams, summary },
      dryRunSummary: truncate(dryRun, 400),
    };
  }

  // "deployment/ns/name" (the MCP preview's workload reference) → its parts.
  private workloadOf(ref: string): { kind: string; namespace: string; name: string } | null {
    const [kind, namespace, ...rest] = ref.split("/");
    if (!kind || !namespace || rest.length === 0) return null;
    return { kind, namespace, name: rest.join("/") };
  }

  // Approve path: atomically claim the row (double-click / multi-pod safe), execute the
  // whitelisted MCP tool, record the outcome. Returns the user-facing card text, plus the
  // target workload on success so the app can schedule a post-remediation status check.
  async executeRemediation(
    id: number,
    approvedBy: string
  ): Promise<{ text: string; target?: { namespace: string; name: string }; backup?: unknown }> {
    const claim = await this.remediations.claimForExecution(id, approvedBy);
    if (claim === null) return { text: "⚠️ Remediation not found (or the store is unavailable)." };
    if (claim === "expired") return { text: "⌛ This approval window (15 min) has passed — re-run the investigation for a fresh proposal." };
    if (claim === "taken") return { text: "⚠️ This remediation was already handled by another approver or process." };

    // GitOps PR remediations open a PR via the worker instead of patching the cluster
    if ((claim.params as { gitops?: boolean }).gitops) return this.executeGitOpsPr(id, approvedBy, claim.params);

    // stored params = tool input + display fields; strip the display fields before the call
    const { reason: _reason, summary, ...toolParams } = claim.params as Record<string, unknown> & { summary?: string };
    const label = typeof summary === "string" ? summary : claim.action;
    try {
      const result = await this.mcp.callTool(claim.action, toolParams);
      const ok = !result.startsWith("Error:");
      // BEFORE finish(): the backup is the undo for the one action that cannot be undone from
      // the cluster, so it is stored on the row that authorised it while we still hold the only
      // copy. `result` cannot carry it — finish() truncates that column to 2000 chars.
      const backup = ok && claim.action === "k8s_delete_orphan" ? backupFrom(result) : null;
      if (backup) await this.remediations.saveBackup(id, backup);
      await this.remediations.finish(id, ok, result);
      if (!ok) return { text: `❌ *Remediation failed* — ${label}:\n\`${truncate(result, 400)}\`` };
      // delete_pod targets a pod, not a workload — drop the random suffix so verification
      // matches the REPLACEMENT pod (same ReplicaSet hash / StatefulSet base)
      const targetName = String(toolParams.name ?? String(toolParams.pod ?? "").replace(/-[a-z0-9]+$/, ""));
      return {
        text: `✅ *Remediation executed* — ${label} (approved by <@${approvedBy}>)\n\`${truncate(result, 400)}\``,
        // No target for a delete: post-remediation verification measures pod readiness, and the
        // object this removed has no pods. Observed 2026-09-16 — a ConfigMap delete scheduled a
        // check that came back five minutes later with "inconclusive — 0/0 pods ready", which is
        // not an inconclusive result, it is a question that was never answerable. The GitOps PR
        // path already returns no target for the same reason one level along: nothing to look at.
        ...(claim.action === "k8s_delete_orphan"
          ? {}
          : { target: { namespace: String(toolParams.namespace ?? ""), name: targetName } }),
        // Handed back so the caller can post it into the thread. Two copies on purpose: this one
        // is the only one that survives losing the agent's Postgres, and it is the one a human
        // can act on at 3am without database access.
        ...(backup ? { backup } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.remediations.finish(id, false, msg);
      return { text: `❌ *Remediation failed* — ${label}: ${truncate(msg, 300)}` };
    }
  }

  // Approve path for a GitOps PR remediation: ask the worker to open the PR. Returns NO
  // target — nothing is live until the PR merges + Flux syncs, so there is nothing for the
  // post-remediation verification to look at (app/index.ts only schedules when target exists).
  private async executeGitOpsPr(id: number, approvedBy: string, params: Record<string, unknown>): Promise<{ text: string }> {
    const p = params as { helmRelease: { name: string; namespace: string }; action: string; container?: string; component?: string; changes: { field: string; from: string | number; to: string | number }[]; pathPrefix?: string; summary?: string };
    const label = typeof p.summary === "string" ? p.summary : "GitOps PR";
    if (!this.gitops) {
      await this.remediations.finish(id, false, "gitops client not available");
      return { text: `❌ *PR not opened* — ${label}: the GitOps PR client is not enabled on this agent.` };
    }
    try {
      const payload = await this.gitops.request({ op: "open_pr", helmRelease: p.helmRelease, action: p.action, container: p.container, component: p.component, changes: p.changes, pathPrefix: p.pathPrefix, incident: { summary: p.summary } });
      if (!payload.ok) {
        await this.remediations.finish(id, false, payload.reason);
        return { text: `❌ *PR not opened* — ${label}: ${truncate(payload.reason, 300)}` };
      }
      if (payload.op !== "open_pr") {
        await this.remediations.finish(id, false, "unexpected worker response");
        return { text: `❌ *PR not opened* — ${label}: unexpected worker response.` };
      }
      await this.remediations.finish(id, true, payload.prUrl);
      return { text: `✅ *GitOps PR opened* — ${label} (approved by <@${approvedBy}>)\n${payload.prUrl}\nReview & merge to apply — Flux syncs after merge; nothing changes on the cluster until then.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.remediations.finish(id, false, msg);
      return { text: `❌ *PR not opened* — ${label}: ${truncate(msg, 300)}` };
    }
  }

  // ---- Post-remediation verification (migrations/006, remediation/verify.ts) ----

  // Schedule the "did that fix it" check. The baseline snapshot is taken NOW, at approval
  // time, because "worse" has to mean the workload regressed while we waited — without a
  // before, the damage we were sent to fix reads as damage the remediation caused.
  // Best-effort by design: a workload we can't snapshot still gets a check (before = null,
  // which only costs the regression comparison), and a store failure never fails the click.
  async scheduleRemediationCheck(
    remediationId: number,
    channel: string,
    threadTs: string,
    target: { namespace: string; name: string }
  ): Promise<void> {
    if (!this.checks.enabled) return; // no Postgres → no durable schedule to keep
    const before = await this.podHealth(target).catch((err) => {
      logger.warn(`[remediation] baseline snapshot for ${target.namespace}/${target.name} failed: ${errDetail(err)}`);
      return null;
    });
    const delaySeconds = Math.round(config.remediation.verifyDelayMs / 1000);
    const stored = await this.checks.schedule(remediationId, channel, threadTs, target, before, delaySeconds);
    if (stored) logger.info(`[remediation] verification for ${remediationId} due in ${delaySeconds}s (${target.namespace}/${target.name})`);
  }

  // One poller pass: claim whatever is due, verify it, record the verdict, and hand back the
  // thread messages for the caller to post. Returns messages instead of posting them so the
  // Slack client stays in the app layer — this class owns Postgres and MCP, not chat.
  //
  // The verdict is recorded BEFORE its message goes out: at-most-once beats a crash between
  // two posts telling on-call twice that their fix failed.
  async runDueRemediationChecks(): Promise<Array<{ channel: string; threadTs: string; text: string }>> {
    const due = await this.checks.claimDue();
    const out: Array<{ channel: string; threadTs: string; text: string }> = [];

    for (const check of due) {
      if (maxAttemptsReached(check)) {
        const detail = `verification kept failing (${check.attempts} attempts) — the cluster or Alertmanager could not be read`;
        await this.checks.abandon(check.id, detail);
        out.push({ channel: check.channel, threadTs: check.threadTs, text: verdictMessage(check, "inconclusive", detail) });
        continue;
      }
      try {
        const { verdict, detail } = await this.verifyRemediation(check);
        await this.checks.complete(check.id, verdict, detail);
        logger.info(`[remediation] check ${check.id} (remediation ${check.remediationId}): ${verdict} — ${detail}`);
        out.push({ channel: check.channel, threadTs: check.threadTs, text: verdictMessage(check, verdict, detail) });
      } catch (err) {
        // Left claimed on purpose: the lease expires and the next pass retries it, which is
        // what makes a transient MCP outage a delay rather than a lost verdict.
        logger.warn(`[remediation] check ${check.id} failed, will retry after the lease: ${errDetail(err)}`);
      }
    }
    return out;
  }

  // Deterministic, no LLM call. Both signals are fetched together and each degrades on its
  // own — a Prometheus outage must not cost us the pod evidence, and vice versa.
  private async verifyRemediation(check: RemediationCheck): Promise<{ verdict: Verdict; detail: string }> {
    const [alert, after] = await Promise.all([
      check.alertname
        ? this.mcp
            .callTool("alertmanager_get_alerts", {})
            .then((raw) => alertState(raw, check.alertname, check.namespace))
            .catch((err) => {
              logger.warn(`[remediation] alert re-check for ${check.alertname} failed: ${errDetail(err)}`);
              return "unknown" as AlertState;
            })
        : Promise.resolve("none" as AlertState),
      this.podHealth(check.target).catch((err) => {
        logger.warn(`[remediation] pod re-check for ${check.target.namespace}/${check.target.name} failed: ${errDetail(err)}`);
        return null;
      }),
    ]);
    return decideVerdict(alert, check.before, after, { alertname: check.alertname });
  }

  private async podHealth(target: { namespace: string; name: string }): Promise<PodHealth | null> {
    const raw = await this.mcp.callTool("k8s_list_pods", { namespace: target.namespace });
    return summarizePods(raw, target.name);
  }

  async rejectRemediation(id: number, by: string): Promise<string> {
    const flipped = await this.remediations.reject(id, by);
    return flipped ? `🚫 Remediation rejected by <@${by}>. Nothing was executed.` : "⚠️ Already handled (or expired).";
  }

  // D. resolved-alert loop: mark the incident resolved, return its Slack thread (or null).
  async resolveIncident(labels: Record<string, string>): Promise<{ channel: string; threadTs: string } | null> {
    return this.incidents.markResolved(labels);
  }

  /**
   * The missed-resolved sweeper. Alertmanager's resolved webhook fires once and is acked
   * before it is processed, so a single failure (agent down, Slack down, pod killed mid-
   * handler) strands the incident as firing forever and — worse — never releases its dedup
   * claim, which suppresses the next real firing of the same alert for the claim's whole TTL.
   * This asks Alertmanager directly instead of waiting for a POST that is never resent.
   *
   * Returns what to post and which dedup claims to release; the Slack client stays in the app
   * layer, same as `runDueRemediationChecks`. Both run from the one poller.
   */
  async runIncidentReconcile(): Promise<ReconciledIncident[]> {
    const cfg = config.incidents.reconcile;
    if (!cfg.enabled) return [];

    const confirmMs = cfg.confirmSeconds * 1000;
    const candidates = await this.incidents.listUnresolved(cfg.minAgeSeconds, cfg.batchLimit);
    if (candidates.length === 0) return [];

    // One read for the whole batch. Any failure to read it ends the pass: absence from this
    // response is the entire recovery signal, so an unreadable response is not evidence that
    // anything recovered — it is no evidence at all.
    let raw: string;
    try {
      raw = await this.mcp.callTool("alertmanager_get_alerts", {});
    } catch (err) {
      logger.warn(
        `[reconcile] Alertmanager unreadable — ${candidates.length} unresolved incident(s) left untouched: ${errDetail(err)}`
      );
      return [];
    }
    if (!alertsReadable(raw)) {
      logger.warn(`[reconcile] Alertmanager response truncated or unparseable — pass skipped, ${candidates.length} candidate(s) untouched`);
      return [];
    }

    const confirming: number[] = [];
    const reset: number[] = [];
    const closing: UnresolvedIncident[] = [];
    for (const inc of candidates) {
      const state = alertState(raw, inc.alertname, inc.namespace);
      switch (decideReconcile(state, inc.clearedSeenAt, confirmMs)) {
        case "confirming":
          confirming.push(inc.id);
          break;
        case "reset":
          reset.push(inc.id);
          break;
        case "resolve":
          closing.push(inc);
          break;
      }
    }
    await this.incidents.noteClearedSeen(confirming);
    await this.incidents.resetClearedSeen(reset);
    if (confirming.length > 0) logger.info(`[reconcile] ${confirming.length} incident(s) seen cleared — confirming over ${cfg.confirmSeconds}s`);

    const out: ReconciledIncident[] = [];
    for (const inc of closing) {
      // Loses the race against another replica → no row back → that replica posts, not us.
      const row = await this.incidents.markResolvedById(inc.id, "reconciler");
      if (!row) continue;
      logger.info(
        `[reconcile] incident ${inc.id} (${row.alertname}${row.namespace ? ` in ${row.namespace}` : ""}) closed — ` +
        `not held by Alertmanager since ${inc.clearedSeenAt}; the resolved webhook never arrived`
      );
      out.push({
        channel: row.channel,
        threadTs: row.threadTs,
        groupLabels: row.groupLabels ?? fallbackLabels(row.alertname, row.namespace),
        text:
          `✅ *Alert resolved* — \`${row.alertname}\`${row.namespace ? ` in \`${row.namespace}\`` : ""}. ` +
          `Alertmanager has not been holding it since \`${inc.clearedSeenAt}\`; its resolved notification never reached me, ` +
          `so I reconciled this from Alertmanager's current state. ` +
          `Wrong? Mention me with \`reopen\` in this thread. ` +
          `If a manual fix did it, react :${config.slack.learnReaction}: on the message describing it (or mention me with \`learn\`) so I remember.`,
      });
    }
    return out;
  }

  /**
   * On-call's word overrides both the webhook and the sweeper: the engineer in the thread
   * knows things neither of them can see. Deterministic, no LLM call — a state correction is
   * the one message that must not be re-interpreted.
   *
   * Returns the reply plus, on a close, the dedup claim to release: leaving that claim held is
   * what would suppress the alert's next firing.
   */
  async setIncidentStatus(
    channel: string,
    threadTs: string,
    by: string,
    command: StatusCommand
  ): Promise<{ text: string; clearDedup?: Record<string, string> }> {
    const incidentId = await this.incidents.findIncidentByThread(channel, threadTs);
    if (incidentId === null) {
      return { text: "🤷 This thread isn't linked to a stored incident — I can only change the status of alert threads I investigated (and stored)." };
    }

    if (command === "reopen") {
      const row = await this.incidents.reopenById(incidentId, by);
      if (!row) return { text: "ℹ️ This incident is already open (firing) — nothing to reopen." };
      logger.info(`[status] incident ${incidentId} (${row.alertname}) reopened by ${by}`);
      return {
        text:
          `🚨 *Reopened* — \`${row.alertname}\` is marked firing again on <@${by}>'s call. ` +
          `Alertmanager may still consider it resolved, so the automatic sweeper will not close it again until it sees the alert clear twice on its own.`,
      };
    }

    const row = await this.incidents.markResolvedById(incidentId, by);
    if (!row) return { text: "ℹ️ This incident is already marked resolved." };
    logger.info(`[status] incident ${incidentId} (${row.alertname}) resolved by ${by}`);
    return {
      text:
        `✅ *Marked resolved* by <@${by}> — \`${row.alertname}\`${row.namespace ? ` in \`${row.namespace}\`` : ""}. ` +
        `The dedup claim is released, so the next firing of this alert gets a fresh investigation. ` +
        `Mention me with \`reopen\` if it comes back. ` +
        `If a manual fix did it, mention me with \`learn\` so I remember what worked.`,
      clearDedup: row.groupLabels ?? fallbackLabels(row.alertname, row.namespace),
    };
  }

  // E. reaction-learn needs to know silently whether a thread maps to a stored incident.
  async findIncidentForThread(channel: string, threadTs: string): Promise<number | null> {
    return this.incidents.findIncidentByThread(channel, threadTs);
  }

  // On-call feedback learning (`@agent learn`): map the thread to its incident, run one
  // structured-output extraction call over the transcript, store the human-confirmed
  // knowledge. Returns the user-facing result message for the thread.
  async learnFromThread(channel: string, threadTs: string, triggerUser: string, triggerTs: string, transcript: string): Promise<string> {
    const incidentId = await this.incidents.findIncidentByThread(channel, threadTs);
    if (incidentId === null) {
      return "🤷 This thread isn't linked to a stored incident — I can only learn from alert threads I investigated (and stored).";
    }

    const response = await this.llm.chat(
      [{ role: "user", content: buildExtractionPrompt(transcript) }],
      [],
      EXTRACTION_SYSTEM
    );
    this.recordUsage(threadTs, response);
    const extracted = parseFeedbackJson(this.extractText(response.content));
    if (!extracted) {
      return "🤷 I couldn't find a concrete conclusion in this thread yet. State the actual root cause / action taken in the thread, then mention me with `learn` again.";
    }

    const result = await this.incidents.storeFeedback(incidentId, {
      slackUser: triggerUser,
      triggerKey: triggerTs, // ts of the learn message — same trigger can never store twice
      rawExcerpt: transcript.slice(-2000), // provenance
      ...extracted,
    });
    if (result === "duplicate") return "📚 Already learned from this exact trigger.";
    if (result === "failed") return "⚠️ Failed to store the feedback — check the agent logs.";

    logger.info(`[learn] incident ${incidentId}: cause=${!!extracted.confirmed_root_cause} action=${!!extracted.action_taken} outcome=${extracted.outcome}`);
    return [
      "📚 *Learned* — I'll recall this on future similar incidents:",
      `• Root cause: ${extracted.confirmed_root_cause ?? "_not stated_"}`,
      `• Action taken: ${extracted.action_taken ?? "_not stated_"}`,
      `• Outcome: \`${extracted.outcome}\``,
      "_Got it wrong? Correct it in the thread and mention me with `learn` again._",
    ].join("\n");
  }

  // Format backstop for conversation-mode mentions: one tool-less LLM call that rewrites
  // an RCA-shaped reply into a plain conversational answer. Deliberately uses a minimal
  // system prompt — the full one is what primes the RCA structure we're removing.
  async reformatToConversation(text: string): Promise<string> {
    return withRoute("light", async () => {
      const response = await this.llm.chat(
        [
          {
            role: "user",
            content:
              "Rewrite this as a short conversational Slack answer (mrkdwn), at most ~10 short lines. Keep the facts and any log excerpts. " +
              "Remove the incident/RCA structure entirely (severity, root cause, evidence, ruled out, recommended actions/plans, risks, impact, confidence). " +
              "Remove kubectl/helm command instructions entirely — execution happens via the approval card, never via the user's terminal. " +
              'Remove any "do you want me to proceed" style closing question — if a change was requested, an approval card or a refusal follows this message automatically. ' +
              "End with at most one short offer to investigate if something looked genuinely wrong.\n\n---\n\n" +
              text,
          },
        ],
        [],
        "You reformat DevOps chatbot replies for Slack. Output only the rewritten reply in Slack mrkdwn."
      );
      this.recordUsage(null, response); // no Slack thread parameter at this call site — never invent one
      const out = this.extractText(response.content);
      return out || text;
    });
  }

  // Remediation lifecycle events (card posted / refused / executed) happen OUTSIDE the
  // LLM conversation — append them to thread memory so follow-ups stay coherent (the
  // model once promised "I'll open an approval card" right after the server refused one,
  // because it never saw the refusal).
  async noteInThread(threadId: string, note: string): Promise<void> {
    await this.memory.append(threadId, { role: "assistant", content: `[system note] ${note}` }).catch(() => {});
  }

  async markRcaSent(threadId: string): Promise<void> {
    await this.memory.markRcaSent(threadId);
  }

  async clearThread(threadId: string): Promise<void> {
    await this.memory.clear(threadId);
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
    await this.llm.shutdown?.();
    await this.gitops?.shutdown();
    await this.incidents.close();
  }
}
