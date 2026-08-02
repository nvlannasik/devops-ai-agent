export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
}

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
  // Which registered backend answered, on which chain, and its configured model name.
  // Set only by RouterLLMClient — the direct providers leave these undefined, and
  // llm_usage stores NULL for them. model can be undefined even when backend is set
  // (e.g. a private-llm backend has no configured model) — leave it undefined rather
  // than substituting another backend's model; a NULL in llm_usage is honest, a wrong
  // model name is not.
  backend?: string;
  route?: "light" | "heavy";
  model?: string;
}

export interface LLMClient {
  chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse>;
  // optional teardown (e.g. SQS client stops its dispatcher and deletes its per-instance queue)
  shutdown?(): Promise<void>;
}
