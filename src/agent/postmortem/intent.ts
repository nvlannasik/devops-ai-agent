// `@agent postmortem` in an incident thread (spec 2026-10-14-postmortem-draft-design). Declines
// mirror learnIntent's: "postmortem nanti aja" is not a request — the incident-208 lesson.
const ASK = /\b(post[- ]?mortem|incident review|write[- ]?up)\b/i;
const DECLINE = /\b(nanti|later|skip|jangan|not now|ga usah|gak usah|nggak usah)\b|\bno\s+post[- ]?mortem\b/i;

export function postmortemIntent(text: string): "postmortem" | "declined" | null {
  if (!ASK.test(text)) return null;
  return DECLINE.test(text) ? "declined" : "postmortem";
}
