import { createLLMClient } from "./llm/index.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { IncidentMemory } from "./incidents/index.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { buildStaticSystemPrompt, buildTimeContext } from "./prompts/system.js";
import { trimHistory, sanitizeContentBlocks } from "./context/index.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import type { LLMClient, Message, ContentBlock, TokenUsage } from "./llm/types.js";
import { initRedis, pingRedis } from "../redis.js";
import logger from "../utils/logger/index.js";

const MAX_ITERATIONS = 10;

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

  storeIncident(labels: Record<string, string>, rca: string): Promise<void> {
    return this.incidents.store(labels, rca);
  }

  async investigate(threadId: string, userMessage: string): Promise<string> {
    logger.info(`[${threadId}] Investigation started`);
    logger.debug(`[${threadId}] Issue: ${truncate(userMessage, 120)}`);
    const investigationStart = Date.now();

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
      const response = await this.llm.chat(messages, tools, systemPrompt);
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
          return "⚠️ The investigation finished but the model returned an empty response. Please re-run or rephrase the request.";
        }
        return summary;
      }

      if (response.stopReason === "tool_use") {
        const rawResults = await this.executeToolCalls(threadId, response.content);
        const trimmedResults = sanitizeContentBlocks(rawResults);
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
