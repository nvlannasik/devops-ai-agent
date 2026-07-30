import { config } from "../../config/index.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { buildBackends, parseRegistry } from "./registry.js";
import { RouterLLMClient } from "./router.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

export function createLLMClient(): LLMClient {
  if (config.llm.provider === "router") {
    // parseRegistry throws on a bad registry, and this runs at boot — an env-var typo must
    // stop the pod, not the first alert of the day.
    const { backends, heavy, light } = parseRegistry(process.env);
    return new RouterLLMClient(buildBackends(backends), heavy, light);
  }
  if (config.llm.provider === "openai-compatible") return new OpenAICompatibleClient();
  if (config.llm.provider === "private-llm") return new SQSLLMClient();
  return new ClaudeClient();
}

export type { LLMClient, Message, ToolDefinition, ToolCall, ToolResult, LLMResponse, ContentBlock } from "./types.js";
