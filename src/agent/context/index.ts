import type { Message, ContentBlock } from "../llm/types.js";

// rough estimate: 1 token ≈ 4 chars
const MAX_TOOL_RESULT_CHARS = 8000;  // ~2k tokens per tool result
const MAX_HISTORY_MESSAGES = 40;     // keep last 40 messages
const TRUNCATION_NOTICE = "\n... [truncated — result too large] ...";

export function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_NOTICE;
}

export function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

  // always keep the first message (original issue) and trim from the middle
  const first = messages[0];
  const recent = messages.slice(-(MAX_HISTORY_MESSAGES - 1));
  return [first, ...recent];
}

export function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "tool_result" && typeof block.content === "string") {
      return { ...block, content: truncateToolResult(block.content) };
    }
    return block;
  });
}
