import type { Message, ContentBlock, ToolDefinition } from "../llm/types.js";
import type { Skill } from "../skills/index.js";
import { compactToolResult } from "./compact.js";
import { estimateMessage, estimateTokens, fitToBudget, type Budget } from "./budget.js";

export { estimateTokens, estimateMessage, fitToBudget } from "./budget.js";
export type { Budget } from "./budget.js";
export { compactToolResult, MAX_TOOL_RESULT_CHARS } from "./compact.js";

const SKILL_OPEN = (name: string): string => `--- skill: ${name} ---`;
const SKILL_CLOSE = (name: string): string => `--- end skill: ${name} ---`;

// A user message carrying tool_result blocks is only valid when the assistant message holding
// the matching tool_use is still present earlier in the array. See budget.ts for the trimming
// rules this constraint produces.
function carriesToolResult(message: Message): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Keep the first message (the original issue) plus the most recent messages, up to
 * `maxMessages` total, without splitting a tool_use / tool_result pair across the trim
 * boundary. Still used as the STORAGE cap in ConversationMemory — the send-side decision now
 * belongs to fitToBudget.
 */
export function trimToWindow(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages) return messages;
  const first = messages[0];
  let start = messages.length - (maxMessages - 1);
  while (start < messages.length && carriesToolResult(messages[start])) {
    start++;
  }
  return [first, ...messages.slice(start)];
}

export function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "tool_result" && typeof block.content === "string") {
      return { ...block, content: compactToolResult(block.content) };
    }
    return block;
  });
}

/**
 * Prepends one delimited block per skill to the request's first user message.
 *
 * NOT the system prompt. src/agent/llm/claude.ts:26-32 caches the entire system prompt as one
 * ephemeral block, so a system prompt that varies per investigation is a guaranteed cache miss
 * plus a rewrite at 1.25x. Riding in the messages also leaves the SQS contract untouched, and
 * survives toOpenAIMessages() in both repos because each already joins a user message's text
 * blocks.
 */
export function injectSkills(messages: Message[], skills: readonly Skill[]): Message[] {
  if (skills.length === 0 || messages.length === 0) return messages;

  const block = skills
    .map((s) => `${SKILL_OPEN(s.name)}\n${s.body}\n${SKILL_CLOSE(s.name)}`)
    .join("\n\n");

  const first = messages[0]!;
  if (first.role !== "user") {
    return [{ role: "user", content: block }, ...messages];
  }

  const content: Message["content"] =
    typeof first.content === "string"
      ? `${block}\n\n${first.content}`
      : [{ type: "text", text: block } as ContentBlock, ...first.content];

  return [{ ...first, content }, ...messages.slice(1)];
}

export interface AssembledRequest {
  messages: Message[];
  /** Returned untouched, byte for byte — see injectSkills. */
  systemPrompt: string;
  skillsUsed: string[];
  skillsDropped: string[];
  messagesDropped: number;
  estimatedTokens: number;
}

/**
 * The single owner of what goes into an LLM request and in what order.
 */
export function assembleRequest(input: {
  history: Message[];
  systemPrompt: string;
  tools: ToolDefinition[];
  skills: readonly Skill[];
  budget: Budget;
}): AssembledRequest {
  const overhead =
    estimateTokens(input.systemPrompt) +
    (input.tools.length > 0 ? estimateTokens(JSON.stringify(input.tools)) : 0);
  const available = input.budget.contextTokens - input.budget.reserveTokens - overhead;

  const fit = fitToBudget({ history: input.history, skills: input.skills, available });
  const messages = injectSkills(fit.history, fit.skills);

  return {
    messages,
    systemPrompt: input.systemPrompt,
    skillsUsed: fit.skills.map((s) => s.name),
    skillsDropped: fit.skillsDropped,
    messagesDropped: fit.messagesDropped,
    estimatedTokens: overhead + messages.reduce((n, m) => n + estimateMessage(m), 0),
  };
}
