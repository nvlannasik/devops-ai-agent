import { createLLMClient } from "./llm/index.js";
import { MCPClient } from "./mcp/client.js";
import { ConversationMemory } from "./memory/index.js";
import { buildSystemPrompt } from "./prompts/system.js";
import { trimHistory, sanitizeContentBlocks } from "./context/index.js";
import type { LLMClient, Message, ContentBlock } from "./llm/types.js";
import logger from "../utils/logger/index.js";

const MAX_ITERATIONS = 10;

export class DevOpsAgent {
  private llm: LLMClient;
  private mcp: MCPClient;
  private memory: ConversationMemory;

  constructor() {
    this.llm = createLLMClient();
    this.mcp = new MCPClient();
    this.memory = new ConversationMemory();
  }

  async initialize(): Promise<void> {
    await this.mcp.connect();
  }

  async investigate(threadId: string, userMessage: string): Promise<string> {
    this.memory.append(threadId, { role: "user", content: userMessage });

    const tools = this.mcp.getTools();
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // trim history to prevent context overflow
      const messages = trimHistory(this.memory.get(threadId));
      logger.debug(`[${threadId}] iteration ${iterations}, messages: ${messages.length}`);

      const response = await this.llm.chat(messages, tools, buildSystemPrompt());

      this.memory.append(threadId, { role: "assistant", content: response.content });

      if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
        return this.extractText(response.content);
      }

      if (response.stopReason === "tool_use") {
        const rawResults = await this.executeToolCalls(threadId, response.content);
        // truncate large tool results before storing in history
        const trimmedResults = sanitizeContentBlocks(rawResults);
        this.memory.append(threadId, { role: "user", content: trimmedResults });
      }
    }

    return "⚠️ Investigation reached maximum iterations. Please review the findings above and try a more specific query.";
  }

  private async executeToolCalls(threadId: string, content: ContentBlock[]): Promise<ContentBlock[]> {
    const toolUses = content.filter((c) => c.type === "tool_use");
    const results: ContentBlock[] = [];

    for (const toolUse of toolUses) {
      const { id, name, input } = toolUse;
      logger.info(`[${threadId}] Calling tool: ${name}`);

      try {
        const result = await this.mcp.callTool(name!, input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: id, content: result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[${threadId}] Tool ${name} failed: ${errMsg}`);
        results.push({ type: "tool_result", tool_use_id: id, content: `Error: ${errMsg}` });
      }
    }

    return results;
  }

  private extractText(content: ContentBlock[]): string {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
  }

  clearThread(threadId: string): void {
    this.memory.clear(threadId);
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
