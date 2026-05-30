import OpenAI from "openai";
import { config } from "../../config/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: config.llm.openaiCompatible.baseUrl,
      apiKey: config.llm.openaiCompatible.apiKey,
    });
    this.model = config.llm.openaiCompatible.model;
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })),
      ],
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    });

    const choice = response.choices[0];
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        });
      }
    }

    const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
    return { content, stopReason: stopReason as LLMResponse["stopReason"] };
  }
}
