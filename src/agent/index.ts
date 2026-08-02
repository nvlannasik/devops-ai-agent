import { createLLMClient } from "./llm/index.js";
import { SERIALIZED_BLOCKS } from "./llm/router.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { IncidentMemory } from "./incidents/index.js";
import { UsageStore } from "./usage/index.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { buildStaticSystemPrompt, buildTimeContext } from "./prompts/system.js";
import { trimHistory, sanitizeContentBlocks } from "./context/index.js";
import { namespacesOf, outOfScope } from "./scope/index.js";
import { parseFeedbackJson, buildExtractionPrompt, EXTRACTION_SYSTEM } from "./feedback/index.js";
import { RemediationStore } from "./remediation/index.js";
import { parseProposal, buildProposalPrompt, PROPOSAL_SYSTEM, type Proposal } from "./remediation/proposal.js";
import { SqsGitOpsClient } from "./gitops/sqs.js";
import { parseGitOpsPreview, type GitOpsPreview } from "./gitops/preview.js";
import type { GitOpsDrift } from "./gitops/types.js";
import { FLUX_HELMRELEASE, FLUX_KUSTOMIZATION, kustomizeRefOf, fluxPathToPrefix } from "./gitops/overlay.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import type { LLMClient, Message, ContentBlock, TokenUsage } from "./llm/types.js";
import { initRedis, pingRedis } from "../redis.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { withRoute, withTrace } from "../utils/trace/index.js";

