import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

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
      system: systemPrompt,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages: messages as Anthropic.MessageParam[],
    });

    return {
      content: response.content as ContentBlock[],
      stopReason: response.stop_reason as LLMResponse["stopReason"],
    };
  }
}
