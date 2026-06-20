import type { Message, ContentBlock } from "../llm/types.js";

// rough estimate: 1 token ≈ 4 chars
const MAX_TOOL_RESULT_CHARS = 8000;  // ~2k tokens per tool result
const MAX_HISTORY_MESSAGES = 40;     // keep last 40 messages
const TRUNCATION_NOTICE = (remaining: number) => `...[truncated ${remaining} chars]`;

export function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const remaining = content.length - MAX_TOOL_RESULT_CHARS;
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_NOTICE(remaining);
}

// A user message carrying tool_result blocks is only valid when the assistant
// message holding the matching tool_use is still present earlier in the array.
// Trimming the middle of the history can leave such a message at the front of
// the window with its tool_use gone — the Anthropic API rejects that orphaned
// tool_result with a 400, which kills exactly the long investigations we keep.
function carriesToolResult(message: Message): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Keep the first message (the original issue) plus the most recent messages, up
 * to `maxMessages` total, without splitting a tool_use / tool_result pair across
 * the trim boundary. The recent window is advanced past any leading orphaned
 * tool_result so the kept slice always starts on a clean turn boundary.
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

export function trimHistory(messages: Message[]): Message[] {
  return trimToWindow(messages, MAX_HISTORY_MESSAGES);
}

export function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "tool_result" && typeof block.content === "string") {
      return { ...block, content: truncateToolResult(block.content) };
    }
    return block;
  });
}
