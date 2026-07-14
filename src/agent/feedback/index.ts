// On-call feedback learning (docs/DESIGN_oncall_feedback_learning.md).
// Pure helpers for the `@agent learn` flow: build a compact thread transcript for the
// extraction LLM call, and parse its JSON output defensively (the model may wrap the
// JSON in prose or code fences).

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
  user?: string;
  bot_id?: string;
  text?: string;
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
