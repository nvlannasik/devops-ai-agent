import { createLLMClient } from "./llm/index.js";
import { SERIALIZED_BLOCKS, namesToolOnly } from "./llm/router.js";
import { routerRegistry } from "./llm/registry.js";
import { MCPClient } from "./mcp/client.js";
import { type McpTools } from "./mcp/types.js";
import { ConversationMemory, type ThreadMemory, type ThreadSummary } from "./memory/index.js";
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
import { historyContent } from "./fabricated-note/index.js";
import { rcaGaps, rcaGapNotice } from "./rca-completeness/index.js";
import { isRcaResponse } from "../utils/slack/blocks.js";
import { RemediationStore } from "./remediation/index.js";
import { RemediationCheckStore, alertState } from "./remediation/verify.js";
import { SqsGitOpsClient } from "./gitops/sqs.js";
import { collectChanges, type ChangeTimeline, type HistoryPayload } from "./changes/index.js";
import { PostmortemStore, type LatestDraft } from "./postmortem/store.js";
import { type PostmortemFacts } from "./postmortem/facts.js";
import { buildPostmortemPrompt, assemblePostmortem, POSTMORTEM_SYSTEM } from "./postmortem/draft.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import { type LLMClient, type LLMResponse, type ContentBlock, type Message, type ToolDefinition } from "./llm/types.js";
import { initRedis, pingRedis } from "../db/redis.js";
import logger from "../utils/logger/index.js";
import { errDetail } from "../utils/logger/index.js";
import { withRoute, withTrace } from "../utils/trace/index.js";
import { TraceRecorder, instrumentLLM, instrumentMCP, type GateName } from "./trace/index.js";
import { TraceStore } from "./trace/store.js";
import { LOG_TOOLS, returnedLogLines, memoSawLogLines, nudgeLostRca, LOG_GAP_NOTICE, demandsLogs, logGapAction } from "./loop/log-gap.js";
import { lastToolResultIn, imageGapRepo, IMAGE_GAP_NOTICE } from "./remediation/evidence-refusals.js";
import { MAX_ITERATIONS, MAX_LOG_FANOUT, TOOL_BUDGET_NOTICE, NO_EVIDENCE_NOTICE, FABRICATED_EVIDENCE_NOTICE, needsEvidence, forcedFinalAnswer, noToolRoundLeft, MAX_TRACKED_THREADS, windowOf, memoCovers, toolCallKey, placeholderIn, PLACEHOLDER_REFUSAL, REPEAT_NOTICE, reportProgress, modeTag, evidenceStamp, staleEvidenceNotice, evidenceTexts } from "./loop/control.js";
import { ThreadSkills, SkillView, selectForThread, decayThreadSkills, resolveSkillNames } from "./skills/thread.js";
import { Remediator } from "./remediation/remediator.js";
import { extractText } from "./loop/control.js";
import { newRunState, addUsage, type InvestigateOptions, type RunCtx } from "./loop/run-state.js";
import { finalizeAnswer } from "./loop/finalize.js";

