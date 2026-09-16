import type { KnownBlock } from "@slack/types";

type Block = KnownBlock;

const SEVERITY_COLOR: Record<string, string> = {
  critical: "🔴", high: "🟠", medium: "🟡", low: "🟢",
};

/**
 * The severity line, tolerant of the markup the model actually produces.
 *
 * rca-format.md asks for `*[emoji] Severity:* \`[level]\`` and that line is the only one in the
 * template shaped that way — every other label is a whole line wrapped in asterisks. So the model
 * regularises it to look like its neighbours, and three consecutive live investigations produced
 * three different shapes, none of them the template's:
 *
 *     🟠 Severity: High             (no markup at all)
 *     🔴 Severity: *Critical*       (bold moved onto the value)
 *     *🔴 Severity: Critical*       (one bold span over the whole line)
 *
 * The old pattern required Severity to sit INSIDE a bold span and the level inside backticks, so
 * all three failed. That cost more than a rendering nicety: isRcaResponse gates the RCA card, so
 * an otherwise complete RCA — Root Cause, Evidence, Actions all correctly formatted — was posted
 * to Slack as plain text, and parseSeverity wrote NULL into incidents.assessed_severity.
 *
 * Deliberately shaped after CONFIDENCE_PATTERN in agent/confidence, which was loosened the same
 * way for the same reason. The colon stays REQUIRED: it is what separates the label line from
 * prose like "severity is high", which must not match.
 *
 * The trailing `(?![|\w])` is load-bearing and a plain `\b` is not enough. A model that emits the
 * template's placeholder verbatim writes `*[emoji] Severity:* \`[Critical|High|Medium|Low]\``, and
 * `\b` happily matches "Critical" in front of the pipe — storing a level the model never chose.
 * parseSeverity feeds assessed_severity, the agent's own judgement column, so a guessed value
 * there is worse than the null that says "not assessed".
 *
 * Exported because three call sites read it — the two here and parseSeverity in agent/incidents —
 * and three copies of one regex is how the two that were not loosened got missed.
 */
export const SEVERITY_PATTERN =
  /(?:[🔴🟠🟡🟢]\s*)?severity[^a-z\n]{0,10}[:`]\s*[`*]?\s*\[?(critical|high|medium|low)\]?(?![|\w])/i;

