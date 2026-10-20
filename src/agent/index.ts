import { createLLMClient } from "./llm/index.js";
import { SERIALIZED_BLOCKS, namesToolOnly } from "./llm/router.js";
import { parseRegistry } from "./llm/registry.js";
import { MCPClient } from "./mcp/client.js";
import { type McpTools } from "./mcp/types.js";
import { ConversationMemory } from "./memory/index.js";
import { IncidentMemory } from "./incidents/index.js";
import { serviceGraph, type OpenIncident } from "./correlation/topology.js";
import { buildClusterModel, ClusterModelCache } from "./onboarding/index.js";
import { namespaceNamed } from "./onboarding/model.js";
import { type ClusterModel } from "./onboarding/types.js";
import { alertsReadable, decideReconcile, type StatusCommand, type UnresolvedIncident } from "./incidents/reconcile.js";
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
import { DELEGATE_TOOL, DELEGATE_MARKER, capFanout, childDeadline, hypothesisOf, subThreadId, withDelegateTool } from "./subagent/index.js";
import { parseFeedbackJson, buildExtractionPrompt, EXTRACTION_SYSTEM, tracesToHumans } from "./feedback/index.js";
import { capConfidence, admitsLogGap, parseConfidence } from "./confidence/index.js";
import { stripTemplateEcho } from "./template-echo/index.js";
import { historyContent, stripFabricatedNote } from "./fabricated-note/index.js";
import { stripMutatingCommands } from "./runbook/index.js";
import { rcaGaps, rcaGapNotice } from "./rca-completeness/index.js";
import { extractSection, isRcaResponse } from "../utils/slack/blocks.js";
import { RemediationStore } from "./remediation/index.js";
import { proposeWithRetry, PROPOSAL_SYSTEM, stripOffer, type Proposal, type Refusal } from "./remediation/proposal.js";
import { rollbackRefusal, staleRollbackRefusal, specChangesOf, rollbackDryRunSummary, rolloutFromRevision } from "./remediation/rollback-gate.js";
import { parsePods, replacementRefusal, healthyTargetRefusal, rbacRestartRefusal, REPLACEMENT_ACTIONS } from "./remediation/replace-guard.js";
import { noOpImageRefusal, noOpResourcesRefusal, oomShrinkRefusal, wrongKindRefusal, holdsWorkload, LISTING_FOR_KIND, WORKLOAD_ACTIONS } from "./remediation/noop-guard.js";
import { RemediationCheckStore, summarizePods, alertState, decideVerdict, verdictMessage, maxAttemptsReached, type AlertState, type PodHealth, type RemediationCheck, type Verdict } from "./remediation/verify.js";
import { SqsGitOpsClient } from "./gitops/sqs.js";
import { parseGitOpsPreview, type GitOpsPreview } from "./gitops/preview.js";
import { pickRevertCommit } from "./gitops/revert.js";
import { type GitOpsDrift } from "./gitops/types.js";
import { FLUX_HELMRELEASE, FLUX_KUSTOMIZATION, kustomizeRefOf, fluxPathToPrefix } from "./gitops/overlay.js";
import { collectChanges, type ChangeTimeline, type HistoryPayload } from "./changes/index.js";
import { PostmortemStore, type LatestDraft } from "./postmortem/store.js";
import { type PostmortemFacts } from "./postmortem/facts.js";
import { buildPostmortemPrompt, assemblePostmortem, POSTMORTEM_SYSTEM } from "./postmortem/draft.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import { type LLMClient, type LLMResponse, type ContentBlock, type Message, type TokenUsage, type ToolDefinition } from "./llm/types.js";
import { initRedis, pingRedis } from "../redis.js";
import logger from "../utils/logger/index.js";
import { errDetail } from "../utils/logger/index.js";
import { currentTrace, withRoute, withTrace } from "../utils/trace/index.js";
import { TraceRecorder, instrumentLLM, instrumentMCP, refusalGate, type GateName } from "./trace/index.js";
import { TraceStore } from "./trace/store.js";
import { LOG_TOOLS, returnedLogLines, memoSawLogLines, nudgeLostRca, LOG_GAP_NOTICE, demandsLogs, logGapAction } from "./loop/log-gap.js";
import { quarantineRefusal, orphanDeleteRefusal, lastToolResultIn, ungroundedTargetRefusal, resourceFaultRefusal, offerMismatchRefusal, targetKey, scaleOutRefusal, unseenImageRefusal, backupFrom, imageGapRepo, IMAGE_GAP_NOTICE } from "./remediation/evidence-refusals.js";
import { MAX_ITERATIONS, MAX_LOG_FANOUT, TOOL_BUDGET_NOTICE, NO_EVIDENCE_NOTICE, FABRICATED_EVIDENCE_NOTICE, needsEvidence, forcedFinalAnswer, noToolRoundLeft, MAX_TRACKED_THREADS, windowOf, memoCovers, toolCallKey, placeholderIn, PLACEHOLDER_REFUSAL, REPEAT_NOTICE, reportProgress, RunMode, modeTag, evidenceStamp, staleEvidenceNotice, evidenceTexts } from "./loop/control.js";
import { ThreadSkills, SkillView, selectForThread, decayThreadSkills, resolveSkillNames } from "./skills/thread.js";

