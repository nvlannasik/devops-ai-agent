import { createLLMClient } from "./llm/index.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { buildStaticSystemPrompt, buildTimeContext } from "./prompts/system.js";
import { trimHistory, sanitizeContentBlocks } from "./context/index.js";
import { config } from "../config/index.js";
import { truncate } from "../utils/truncate/index.js";
import type { LLMClient, Message, ContentBlock, TokenUsage } from "./llm/types.js";
import { Redis } from "ioredis";
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

  constructor() {
    this.llm = createLLMClient();
    this.mcp = new MCPClient();
    this.memory = new ConversationMemory(); // default in-memory; replaced in initialize() if Redis configured
  }

  async initialize(): Promise<void> {
    await this.mcp.connect();
    if (config.memory.backend === "redis") {
      const { host, port, db, username, password, tls } = config.memory.redis;
      const redis = new Redis({
        host,
        port,
        db,
        username,
        password,
        tls: tls ? {} : undefined,
      });
      redis.on("error", (err: Error) => logger.error(`Redis error: ${err.message}`));
      await redis.ping(); // verify connection at startup — fails fast if unreachable
      this.memory = new ConversationMemory(redis);
      logger.info(`Memory backend: Redis ${host}:${port} db=${db} tls=${tls}`);
    } else {
      logger.info("Memory backend: in-memory");
    }
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
  }
}
