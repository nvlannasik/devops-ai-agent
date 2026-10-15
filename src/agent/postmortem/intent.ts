// `@agent postmortem` in an incident thread (spec 2026-10-14-postmortem-draft-design). Declines
// mirror learnIntent's: "postmortem nanti aja" is not a request — the incident-208 lesson.
//
// The trigger is ANCHORED to the START of the mention (final-fix item 2, 2026-10-14): "is the
// root cause in the postmortem right?" and "we'll do the postmortem later" both mention the word
// in passing, about something else, and must fall through to the normal investigation path
// rather than being read as a postmortem command. The grammar: optional polite lead-in, optional
// verb, optional article, then the ask word itself.
// One or more polite lead-ins ("tolong", "bisa", "minta", "mohon" …) may stack: "bisa tolong bikin postmortem".
const LEADIN = "(?:(?:please|tolong|can you|could you|pls|bisa|minta|mohon)\\s+)+";
// Indonesian verbs take a passive "di-" and a "-kan"/"-in" suffix: buatkan, bikinin, dibuatkan.
const VERB = "(?:(?:di)?(?:bikin|buat)(?:kan|in)?|make|write|draft|generate|create|do)\\s+";
const ARTICLE = "(?:a|an|the)\\s+";
// "write up" (unhyphenated) is the ask word only when it is NOT followed by a WH-word — "write up
// why the checkout pod restarts" is a request to explain, not a request for a postmortem document.
const ASK = "(?:postmortem|post-mortem|incident review|write-up|write up(?!\\s+(?:why|what|when|where|who|how)\\b))";

const ASK_ANCHOR = new RegExp(`^\\s*(?:${LEADIN})?(?:${VERB})?(?:${ARTICLE})?${ASK}`, "i");

// Decline-starting words get their own symmetric anchor: "jangan"/"skip"/"no" directly in front
// of the verb or the ask word IS the decline, start-anchored exactly like the ask itself — not a
// bare "jangan"/"skip" anywhere in the text (that would catch "jangan sebut nama orang" tacked
// onto an otherwise-genuine request, see the test for it).
const JANGAN_ANCHOR = new RegExp(`^\\s*jangan\\s+(?:${VERB})?(?:${ARTICLE})?${ASK}`, "i");
const SKIP_ANCHOR = new RegExp(`^\\s*skip\\s+(?:${ARTICLE})?${ASK}`, "i");
const NO_POSTMORTEM_ANCHOR = /^\s*no\s+post[- ]?mortem\b/i;

// Decline words that can appear anywhere once the ask itself is already anchored — "postmortem
// nanti aja", "postmortem later". Bare "jangan" is deliberately NOT here: see JANGAN_ANCHOR above.
const DECLINE_REST = /\b(nanti|later|skip|not now|ga usah|gak usah|nggak usah)\b/i;

// "jangan lupa" ("don't forget") and "don't skip" READ like a decline word but negate one — drop
// the whole phrase before testing anything else so the word it negates ("lupa"/"jangan", "skip")
// isn't left behind to trip a decline anchor or DECLINE_REST on its own. `'?` covers "don't"/"dont".
const NEUTRALIZE = /\b(jangan\s+lupa|don'?t\s+forget|don'?t\s+skip)\b/gi;

export function postmortemIntent(text: string): "postmortem" | "declined" | null {
  const stripped = text.replace(NEUTRALIZE, "").trim();
  if (JANGAN_ANCHOR.test(stripped) || SKIP_ANCHOR.test(stripped) || NO_POSTMORTEM_ANCHOR.test(stripped)) return "declined";
  if (!ASK_ANCHOR.test(stripped)) return null;
  return DECLINE_REST.test(stripped) ? "declined" : "postmortem";
}
