import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition, ContentBlock, TokenUsage } from "./types.js";

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor() {
    this.client = new Anthropic({ apiKey: config.llm.claude.apiKey });
    this.model = config.llm.claude.model;
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8096,
      // system prompt as a cacheable block — large static content, stable across iterations
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      // mark last tool to cache the entire tools array (tools rarely change mid-session)
      tools: tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
        ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } as const } : {}),
      })),
      messages: messages as Anthropic.MessageParam[],
    });

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    const usage: TokenUsage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    };

    return {
      content: response.content as ContentBlock[],
      stopReason: response.stop_reason as LLMResponse["stopReason"],
      usage,
    };
  }
}