// Moved out in the 2026-10-20 housekeeping; re-exported so every import site stays valid.
export * from "./loop/log-gap.js";
export * from "./remediation/evidence-refusals.js";
export * from "./loop/control.js";
export * from "./skills/thread.js";

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

// this.timelines (the rollback gate's per-process copy of a thread's change timeline): pruned by
// age so a thread nobody revisits does not leak forever, and capped by count as a hard backstop.
const TIMELINE_MAX_AGE_MS = 24 * 3_600_000;
const TIMELINE_MAX_ENTRIES = 500;

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

export interface AgentDeps {
  llm?: LLMClient;
  mcp?: McpTools;
  /** Who is running this agent — the dashboard's Harness page shows `prod` only. */
  traceSource?: "prod" | "bench";
  /** Tests and replay inject one; production gets one with a store in initialize(). */
  recorder?: TraceRecorder;
  /**
   * Replay injects a store that accepts every card: without a database `propose()` returns null,
   * and a proposal that passed every gate would replay as "no proposal".
   */
  remediations?: RemediationStore;
}

export class DevOpsAgent {
  private llm: LLMClient;
  private mcp: McpTools;
  // Investigation traces (agent/trace, migrations/011). A recorder with no sink is a no-op, which
  // is what this is until initialize() has a pool.
  private trace: TraceRecorder;
  private traceStore = new TraceStore(null);
  private readonly traceSource: "prod" | "bench";
  private memory: ConversationMemory;
  private incidents: IncidentMemory;
  private usage: UsageStore;
  private remediations: RemediationStore;
  private checks: RemediationCheckStore;
  private postmortems: PostmortemStore;
  private gitops: SqsGitOpsClient | null;
  // The onboarding cluster model (agent/onboarding), 5 min per namespace scope — see clusterModel().
  private readonly clusterModels: ClusterModelCache;
  private readonly skills: SkillRegistry;
  private readonly threadSkills: ThreadSkills = new Map();
  // threadId -> (tool call key -> in-flight or settled result). One entry per INVESTIGATION,
  // not per thread: a later turn must be free to re-fetch, because the cluster moved on.
  private readonly toolMemo = new Map<string, Map<string, { result: Promise<string>; window: number[] }>>();
  // threadId -> this process's own copy of the thread's change timeline (agent/changes), for the
  // rollback gate. ponytail: in-process map + DB fallback (timelineFor); bounded by age and count.
  private readonly timelines = new Map<string, { t: ChangeTimeline; at: number }>();
  private budget: Budget;

