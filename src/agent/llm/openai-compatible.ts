import OpenAI from "openai";
import { config } from "../../config/index.js";
import logger from "../../utils/logger/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition, ContentBlock } from "./types.js";

// Our Message[] is Anthropic-shaped; an OpenAI-compatible backend needs native
// tool_calls / role:"tool". This used to be `JSON.stringify(m.content)` — which fed the
// literal `[{"type":"tool_use",...}]` to the model as TEXT. A big model ignores the noise;
// a small one imitates it and answers with that JSON instead of calling a tool, which the
// agent then posts to Slack verbatim (and re-stringifies next turn → nested escaping).
// Kept in sync with llm-worker/src/llm.ts (separate repos, no shared module). Exported for tests.
export function toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    if (m.role === "assistant") {
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "",
          type: "function" as const,
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) });
      continue;
    }
    // user turn: tool results must come FIRST — OpenAI requires every tool message to
    // follow the assistant turn that requested it, before any new user text
    for (const b of m.content.filter((b) => b.type === "tool_result")) {
      out.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: b.content ?? "" });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

// Per-instance overrides — see ClaudeOptions. This is also how an aggregator such as
// OpenRouter is registered: it is an ordinary OpenAI-compatible backend, not a special case.
export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// The 400 a newer OpenAI model answers with when it is sent `max_tokens`. Matched on the
// parameter NAME, not the sentence around it: the wording has already changed once, the name
// is the part that carries the instruction. Exported for the test.
export function wantsMaxCompletionTokens(err: unknown): boolean {
  const e = err as { status?: number; message?: unknown };
  return e?.status === 400 && typeof e.message === "string" && e.message.includes("max_completion_tokens");
}

export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI;
  readonly model: string;
  // OpenAI's o-series / gpt-5 models REJECT `max_tokens` outright, while every self-hosted or
  // aggregated backend we talk to (vLLM, DeepSeek, OpenRouter) only knows `max_tokens` — and
  // both are ordinary "openai-compatible" entries in the same router. Nothing in the response
  // says which family we're on, and switching on the model name breaks the day a provider
  // renames one, so we send the widely-understood parameter and let the 400 teach us. Clients
  // are built once at boot (registry.ts), so the lesson costs one wasted request per backend
  // per pod, not one per call.
  private tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl ?? config.llm.openaiCompatible.baseUrl,
      apiKey: opts.apiKey ?? config.llm.openaiCompatible.apiKey,
    });
    this.model = opts.model ?? config.llm.openaiCompatible.model;
  }

  private body(messages: Message[], tools: ToolDefinition[], systemPrompt: string): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    return {
      model: this.model,
      [this.tokenParam]: config.llm.maxTokens,
      messages: [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)],
      // omit when the agent disables tools (tool budget reached) — some providers reject []
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    };
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    let response;
    try {
      response = await this.client.chat.completions.create(this.body(messages, tools, systemPrompt));
    } catch (err) {
      // Retry only on the one error that tells us exactly what to change, and only while we
      // still have something to change — otherwise this would swallow a real 400 (bad tool
      // schema, oversized context) behind a duplicate request.
      if (this.tokenParam === "max_completion_tokens" || !wantsMaxCompletionTokens(err)) throw err;
      this.tokenParam = "max_completion_tokens";
      logger.info(`[llm] ${this.model} rejects max_tokens — switching this backend to max_completion_tokens`);
      response = await this.client.chat.completions.create(this.body(messages, tools, systemPrompt));
    }

    const choice = response.choices[0];
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      // Small models emit malformed argument JSON regularly. An unguarded parse threw out
      // of the whole chat() call, so one bad tool call killed the investigation with an
      // opaque "Unexpected token" and no hint of which tool. Keep the block (dropping it
      // breaks tool_use/tool_result pairing) with empty args — the tool's own schema
      // validation then tells the model what it got wrong, and it retries.
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        logger.warn(`Malformed tool arguments from the model for "${tc.function.name}": ${tc.function.arguments.slice(0, 200)}`);
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }

    // "length" = cut off by the token limit. Mapping it to end_turn posts a truncated RCA
    // to Slack as if it were complete; the loop already handles max_tokens (agent/index.ts).
    const stopReason =
      choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
    return {
      content,
      stopReason: stopReason as LLMResponse["stopReason"],
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }
}
