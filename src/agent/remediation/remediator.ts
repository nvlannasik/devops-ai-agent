import { type McpTools } from "../mcp/types.js";
import { ConversationMemory } from "../memory/index.js";
import { IncidentMemory } from "../incidents/index.js";
import { observedText } from "../grounding/index.js";
import { extractSection } from "../../utils/slack/blocks.js";
import { RemediationStore } from "./index.js";
import { proposeWithRetry, PROPOSAL_SYSTEM, type Proposal, type Refusal } from "./proposal.js";
import { rollbackRefusal, staleRollbackRefusal, specChangesOf, rollbackDryRunSummary, rolloutFromRevision } from "./rollback-gate.js";
import { parsePods, replacementRefusal, healthyTargetRefusal, rbacRestartRefusal, REPLACEMENT_ACTIONS } from "./replace-guard.js";
import { noOpImageRefusal, noOpResourcesRefusal, oomShrinkRefusal, wrongKindRefusal, holdsWorkload, LISTING_FOR_KIND, WORKLOAD_ACTIONS } from "./noop-guard.js";
import { RemediationCheckStore, summarizePods, alertState, decideVerdict, verdictMessage, maxAttemptsReached, type AlertState, type PodHealth, type RemediationCheck, type Verdict, applyState, expectFromChanges, expectFromRevert, AWAIT_POLL_SECONDS, AWAIT_APPLY_SECONDS, type ApplyExpectation } from "./verify.js";
import { SqsGitOpsClient } from "../gitops/sqs.js";
import { parseGitOpsPreview, type GitOpsPreview } from "../gitops/preview.js";
import { pickRevertCommit } from "../gitops/revert.js";
import { type GitOpsDrift } from "../gitops/types.js";
import { FLUX_HELMRELEASE, FLUX_KUSTOMIZATION, kustomizeRefOf, fluxPathToPrefix } from "../gitops/overlay.js";
import { type ChangeTimeline } from "../changes/index.js";
import { config } from "../../config/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { type LLMClient, type LLMResponse, type Message } from "../llm/types.js";
import logger from "../../utils/logger/index.js";
import { errDetail } from "../../utils/logger/index.js";
import { currentTrace, withRoute, withTrace } from "../../utils/trace/index.js";
import { TraceRecorder, refusalGate } from "../trace/index.js";
import { TraceStore } from "../trace/store.js";
import { quarantineRefusal, orphanDeleteRefusal, ungroundedTargetRefusal, resourceFaultRefusal, offerMismatchRefusal, targetKey, scaleOutRefusal, unseenImageRefusal, backupFrom } from "./evidence-refusals.js";
import { extractText } from "../loop/control.js";

/**
 * What the remediator reads off the agent. Getters, not values: `initialize()` swaps the stores
 * and the trace recorder after construction, and the remediator must see the swapped ones.
 */
export interface RemediatorHost {
  readonly mcp: McpTools;
  readonly llm: LLMClient;
  readonly remediations: RemediationStore;
  readonly checks: RemediationCheckStore;
  readonly gitops: SqsGitOpsClient | null;
  readonly memory: ConversationMemory;
  readonly incidents: IncidentMemory;
  trace(): TraceRecorder;
  traceStore(): TraceStore;
  timelineFor(threadId?: string): Promise<ChangeTimeline | null>;
  recordUsage(threadTs: string | null, response: LLMResponse): void;
}

