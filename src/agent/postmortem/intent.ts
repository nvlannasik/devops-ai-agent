// `@agent postmortem` in an incident thread (spec 2026-10-14-postmortem-draft-design). Declines
// mirror learnIntent's: "postmortem nanti aja" is not a request — the incident-208 lesson.
const ASK = /\b(post[- ]?mortem|incident review|write[- ]?up)\b/i;
const DECLINE = /\b(nanti|later|skip|jangan|not now|ga usah|gak usah|nggak usah)\b|\bno\s+post[- ]?mortem\b/i;

// "jangan lupa" ("don't forget") and "don't skip" READ like a decline word but negate one — drop
// the whole phrase before testing DECLINE so the word it negates ("lupa"/"jangan", "skip") isn't
// left behind to trip the gate on its own. `'?` covers "don't"/"dont" with one pattern.
const NEUTRALIZE = /\b(jangan\s+lupa|don'?t\s+forget|don'?t\s+skip)\b/gi;

export function postmortemIntent(text: string): "postmortem" | "declined" | null {
  if (!ASK.test(text)) return null;
  return DECLINE.test(text.replace(NEUTRALIZE, "")) ? "declined" : "postmortem";
}