// Moved out in the 2026-10-20 housekeeping; re-exported so every import site stays valid.
export * from "./loop/log-gap.js";
export * from "./remediation/evidence-refusals.js";
export * from "./loop/control.js";
export * from "./skills/thread.js";
export * from "./loop/run-state.js";

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
  private readonly remediator: Remediator;
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
      registry: routerRegistry(),
      provider: config.llm.provider,
      maxTokens: config.llm.maxTokens, overheadTokens: estimateTokens(buildStaticSystemPrompt()),
    });
    // Getters: initialize() swaps the stores and the recorder after this line.
    const self = this;
    this.remediator = new Remediator({
      get mcp() { return self.mcp; },
      get llm() { return self.llm; },
      get remediations() { return self.remediations; },
      get checks() { return self.checks; },
      get gitops() { return self.gitops; },
      get memory() { return self.memory; },
      get incidents() { return self.incidents; },
      trace: () => self.trace,
      traceStore: () => self.traceStore,
      timelineFor: (threadId) => self.timelineFor(threadId),
      recordUsage: (threadTs, response) => self.recordUsage(threadTs, response),
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
      registry: routerRegistry(),
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
  // ---- Dashboard /memory (read-only) ----

  /**
   * Exactly what recall puts in front of the model for this key — the agent's own two calls, not
   * a dashboard copy of them, so the page cannot show one thing while the model reads another.
   * No alert text, so the "possibly related" tier (full-text on that text) is not part of it.
   */
  async memoryRecall(labels: Record<string, string>): Promise<{ incidents: string; remediations: string }> {
    const [incidents, remediations] = await Promise.all([this.recallIncidents(labels), this.recallRemediations(labels)]);
    return { incidents, remediations };
  }

  conversationThreads(): Promise<ThreadSummary[]> {
    return this.memory.list();
  }

  conversationThread(threadId: string): Promise<ThreadMemory | null> {
    return this.memory.inspect(threadId);
  }

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
    const s = newRunState(selectForThread(this.skills, this.threadSkills, threadId, `${modeTag(mode)}\n${opts.trigger ?? userMessage}`));
    this.persistThreadSkills(threadId, s.skills);

    // SECURITY: [WRITE] tools never enter the agentic loop — the model must not be able
    // to execute state-changing actions on its own. Write tools are reachable only via
    // the proposal dry-run and the human-approved execution path (direct callTool).
    const tools = withDelegateTool(
      this.mcp.getTools().filter((t) => !t.description.startsWith("[WRITE]")),
      config.subagents,
      { depth, maxToolRounds }
    );
    const systemPrompt = buildStaticSystemPrompt();
    // Every exit from this loop goes through here, so the footer is never missing from the
    // paths that matter most — the timeout and the out-of-steps replies are exactly where a
    // reader wants to know how long it ran and on which model.
    //
    // The completion line is emitted HERE rather than where the model stops talking, and that is
    // a fix, not a tidy-up: it used to sit above the log-gap gate, so a run that took the extra
    // round logged "Investigation complete in 28451ms (2 LLM calls)" and then kept going, twice
    // in one thread on 2026-09-15. It also never fired at all on the deadline and out-of-steps
    // exits, which are the two a reader most wants the duration for.
    const done = (text: string): string => finalizeAnswer(ctx, s, this.trace, text);

    // A delegate inherits a deadline instead of taking a fresh one: its whole point is to finish
    // inside the parent's budget, and config.investigationTimeoutMs would hand it the full 300s
    // the parent is already spending.
    const deadline = opts.deadline ?? investigationStart + config.investigationTimeoutMs;
    const ctx: RunCtx = { threadId, mode, depth, maxToolRounds, maxIterations, deadline, startedAt: investigationStart, tools, systemPrompt, opts };

    while (s.iterations < maxIterations) {
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
        const notice = forcedFinalAnswer({ toolRounds: s.toolRounds, maxToolRounds, iterations: s.iterations, maxIterations, depth, outOfTime: true });
        if (notice && !s.toolsDisabled && s.toolRounds > 0) {
          s.toolsDisabled = true;
          await this.memory.append(threadId, { role: "user", content: [{ type: "text", text: notice }] });
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${s.iterations} LLM calls ` +
            `and ${s.toolRounds} tool rounds — forcing a final answer from the evidence gathered`
          );
          this.trace.gate(threadId, "deadline", "forced");
        } else {
          // Nothing gathered, or the answer turn is already spent. Either way there is no
          // finding to salvage and the apology is the truthful reply.
          logger.warn(
            `[${threadId}] Investigation exceeded its ${overBy}ms budget after ${s.iterations} LLM calls ` +
            `(tool rounds: ${s.toolRounds}, answer turn ${s.toolsDisabled ? "already spent" : "not reachable"})`
          );
          this.trace.gate(threadId, "deadline", "apology");
          return done("⚠️ Investigation exceeded its time budget. Please review the partial findings above and try a more specific query.");
        }
      }
      s.iterations++;

      const assembled = assembleRequest({
        history: await this.memory.get(threadId),
        systemPrompt,
        tools: s.toolsDisabled ? [] : tools,
        skills: s.skills,
        budget: this.budget,
      });
      logger.debug(
        `[${threadId}] LLM call #${s.iterations} (history: ${assembled.messages.length} messages, ` +
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
        response = await this.llm.chat(assembled.messages, s.toolsDisabled ? [] : tools, assembled.systemPrompt);
        s.lastResponse = response;
      } catch (err) {
        // the LLM call is the one hop that leaves this process; without this line a
        // worker/queue failure surfaced only as a generic Slack error with no context
        logger.error(`[${threadId}] LLM call #${s.iterations} failed after ${Date.now() - llmStart}ms: ${errDetail(err)}`);
        throw err;
      }
      const llmMs = Date.now() - llmStart;

      // what the model actually produced — the missing piece when Slack shows garbage but
      // the logs only say "stop=end_turn"
      logger.debug(
        `[${threadId}] LLM #${s.iterations} content: [${response.content.map((c) => c.type).join(", ") || "empty"}]` +
        (extractText(response.content) ? ` text="${truncate(extractText(response.content), 200)}"` : "")
      );

      if (response.usage) {
        s.totalUsage = addUsage(s.totalUsage, response.usage);
        this.recordUsage(threadId, response);
        logger.debug(
          `[${threadId}] LLM #${s.iterations} ${llmMs}ms | ` +
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
        const summary = extractText(response.content);
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
        if (namesToolOnly(summary, s.toolsDisabled ? [] : tools)) {
          logger.warn(
            `[${threadId}] final answer is just the tool name \`${summary.trim()}\` — the backend named a ` +
            `tool instead of calling it. Check its tool-call parser; on LLM_PROVIDER=router this escalates instead.`
          );
        }
        // Before every other gate: an alert answered with no tool call at all has not been
        // investigated, and whatever the other gates would ask about is downstream of that.
        const noFetch = noToolRoundLeft({ toolsDisabled: s.toolsDisabled, iterations: s.iterations, maxIterations });
        if (needsEvidence({ mode, toolRounds: s.toolRounds, nudged: s.noEvidenceNudged, toolsDisabled: noFetch, answer: summary })) {
          s.noEvidenceNudged = true;
          s.preNudgeSummary = summary;
          s.toolRoundsAtNudge = s.toolRounds;
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
          demandsLogs: demandsLogs(s.skills),
          sawLogLines: s.sawLogLines,
          nudged: s.logGapNudged,
          toolsDisabled: noFetch,
          toolRounds: s.toolRounds,
          toolRoundsAtNudge: s.toolRoundsAtNudge,
          heldBy: s.heldBy,
        });
        if (gap === "restore") {
          // Gate-agnostic on purpose: both gates hold their answer in the same slot, so this
          // sentence has to be true of whichever one spent the round.
          logger.warn(
            `[${threadId}] the extra round fetched nothing — keeping the pre-nudge answer ` +
            `(${s.preNudgeSummary.length} chars) over the retry's ${summary.length}`
          );
          this.trace.resolveNudge(threadId, "restored");
          return done(s.preNudgeSummary);
        }
        if (gap === "nudge") {
          s.logGapNudged = true;
          s.preNudgeSummary = summary;
          s.heldBy = "tools";
          s.toolRoundsAtNudge = s.toolRounds;
          logger.info(
            `[${threadId}] answered after ${s.toolRounds} tool round(s) with no log lines, while ` +
            `[${s.skills.map((s) => s.name).join(", ")}] read logs — one more round`
          );
          this.trace.gate(threadId, "log-gap", "nudge", `after ${s.toolRounds} tool round(s)`);
          await this.memory.append(threadId, { role: "user", content: LOG_GAP_NOTICE });
          continue;
        }
        if (nudgeLostRca({ mode, heldBy: s.heldBy, before: s.preNudgeSummary, after: summary })) {
          logger.warn(
            `[${threadId}] the extra round replaced an RCA with something that is not one ` +
            `("${truncate(summary, 80)}") — keeping the RCA`
          );
          this.trace.gate(threadId, "nudge-lost-rca", "kept", truncate(summary, 200));
          this.trace.resolveNudge(threadId, "kept-earlier");
          return done(s.preNudgeSummary);
        }
        // Second gate, same hold slot: only one nudge may be outstanding, so this is reached only
        // when the log gap did not take the round. Evidence-driven, so it is safe in every mode —
        // the trigger is a pull failure in tool output, not a guess about the question.
        if (!s.imageGapNudged && !noFetch && s.toolRounds > 0) {
          const repo = imageGapRepo(summary, observedText(await this.memory.get(threadId)));
          if (repo) {
            s.imageGapNudged = true;
            s.preNudgeSummary = summary;
            s.heldBy = "tools";
            s.toolRoundsAtNudge = s.toolRounds;
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
        if (!s.rcaGapNudged && s.iterations < maxIterations && mode === "alert" && isRcaResponse(summary)) {
          const missing = rcaGaps(summary);
          if (missing.length > 0) {
            s.rcaGapNudged = true;
            s.preNudgeSummary = summary;
            s.heldBy = "rca";
            s.toolRoundsAtNudge = s.toolRounds;
            logger.info(`[${threadId}] RCA is missing ${missing.join(", ")} — one more round to complete it`);
            this.trace.gate(threadId, "rca-completeness", "nudge", missing.join(", "));
            await this.memory.append(threadId, { role: "user", content: rcaGapNotice(missing) });
            continue;
          }
        }
        // The completion round replaces what it was given, so it can lose as well as gain. The
        // other gates decide that on whether the extra round ran any tools; this one can compare
        // the thing itself, which is the better test when it is available.
        if (s.rcaGapNudged && s.preNudgeSummary !== "" && rcaGaps(summary).length > rcaGaps(s.preNudgeSummary).length) {
          logger.warn(
            `[${threadId}] the completion round came back with more missing than it was given ` +
            `(${rcaGaps(summary).join(", ")}) — keeping the earlier answer`
          );
          this.trace.resolveNudge(threadId, "kept-earlier");
          return done(s.preNudgeSummary);
        }
        return done(summary);
      }

      if (response.stopReason === "tool_use") {
        if (s.toolsDisabled) {
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
          if (delegated.sawLogLines) s.sawLogLines = true;
        }

        if (maxToolRounds !== Infinity) {
          // Namespace scope lock: the first tool round defines the question's namespaces.
          if (s.scopeNamespaces === null) {
            s.scopeNamespaces = namespacesOf(executable);
          } else {
            const drift = outOfScope(executable, s.scopeNamespaces);
            if (drift.length > 0) {
              const scopeList = [...s.scopeNamespaces].join(", ");
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
        reportProgress(opts.onProgress, s.toolRounds, [...executable, ...delegateCalls], (err) =>
          logger.debug(`[${threadId}] progress callback threw, ignored: ${errDetail(err)}`)
        );

        s.totalToolCalls += executable.length;
        const executed = executable.length > 0 ? await this.executeToolCalls(threadId, executable, opts.namespace) : [];
        if (!s.sawLogLines) {
          const logIds = new Set(executable.filter((t) => LOG_TOOLS.has(t.name ?? "")).map((t) => t.id));
          s.sawLogLines = executed.some(
            (r) => r.type === "tool_result" && logIds.has(r.tool_use_id) && returnedLogLines(String(r.content ?? ""))
          );
        }
        const trimmedResults = sanitizeContentBlocks([...executed, ...delegateResults, ...refusals]);
        // Appended, never unshifted: Anthropic requires every tool_result block to come first in
        // its user message, and a text block ahead of them is a 400.
        if (executed.length > 0) trimmedResults.push({ type: "text", text: evidenceStamp() });

        s.toolRounds++;
        const notice = forcedFinalAnswer({ toolRounds: s.toolRounds, maxToolRounds, iterations: s.iterations, maxIterations, depth });
        if (notice) {
          s.toolsDisabled = true;
          trimmedResults.push({ type: "text", text: notice });
          logger.info(
            notice === TOOL_BUDGET_NOTICE
              ? `[${threadId}] tool budget (${maxToolRounds} rounds) reached — forcing final answer`
              : `[${threadId}] iteration ceiling (${maxIterations}) reached after ${s.toolRounds} tool rounds — forcing final answer`
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
          const before = s.skills.length;
          s.skills = selectForThread(this.skills, this.threadSkills, threadId, text);
          const added = s.skills.slice(before).map((s) => s.name);
          if (added.length > 0) {
            this.persistThreadSkills(threadId, s.skills);
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
      const text = typeof m.content === "string" ? m.content : extractText(m.content);
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
    const text = extractText(r.content);
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

  // ---- Guarded Remediation — the bodies live in remediation/remediator.ts; these delegate. ----

  proposeRemediation(...a: Parameters<Remediator["proposeRemediation"]>): ReturnType<Remediator["proposeRemediation"]> { return this.remediator.proposeRemediation(...a); }
  refusalFor(...a: Parameters<Remediator["refusalFor"]>): ReturnType<Remediator["refusalFor"]> { return this.remediator.refusalFor(...a); }
  scaleRefusalFor(...a: Parameters<Remediator["scaleRefusalFor"]>): ReturnType<Remediator["scaleRefusalFor"]> { return this.remediator.scaleRefusalFor(...a); }
  imageRefusalFor(...a: Parameters<Remediator["imageRefusalFor"]>): ReturnType<Remediator["imageRefusalFor"]> { return this.remediator.imageRefusalFor(...a); }
  guardRefusalFor(...a: Parameters<Remediator["guardRefusalFor"]>): ReturnType<Remediator["guardRefusalFor"]> { return this.remediator.guardRefusalFor(...a); }
  noOpResourcesRefusalFor(...a: Parameters<Remediator["noOpResourcesRefusalFor"]>): ReturnType<Remediator["noOpResourcesRefusalFor"]> { return this.remediator.noOpResourcesRefusalFor(...a); }
  kindRefusalFor(...a: Parameters<Remediator["kindRefusalFor"]>): ReturnType<Remediator["kindRefusalFor"]> { return this.remediator.kindRefusalFor(...a); }
  noOpImageRefusalFor(...a: Parameters<Remediator["noOpImageRefusalFor"]>): ReturnType<Remediator["noOpImageRefusalFor"]> { return this.remediator.noOpImageRefusalFor(...a); }
  replacementRefusalFor(...a: Parameters<Remediator["replacementRefusalFor"]>): ReturnType<Remediator["replacementRefusalFor"]> { return this.remediator.replacementRefusalFor(...a); }
  resolveOverlayPath(...a: Parameters<Remediator["resolveOverlayPath"]>): ReturnType<Remediator["resolveOverlayPath"]> { return this.remediator.resolveOverlayPath(...a); }
  executeRemediation(...a: Parameters<Remediator["executeRemediation"]>): ReturnType<Remediator["executeRemediation"]> { return this.remediator.executeRemediation(...a); }
  scheduleRemediationCheck(...a: Parameters<Remediator["scheduleRemediationCheck"]>): ReturnType<Remediator["scheduleRemediationCheck"]> { return this.remediator.scheduleRemediationCheck(...a); }
  runDueRemediationChecks(...a: Parameters<Remediator["runDueRemediationChecks"]>): ReturnType<Remediator["runDueRemediationChecks"]> { return this.remediator.runDueRemediationChecks(...a); }
  rejectRemediation(...a: Parameters<Remediator["rejectRemediation"]>): ReturnType<Remediator["rejectRemediation"]> { return this.remediator.rejectRemediation(...a); }

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
    const parsed = parseFeedbackJson(extractText(response.content));
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
      const out = extractText(response.content);
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
