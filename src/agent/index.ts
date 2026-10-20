import { createLLMClient } from "./llm/index.js";
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
import { buildStaticSystemPrompt } from "./prompts/system.js";
import { resolveBudget } from "./context/resolve-budget.js";
import { estimateTokens, type Budget } from "./context/budget.js";
import { loadSkills, resolveSkillsDir, type SkillRegistry } from "./skills/index.js";
import { groundingGaps } from "./grounding/index.js";
import { parseFeedbackJson, buildExtractionPrompt, EXTRACTION_SYSTEM, tracesToHumans } from "./feedback/index.js";
import { RemediationStore } from "./remediation/index.js";
import { RemediationCheckStore, alertState } from "./remediation/verify.js";
import { SqsGitOpsClient } from "./gitops/sqs.js";
import { collectChanges, type ChangeTimeline, type HistoryPayload } from "./changes/index.js";
import { PostmortemStore, type LatestDraft } from "./postmortem/store.js";
import { type PostmortemFacts } from "./postmortem/facts.js";
import { buildPostmortemPrompt, assemblePostmortem, POSTMORTEM_SYSTEM } from "./postmortem/draft.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import { type LLMClient, type LLMResponse, type Message, type ToolDefinition } from "./llm/types.js";
import { initRedis, pingRedis } from "../db/redis.js";
import logger from "../utils/logger/index.js";
import { errDetail } from "../utils/logger/index.js";
import { withRoute, withTrace } from "../utils/trace/index.js";
import { TraceRecorder, instrumentLLM, instrumentMCP, type GateName } from "./trace/index.js";
import { TraceStore } from "./trace/store.js";
import { lastToolResultIn } from "./remediation/evidence-refusals.js";
import { ThreadSkills, SkillView } from "./skills/thread.js";
import { Remediator } from "./remediation/remediator.js";
import { InvestigationRunner } from "./loop/runner.js";
import { extractText } from "./loop/control.js";
import { type InvestigateOptions } from "./loop/run-state.js";

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
  private readonly runner: InvestigationRunner;
  // The onboarding cluster model (agent/onboarding), 5 min per namespace scope — see clusterModel().
  private readonly clusterModels: ClusterModelCache;
  private readonly skills: SkillRegistry;
  private readonly threadSkills: ThreadSkills = new Map();
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
    this.runner = new InvestigationRunner({
      get mcp() { return self.mcp; },
      get llm() { return self.llm; },
      get memory() { return self.memory; },
      get skills() { return self.skills; },
      get threadSkills() { return self.threadSkills; },
      trace: () => self.trace,
      budget: () => self.budget,
      investigate: (threadId, userMessage, opts) => self.investigate(threadId, userMessage, opts),
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
      this.runner.run(threadId, userMessage, opts).finally(() => this.trace.finish(threadId))
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
