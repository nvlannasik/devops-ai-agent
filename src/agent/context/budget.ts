import type { Message, ContentBlock } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

// Three characters per token, not the usual four. This context is dominated by JSON tool
// results, which tokenize far worse than prose. Over-estimating wastes window; under-estimating
// produces a 400, or worse a silent server-side truncation that removes evidence the model then
// reasons without.
export const CHARS_PER_TOKEN = 3;
export const BUDGET_SAFETY_MARGIN = 1024;

export const DEFAULT_CONTEXT_TOKENS = {
  claude: 200_000,
  "openai-compatible": 128_000,
  "private-llm": 32_000,
} as const;

export interface Budget {
  contextTokens: number;
  reserveTokens: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const blockText = (b: ContentBlock): string =>
  (b.text ?? "") + (b.content ?? "") + (b.name ?? "") + (b.input ? JSON.stringify(b.input) : "");

export const estimateMessage = (m: Message): number =>
  typeof m.content === "string"
    ? estimateTokens(m.content)
    : m.content.reduce((n, b) => n + estimateTokens(blockText(b)), 0);

const carriesToolResult = (m: Message): boolean =>
  m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");

const carriesToolUse = (m: Message): boolean =>
  m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");

export interface FitResult {
  history: Message[];
  skills: Skill[];
  skillsDropped: string[];
  messagesDropped: number;
}

// Keep-order, i.e. the reverse of drop-order: an always-skill outranks a matched one, and within
// a rank the smaller body is kept first — so the largest matched playbook is the first thing to
// go. No name is special-cased here; with one always-skill this is exactly "rca-format drops
// last", and if a second is ever added the tie-break is size rather than identity.
const keepRank = (s: Skill): number => (s.when === "always" ? 0 : 1);

/**
 * Fits skills and history into `available` tokens.
 *
 * Pinned, in this order: the thread's opening message, the most recent message, and — when that
 * most recent message carries tool_result blocks — the assistant message holding the matching
 * tool_use. Then skills, then history newest-first. Whatever is left of the middle is dropped
 * from the oldest end, and the window is advanced past any leading orphaned tool_result.
 */
export function fitToBudget(input: {
  history: Message[];
  skills: readonly Skill[];
  available: number;
}): FitResult {
  const { history, available } = input;
  if (history.length === 0) {
    return { history: [], skills: [...input.skills], skillsDropped: [], messagesDropped: 0 };
  }

  const cost = history.map(estimateMessage);
  const first = 0;
  const last = history.length - 1;
  // A trailing tool_result is meaningless without the tool_use it answers.
  const pinFrom = last > first && carriesToolResult(history[last]!) && carriesToolUse(history[last - 1]!)
    ? last - 1
    : last;

  const pinned: number[] = [first];
  for (let i = pinFrom; i <= last; i++) if (i > first) pinned.push(i);
  let used = pinned.reduce((n, i) => n + cost[i]!, 0);

  const kept: Skill[] = [];
  const skillsDropped: string[] = [];
  for (const s of [...input.skills].sort((a, b) => keepRank(a) - keepRank(b) || a.body.length - b.body.length)) {
    const t = estimateTokens(s.body);
    if (used + t <= available) {
      used += t;
      kept.push(s);
    } else {
      skillsDropped.push(s.name);
    }
  }

  const middle: Message[] = [];
  for (let i = pinFrom - 1; i > first; i--) {
    const t = cost[i]!;
    if (used + t > available) break;
    used += t;
    middle.unshift(history[i]!);
  }

  const tail = history.slice(pinFrom).filter((_, k) => pinFrom + k > first);
  let out = [history[first]!, ...middle, ...tail];

  // The window must open on a clean turn boundary — see carriesToolResult above.
  let start = 1;
  while (start < out.length - 1 && carriesToolResult(out[start]!)) start++;
  if (start > 1) out = [out[0]!, ...out.slice(start)];

  return { history: out, skills: kept, skillsDropped, messagesDropped: history.length - out.length };
}
