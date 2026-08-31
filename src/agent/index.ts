import { createLLMClient } from "./llm/index.js";
import { SERIALIZED_BLOCKS } from "./llm/router.js";
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
import { groundingGaps } from "./grounding/index.js";
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
import { parseProposal, buildProposalPrompt, PROPOSAL_SYSTEM, type Proposal } from "./remediation/proposal.js";
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
 * The iteration ceiling. Says nothing about output format: the alert path lands here and its
 * answer IS the RCA, so the system prompt and the response-mode marker keep deciding the shape.
 */
export const ITERATION_CEILING_NOTICE =
  "[ITERATION LIMIT REACHED — this is your final turn and tool calls are disabled. Write the answer now " +
  "from the evidence already gathered. Do not ask for more data and do not promise follow-up work. " +
  "Thin evidence is not a reason to withhold a conclusion: give your best root-cause hypothesis, and if " +
  "you are producing an RCA set Confidence to Low and name the one check that would confirm it.]";

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
}): string | null {
  const reached =
    state.toolRounds >= state.maxToolRounds || state.iterations >= state.maxIterations - 1;
  if ((state.depth ?? 0) > 0) return reached ? DELEGATE_BUDGET_NOTICE : null;
  if (state.toolRounds >= state.maxToolRounds) return TOOL_BUDGET_NOTICE;
  if (state.iterations >= state.maxIterations - 1) return ITERATION_CEILING_NOTICE;
  return null;
}

// Per-thread skill sets live in memory, like ConversationMemory's rcaThreads. Bounded so a
// long-running pod cannot accumulate one entry per thread it has ever seen; eviction is
// insertion-order, and a thread that outlives its entry simply re-selects from its next message.
export const MAX_TRACKED_THREADS = 500;
// Ceiling on the playbooks one investigation may accumulate. Selection runs again on every
// tool round (see runInvestigation), and each of those rounds may match up to
// MAX_MATCHED_SKILLS more — without a ceiling a long investigation ends up carrying the whole
// directory. Earliest wins: the alert's own playbook outranks one a later log line suggested.
export const MAX_THREAD_SKILLS = 5;

/**
 * The last four exist for sub-agent delegation: a delegate is the same loop run with a smaller
 * budget, a borrowed deadline, and no delegate tool of its own. They are options rather than a
 * second loop because the guards that matter — the [WRITE] filter, the namespace scope lock, the
 * log fan-out cap, the forced final answer — live in that loop, and a copy of it is a copy of
 * them that drifts.
 */
