import { createLLMClient } from "./llm/index.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { IncidentMemory } from "./incidents/index.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { buildStaticSystemPrompt, buildTimeContext } from "./prompts/system.js";
import { trimHistory, sanitizeContentBlocks } from "./context/index.js";
import { namespacesOf, outOfScope } from "./scope/index.js";
import { parseFeedbackJson, buildExtractionPrompt, EXTRACTION_SYSTEM } from "./feedback/index.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import type { LLMClient, Message, ContentBlock, TokenUsage } from "./llm/types.js";
import { initRedis, pingRedis } from "../redis.js";
import logger from "../utils/logger/index.js";

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

  constructor() {
    this.llm = createLLMClient();
    this.mcp = new MCPClient();
    this.memory = new ConversationMemory(); // default in-memory; replaced in initialize() if Redis configured
    this.incidents = new IncidentMemory(null); // no-op until initialize() wires Postgres
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
      this.incidents = new IncidentMemory(pool);
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

  storeIncident(labels: Record<string, string>, rca: string, channel?: string, threadTs?: string): Promise<number | null> {
    return this.incidents.store(labels, rca, channel && threadTs ? { channel, threadTs } : undefined);
  }

  async investigate(threadId: string, userMessage: string, opts: { maxToolRounds?: number } = {}): Promise<string> {
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
      ? `[FOLLOW-UP — conversation mode, do NOT use RCA format]\n${userMessage}`
      : `${buildTimeContext()}\n\n${userMessage}`;

    await this.memory.append(threadId, { role: "user", content: messageToAppend });

    const tools = this.mcp.getTools();
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
      const response = await this.llm.chat(messages, toolsDisabled ? [] : tools, systemPrompt);
      const llmMs = Date.now() - llmStart;

      if (response.usage) {
        totalUsage = addUsage(totalUsage, response.usage);
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
    const response = await this.llm.chat(
      [
        {
          role: "user",
          content:
            "Rewrite this as a short conversational Slack answer (mrkdwn). Keep the facts and any log excerpts. " +
            "Remove the incident/RCA structure entirely (severity, root cause, evidence, ruled out, recommended actions, impact, confidence). " +
            "End with at most one short offer to investigate if something looked genuinely wrong.\n\n---\n\n" +
            text,
        },
      ],
      [],
      "You reformat DevOps chatbot replies for Slack. Output only the rewritten reply in Slack mrkdwn."
    );
    const out = this.extractText(response.content);
    return out || text;
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
    await this.incidents.close();
  }
}
