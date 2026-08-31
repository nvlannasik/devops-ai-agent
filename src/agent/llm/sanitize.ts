import type { Message } from "./types.js";

/**
 * A UTF-16 surrogate with no partner. Valid in a JavaScript string, and `JSON.stringify` will
 * happily emit it as a bare `\ud83d` escape — which every strict JSON parser on the other end
 * rejects, so the request never reaches the model at all:
 *
 *   400 The request body is not valid JSON: no low surrogate in string
 *
 * Two ways one gets into a request, and the second is why this guard lives at the wire rather
 * than at any single producer:
 *
 * 1. **Our own truncation.** Emoji are surrogate pairs, and the RCA format is full of them
 *    (🔴 📍 📈). Every fixed-offset cut over model-written text can land between the halves —
 *    `buildProposalPrompt`'s 2500/-1500 slice, `compactToolResult`'s head+tail, the recall
 *    snippets in `incidents/`. That is five producers and counting.
 * 2. **The model itself**, which no producer-side fix would catch.
 *
 * The failure is also invisible in a useful way from the router's seat: the payload is identical
 * on every backend, so all three fail with the same 400 and the up-only failover spends the whole
 * chain re-sending the same broken bytes.
 *
 * U+FFFD rather than deletion: half an emoji carries nothing, and the replacement character says
 * a character was lost here instead of quietly closing the gap.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const stripLoneSurrogates = (text: string): string => {
  LONE_SURROGATE.lastIndex = 0; // `g` keeps state across calls on a shared regex
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "�") : text;
};

// Walks every string in the payload, `input` on a tool_use included: those arguments are written
// by the model too, and they ride back into history on the next turn like any other block.
const deep = (value: unknown): unknown => {
  if (typeof value === "string") return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(deep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
  }
  return value;
};

/**
 * Call this first in every LLMClient.chat(). Tools are deliberately NOT walked: their definitions
 * come from the MCP server's own listTools(), are static for the process, and are cached as one
 * block — rewriting them per call would spend allocations on the one part of the request no model
 * ever wrote.
 */
export function sanitizeForWire(
  messages: Message[],
  systemPrompt: string
): { messages: Message[]; systemPrompt: string } {
  return {
    messages: deep(messages) as Message[],
    systemPrompt: stripLoneSurrogates(systemPrompt),
  };
}
