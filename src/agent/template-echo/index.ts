/**
 * The RCA template's own placeholders, deleted when the model prints them instead of filling them.
 *
 * Live 2026-09-25, an ImagePullBackOff RCA posted to Slack:
 *
 *     1. [Symptom] Pod oauth2-proxy-...-8d4l7 in oauth2-proxy is Pending ... — k8s_describe_pod
 *     2. ← [why step 1 happened] The image pull failed due to a TLS handshake timeout ...
 *     4. ⛔ [what you cannot see from here, and what access would show it] Need targeted ...
 *
 * The slot was not filled, it was LABELLED: the model kept the bracket and put its content behind
 * it. `rca-format.md` already says "Never emit a bracket in your output", so this is the familiar
 * shape — a prompt rule that does not hold on the small heavy model — and it gets the familiar
 * answer.
 *
 * The template was fixed in the same change: in the causal chain the brackets sat in the LABEL
 * position, unlike every section that does not leak, where a real bold label precedes the slot.
 * This is the backstop under that fix, and it earns its place on its own — the placeholder
 * vocabulary is OURS, so an echo is always our own text coming back, never the cluster's.
 *
 * Narrow by construction: only a bracket whose whole content matches a placeholder we ship is
 * removed. A log line's `[ERROR]`, a bracketed timestamp, an array index — none of them match and
 * none may be touched, because the RCA quotes real output and that output is the evidence.
 */

const PLACEHOLDER = new RegExp(
  `^(?:${[
    // the causal chain, the old shape and the new one
    "symptom",
    "why step \\d+ happened",
    "what the alert fired on[^\\]]*",
    "what you cannot see[^\\]]*",
    // evidence and ruled out
    "fact(?:\\s*\\d+)?",
    "hypothesis(?:\\s*\\d+)?",
    "what the tool output shows[^\\]]*",
    "another one",
    "what you considered",
    "the tool result that excludes it",
    "specific reason from tool result",
    // the verdict fields and the action ladder
    "level",
    "emoji",
    "one sentence:[^\\]]*",
    "safe to execute now[^\\]]*",
    "fix within hours/days",
    "architectural or process change[^\\]]*",
  ].join("|")})$`,
  "i",
);

export function stripTemplateEcho(rca: string): { text: string; dropped: number } {
  let dropped = 0;
  const lines = rca.split("\n").map((line) => {
    const cleaned = line.replace(/\[([^\]\n]{1,160})\]/g, (whole, inner: string) => {
      if (!PLACEHOLDER.test(inner.trim())) return whole;
      dropped++;
      return "";
    });
    if (cleaned === line) return line;
    // The slot stood where the content now begins, so what it leaves behind is a doubled space, or
    // a dash orphaned against the list marker. Tidied only on lines something was removed from:
    // collapsing runs of spaces across the whole answer would reach inside fenced log output.
    return cleaned
      .replace(/^([ \t]*(?:\d+\.|•|⛔)?[ \t]*)[—–-][ \t]*/, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();
  });
  return dropped > 0 ? { text: lines.join("\n"), dropped } : { text: rca, dropped: 0 };
}
