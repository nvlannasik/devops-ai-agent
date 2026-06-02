import { config } from "../../config/index.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

export function createLLMClient(): LLMClient {
  if (config.llm.provider === "openai-compatible") return new OpenAICompatibleClient();
  if (config.llm.provider === "private-llm") return new SQSLLMClient();
  return new ClaudeClient();
}

export type { LLMClient, Message, ToolDefinition, ToolCall, ToolResult, LLMResponse, ContentBlock } from "./types.js";