const MAX_ITERATIONS = 10;
// conversation mode: max distinct pods whose logs may be fetched in one round — a generic
// name matching many pods ("metallb" → 8) should produce a "which one?" question, not a dump
const MAX_LOG_FANOUT = 2;

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
  private gitops: SqsGitOpsClient | null;

  constructor() {
    this.llm = createLLMClient();
    this.mcp = new MCPClient();
    this.memory = new ConversationMemory(); // default in-memory; replaced in initialize() if Redis configured
    this.incidents = new IncidentMemory(null); // no-op until initialize() wires Postgres
    this.usage = new UsageStore(null); // no-op until initialize() wires Postgres
    this.remediations = new RemediationStore(null); // no-op until initialize() wires Postgres
    this.gitops = config.gitops.enabled ? new SqsGitOpsClient() : null; // GitOps PR-flow bridge (opt-in)
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
      logger.info(`Incident memory: Postgres ${host}:${port}/${database} sslmode=${sslMode}`);
    } else {
      logger.info("Incident memory: disabled (set DB_HOST to enable)");
    }
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
  recallIncidents(labels: Record<string, string>): Promise<string> {
    return this.incidents.recall(labels);
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
      return `- ${date}: ${r.summary} — ${r.status}${pr}`;
    });
    return [
      `## Previously remediated — same alert${labels.namespace ? ` in namespace ${labels.namespace}` : ""}`,
      ...lines,
      `These are prior actions taken for this recurring issue. Prefer confirming whether the same fix still applies over proposing a brand-new one.`,
    ].join("\n");
  }

  storeIncident(labels: Record<string, string>, rca: string, channel?: string, threadTs?: string): Promise<number | null> {
    return this.incidents.store(labels, rca, channel && threadTs ? { channel, threadTs } : undefined);
  }

  // Everything below runs inside the trace context so outbound SQS requests carry the
  // threadId — that is what lets you grep one id across the agent log, the llm-worker
  // log, and the Slack thread when an answer comes out wrong.
  investigate(threadId: string, userMessage: string, opts: { maxToolRounds?: number } = {}): Promise<string> {
    return withTrace(threadId, () => this.runInvestigation(threadId, userMessage, opts));
  }

  private async runInvestigation(threadId: string, userMessage: string, opts: { maxToolRounds?: number } = {}): Promise<string> {
    logger.info(`[${threadId}] Investigation started`);
    logger.debug(`[${threadId}] Issue: ${truncate(userMessage, 120)}`);
    const investigationStart = Date.now();

    // Deterministic tool budget. Prompt-level scope rules alone don't hold: the model
    // kept chasing anomalies into other namespaces on plain data questions. Once the
    // budget is spent, the next LLM call gets NO tools — it must answer with what it has.
    const maxToolRounds = opts.maxToolRounds ?? Infinity;
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

    // SECURITY: [WRITE] tools never enter the agentic loop — the model must not be able
    // to execute state-changing actions on its own. Write tools are reachable only via
    // the proposal dry-run and the human-approved execution path (direct callTool).
    const tools = this.mcp.getTools().filter((t) => !t.description.startsWith("[WRITE]"));
    const systemPrompt = buildStaticSystemPrompt();
    let iterations = 0;
    let totalUsage = zeroUsage();

    const deadline = investigationStart + config.investigationTimeoutMs;

    while (iterations < MAX_ITERATIONS) {
      if (Date.now() > deadline) {
        logger.warn(`[${threadId}] Investigation exceeded ${config.investigationTimeoutMs}ms budget after ${iterations} LLM calls`);
        return "⚠️ Investigation exceeded its time budget. Please review the partial findings above and try a more specific query.";
      }
      iterations++;

      const messages = trimHistory(await this.memory.get(threadId));
      logger.debug(`[${threadId}] LLM call #${iterations} (history: ${messages.length} messages)`);

      const llmStart = Date.now();
      let response;
      try {
        response = await this.llm.chat(messages, toolsDisabled ? [] : tools, systemPrompt);
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
        void this.usage.record({
          threadTs: threadId,
          backend: response.backend ?? null,
          route: response.route ?? null,
          model: config.llm.claude.model ?? null,
          usage: response.usage,
        });
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
        const trimmedResults = sanitizeContentBlocks([...executed, ...refusals]);

        toolRounds++;
        if (toolRounds >= maxToolRounds) {
          toolsDisabled = true;
          trimmedResults.push({
            type: "text",
            text: "[TOOL BUDGET REACHED — compose your final answer now from the data above. Tool calls are disabled. Reply in plain Slack mrkdwn — do NOT use the RCA incident format. If something looked anomalous, mention it in one line and offer to investigate.]",
          });
          logger.info(`[${threadId}] tool budget (${maxToolRounds} rounds) reached — forcing final answer`);
        }

        await this.memory.append(threadId, { role: "user", content: trimmedResults });
      }
    }

    logger.warn(`[${threadId}] Investigation hit max iterations (${MAX_ITERATIONS})`);
    return "⚠️ Investigation reached maximum iterations. Please review the findings above and try a more specific query.";
  }

  private async executeToolCalls(threadId: string, content: ContentBlock[]): Promise<ContentBlock[]> {
    const toolUses = content.filter((c) => c.type === "tool_use");

    // run all tool calls in parallel — k8s/prometheus/loki calls are independent
    return Promise.all(
      toolUses.map(async (toolUse) => {
        const { id, name, input } = toolUse;
        // second layer of the write-tool exclusion (first: filtered from the tools list)
        const def = this.mcp.getTools().find((t) => t.name === name);
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
          return { type: "tool_result" as const, tool_use_id: id, content: result };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[${threadId}] ← tool: ${name} failed (${Date.now() - start}ms): ${errMsg}`);
          return { type: "tool_result" as const, tool_use_id: id, content: `Error: ${errMsg}` };
        }
      })
    );
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

    const response = await this.llm.chat([{ role: "user", content: buildProposalPrompt(labels, rca) }], [], PROPOSAL_SYSTEM);
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
      // delete_pod targets a pod, not a workload — drop the random suffix so the 90s
      // status check matches the REPLACEMENT pod (same ReplicaSet hash / StatefulSet base)
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
  // target — nothing is live until the PR merges + Flux syncs, so there's no 90s pod check.
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

  // Post-remediation status check — deterministic, no LLM call: list the namespace's
  // pods and keep the target workload's lines (pod names carry the workload prefix).
  async remediationStatus(namespace: string, name: string): Promise<string> {
    const out = await this.mcp.callTool("k8s_list_pods", { namespace });
    const lines = out.split("\n").filter((l) => l.includes(name));
    return lines.length > 0 ? lines.join("\n") : truncate(out, 500);
  }

  async rejectRemediation(id: number, by: string): Promise<string> {
    const flipped = await this.remediations.reject(id, by);
    return flipped ? `🚫 Remediation rejected by <@${by}>. Nothing was executed.` : "⚠️ Already handled (or expired).";
  }

  // D. resolved-alert loop: mark the incident resolved, return its Slack thread (or null).
  async resolveIncident(labels: Record<string, string>): Promise<{ channel: string; threadTs: string } | null> {
    return this.incidents.markResolved(labels);
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
