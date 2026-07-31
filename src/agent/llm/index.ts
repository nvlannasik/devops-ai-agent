import { config } from "../../config/index.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { buildBackends, parseRegistry } from "./registry.js";
import { RouterLLMClient } from "./router.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

export function createLLMClient(): LLMClient {
  // config casts LLM_PROVIDER to the union without checking it, so an unknown value reaches
  // here as a plain string. Same rule as parseRegistry below: an env-var typo must stop the
  // pod at boot, not silently demote it to a provider nobody asked for.
  switch (config.llm.provider) {
    case "router": {
      // parseRegistry throws on a bad registry, and this runs at boot — an env-var typo must
      // stop the pod, not the first alert of the day.
      const { backends, heavy, light } = parseRegistry(process.env);
      return new RouterLLMClient(buildBackends(backends), heavy, light);
    }
    case "openai-compatible":
      return new OpenAICompatibleClient();
    case "private-llm":
      return new SQSLLMClient();
    case "claude":
      return new ClaudeClient();
    default: {
      const unknown: never = config.llm.provider;
      throw new Error(
        `LLM_PROVIDER="${unknown}" is not a known provider ` +
        `(claude, openai-compatible, private-llm, router)`
      );
    }
  }
}

export type { LLMClient, Message, ToolDefinition, ToolCall, ToolResult, LLMResponse, ContentBlock } from "./types.js";