// exported: reformatToRca gates on it — isRcaResponse alone passed texts that rendered empty
export function extractSection(text: string, label: string): string {
  // matches "*📍 Root Cause*\n..." up to the next "*emoji Label*" or end.
  //
  // `[ \t]*` before the newline is not cosmetic. Two spaces at the end of a line is markdown's
  // hard line break, and the model writes the heading that way — "*📍 Root Cause*  \n". Requiring
  // the newline to touch the closing asterisk made every section come back "" for those answers,
  // and app/index.ts reads `isRcaResponse(rca) && !!extractSection(rca, "Root Cause")`: the
  // severity half passed, this half did not, so a complete RCA was posted through splitForSlack
  // as plain mrkdwn. That is what "the dividers disappeared" was — no Block Kit card was built
  // at all, so there were no dividers to lose. Whether it happened came down to whether the
  // model felt like adding trailing spaces that run.
  //
  // dashboard/rca.ts parses the same text and is not affected: it trims each line first.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\*[^*]*${escaped}[^*]*\\*[ \\t]*\\n([\\s\\S]*?)(?=\\n[ \\t]*\\*[🔴🟠🟡🟢⚡📍📊🚫🔧⚠️📈][^*]*\\*|$)`, "i");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function divider(): Block {
  return { type: "divider" };
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

// Conversation replies sometimes leak RCA-template SECTIONS without the Severity label
// isRcaResponse keys on ("Proposed plan: Immediate/Short-term/Long-term", "Impact if
// Unresolved", "Confidence: High"). Two or more distinct markers = structural leak →
// the reply should be reformatted to a plain conversational answer.
export function leaksRcaStructure(text: string): boolean {
  // mutating kubectl/helm command dumps are their own leak class — execution happens
  // via the approval card, never via instructions for the user's terminal
  const commandDump = /\bkubectl\s+(rollout|scale|set|patch|delete|apply|edit)\b|\bhelm\s+(upgrade|rollback|uninstall)\b/i;
  const markers = [
    /impact if unresolved/i,
    /confidence:\s*[`*]?\s*(high|medium|low)/i,
    /ruled out/i,
    /immediate:[\s\S]{0,400}short-term:/i,
  ];
  return commandDump.test(text) || markers.filter((m) => m.test(text)).length >= 2;
}

// The template's other headings, in the shape extractSection looks for: a whole line wrapped in
// asterisks. Any ONE of them standing beside Root Cause is enough to say "this is the card".
const RCA_HEADINGS = [
  /\*[^*]*Recommended Actions[^*]*\*/i,
  /\*[^*]*Impact[^*]*\*/i,
  /\*[^*]*Evidence[^*]*\*/i,
  /\*[^*]*Ruled Out[^*]*\*/i,
  /\*[^*]*Confidence[^*]*\*/i,
  /\*[^*]*TL;DR[^*]*\*/i,
];

/**
 * Does this answer want the RCA card?
 *
 * Root Cause is required and always was. The severity line is no longer: it is ONE line of the
 * template, and a model that drops it has still written an RCA. Observed 2026-09-15 16:52 on an
 * explicit "investigasi kenapa prometheus query nya kosong" — the model returned `*📍 Root Cause*`
 * with a numbered causal chain, Evidence and Recommended Actions across 4200+ characters, no
 * Severity line, and all of it went to Slack as plain mrkdwn: no header, no dividers, no sections,
 * and nothing in the thread saying the card had been skipped. `buildRcaBlocks` already renders a
 * missing severity as `⚪ Unknown Severity Incident`, so the card could always have carried that
 * answer — only the gate in front of it could not.
 *
 * A second heading is required in severity's place, and that is what keeps the gate honest: an
 * answer that merely mentions a root cause in prose has no bolded heading at all, so a
 * conversational reply is still not dragged into the template.
 */
export function isRcaResponse(text: string): boolean {
  if (!/\*[^*]*Root Cause[^*]*\*/i.test(text)) return false;
  return SEVERITY_PATTERN.test(text) || RCA_HEADINGS.some((r) => r.test(text));
}

/**
 * The run footer: how long it took, on which model, over how many rounds.
 *
 * Built from measured metadata, never parsed back out of the reply — and appended as its own
 * Slack block rather than as text, because extractSection() reads a section "up to the next
 * heading or END OF TEXT". A footer line glued onto the reply would be swallowed into the
 * Confidence section and land in the dashboard's RCA card as part of the agent's verdict.
 */
export function formatRunFooter(meta: {
  durationMs: number;
  rounds: number;
  toolCalls: number;
  model?: string;
  backend?: string;
  route?: "light" | "heavy";
}): string {
  const secs = meta.durationMs / 1000;
  const parts = [`⏱ ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`];
  // backend is the name YOU gave it in the routes; model is what actually ran. Both, when they
  // differ — "private-llm-chatgpt" alone does not say which model, and a bare model name does
  // not say which route answered after a failover.
  const engine = meta.model && meta.backend && meta.model !== meta.backend
    ? `${meta.backend} (${meta.model})`
    : meta.model ?? meta.backend;
  if (engine) parts.push(`🧠 ${engine}${meta.route ? ` · ${meta.route}` : ""}`);
  parts.push(`${meta.rounds} round${meta.rounds === 1 ? "" : "s"}`);
  if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} tool call${meta.toolCalls === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function buildRcaBlocks(rcaText: string, footer?: string): Block[] {
  const blocks: Block[] = [];

  // ── Severity ─────────────────────────────────────────────────────────────
  const severityMatch = rcaText.match(SEVERITY_PATTERN);
  const severity = severityMatch ? severityMatch[1].trim().toLowerCase() : "";
  const severityEmoji = SEVERITY_COLOR[severity] ?? "⚪";
  const severityLabel = severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : "Unknown";

  blocks.push(header(`${severityEmoji} ${severityLabel} Severity Incident`));
  blocks.push(divider());

  // ── Section order ────────────────────────────────────────────────────────
  // This is the on-call reading order, and it is deliberately NOT the order the sections are
  // reasoned in: what is broken, why it matters, what to do, and only then the argument behind
  // it. prompts/skills/rca-format.md emits them in this same order, so nothing is reordered
  // here — keep the two in step, and keep the emoji set in extractSection's lookahead in step
  // too, since a label whose emoji is missing there stops ending the section above it.

  // ── TL;DR ────────────────────────────────────────────────────────────────
  // Optional: an RCA written before this section existed, or by a model that skipped it, still
  // renders — it just opens on Impact the way it used to.
  const tldr = extractSection(rcaText, "TL;DR");
  if (tldr) {
    blocks.push(section(`*⚡ TL;DR*\n${tldr}`));
    blocks.push(divider());
  }

  // ── Impact ───────────────────────────────────────────────────────────────
  // Above the actions, not below them: impact is what decides whether the actions are worth
  // waking someone for, and it used to sit second-to-last on the card.
  const impact = extractSection(rcaText, "Impact");
  if (impact) {
    blocks.push(section(`*⚠️ Impact if Unresolved*\n${impact}`));
  }

  // ── Recommended Actions ──────────────────────────────────────────────────
  const actions = extractSection(rcaText, "Recommended Actions");
  if (actions) {
    blocks.push(section(`*🔧 Recommended Actions*\n${actions}`));
  }

  if (impact || actions) blocks.push(divider());

  // ── Root Cause ───────────────────────────────────────────────────────────
  // A numbered causal chain now rather than a paragraph, but the label is unchanged on purpose:
  // isRcaResponse, dashboard/rca.ts and extractRootCause all key on it.
  const rootCause = extractSection(rcaText, "Root Cause");
  if (rootCause) {
    blocks.push(section(`*📍 Root Cause*\n${rootCause}`));
    blocks.push(divider());
  }

  // ── Evidence ─────────────────────────────────────────────────────────────
  const evidence = extractSection(rcaText, "Evidence");
  if (evidence) {
    blocks.push(section(`*📊 Evidence*\n${evidence}`));
  }

  // ── Ruled Out ────────────────────────────────────────────────────────────
  const ruledOut = extractSection(rcaText, "Ruled Out");
  if (ruledOut) {
    blocks.push(section(`*🚫 Ruled Out*\n${ruledOut}`));
  }

  if (evidence || ruledOut) blocks.push(divider());


  // ── Confidence ────────────────────────────────────────────────────────────
  const confidenceMatch = rcaText.match(/\*[^*]*Confidence[^*]*\*[^`]*`([^`]+)`[^—–\n]*(—|–)?\s*([^\n]+)?/i);
  if (confidenceMatch) {
    const level = confidenceMatch[1].trim();
    const explanation = confidenceMatch[3]?.trim() ?? "";
    const confText = explanation
      ? `*📈 Confidence:* \`${level}\` — ${explanation}`
      : `*📈 Confidence:* \`${level}\``;
    blocks.push(section(confText));
  }

  // fallback: if parsing failed, return raw text as a single block
  if (blocks.length <= 2) {
    return [section(rcaText)];
  }

  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });

  return blocks;
}