/** The guarded-remediation half of the agent (housekeeping 2026-10-20: out of agent/index.ts). */
export class Remediator {
  constructor(private readonly host: RemediatorHost) {}

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
    opts: { userRequested?: boolean; threadId?: string; offer?: string | null } = {}
  ): ReturnType<Remediator["proposeRemediationRun"]> {
    // A run of its own under the thread, phase "proposal": the proposal's LLM call, its guard
    // reads, the dry-run and every refusal land in one trace beside the RCA's.
    const thread = opts.threadId ?? currentTrace();
    if (!thread) return this.proposeRemediationRun(incidentId, labels, rca, opts);
    this.host.trace().begin(thread, {
      phase: "proposal",
      issue: rca,
      opts: { userRequested: !!opts.userRequested, offer: opts.offer ?? null },
      labels,
      tools: this.host.mcp.getTools(),
    });
    try {
      const out = await withTrace(thread, () => this.proposeRemediationRun(incidentId, labels, rca, opts));
      this.host.trace().end(thread, {
        answer: out === null ? null : "refused" in out ? { refused: out.refused } : { action: out.proposal.action, summary: out.proposal.summary },
      });
      return out;
    } finally {
      await this.host.trace().finish(thread);
    }
  }

  private async proposeRemediationRun(
    incidentId: number | null,
    labels: Record<string, string>,
    rca: string,
    opts: { userRequested?: boolean; threadId?: string; offer?: string | null } = {}
  ): Promise<
    | { id: number; proposal: Proposal; dryRunSummary: string; gitOps?: { path: string; valuesKey: string; helmRelease: { name: string; namespace: string } } }
    | { refused: string }
    | null
  > {
    // write tools present at all? (server-side flag off = never propose)
    if (!this.host.mcp.getTools().some((t) => t.description.startsWith("[WRITE]"))) return null;

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
    // Every gate that can refuse a proposal lives in refusalFor — ONE chain, shared with the
    // benchmark — and it runs inside proposeWithRetry, so a refusal gets one re-ask carrying its
    // reason instead of ending the incident's only chance at a card. See refusalNotice.
    const ctx = { userRequested: opts.userRequested, threadId: opts.threadId, offer: opts.offer ?? null, labels, rca };
    const { proposal, raw, refused } = await proposeWithRetry(
      labels,
      rca,
      async (prompt) => {
        const response = await withRoute("light", () => this.host.llm.chat([{ role: "user", content: prompt }], [], PROPOSAL_SYSTEM));
        this.host.recordUsage(null, response); // no Slack thread at this call site — never invent one
        return extractText(response.content);
      },
      async (p) => {
        const r = await this.refusalFor(p, ctx);
        if (r) {
          logger.info(`[remediation] ${r.gate} refused ${p.summary}: ${r.reason}`);
          this.host.trace().gate(opts.threadId ?? currentTrace() ?? "", refusalGate(r.gate), "refused", r.reason);
        }
        return r;
      }
    );
    if (!proposal) {
      // A refusal the re-ask could not get past: the model DID want to act, and the human
      // deserves to know why there is no card.
      if (refused) return { refused };
      logger.info(`[remediation] no actionable proposal from model: ${truncate(raw, 200)}`);
      return null;
    }
    if (raw.includes("\n[re-ask] ")) logger.info(`[remediation] refusal re-asked; the model revised to ${proposal.summary}`);
    // the specific proposed action must actually be registered on the server
    if (!this.host.mcp.getTools().some((t) => t.name === proposal.action)) {
      logger.info(`[remediation] proposed action ${proposal.action} is not registered on the MCP server`);
      return null;
    }

    // One pending card per action+target, across incidents — see RemediationStore.pendingFor.
    // Not in refusalFor: it is a fact about the store, and no re-ask can change it.
    const pending = await this.host.remediations.pendingFor(targetKey(proposal.action, proposal.namespace, proposal.name)).catch(() => null);
    if (pending !== null) {
      logger.info(`[remediation] duplicate of pending card ${pending}: ${proposal.summary}`);
      return { refused: `An approval card for this exact action on \`${proposal.namespace}/${proposal.name}\` is already waiting (remediation ${pending}). Approve or reject that one — a second card is the same decision twice.` };
    }

    // Mandatory dry-run before any card — validates the target AND exercises the MCP
    // server's namespace guardrails with zero side effects.
    const dryRun = await this.host.mcp.callTool(proposal.action, { ...proposal.toolParams, dry_run: true });
    if (dryRun.startsWith("Error:")) {
      logger.info(`[remediation] dry-run refused for ${proposal.summary}: ${truncate(dryRun, 200)}`);
      this.host.trace().gate(opts.threadId ?? currentTrace() ?? "", "dry-run", "failed", truncate(dryRun, 300));
      return { refused: dryRun.replace(/^Error:\s*/, "") };
    }

    // The gate chain is tool-free and reasons only from the timeline collected before the
    // investigation started — a "roll it back" mention hours later can find the Deployment has
    // moved past it (a fix-forward, someone else's rollout). The dry-run's own `fromRevision` is
    // the one piece of LIVE evidence in this flow, so this runs AFTER it succeeds, never inside
    // refusalFor. See rollback-gate.ts.
    if (proposal.action === "k8s_rollout_undo") {
      const stale = staleRollbackRefusal(proposal, await this.host.timelineFor(opts.threadId), dryRun);
      if (stale) {
        logger.info(`[remediation] rollback refused for ${proposal.summary}: ${truncate(stale, 200)}`);
        this.host.trace().gate(opts.threadId ?? currentTrace() ?? "", "remediation-rollback", "refused", stale);
        return { refused: stale };
      }
    }

    // Flux HelmRelease-managed workloads return a structured PR preview (not a direct-patch
    // validation) — route to the GitOps PR flow instead of storing a direct-patch card.
    const preview = parseGitOpsPreview(dryRun);
    if (preview) return preview.action === "rollback" ? this.proposeRevertPr(incidentId, proposal, preview, opts.threadId) : this.proposeGitOpsPr(incidentId, proposal, preview);

    // A rollback replays the live revision the dry-run saw as `from_revision`: the MCP patch
    // tests it first, so an approve after the Deployment moved fails instead of undoing a
    // revision the approver never saw. Fail closed if the dry-run did not say.
    const rollbackFrom = proposal.action === "k8s_rollout_undo" ? rolloutFromRevision(dryRun) : undefined;
    if (proposal.action === "k8s_rollout_undo" && rollbackFrom === undefined) {
      return { refused: `the rollback dry-run for \`${proposal.namespace}/${proposal.name}\` did not report the live revision, so the approval cannot be pinned to it — re-investigate` };
    }

    // store the exact tool params + display fields — execution replays params verbatim
    const id = await this.host.remediations.propose(incidentId, proposal.action, {
      ...proposal.toolParams,
      ...(rollbackFrom !== undefined ? { from_revision: rollbackFrom } : {}),
      target: targetKey(proposal.action, proposal.namespace, proposal.name),
      reason: proposal.reason,
      summary: proposal.summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }

    return { id, proposal, dryRunSummary: proposal.action === "k8s_rollout_undo" ? rollbackDryRunSummary(dryRun) : truncate(dryRun, 400) };
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
   * Every gate that can refuse a proposal before the dry-run, in production's order — ONE chain,
   * called by proposeRemediation and by the benchmark alike.
   *
   * The benchmark used to rebuild this chain from the individual gates, and it had drifted exactly
   * the way its own comment warned: no quarantine gate, no orphan gate, and neither user-request
   * exemption — so it could score a card production would never post, and refuse one it would.
   * The duplicate-card check and the dry-run stay in proposeRemediation: one is a fact about the
   * store, the other about the live cluster, and a re-ask can change neither.
   *
   * The gate names are the words the log has always used ("[remediation] <gate> refused …"), so a
   * grep written before this function existed still finds every refusal.
   */
  async refusalFor(
    proposal: Proposal,
    ctx: { userRequested?: boolean; threadId?: string; offer: string | null; labels: Record<string, string>; rca: string }
  ): Promise<Refusal | null> {
    // The replacement guard, before the dry-run: a restart or a delete against a fault that
    // lives in the spec is a change the MCP server will happily validate, because there is
    // nothing wrong with it as an operation — it just cannot work. See replace-guard.ts for why
    // this is code and not another paragraph in the prompt.
    //
    // Skipped when the human asked for the action in words. The guard exists to stop the MODEL
    // reaching for a gesture when it cannot place a fault; a person who types "restart the
    // payments deployment" has placed it themselves and may know something the pod list does not
    // show. Their request is already sufficient evidence per buildProposalPrompt.
    // First, and for a user's request too: every check below that reads the spec reads it by kind,
    // and a wrong kind makes each of them fail open (bench B04). See wrongKindRefusal.
    const wrongKind = await this.kindRefusalFor(proposal);
    if (wrongKind) return { gate: "kind gate", reason: wrongKind };

    const evidence = await this.threadEvidence(ctx.threadId);
    if (!ctx.userRequested) {
      // What may name the target as the fault: the Root Cause (never the Immediate line — that is
      // where the reflex restart is written) and the alert's labels. Whole text when no section.
      // Labels as key=value, so `service=api` reads as the Service, never as the Deployment `api`.
      const mentions = `${extractSection(ctx.rca, "Root Cause") || ctx.rca}\n${Object.entries(ctx.labels).map(([k, v]) => `${k}=${v}`).join(" ")}`;
      const replaced = (await this.guardRefusalFor(proposal, mentions, evidence)) ?? rbacRestartRefusal(proposal.action, proposal.toolParams, evidence);
      if (replaced) return { gate: "replacement guard", reason: replaced };
    }

    // The quarantine gate, and unlike the replacement guard it is NOT skipped for a user
    // request. "Delete the unused mongodb endpoint" is exactly the sentence that produces a
    // quarantine proposal, and the user saying it is not evidence that the workload is idle —
    // they are asking BECAUSE they are unsure. Measurement is the only thing that settles it,
    // and this is where we insist on having done it.
    const idle = await this.quarantineRefusalFor(proposal, ctx.threadId);
    if (idle) return { gate: "quarantine gate", reason: idle };

    // Same rule, same reason, for the one action that cannot be undone from the cluster.
    const orphan = await this.orphanRefusalFor(proposal, ctx.threadId);
    if (orphan) return { gate: "orphan gate", reason: orphan };

    // A rollback needs the change it undoes ON RECORD — see rollback-gate.ts. Not skipped for a
    // user request: "roll it back" names an intent, not a revision.
    if (proposal.action === "k8s_rollout_undo") {
      const rollback = rollbackRefusal(proposal, await this.host.timelineFor(ctx.threadId));
      if (rollback) return { gate: "rollback gate", reason: rollback };
    }

    // The offer is what the human answered "yes" to — see offerMismatchRefusal.
    const wrongTarget = offerMismatchRefusal(proposal, ctx.offer);
    if (wrongTarget) return { gate: "offer gate", reason: wrongTarget };

    // A target nothing in the run ever saw is an invented one — see ungroundedTargetRefusal.
    const target = ungroundedTargetRefusal(proposal, evidence, ctx.labels);
    if (target) return { gate: "target gate", reason: target };

    // A resize needs a fault a resize can fix — see resourceFaultRefusal. It lived only in the
    // bench's half of the chain and was lost when the two were merged; A01 re-proposed a resize
    // for a missing ConfigMap key on 2026-09-28. Skipped for a user request, like the replacement guard.
    if (!ctx.userRequested) {
      const size = resourceFaultRefusal(proposal, evidence);
      if (size) return { gate: "resource-fault gate", reason: size };
    }

    // Replicas need a measurement of their own. Skipped for a user request, like the replacement
    // guard: a person who asks for more replicas has placed the need themselves.
    if (!ctx.userRequested) {
      const scale = await this.scaleRefusalFor(proposal, ctx.threadId);
      if (scale) return { gate: "scale gate", reason: scale };
    }

    // And for images: never a card for an image nothing in the thread showed. Not skipped for a
    // user request either — a person who names the image satisfies it in their own words.
    const image = await this.imageRefusalFor(proposal, ctx.threadId, ctx.rca);
    if (image) return { gate: "image gate", reason: image };

    return null;
  }

  /**
   * Public because `bench/run.ts` applies it too — and it did not, which is how C08 came to be
   * scored on a proposal production would have refused. The benchmark's chain is meant to end
   * where a human would either see a card or not; a guard missing from it makes the measurement
   * kinder than the system it measures.
   */
  async scaleRefusalFor(proposal: Proposal, threadId: string | undefined): Promise<string | null> {
    return scaleOutRefusal(proposal, await this.threadEvidence(threadId));
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
    return observedText(await this.host.memory.get(threadId).catch(() => [] as Message[]));
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
  async guardRefusalFor(proposal: Proposal, mentions = "", evidence: string | null = null): Promise<string | null> {
    if (REPLACEMENT_ACTIONS.has(proposal.action)) return this.replacementRefusalFor(proposal, mentions);
    if (proposal.action === "k8s_set_image") return this.noOpImageRefusalFor(proposal);
    if (proposal.action === "k8s_set_resources") return this.noOpResourcesRefusalFor(proposal, evidence);
    return null;
  }

  /**
   * Is this resources change proposing the numbers already configured? See `noop-guard.ts`.
   *
   * One `k8s_recommend_resources` call, narrowed to the workload. A read tool on purpose — the
   * benchmark applies `guardRefusalFor` and never runs the write path, so a guard that needed the
   * dry-run's `previousResources` would be invisible to the measurement that found this.
   */
  /** `evidence`: the thread's tool output, for the OOMKill half (oomShrinkRefusal). */
  async noOpResourcesRefusalFor(proposal: Proposal, evidence: string | null = null): Promise<string | null> {
    const namespace = proposal.toolParams.namespace;
    if (typeof namespace !== "string" || !namespace) return null;
    try {
      const raw = await this.host.mcp.callTool("k8s_recommend_resources", { namespace, workload: proposal.name });
      return noOpResourcesRefusal(proposal.action, proposal.toolParams, raw) ?? oomShrinkRefusal(proposal.action, proposal.toolParams, raw, evidence);
    } catch (err) {
      logger.debug(`[remediation] no-op resources guard could not read ${namespace}/${proposal.name}: ${errDetail(err)}`);
      return null;
    }
  }

  /**
   * Is this image change writing back the image already in the spec? See `noop-guard.ts`.
   *
   * One listing call, chosen by the proposal's own kind. Fails open on anything it cannot read,
   * like the replacement guard — a guard that refuses on a failed tool call is a guess.
   */
  /**
   * The workload listings `wrongKindRefusal` judges from. The proposed kind's listing first, and in
   * the common case only that one — the name is there, and it is the read the no-op gate makes
   * anyway, so a recorded run replays unchanged. The other kinds only when it is not.
   * A failed call is an unreadable listing, which refuses nothing.
   */
  async kindRefusalFor(proposal: Proposal): Promise<string | null> {
    if (!WORKLOAD_ACTIONS.has(proposal.action)) return null;
    const { namespace, name } = proposal.toolParams;
    if (typeof namespace !== "string" || !namespace || typeof name !== "string" || !name) return null;
    const kind = typeof proposal.toolParams.kind === "string" ? proposal.toolParams.kind : "deployment";
    if (!LISTING_FOR_KIND[kind]) return null;
    const list = (k: string) =>
      this.host.mcp.callTool(LISTING_FOR_KIND[k]!, { namespace }).catch((err) => {
        logger.debug(`[remediation] kind gate could not list ${k}s in ${namespace}: ${errDetail(err)}`);
        return "";
      });
    const listings: Record<string, string> = { [kind]: await list(kind) };
    if (holdsWorkload(listings[kind]!, name) !== false) return null;
    for (const k of Object.keys(LISTING_FOR_KIND)) if (k !== kind) listings[k] = await list(k);
    return wrongKindRefusal(proposal.action, proposal.toolParams, listings);
  }

  async noOpImageRefusalFor(proposal: Proposal): Promise<string | null> {
    const namespace = proposal.toolParams.namespace;
    const kind = typeof proposal.toolParams.kind === "string" ? proposal.toolParams.kind : "deployment";
    const tool = LISTING_FOR_KIND[kind];
    if (typeof namespace !== "string" || !namespace || !tool) return null;
    try {
      const raw = await this.host.mcp.callTool(tool, { namespace });
      return noOpImageRefusal(proposal.action, proposal.toolParams, raw);
    } catch (err) {
      logger.debug(`[remediation] no-op guard could not list ${kind}s in ${namespace}: ${errDetail(err)}`);
      return null;
    }
  }

  /** `mentions`: the text that may name the target as the fault — see healthyTargetRefusal. */
  async replacementRefusalFor(proposal: Proposal, mentions = ""): Promise<string | null> {
    const namespace = proposal.toolParams.namespace;
    if (typeof namespace !== "string" || !namespace) return null;
    try {
      const raw = await this.host.mcp.callTool("k8s_list_pods", { namespace });
      const pods = parsePods(raw);
      return (
        replacementRefusal(proposal.action, proposal.toolParams, pods) ??
        healthyTargetRefusal(proposal.action, proposal.toolParams, pods, mentions)
      );
    } catch (err) {
      logger.debug(`[remediation] replacement guard could not list pods in ${namespace}: ${errDetail(err)}`);
      return null;
    }
  }

  // Auto-detect the GitOps overlay path for a HelmRelease from Flux's own config: HR CR →
  // the Kustomization that applied it (kustomize.toolkit.fluxcd.io labels) → its spec.path
  // (e.g. "apps/dev/applications"). Reuses the read-only k8s_get_custom_resources MCP tool.
  // Best-effort: undefined on any miss → the worker falls back to its GITOPS_PATH_PREFIX.
  async resolveOverlayPath(hr: { name: string; namespace: string }): Promise<string | undefined> {
    try {
      const hrRes = await this.host.mcp.callTool("k8s_get_custom_resources", { ...FLUX_HELMRELEASE, namespace: hr.namespace, name: hr.name });
      if (hrRes.startsWith("Error:")) {
        logger.info(`[remediation] overlay auto-detect: can't read HelmRelease ${hr.namespace}/${hr.name} — ${truncate(hrRes, 200)} (needs RBAC get on helm.toolkit.fluxcd.io/helmreleases)`);
        return undefined;
      }
      const ksRef = kustomizeRefOf(JSON.parse(hrRes));
      if (!ksRef) {
        logger.info(`[remediation] overlay auto-detect: HelmRelease ${hr.namespace}/${hr.name} has no kustomize.toolkit.fluxcd.io labels`);
        return undefined;
      }
      const ksRes = await this.host.mcp.callTool("k8s_get_custom_resources", { ...FLUX_KUSTOMIZATION, namespace: ksRef.namespace, name: ksRef.name });
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
    if (!this.host.gitops) {
      return { refused: `${preview.message} (GitOps PR remediation is not enabled on the agent — set GITOPS_REMEDIATION_ENABLED=true)` };
    }
    const pathPrefix = await this.resolveOverlayPath(preview.helmRelease);
    let payload;
    try {
      payload = await this.host.gitops.request({ op: "dry_run", helmRelease: preview.helmRelease, action: preview.action, container: preview.container, component: preview.component, changes: preview.changes, pathPrefix });
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
    const id = await this.host.remediations.propose(incidentId, proposal.action, {
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
      workload: preview.workload, // kind/namespace/name: what the apply-watch reads once the PR is open
      reason: proposal.reason,
      summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] gitops not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }
    return { id, proposal: { ...proposal, summary }, dryRunSummary: payload.diff, gitOps: { path: payload.path, valuesKey: payload.valuesKey, helmRelease: preview.helmRelease } };
  }

  // A rollback on a Flux-managed Deployment: the cluster patch would be reverted by Flux, so the
  // undo is a revert PR of the commit the change timeline names (pickRevertCommit — never a sha
  // from the model). Dry-run first, so the card shows the diff and an unclean revert never posts.
  private async proposeRevertPr(
    incidentId: number | null,
    proposal: Proposal,
    preview: GitOpsPreview,
    threadId?: string
  ): Promise<{ id: number; proposal: Proposal; dryRunSummary: string; gitOps?: { path: string; valuesKey: string; helmRelease: { name: string; namespace: string } } } | { refused: string } | null> {
    if (!this.host.gitops) return { refused: `${preview.message} (GitOps PR remediation is not enabled on the agent — set GITOPS_REMEDIATION_ENABLED=true)` };
    // The commit behind the broken rollout landed BEFORE it. A newer commit to the same release
    // means the repo moved on since — reverting either one is a guess, so refuse.
    const timeline = await this.host.timelineFor(threadId);
    const broke = timeline ? specChangesOf(timeline, proposal.name)[0] : undefined;
    const newer = broke && (timeline?.commits ?? []).find((c) => c.helmRelease === preview.helmRelease.name && Date.parse(c.at) > Date.parse(broke.at));
    if (broke && newer) {
      return {
        refused: `the GitOps repo moved past the rollout that broke \`${proposal.namespace}/${proposal.name}\` (commit ${newer.sha.slice(0, 7)} at ${newer.at} is newer than revision ${broke.revision}) — re-investigate before reverting`,
      };
    }
    const commit = broke ? pickRevertCommit(timeline, preview.helmRelease.name, broke.at) : null;
    if (!commit) {
      return {
        refused: `\`${proposal.namespace}/${proposal.name}\` is managed by Flux HelmRelease \`${preview.helmRelease.name}\`, and the change timeline holds no Git commit for it — there is nothing to revert. If its values changed with no commit, the cluster drifted from Git; reconcile instead.`,
      };
    }
    const pathPrefix = await this.resolveOverlayPath(preview.helmRelease);
    let payload;
    try {
      payload = await this.host.gitops.request({ op: "revert_pr", helmRelease: preview.helmRelease, sha: commit.sha, pathPrefix, dryRun: true });
    } catch (err) {
      return { refused: `couldn't prepare the revert PR: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!payload.ok) {
      logger.info(`[remediation] revert_pr dry-run refused: ${payload.reason}`);
      return { refused: payload.reason };
    }
    if (payload.op !== "revert_pr" || !payload.dryRun) return null; // defensive: wrong op from the worker
    const summary = `open a revert PR for \`${commit.sha.slice(0, 7)}\` ${commit.message} (\`${payload.paths.join("`, `")}\`) — undoes the change behind ${proposal.summary}`;
    const id = await this.host.remediations.propose(incidentId, proposal.action, {
      gitops: true,
      revert: true,
      helmRelease: preview.helmRelease,
      sha: commit.sha,
      pathPrefix,
      target: targetKey(proposal.action, proposal.namespace, proposal.name),
      // What the workload runs again once the revert is applied: the broken rollout's diff, at
      // its `from` side — known only now, from the timeline, so stored with the card.
      ...(expectFromRevert(broke?.diff) ? { applyExpect: expectFromRevert(broke?.diff) } : {}),
      reason: proposal.reason,
      summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] revert not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }
    return {
      id,
      proposal: { ...proposal, summary },
      dryRunSummary: payload.diff,
      gitOps: { path: payload.paths.join(", "), valuesKey: `revert ${commit.sha.slice(0, 7)}`, helmRelease: preview.helmRelease },
    };
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
    if (!this.host.mcp.getTools().some((t) => t.name === "flux_reconcile")) {
      return {
        refused:
          `cluster/GitOps drift: \`${drift.valuesKey}\` is \`${drift.gitValue}\` in \`${drift.path}\` but the cluster runs ` +
          `\`${drift.clusterValue}\`. Run \`flux reconcile helmrelease ${preview.helmRelease.namespace}/${preview.helmRelease.name} --force\` ` +
          `to restore the declared state (the agent's flux_reconcile tool is not available on this MCP server).`,
      };
    }

    const toolParams = { namespace: target.namespace, name: target.name, kind: target.kind };
    const dryRun = await this.host.mcp.callTool("flux_reconcile", { ...toolParams, dry_run: true });
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
    const id = await this.host.remediations.propose(incidentId, "flux_reconcile", {
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
  ): Promise<{ text: string; target?: { namespace: string; name: string }; backup?: unknown; awaitApply?: AwaitApply }> {
    const claim = await this.host.remediations.claimForExecution(id, approvedBy);
    if (claim === null) return { text: "⚠️ Remediation not found (or the store is unavailable)." };
    if (claim === "expired") return { text: "⌛ This approval window (15 min) has passed — re-run the investigation for a fresh proposal." };
    if (claim === "taken") return { text: "⚠️ This remediation was already handled by another approver or process." };

    // GitOps PR remediations open a PR via the worker instead of patching the cluster
    if ((claim.params as { gitops?: boolean }).gitops) return this.executeGitOpsPr(id, approvedBy, claim.params);

    // stored params = tool input + display fields; strip the display fields before the call
    const { reason: _reason, summary, ...toolParams } = claim.params as Record<string, unknown> & { summary?: string };
    const label = typeof summary === "string" ? summary : claim.action;
    try {
      const result = await this.host.mcp.callTool(claim.action, toolParams);
      const ok = !result.startsWith("Error:");
      // BEFORE finish(): the backup is the undo for the one action that cannot be undone from
      // the cluster, so it is stored on the row that authorised it while we still hold the only
      // copy. `result` cannot carry it — finish() truncates that column to 2000 chars.
      const backup = ok && claim.action === "k8s_delete_orphan" ? backupFrom(result) : null;
      if (backup) await this.host.remediations.saveBackup(id, backup);
      await this.host.remediations.finish(id, ok, result);
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
      await this.host.remediations.finish(id, false, msg);
      return { text: `❌ *Remediation failed* — ${label}: ${truncate(msg, 300)}` };
    }
  }

  // Approve path for a GitOps PR remediation: ask the worker to open the PR. Returns NO
  // target — nothing is live until the PR merges + Flux syncs, so there is nothing for the
  // post-remediation verification to look at (app/index.ts only schedules when target exists).
  private async executeGitOpsPr(id: number, approvedBy: string, params: Record<string, unknown>): Promise<{ text: string; awaitApply?: AwaitApply }> {
    const p = params as { helmRelease: { name: string; namespace: string }; action: string; container?: string; component?: string; changes: { field: string; from: string | number; to: string | number }[]; pathPrefix?: string; summary?: string };
    const label = typeof p.summary === "string" ? p.summary : "GitOps PR";
    if (!this.host.gitops) {
      await this.host.remediations.finish(id, false, "gitops client not available");
      return { text: `❌ *PR not opened* — ${label}: the GitOps PR client is not enabled on this agent.` };
    }
    if ((params as { revert?: boolean }).revert) {
      const r = params as { helmRelease: { name: string; namespace: string }; sha: string; pathPrefix?: string; summary?: string };
      try {
        const payload = await this.host.gitops.request({ op: "revert_pr", helmRelease: r.helmRelease, sha: r.sha, pathPrefix: r.pathPrefix, dryRun: false, incident: { summary: r.summary } });
        if (!payload.ok || payload.op !== "revert_pr" || payload.dryRun) {
          const reason = payload.ok ? "unexpected worker response" : payload.reason;
          await this.host.remediations.finish(id, false, reason);
          return { text: `❌ *Revert PR not opened* — ${label}: ${truncate(reason, 300)}` };
        }
        await this.host.remediations.finish(id, true, payload.prUrl);
        const workload = targetOf(String((params as { target?: unknown }).target ?? ""));
        const expect = ((params as { applyExpect?: ApplyExpectation }).applyExpect ?? null);
        const awaitApply = workload && expect?.fields?.length ? { target: { namespace: workload.namespace, name: workload.name, kind: "Deployment" }, expect } : undefined;
        return {
          text: `✅ *Revert PR opened* — ${label} (approved by <@${approvedBy}>)\n${payload.prUrl}\nReview & merge to apply — Flux syncs after merge; nothing changes on the cluster until then.${awaitApply ? " Once it runs, I check whether it fixed the problem." : ""}`,
          ...(awaitApply ? { awaitApply } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.host.remediations.finish(id, false, msg);
        return { text: `❌ *Revert PR not opened* — ${label}: ${truncate(msg, 300)}` };
      }
    }
    try {
      const payload = await this.host.gitops.request({ op: "open_pr", helmRelease: p.helmRelease, action: p.action, container: p.container, component: p.component, changes: p.changes, pathPrefix: p.pathPrefix, incident: { summary: p.summary } });
      if (!payload.ok) {
        await this.host.remediations.finish(id, false, payload.reason);
        return { text: `❌ *PR not opened* — ${label}: ${truncate(payload.reason, 300)}` };
      }
      if (payload.op !== "open_pr") {
        await this.host.remediations.finish(id, false, "unexpected worker response");
        return { text: `❌ *PR not opened* — ${label}: unexpected worker response.` };
      }
      await this.host.remediations.finish(id, true, payload.prUrl);
      // Not verifiable yet — but it will be once Flux runs it: hand back what to watch for, and the
      // app schedules an awaiting check (scheduleAwaitingApply). The revert branch above does the
      // same from the broken rollout's diff, stored with its card.
      const workload = this.workloadOf(String(params.workload ?? "")) ?? targetOf(String(params.target ?? ""));
      const expect = expectFromChanges(p.changes ?? [], p.container);
      const awaitApply = workload && expect ? { target: { namespace: workload.namespace, name: workload.name, kind: kindName(workload.kind) }, expect } : undefined;
      return {
        text: `✅ *GitOps PR opened* — ${label} (approved by <@${approvedBy}>)\n${payload.prUrl}\nReview & merge to apply — Flux syncs after merge; nothing changes on the cluster until then.${awaitApply ? " Once it runs, I check whether it fixed the problem." : ""}`,
        ...(awaitApply ? { awaitApply } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.host.remediations.finish(id, false, msg);
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
    if (!this.host.checks.enabled) return; // no Postgres → no durable schedule to keep
    const before = await this.podHealth(target).catch((err) => {
      logger.warn(`[remediation] baseline snapshot for ${target.namespace}/${target.name} failed: ${errDetail(err)}`);
      return null;
    });
    const delaySeconds = Math.round(config.remediation.verifyDelayMs / 1000);
    const stored = await this.host.checks.schedule(remediationId, channel, threadTs, target, before, delaySeconds);
    if (stored) logger.info(`[remediation] verification for ${remediationId} due in ${delaySeconds}s (${target.namespace}/${target.name})`);
  }

  // A GitOps PR's check: watch the workload until it runs what the PR set (migrations/016).
  async scheduleAwaitingApply(remediationId: number, channel: string, threadTs: string, a: AwaitApply): Promise<void> {
    if (!this.host.checks.enabled) return;
    const stored = await this.host.checks.scheduleAwaiting(remediationId, channel, threadTs, a.target, a.expect, AWAIT_POLL_SECONDS, AWAIT_APPLY_SECONDS);
    if (stored) logger.info(`[remediation] GitOps PR ${remediationId}: watching ${a.target.namespace}/${a.target.name} for ${describeExpect(a.expect)}`);
  }

  // One awaiting check, once: applied → baseline + the ordinary verification; past apply_by →
  // expired, said once, no verdict; anything else (not merged, or unreadable) → look again later.
  private async pollAwaitingApply(check: RemediationCheck): Promise<{ channel: string; threadTs: string; text: string } | null> {
    const where = `\`${check.target.namespace}/${check.target.name}\``;
    const kind = check.target.kind ?? "Deployment";
    const raw = await this.host.mcp
      .callTool("k8s_get_resource", { api_version: "apps/v1", kind, namespace: check.target.namespace, name: check.target.name })
      .catch((err) => {
        logger.warn(`[remediation] apply-watch read of ${check.target.namespace}/${check.target.name} failed: ${errDetail(err)}`);
        return "";
      });
    const state = check.expect ? applyState(check.expect, raw) : "unknown";
    if (state === "applied") {
      const before = await this.podHealth(check.target).catch(() => null);
      const delaySeconds = Math.round(config.remediation.verifyDelayMs / 1000);
      await this.host.checks.markApplied(check.id, before, delaySeconds);
      logger.info(`[remediation] GitOps PR ${check.remediationId} applied on ${check.target.namespace}/${check.target.name} — verification due in ${delaySeconds}s`);
      return {
        channel: check.channel,
        threadTs: check.threadTs,
        text: `🔄 *GitOps change applied* · ${where} now runs ${describeExpect(check.expect!)} — checking in ${Math.max(1, Math.round(delaySeconds / 60))}m whether it fixed the problem.`,
      };
    }
    const deadline = Date.parse(check.applyBy ?? "");
    if (!Number.isFinite(deadline) || Date.now() >= deadline) {
      const detail = `the PR's change (${describeExpect(check.expect ?? null)}) was never running on ${check.target.namespace}/${check.target.name}`;
      await this.host.checks.expire(check.id, detail);
      return {
        channel: check.channel,
        threadTs: check.threadTs,
        text: `⌛ *GitOps change not applied* · ${where} still does not run ${describeExpect(check.expect ?? null)}, 24h after the PR — so nothing was verified. Merge it (Flux syncs it) or close it.`,
      };
    }
    await this.host.checks.waitMore(check.id);
    return null;
  }

  // One poller pass: claim whatever is due, verify it, record the verdict, and hand back the
  // thread messages for the caller to post. Returns messages instead of posting them so the
  // Slack client stays in the app layer — this class owns Postgres and MCP, not chat.
  //
  // The verdict is recorded BEFORE its message goes out: at-most-once beats a crash between
  // two posts telling on-call twice that their fix failed.
  async runDueRemediationChecks(): Promise<Array<{ channel: string; threadTs: string; text: string }>> {
    const due = await this.host.checks.claimDue();
    const out: Array<{ channel: string; threadTs: string; text: string }> = [];

    for (const check of due) {
      if (check.status === "awaiting") {
        const msg = await this.pollAwaitingApply(check).catch((err) => {
          logger.warn(`[remediation] apply-watch ${check.id} failed, will retry after the lease: ${errDetail(err)}`);
          return null;
        });
        if (msg) out.push(msg);
        continue;
      }
      if (maxAttemptsReached(check)) {
        const detail = `verification kept failing (${check.attempts} attempts) — the cluster or Alertmanager could not be read`;
        await this.host.checks.abandon(check.id, detail);
        out.push({ channel: check.channel, threadTs: check.threadTs, text: verdictMessage(check, "inconclusive", detail) });
        continue;
      }
      try {
        const { verdict, detail } = await this.verifyRemediation(check);
        await this.host.checks.complete(check.id, verdict, detail);
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
        ? this.host.mcp
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
    const raw = await this.host.mcp.callTool("k8s_list_pods", { namespace: target.namespace });
    return summarizePods(raw, target.name);
  }

  async rejectRemediation(id: number, by: string): Promise<string> {
    const flipped = await this.host.remediations.reject(id, by);
    return flipped ? `🚫 Remediation rejected by <@${by}>. Nothing was executed.` : "⚠️ Already handled (or expired).";
  }
}

/** What an opened GitOps PR leaves for the apply-watch: the workload, and what it should end up running. */
export type AwaitApply = { target: { namespace: string; name: string; kind: string }; expect: ApplyExpectation };

/** `deployment` → `Deployment`, the spelling k8s_get_resource's `kind` takes. */
const kindName = (kind: string): string => ({ deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet" })[kind.toLowerCase()] ?? "Deployment";

/** `k8s_scale:ns/name` — the card's target key — for rows proposed before `workload` was stored. */
function targetOf(key: string): { kind: string; namespace: string; name: string } | null {
  const m = /^[a-z0-9_]+:([^/\s]+)\/([^/\s]+)$/.exec(key);
  return m ? { kind: "deployment", namespace: m[1]!, name: m[2]! } : null;
}

function describeExpect(e: ApplyExpectation | null): string {
  const fields = e?.fields ?? [];
  if (fields.length === 0) return "the PR's change";
  const shown = fields.slice(0, 3).map((f) => `\`${f.field}=${truncate(String(f.value), 60)}\``).join(", ");
  return fields.length > 3 ? `${shown} and ${fields.length - 3} more` : shown;
}
