// On-call feedback learning (docs/DESIGN_oncall_feedback_learning.md).
// Pure helpers for the `@agent learn` flow: build a compact thread transcript for the
// extraction LLM call, and parse its JSON output defensively (the model may wrap the
// JSON in prose or code fences).

import { keyTerms } from "./terms.js";

export interface ExtractedFeedback {
  confirmed_root_cause: string | null;
  action_taken: string | null;
  outcome: "resolved" | "mitigated" | "unresolved" | "unknown";
}

const OUTCOMES = new Set(["resolved", "mitigated", "unresolved", "unknown"]);

export function parseFeedbackJson(text: string): ExtractedFeedback | null {
  const match = text.match(/\{[\s\S]*\}/); // first { to last } — tolerates fences/prose around it
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const cause = str(raw.confirmed_root_cause);
    const action = str(raw.action_taken);
    if (!cause && !action) return null; // nothing substantive to learn

    const rawOutcome = typeof raw.outcome === "string" ? raw.outcome.toLowerCase().trim() : "";
    const outcome = (OUTCOMES.has(rawOutcome) ? rawOutcome : "unknown") as ExtractedFeedback["outcome"];
    return { confirmed_root_cause: cause, action_taken: action, outcome };
  } catch {
    return null;
  }
}

export interface ThreadMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

// ---- What counts as a human saying something (incident 208, 2026-10-03) ----
//
// "learn dihiraukan aja untuk saat ini" — "ignore learn for now" — ran learn, and with no human
// statement anywhere in the thread the extraction call wrote the AGENT's own hallucinated RCA into
// incident_feedback, the tier recall frames as "confirmed by on-call". The next investigation
// recalled it as fact and proposed a restart for an invented workload. The prompt already said
// "ignore bot hypotheses unless a human confirmed them"; a prompt rule is not a guard. These are.

/** "learn" followed by a decline or a deferral is not a request to learn. */
const DECLINE = /\b(abaikan|diabaikan|hiraukan|dihiraukan|jangan|nggak usah|ga usah|gak usah|tidak usah|batal|nanti|skip|ignore|cancel|later|not now)\b/i;
const LEARN_PREFIX = /^\s*(?:<@[A-Z0-9]+>\s*)*learn\b[\s:—–-]*/i;
const MENTION = /<@[A-Z0-9]+>/g;
/** Shorter than this is an acknowledgement ("ok", "thanks"), not a statement of cause. */
const MIN_STATEMENT = 12;

export function learnIntent(text: string): "learn" | "declined" {
  return DECLINE.test(text.replace(LEARN_PREFIX, "")) ? "declined" : "learn";
}

/**
 * The words humans wrote in the thread, which is the only thing the learn flow may store as
 * confirmed. The bot's own messages are excluded — except the one a human put ✅ on (`endorsedTs`),
 * which that human has explicitly confirmed. The learn message counts for what follows `learn`
 * ("learn: the pool was exhausted"), and not at all when it declines.
 */
export function humanStatements(messages: ThreadMessage[], triggerTs: string | null, endorsedTs?: string): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const text = (m.text ?? "").replace(LEARN_PREFIX, "").replace(MENTION, "").trim();
    if (text.length < MIN_STATEMENT) continue;
    if (endorsedTs && m.ts === endorsedTs) out.push(text);
    else if (m.bot_id) continue;
    else if (m.ts === triggerTs && DECLINE.test(text)) continue;
    else out.push(text);
  }
  return out;
}

/**
 * Drops an extracted field whose names and error terms appear nowhere in what the humans wrote —
 * it was lifted from the bot's messages. A field with no such terms (pure prose: "the database
 * was down") cannot be checked this way and is kept. Null when nothing survives.
 */
export function tracesToHumans(f: ExtractedFeedback, humanText: string): ExtractedFeedback | null {
  const said = humanText.toLowerCase();
  const keep = (v: string | null): string | null => {
    if (!v) return v;
    const terms = keyTerms(v);
    return terms.length === 0 || terms.some((t) => said.includes(t.term.toLowerCase())) ? v : null;
  };
  const cause = keep(f.confirmed_root_cause);
  const action = keep(f.action_taken);
  return cause || action ? { ...f, confirmed_root_cause: cause, action_taken: action } : null;
}

// Compact transcript: one line per message, humans vs agent labeled so the extraction
// call can weigh human statements over bot hypotheses. Tail-biased truncation — the
// conclusion of an incident discussion lives at the end.
export function buildTranscript(messages: ThreadMessage[], maxChars = 6000): string {
  const lines = messages
    .filter((m) => m.text && m.text.trim())
    .map((m) => `${m.bot_id ? "agent" : `user ${m.user ?? "?"}`}: ${m.text!.trim()}`);
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

// Minimal system prompt on purpose — the full agent prompt would prime RCA structure.
export const EXTRACTION_SYSTEM =
  "You extract confirmed incident knowledge from Slack thread transcripts. Output ONLY a JSON object, no prose.";

export function buildExtractionPrompt(transcript: string): string {
  return (
    "From this incident thread transcript, extract what the on-call HUMANS confirmed. " +
    "Ignore unverified bot hypotheses unless a human explicitly confirmed them. " +
    'Output only JSON: {"confirmed_root_cause": string|null, "action_taken": string|null, ' +
    '"outcome": "resolved"|"mitigated"|"unresolved"|"unknown"}. ' +
    "If the humans did not state anything concrete, use nulls.\n\n---\n" +
    transcript
  );
}