  constructor(deps: AgentDeps = {}) {
    this.traceSource = deps.traceSource ?? "prod";
    this.trace = deps.recorder ?? new TraceRecorder(null, { source: this.traceSource, sha: config.trace.sha });
    // Wrapped once, here, so every chat()/callTool() call site is recorded without touching it.
    // The getter matters: initialize() replaces this.trace after the wrappers exist.
    this.llm = instrumentLLM(deps.llm ?? createLLMClient(), () => this.trace);
    this.mcp = instrumentMCP(deps.mcp ?? new MCPClient(), () => this.trace);
    this.memory = new ConversationMemory(); // default in-memory; replaced in initialize() if Redis configured
    this.incidents = new IncidentMemory(null); // no-op until initialize() wires Postgres
    this.usage = new UsageStore(null); // no-op until initialize() wires Postgres
    this.remediations = deps.remediations ?? new RemediationStore(null); // no-op until initialize() wires Postgres
    this.checks = new RemediationCheckStore(null); // no-op until initialize() wires Postgres
    this.postmortems = new PostmortemStore(null); // no-op until initialize() wires Postgres
    this.gitops = config.gitops.enabled ? new SqsGitOpsClient() : null; // GitOps PR-flow bridge (opt-in)
    const gitops = this.gitops;
    this.clusterModels = new ClusterModelCache((ns) =>
      buildClusterModel(
        {
          inventory: (n) => this.mcp.callTool("k8s_cluster_inventory", n ? { namespace: n } : { detail: true }),
          callGraph: () => serviceGraph((name, input) => this.mcp.callTool(name, input)),
          locate: gitops ? (pathPrefix, targets) => gitops.request({ op: "locate", targets, ...(pathPrefix ? { pathPrefix } : {}) }) : undefined,
          overlayPath: (hr) => this.resolveOverlayPath(hr),
          now: Date.now,
        },
        ns
      )
    );

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
      this.traceStore = new TraceStore(pool);
      // An injected recorder (tests, replay) is kept; only the default no-op one gets the pool.
      if (!this.trace.enabled && config.trace.enabled) {
        this.trace = new TraceRecorder(this.traceStore, { source: this.traceSource, sha: config.trace.sha });
      }
      this.incidents = new IncidentMemory(pool, (id, ts) => void this.usage.linkToIncident(id, ts));
      this.remediations = new RemediationStore(pool);
      this.checks = new RemediationCheckStore(pool);
      this.postmortems = new PostmortemStore(pool);
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
  /** The thread's latest result of `tool` — see lastToolResultIn. */
  async lastToolResult(threadId: string, tool: string): Promise<string | null> {
    return lastToolResultIn(await this.memory.get(threadId).catch(() => [] as Message[]), tool);
  }

  /** k8s_cluster_inventory's raw result, for the dashboard's /cluster page — no LLM involved. */
  /** The onboarding cluster model (agent/onboarding) — called outside any investigation, like collectChanges. */
  async clusterModel(namespace?: string): Promise<ClusterModel | null> {
    return this.clusterModels.get(namespace);
  }

  /** The whole-cluster model for /cluster: never waits; a cold or stale cache kicks a background build. */
  peekClusterModel(): ClusterModel | null {
    return this.clusterModels.peek();
  }

  /** The namespace a tour mention names, matched against the live namespace list; null when it names none. */
  async tourNamespace(text: string): Promise<string | null> {
    const raw = await this.mcp.callTool("k8s_cluster_inventory", {}).catch(() => "");
    try {
      const names = ((JSON.parse(raw) as { namespaces?: Array<{ name: string }> }).namespaces ?? []).map((n) => n.name);
      return namespaceNamed(text, names);
    } catch {
      return null;
    }
  }

  async clusterInventory(): Promise<string> {
    return this.mcp.callTool("k8s_cluster_inventory", { detail: true });
  }

  /** Direct MCP access for callers outside the agentic loop — e.g. cross-alert correlation's
   * service-graph query (app/index.ts), which needs one tool call and no investigation. */
  callTool(name: string, input: Record<string, unknown>): Promise<string> {
    return this.mcp.callTool(name, input);
  }

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

  // The change timeline for an alert (agent/changes). Called by app/index.ts BEFORE investigate()
  // and outside any trace run, so replay never executes it. null = no namespace to scope it to.
  async collectChanges(namespace: string | undefined, alertAt: Date, subjects: string[], threadId?: string): Promise<ChangeTimeline | null> {
    if (!namespace) return null;
    const gitops = this.gitops;
    const t = await collectChanges(
      {
        callTool: (name, input) => this.mcp.callTool(name, input),
        history: gitops
          ? async (hr, since) => (await gitops.request({ op: "history", helmRelease: hr, since, pathPrefix: await this.resolveOverlayPath(hr) })) as HistoryPayload
          : undefined,
      },
      namespace,
      alertAt,
      subjects
    );
    logger.info(`[changes] ${namespace}: ${t.changes.length} change(s), ${t.commits.length} commit(s)${t.unread.length ? `, unread: ${t.unread.join("; ")}` : ""}`);
    if (threadId) {
      const now = Date.now();
      for (const [k, v] of this.timelines) if (now - v.at > TIMELINE_MAX_AGE_MS) this.timelines.delete(k);
      if (this.timelines.size >= TIMELINE_MAX_ENTRIES) {
        const oldest = this.timelines.keys().next().value;
        if (oldest !== undefined) this.timelines.delete(oldest);
      }
      this.timelines.set(threadId, { t, at: now });
    }
    return t;
  }

  // The change timeline a rollback is gated on: this process's copy, else the incident row's.
  async timelineFor(threadId?: string): Promise<ChangeTimeline | null> {
    if (!threadId) return null;
    const hit = this.timelines.get(threadId);
    if (hit) return hit.t;
    const stored = await this.incidents.changesForThread(threadId).catch(() => null);
    return (stored as ChangeTimeline | null) ?? null;
  }

  storeIncident(
    labels: Record<string, string>,
    rca: string,
    channel?: string,
    threadTs?: string,
    /** The group's Alertmanager severity as the Slack card rendered it — see store(). */
    alertSeverity?: string | null,
    changes?: ChangeTimeline | null,
    /** Cross-alert correlation (agent/correlation): subjects + child + alertStartedAt, passed
     *  straight through. */
    opts?: { subjects?: string[]; child?: boolean; alertStartedAt?: Date }
  ): Promise<number | null> {
    return this.incidents.store(labels, rca, channel && threadTs ? { channel, threadTs } : undefined, alertSeverity, changes, opts);
  }

  // Open top-level incidents in `namespace` from the last `sinceMinutes` — the candidate set a
  // new alert group is checked against for cross-alert correlation (agent/correlation).
  openRelatable(namespace: string, sinceMinutes: number): Promise<OpenIncident[]> {
    return this.incidents.openRelatable(namespace, sinceMinutes);
  }

  // Everything below runs inside the trace context so outbound SQS requests carry the
  // threadId — that is what lets you grep one id across the agent log, the llm-worker
  // log, and the Slack thread when an answer comes out wrong.
  investigate(threadId: string, userMessage: string, opts: InvestigateOptions = {}): Promise<string> {
    // finish() in a finally: a run that throws (backend down mid-loop) is still written — it is
    // exactly the run someone will want to look at.
    return withTrace(threadId, () =>
      this.runInvestigation(threadId, userMessage, opts).finally(() => this.trace.finish(threadId))
    );
  }

  private async runInvestigation(threadId: string, userMessage: string, opts: InvestigateOptions = {}): Promise<string> {
    logger.info(`[${threadId}] Investigation started`);
    this.trace.begin(threadId, {
      phase: "investigate",
      issue: userMessage,
      opts: {
        mode: opts.mode ?? "alert",
        trigger: opts.trigger ?? null,
        namespace: opts.namespace ?? null,
        maxToolRounds: opts.maxToolRounds !== undefined && Number.isFinite(opts.maxToolRounds) ? opts.maxToolRounds : null,
        maxIterations: opts.maxIterations ?? null,
        depth: opts.depth ?? 0,
      },
      tools: this.mcp.getTools(),
    });
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
    let rcaGapNudged = false;   // same, for an RCA that stopped before the template did
    // WHICH gate is holding an answer, not merely that one is. The log-gap restore test reads
    // "the extra round ran no tools" as failure, which is true of a nudge that asked for a fetch
    // and false of the RCA-completeness one, whose whole request is a tool-free rewrite.
    let heldBy: "tools" | "rca" | null = null;
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
      // An answer that says it could not read the logs cannot also be highly confident — see
      // capConfidence. Here, so the alert path and a mention both pass through it.
      const { text: rated, capped } = capConfidence(text, sawLogLines);
      if (capped) {
        logger.info(`[${threadId}] capped Confidence: High → Medium — the answer reports no logs`);
        this.trace.gate(threadId, "confidence-cap", "capped");
      } else if (parseConfidence(text) === "high") {
        // Bench C03 attempt 1, 2026-09-24: every log result came back under LOG_RESULT_MIN_CHARS,
        // and the stored answer matches admitsLogGap when tested offline — both conditions looked
        // met, and the cap still declined. The artifacts could not say which input differed,
        // because neither was ever written down. One line, only on a High rating, settles the next.
        // Settled 2026-09-29 by this very line (sawLogLines=true): a memoised repeat call, measured
        // WITH its repeat notice — see REPEAT_PREFIX.
        logger.info(
          `[${threadId}] Confidence: High kept — sawLogLines=${sawLogLines} admitsLogGap=${admitsLogGap(text)}`
        );
        this.trace.gate(threadId, "confidence-cap", "kept-high", `sawLogLines=${sawLogLines}`);
      }
      // A placeholder the model labelled instead of filling — see stripTemplateEcho. Done here
      // rather than in the Slack renderer: the same text reaches Postgres and the next
      // investigation's recall block, and "[Symptom]" is no more readable in either of those.
      const { text: filled, dropped } = stripTemplateEcho(rated);
      if (dropped > 0) {
        logger.info(`[${threadId}] dropped ${dropped} echoed template placeholder(s) from the answer`);
        this.trace.gate(threadId, "template-echo", "dropped", "", { count: dropped });
      }
      // A `[system note]` the MODEL wrote — see stripFabricatedNote. Here rather than in the Slack
      // renderer for two reasons: the same text is what the proposal step reads as its evidence, and
      // a fabricated "already executed" is exactly what makes it answer {"action": null}; and it
      // also reaches Postgres and the next investigation's recall, where a false lifecycle fact is
      // worse than an unreadable one. Logged at warn, not info: every other scrubber here is fixing
      // formatting, this one caught the answer claiming work it never did.
      const { text: honest, dropped: notes } = stripFabricatedNote(filled);
      if (notes > 0) {
        logger.warn(
          `[${threadId}] dropped ${notes} fabricated [system note] line(s) — the answer claimed an execution that never happened`
        );
        this.trace.gate(threadId, "fabricated-note", "dropped", "", { count: notes });
      }
      // A Runbook command that would CHANGE something, or is not a command a human can run (our own
      // tool calls, 2026-09-29) — see agent/runbook. Warn, like the note above.
      const { text: readOnly, dropped: commands } = stripMutatingCommands(honest);
      if (commands.length > 0) {
        logger.warn(
          `[${threadId}] dropped ${commands.length} Runbook line(s) that are not a read-only kubectl/helm/flux command: ` +
          truncate(commands.join(" | "), 300)
        );
        this.trace.gate(threadId, "runbook", "dropped", truncate(commands.join(" | "), 300), { count: commands.length });
      }
      // The [OFFER] line is for the gate, never for a reader. Thread memory already holds the raw
      // reply (appended above), which is where app/index.ts reads it back — see parseOffer.
      const answer = stripOffer(readOnly);
      if (answer !== readOnly) this.trace.gate(threadId, "offer", "stripped");
      this.trace.end(threadId, { answer, ms: durationMs, llmCalls: iterations, toolCalls: totalToolCalls });
      return answer;
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
          this.trace.gate(threadId, "deadline", "forced");
        } else {
          // Nothing gathered, or the answer turn is already spent. Either way there is no
          // finding to salvage and the apology is the truthful reply.
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${iterations} LLM calls ` +
            `(tool rounds: ${toolRounds}, answer turn ${toolsDisabled ? "already spent" : "not reachable"})`
          );
          this.trace.gate(threadId, "deadline", "apology");
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

      this.trace.skills(threadId, assembled.skillsUsed);
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

      // Scrubbed of any [system note] the model wrote itself — see historyContent. Only memory: the
      // reply this turn returns goes through done(), which scrubs and logs it for Slack.
      await this.memory.append(threadId, { role: "assistant", content: historyContent(response.content).blocks });

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
        const noFetch = noToolRoundLeft({ toolsDisabled, iterations, maxIterations });
        if (needsEvidence({ mode, toolRounds, nudged: noEvidenceNudged, toolsDisabled: noFetch, answer: summary })) {
          noEvidenceNudged = true;
          preNudgeSummary = summary;
          toolRoundsAtNudge = toolRounds;
          logger.warn(
            `[${threadId}] answered with zero tool calls — one more round to go and look` +
            (mode === "alert" ? "" : " (the answer presented tool output it never fetched)")
          );
          this.trace.gate(threadId, "no-evidence", "nudge");
          await this.memory.append(threadId, {
            role: "user",
            content: mode === "alert" ? NO_EVIDENCE_NOTICE : FABRICATED_EVIDENCE_NOTICE,
          });
          continue;
        }
        // The last gate before an answer leaves — see logGapAction for all three outcomes.
        const gap = logGapAction({
          mode,
          demandsLogs: demandsLogs(skills),
          sawLogLines,
          nudged: logGapNudged,
          toolsDisabled: noFetch,
          toolRounds,
          toolRoundsAtNudge,
          heldBy,
        });
        if (gap === "restore") {
          // Gate-agnostic on purpose: both gates hold their answer in the same slot, so this
          // sentence has to be true of whichever one spent the round.
          logger.warn(
            `[${threadId}] the extra round fetched nothing — keeping the pre-nudge answer ` +
            `(${preNudgeSummary.length} chars) over the retry's ${summary.length}`
          );
          this.trace.resolveNudge(threadId, "restored");
          return done(preNudgeSummary);
        }
        if (gap === "nudge") {
          logGapNudged = true;
          preNudgeSummary = summary;
          heldBy = "tools";
          toolRoundsAtNudge = toolRounds;
          logger.info(
            `[${threadId}] answered after ${toolRounds} tool round(s) with no log lines, while ` +
            `[${skills.map((s) => s.name).join(", ")}] read logs — one more round`
          );
          this.trace.gate(threadId, "log-gap", "nudge", `after ${toolRounds} tool round(s)`);
          await this.memory.append(threadId, { role: "user", content: LOG_GAP_NOTICE });
          continue;
        }
        if (nudgeLostRca({ mode, heldBy, before: preNudgeSummary, after: summary })) {
          logger.warn(
            `[${threadId}] the extra round replaced an RCA with something that is not one ` +
            `("${truncate(summary, 80)}") — keeping the RCA`
          );
          this.trace.gate(threadId, "nudge-lost-rca", "kept", truncate(summary, 200));
          this.trace.resolveNudge(threadId, "kept-earlier");
          return done(preNudgeSummary);
        }
        // Second gate, same hold slot: only one nudge may be outstanding, so this is reached only
        // when the log gap did not take the round. Evidence-driven, so it is safe in every mode —
        // the trigger is a pull failure in tool output, not a guess about the question.
        if (!imageGapNudged && !noFetch && toolRounds > 0) {
          const repo = imageGapRepo(summary, observedText(await this.memory.get(threadId)));
          if (repo) {
            imageGapNudged = true;
            preNudgeSummary = summary;
            heldBy = "tools";
            toolRoundsAtNudge = toolRounds;
            logger.info(`[${threadId}] answer names \`${repo}\` only as the image that failed to pull — one more round for the tag that works`);
            this.trace.gate(threadId, "image-gap", "nudge", repo);
            await this.memory.append(threadId, { role: "user", content: IMAGE_GAP_NOTICE });
            continue;
          }
        }
        // Third gate, same hold slot, and the only one that does NOT want another tool round —
        // see rca-completeness. The investigation is over; what is missing is writing. So it is
        // not gated on `toolsDisabled`: a tool-free turn is exactly the turn it asks for. It still
        // needs a call left to spend it on — on the last one the nudge fell out into the apology.
        if (!rcaGapNudged && iterations < maxIterations && mode === "alert" && isRcaResponse(summary)) {
          const missing = rcaGaps(summary);
          if (missing.length > 0) {
            rcaGapNudged = true;
            preNudgeSummary = summary;
            heldBy = "rca";
            toolRoundsAtNudge = toolRounds;
            logger.info(`[${threadId}] RCA is missing ${missing.join(", ")} — one more round to complete it`);
            this.trace.gate(threadId, "rca-completeness", "nudge", missing.join(", "));
            await this.memory.append(threadId, { role: "user", content: rcaGapNotice(missing) });
            continue;
          }
        }
        // The completion round replaces what it was given, so it can lose as well as gain. The
        // other gates decide that on whether the extra round ran any tools; this one can compare
        // the thing itself, which is the better test when it is available.
        if (rcaGapNudged && preNudgeSummary !== "" && rcaGaps(summary).length > rcaGaps(preNudgeSummary).length) {
          logger.warn(
            `[${threadId}] the completion round came back with more missing than it was given ` +
            `(${rcaGaps(summary).join(", ")}) — keeping the earlier answer`
          );
          this.trace.resolveNudge(threadId, "kept-earlier");
          return done(preNudgeSummary);
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
          const delegated = await this.runDelegates(threadId, run, deadline);
          delegateResults = [...delegated.results, ...overflow];
          if (delegated.sawLogLines) sawLogLines = true;
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
              this.trace.gate(threadId, "scope-lock", "refused", scopeList, { count: drift.length });
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
            this.trace.gate(threadId, "log-fanout", "refused", "", { pods: logPods.size });
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
            (r) => r.type === "tool_result" && logIds.has(r.tool_use_id) && returnedLogLines(String(r.content ?? ""))
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
          this.trace.gate(threadId, notice === TOOL_BUDGET_NOTICE ? "tool-budget" : "iteration-ceiling", "forced");
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
    this.trace.gate(threadId, "iteration-ceiling", "exhausted");
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
  private async runDelegates(
    threadId: string,
    calls: ContentBlock[],
    parentDeadline: number
  ): Promise<{ results: ContentBlock[]; sawLogLines: boolean }> {
    const cutoff = childDeadline(parentDeadline);
    const block = (id: string | undefined, content: string): ContentBlock =>
      ({ type: "tool_result" as const, tool_use_id: id, content });
    let sawLogLines = false; // any delegate's log call returned lines — see memoSawLogLines

    const results = await Promise.all(
      calls.map(async (call, i) => {
        const hypothesis = hypothesisOf(call);
        if (!hypothesis) {
          return block(call.id, "Error: delegate_investigation needs a non-empty `hypothesis` — state the claim to test.");
        }
        if (Date.now() >= cutoff) {
          logger.warn(`[${threadId}] delegate refused — less than the reserve left before the investigation deadline`);
          this.trace.gate(threadId, "delegate", "refused");
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
          // Read before `finally` drops the memo.
          if (await memoSawLogLines(this.toolMemo.get(sub))) sawLogLines = true;
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
    return { results, sawLogLines };
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
        this.trace.gate(threadId, "injection", "framed", name ?? "", { hits });
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
          this.trace.gate(threadId, "write-blocked", "refused", name ?? "");
          return {
            type: "tool_result" as const,
            tool_use_id: id,
            content: "Error: write tools require the human approval flow and cannot be called during an investigation.",
          };
        }
        const placeholder = placeholderIn(input);
        if (placeholder) {
          logger.warn(`[${threadId}] refused ${name}: placeholder ${placeholder} in its input`);
          this.trace.gate(threadId, "placeholder", "refused", `${name}: ${placeholder}`);
          return { type: "tool_result" as const, tool_use_id: id, content: PLACEHOLDER_REFUSAL(placeholder, namespace) };
        }
        // Repeat suppression. The memo holds the PROMISE, not the settled value, so two
        // identical calls in the same parallel round collapse onto one request as well.
        // Only successes stay memoised — a failure that is retried may genuinely succeed,
        // and pinning it would turn one transient error into a dead tool for the rest of
        // the investigation.
        const memo = this.toolMemo.get(threadId);
        const key = toolCallKey(name, input);
        const asked = windowOf(input);
        const cached = memo?.get(key);
        if (cached && memoCovers(cached.window, asked)) {
          try {
            const result = await cached.result;
            logger.info(`[${threadId}] ⟲ tool: ${name} repeat call — served from this investigation's memo (${result.length} chars), not re-run`);
            this.trace.gate(threadId, "repeat-call", "memo", name ?? "");
            return { type: "tool_result" as const, tool_use_id: id, content: guard(REPEAT_NOTICE + result, name) };
          } catch {
            memo?.delete(key); // it failed; let this call have its own attempt
          }
        }

        const start = Date.now();
        logger.info(`[${threadId}] → tool: ${name} input: ${truncate(JSON.stringify(input))}`);
        const pending = this.mcp.callTool(name!, input as Record<string, unknown>);
        memo?.set(key, { result: pending, window: asked });
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

  // ---- Postmortem draft (agent/postmortem, spec 2026-10-14-postmortem-draft-design.md) ----

  /**
   * Everything a draft is built from: Postgres facts (PostmortemStore.facts) plus the Slack
   * thread's human statements, which only SlackApp can read (it owns the client). `humans: null`
   * means that read failed — the thread is unreadable, not "nobody said anything" — and adds
   * "Slack thread" to `unavailable` so `## Sources` says so rather than silently going quiet.
   */
  async postmortemFacts(incidentId: number, humans: string[] | null): Promise<PostmortemFacts | null> {
    const stored = await this.postmortems.facts(incidentId);
    if (!stored) return null;
    return {
      ...stored,
      humans: humans ?? [],
      unavailable: [...stored.unavailable, ...(humans === null ? ["Slack thread"] : [])],
    };
  }

  /**
   * The ONE LLM call a postmortem costs: no tools, light route — a Markdown write-up of facts
   * already gathered, not an investigation. `threadId` is the Slack thread the draft was
   * requested in — optional (and defaulted to null) so a caller with no Slack thread (replay,
   * a future non-Slack trigger) stays exactly as before; handlePostmortem passes its own.
   */
  async draftPostmortem(f: PostmortemFacts, threadId: string | null = null): Promise<{ markdown: string; backend: string }> {
    // The writing rules are the `postmortem-format` skill and ride in the user message, like every
    // skill: the system prompt stays the constant heading contract (cache-safe).
    const guide = this.skills.all().find((s) => s.name === "postmortem-format")?.body;
    const r = await withRoute("light", () => this.llm.chat([{ role: "user", content: buildPostmortemPrompt(f, guide) }], [], POSTMORTEM_SYSTEM));
    this.recordUsage(threadId, r);
    const text = this.extractText(r.content);
    // response.backend is set only by the router (RouterLLMClient); a direct single-backend
    // provider leaves it undefined, and llm_usage stores NULL for the same reason — "light
    // route" names what actually ran without inventing a backend identity nothing configured.
    return { markdown: assemblePostmortem(f, text, new Date()), backend: r.backend ?? "light route" };
  }

  async storePostmortem(incidentId: number, requestedBy: string | null, markdown: string, backend: string): Promise<number | null> {
    return this.postmortems.store(incidentId, requestedBy, markdown, backend);
  }

  async latestPostmortem(incidentId: number): Promise<LatestDraft | null> {
    return this.postmortems.latest(incidentId);
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
    opts: { userRequested?: boolean; threadId?: string; offer?: string | null } = {}
  ): ReturnType<DevOpsAgent["proposeRemediationRun"]> {
    // A run of its own under the thread, phase "proposal": the proposal's LLM call, its guard
    // reads, the dry-run and every refusal land in one trace beside the RCA's.
    const thread = opts.threadId ?? currentTrace();
    if (!thread) return this.proposeRemediationRun(incidentId, labels, rca, opts);
    this.trace.begin(thread, {
      phase: "proposal",
      issue: rca,
      opts: { userRequested: !!opts.userRequested, offer: opts.offer ?? null },
      labels,
      tools: this.mcp.getTools(),
    });
    try {
      const out = await withTrace(thread, () => this.proposeRemediationRun(incidentId, labels, rca, opts));
      this.trace.end(thread, {
        answer: out === null ? null : "refused" in out ? { refused: out.refused } : { action: out.proposal.action, summary: out.proposal.summary },
      });
      return out;
    } finally {
      await this.trace.finish(thread);
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
    // Every gate that can refuse a proposal lives in refusalFor — ONE chain, shared with the
    // benchmark — and it runs inside proposeWithRetry, so a refusal gets one re-ask carrying its
    // reason instead of ending the incident's only chance at a card. See refusalNotice.
    const ctx = { userRequested: opts.userRequested, threadId: opts.threadId, offer: opts.offer ?? null, labels, rca };
    const { proposal, raw, refused } = await proposeWithRetry(
      labels,
      rca,
      async (prompt) => {
        const response = await withRoute("light", () => this.llm.chat([{ role: "user", content: prompt }], [], PROPOSAL_SYSTEM));
        this.recordUsage(null, response); // no Slack thread at this call site — never invent one
        return this.extractText(response.content);
      },
      async (p) => {
        const r = await this.refusalFor(p, ctx);
        if (r) {
          logger.info(`[remediation] ${r.gate} refused ${p.summary}: ${r.reason}`);
          this.trace.gate(opts.threadId ?? currentTrace() ?? "", refusalGate(r.gate), "refused", r.reason);
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
    if (!this.mcp.getTools().some((t) => t.name === proposal.action)) {
      logger.info(`[remediation] proposed action ${proposal.action} is not registered on the MCP server`);
      return null;
    }

    // One pending card per action+target, across incidents — see RemediationStore.pendingFor.
    // Not in refusalFor: it is a fact about the store, and no re-ask can change it.
    const pending = await this.remediations.pendingFor(targetKey(proposal.action, proposal.namespace, proposal.name)).catch(() => null);
    if (pending !== null) {
      logger.info(`[remediation] duplicate of pending card ${pending}: ${proposal.summary}`);
      return { refused: `An approval card for this exact action on \`${proposal.namespace}/${proposal.name}\` is already waiting (remediation ${pending}). Approve or reject that one — a second card is the same decision twice.` };
    }

    // Mandatory dry-run before any card — validates the target AND exercises the MCP
    // server's namespace guardrails with zero side effects.
    const dryRun = await this.mcp.callTool(proposal.action, { ...proposal.toolParams, dry_run: true });
    if (dryRun.startsWith("Error:")) {
      logger.info(`[remediation] dry-run refused for ${proposal.summary}: ${truncate(dryRun, 200)}`);
      this.trace.gate(opts.threadId ?? currentTrace() ?? "", "dry-run", "failed", truncate(dryRun, 300));
      return { refused: dryRun.replace(/^Error:\s*/, "") };
    }

    // The gate chain is tool-free and reasons only from the timeline collected before the
    // investigation started — a "roll it back" mention hours later can find the Deployment has
    // moved past it (a fix-forward, someone else's rollout). The dry-run's own `fromRevision` is
    // the one piece of LIVE evidence in this flow, so this runs AFTER it succeeds, never inside
    // refusalFor. See rollback-gate.ts.
    if (proposal.action === "k8s_rollout_undo") {
      const stale = staleRollbackRefusal(proposal, await this.timelineFor(opts.threadId), dryRun);
      if (stale) {
        logger.info(`[remediation] rollback refused for ${proposal.summary}: ${truncate(stale, 200)}`);
        this.trace.gate(opts.threadId ?? currentTrace() ?? "", "remediation-rollback", "refused", stale);
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
    const id = await this.remediations.propose(incidentId, proposal.action, {
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
      const rollback = rollbackRefusal(proposal, await this.timelineFor(ctx.threadId));
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
      const raw = await this.mcp.callTool("k8s_recommend_resources", { namespace, workload: proposal.name });
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
      this.mcp.callTool(LISTING_FOR_KIND[k]!, { namespace }).catch((err) => {
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
      const raw = await this.mcp.callTool(tool, { namespace });
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
      const raw = await this.mcp.callTool("k8s_list_pods", { namespace });
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

  // A rollback on a Flux-managed Deployment: the cluster patch would be reverted by Flux, so the
  // undo is a revert PR of the commit the change timeline names (pickRevertCommit — never a sha
  // from the model). Dry-run first, so the card shows the diff and an unclean revert never posts.
  private async proposeRevertPr(
    incidentId: number | null,
    proposal: Proposal,
    preview: GitOpsPreview,
    threadId?: string
  ): Promise<{ id: number; proposal: Proposal; dryRunSummary: string; gitOps?: { path: string; valuesKey: string; helmRelease: { name: string; namespace: string } } } | { refused: string } | null> {
    if (!this.gitops) return { refused: `${preview.message} (GitOps PR remediation is not enabled on the agent — set GITOPS_REMEDIATION_ENABLED=true)` };
    // The commit behind the broken rollout landed BEFORE it. A newer commit to the same release
    // means the repo moved on since — reverting either one is a guess, so refuse.
    const timeline = await this.timelineFor(threadId);
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
      payload = await this.gitops.request({ op: "revert_pr", helmRelease: preview.helmRelease, sha: commit.sha, pathPrefix, dryRun: true });
    } catch (err) {
      return { refused: `couldn't prepare the revert PR: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!payload.ok) {
      logger.info(`[remediation] revert_pr dry-run refused: ${payload.reason}`);
      return { refused: payload.reason };
    }
    if (payload.op !== "revert_pr" || !payload.dryRun) return null; // defensive: wrong op from the worker
    const summary = `open a revert PR for \`${commit.sha.slice(0, 7)}\` ${commit.message} (\`${payload.paths.join("`, `")}\`) — undoes the change behind ${proposal.summary}`;
    const id = await this.remediations.propose(incidentId, proposal.action, {
      gitops: true,
      revert: true,
      helmRelease: preview.helmRelease,
      sha: commit.sha,
      pathPrefix,
      target: targetKey(proposal.action, proposal.namespace, proposal.name),
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
    if ((params as { revert?: boolean }).revert) {
      const r = params as { helmRelease: { name: string; namespace: string }; sha: string; pathPrefix?: string; summary?: string };
      try {
        const payload = await this.gitops.request({ op: "revert_pr", helmRelease: r.helmRelease, sha: r.sha, pathPrefix: r.pathPrefix, dryRun: false, incident: { summary: r.summary } });
        if (!payload.ok || payload.op !== "revert_pr" || payload.dryRun) {
          const reason = payload.ok ? "unexpected worker response" : payload.reason;
          await this.remediations.finish(id, false, reason);
          return { text: `❌ *Revert PR not opened* — ${label}: ${truncate(reason, 300)}` };
        }
        await this.remediations.finish(id, true, payload.prUrl);
        return { text: `✅ *Revert PR opened* — ${label} (approved by <@${approvedBy}>)\n${payload.prUrl}\nReview & merge to apply — Flux syncs after merge; nothing changes on the cluster until then.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.remediations.finish(id, false, msg);
        return { text: `❌ *Revert PR not opened* — ${label}: ${truncate(msg, 300)}` };
      }
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
  /** A gate decided by the app layer, after the run (the RCA card, grounding, the proposal). */
  recordGate(threadTs: string, name: GateName, outcome: string, detail = "", extra: Record<string, unknown> = {}): void {
    this.trace.gate(threadTs, name, outcome, detail, extra);
  }

  /** Retention for agent_events — called from the app's poller. */
  pruneTraces(): Promise<number> {
    return this.traceStore.prune();
  }

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
  /**
   * `humanText` is what humans wrote in the thread (`humanStatements` — the bot's messages
   * excluded, a ✅'d one included). It is both the precondition and the check: with nothing in it
   * there is nothing to extract, and an extracted cause must trace back to it. Incident 208,
   * 2026-10-03: neither was enforced, and the agent's own hallucinated RCA was stored here as
   * "confirmed by on-call".
   */
  async learnFromThread(channel: string, threadTs: string, triggerUser: string, triggerTs: string, transcript: string, humanText: string): Promise<string> {
    const incidentId = await this.incidents.findIncidentByThread(channel, threadTs);
    if (incidentId === null) {
      return "🤷 This thread isn't linked to a stored incident — I can only learn from alert threads I investigated (and stored).";
    }
    if (!humanText.trim()) {
      logger.info(`[learn] incident ${incidentId}: nothing a human stated in the thread — no extraction`);
      return "🤷 Nothing a human stated in this thread yet, so there is nothing to learn — I don't learn from my own analysis. Write the actual root cause or fix here (or ✅ the message that has it), then mention me with `learn`.";
    }

    const response = await this.llm.chat(
      [{ role: "user", content: buildExtractionPrompt(transcript) }],
      [],
      EXTRACTION_SYSTEM
    );
    this.recordUsage(threadTs, response);
    const parsed = parseFeedbackJson(this.extractText(response.content));
    if (!parsed) {
      return "🤷 I couldn't find a concrete conclusion in this thread yet. State the actual root cause / action taken in the thread, then mention me with `learn` again.";
    }
    const extracted = tracesToHumans(parsed, humanText);
    if (!extracted) {
      logger.warn(`[learn] incident ${incidentId}: extraction named nothing a human wrote — refused (${truncate(parsed.confirmed_root_cause ?? parsed.action_taken ?? "", 160)})`);
      return "🤷 What I extracted came from my own messages, not from anything a human wrote here, so I did not store it as confirmed. State the root cause or fix in your own words, then mention me with `learn`.";
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
  /** Where the approval card landed — see RemediationStore.recordCard. */
  async recordCardMessage(id: number, channel: string, ts: string, threadTs: string): Promise<void> {
    await this.remediations.recordCard(id, channel, ts, threadTs);
  }

  /** Cards whose approval window passed without a click — see RemediationStore.expireStale. */
  async expireStaleRemediations(): Promise<Array<{ id: number; channel: string | null; ts: string | null; threadTs: string | null; summary: string }>> {
    return this.remediations.expireStale();
  }

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