export interface InvestigateOptions {
  maxToolRounds?: number;
  trigger?: string;
  /** Defaults to MAX_ITERATIONS. */
  maxIterations?: number;
  /** Absolute epoch ms. Defaults to now + config.investigationTimeoutMs. */
  deadline?: number;
  /** 0 = the lead investigation, 1 = a delegate. Only depth 0 is offered the delegate tool. */
  depth?: number;
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
    if (text.trim()) out.push(text);
  }
  return out;
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

  storeIncident(labels: Record<string, string>, rca: string, channel?: string, threadTs?: string): Promise<number | null> {
    return this.incidents.store(labels, rca, channel && threadTs ? { channel, threadTs } : undefined);
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

    // Deterministic tool budget. Prompt-level scope rules alone don't hold: the model
    // kept chasing anomalies into other namespaces on plain data questions. Once the
    // budget is spent, the next LLM call gets NO tools — it must answer with what it has.
    const maxToolRounds = opts.maxToolRounds ?? Infinity;
    const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    const depth = opts.depth ?? 0;
    let toolRounds = 0;
    let toolsDisabled = false;
    let scopeNamespaces: Set<string> | null = null; // set by the first tool round (conversation mode)

    const isFollowUp = await this.memory.hasRca(threadId);

    // for first message: prepend time context
    // for follow-up: prepend explicit mode instruction so LLM doesn't default to RCA format
    const messageToAppend = isFollowUp
      ? `[FOLLOW-UP — conversation mode, do NOT use RCA format. Out-of-scope requests (code, general questions) are still declined in one line per Scope of Work, even mid-thread.]\n${userMessage}`
      : `${buildTimeContext()}\n\n${userMessage}`;

    await this.memory.append(threadId, { role: "user", content: messageToAppend });

    // Matched on the alert text alone, not on userMessage: src/app/index.ts prepends recalled
    // prior incidents, and a previous incident's RCA must not select this one's playbook.
    // A thread outlives a pod: its conversation comes back from Redis, so its playbooks have to
    // as well or the follow-up answers with a different skill set than the turn it follows.
    await this.rehydrateThreadSkills(threadId);
    let skills = selectForThread(this.skills, this.threadSkills, threadId, opts.trigger ?? userMessage);
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
        logger.warn(`[${threadId}] Investigation exceeded its ${deadline - investigationStart}ms budget after ${iterations} LLM calls`);
        return "⚠️ Investigation exceeded its time budget. Please review the partial findings above and try a more specific query.";
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
        const duration = Date.now() - investigationStart;
        logger.info(
          `[${threadId}] Investigation complete in ${duration}ms (${iterations} LLM calls) | ` +
          `total tokens — in=${totalUsage.inputTokens} out=${totalUsage.outputTokens} ` +
          `cache_read=${totalUsage.cacheReadTokens} cache_write=${totalUsage.cacheCreationTokens}`
        );
        const summary = this.extractText(response.content);
        if (!summary) {
          // never return empty — Slack chat.postMessage rejects an empty text with `no_text`
          logger.warn(`[${threadId}] LLM returned an empty final response (stop=${response.stopReason})`);
          if (response.stopReason === "max_tokens") {
            // reasoning models can spend the entire output budget thinking and emit no text
            return "⚠️ The model hit its output-token limit before writing the answer (its reasoning consumed the whole budget). Try again — or raise `LLM_MAX_TOKENS` / set `LLM_REASONING_EFFORT=low` on the llm-worker.";
          }
          return "⚠️ The investigation finished but the model returned an empty response. Please re-run or rephrase the request.";
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
        return summary;
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

        const executed = executable.length > 0 ? await this.executeToolCalls(threadId, executable) : [];
        const trimmedResults = sanitizeContentBlocks([...executed, ...delegateResults, ...refusals]);

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
    return "⚠️ Investigation ran out of steps before the model wrote a conclusion. Nothing was lost — re-run it, or ask about one specific symptom to narrow the search.";
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
        }
      })
    );
  }

  private async executeToolCalls(threadId: string, content: ContentBlock[]): Promise<ContentBlock[]> {
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
        const start = Date.now();
        logger.info(`[${threadId}] → tool: ${name} input: ${truncate(JSON.stringify(input))}`);
        try {
          const result = await this.mcp.callTool(name!, input as Record<string, unknown>);
          logger.info(`[${threadId}] ← tool: ${name} ok (${Date.now() - start}ms, ${result.length} chars)`);
          return { type: "tool_result" as const, tool_use_id: id, content: guard(result, name) };
        } catch (err) {
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
  async ungroundedNames(threadId: string, answer: string): Promise<string[]> {
    const history = await this.memory.get(threadId).catch(() => [] as Message[]);
    const gaps = groundingGaps(answer, history);
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
    rca: string
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
    const response = await withRoute("light", () =>
      this.llm.chat([{ role: "user", content: buildProposalPrompt(labels, rca) }], [], PROPOSAL_SYSTEM)
    );
    this.recordUsage(null, response); // no Slack thread at this call site — never invent one
    const text = this.extractText(response.content);
    const proposal = parseProposal(text);
    if (!proposal) {
      logger.info(`[remediation] no actionable proposal from model: ${truncate(text, 200)}`);
      return null;
    }
    // the specific proposed action must actually be registered on the server
    if (!this.mcp.getTools().some((t) => t.name === proposal.action)) {
      logger.info(`[remediation] proposed action ${proposal.action} is not registered on the MCP server`);
      return null;
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
      reason: proposal.reason,
      summary: proposal.summary,
    });
    if (typeof id !== "number") {
      logger.info(`[remediation] not stored: ${id === "duplicate" ? "an active card already exists for this incident" : "store failure"}`);
      return null;
    }

    return { id, proposal, dryRunSummary: truncate(dryRun, 400) };
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
  ): Promise<{ text: string; target?: { namespace: string; name: string } }> {
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
      await this.remediations.finish(id, ok, result);
      if (!ok) return { text: `❌ *Remediation failed* — ${label}:\n\`${truncate(result, 400)}\`` };
      // delete_pod targets a pod, not a workload — drop the random suffix so verification
      // matches the REPLACEMENT pod (same ReplicaSet hash / StatefulSet base)
      const targetName = String(toolParams.name ?? String(toolParams.pod ?? "").replace(/-[a-z0-9]+$/, ""));
      return {
        text: `✅ *Remediation executed* — ${label} (approved by <@${approvedBy}>)\n\`${truncate(result, 400)}\``,
        target: { namespace: String(toolParams.namespace ?? ""), name: targetName },
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
