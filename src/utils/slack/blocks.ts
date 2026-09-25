import type { KnownBlock } from "@slack/types";
import { actionsTable, evidenceTable } from "./rca-tables.js";
import { splitForSlack } from "./split.js";

export type Block = KnownBlock;

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

/**
 * Slack rejects a `section` whose text is over 3000 characters — the whole message, with
 * `invalid_blocks`, so one long section costs the entire card.
 *
 * Live 2026-09-23 04:41: a seven-round investigation produced a 4961-character section and the
 * RCA never reached Slack at all. The size was already in the log line beside it ("longest 4961
 * chars"), added when a previous card-shaped failure went unexplained.
 *
 * Split rather than truncated: an RCA's long section is the evidence list, and dropping its tail
 * silently is the same failure one step quieter. `splitForSlack` is fence-aware, so a code block
 * spanning the cut is closed and reopened.
 */
const SLACK_SECTION_MAX = 2900;

function section(text: string): Block[] {
  return splitForSlack(text, SLACK_SECTION_MAX).map((part) => ({
    type: "section",
    text: { type: "mrkdwn", text: part },
  }));
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
 * A run's wall-clock time, in the units a reader actually thinks in.
 *
 * It used to be seconds all the way up, so a slow private backend printed `⏱ 101s` and the reader
 * had to divide. Investigations on this stack reach minutes routinely — the alert path runs up to
 * ten LLM calls against a self-hosted model — so minutes are the normal case, not the edge one.
 *
 * Sub-10s keeps one decimal, because that is the range where the difference between 2.1s and 8.4s
 * is the thing worth knowing. The threshold is tested on the value that would be PRINTED, so
 * 9.9s keeps its decimal and 9.999s prints `10s` rather than the `10.0s` a naive `< 10` gives.
 *
 * A zero unit is dropped rather than padded: `2m` beats `2m 0s`, and `1h 9s` is what an hour and
 * nine seconds is. Exported for the test, and because the dashboard will want the same units the
 * Slack card shows when it grows a duration column.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  // Rounded to the decimal it would PRINT, not to a whole second: `< 10` on the whole value hands
  // 9.9s to the integer branch and prints `10s`, and `< 10` on the raw value prints `10.0s` for
  // 9.999s. Rounding first makes the threshold mean what the comment says it means.
  const oneDp = Math.round(total * 10) / 10;
  if (oneDp < 10) return `${oneDp.toFixed(1)}s`;

  const whole = Math.round(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  // The seconds clause also carries the all-zero case, which only `0ms` reaches — and `0s` is a
  // better answer there than an empty string.
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
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
  const parts = [`⏱ ${formatDuration(meta.durationMs)}`];
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
    blocks.push(...section(`*⚡ TL;DR*\n${tldr}`));
    blocks.push(divider());
  }

  // ── One divider per section, and the rule is the point ───────────────────
  // Impact and Recommended Actions used to share one, and so did Evidence and Ruled Out —
  // `if (impact || actions) push(divider())`, which is the shape you write to stop a divider
  // dangling when one of a pair is absent. The missing rule BETWEEN them was a side effect of
  // that guard, not a decision to group them, and it was noticed as exactly that: two sections
  // running together while their neighbours were separated. Pushing the divider inside each
  // `if` solves the dangling case too, and it cannot drift back.
  //
  // ── Impact ───────────────────────────────────────────────────────────────
  // Above the actions, not below them: impact is what decides whether the actions are worth
  // waking someone for, and it used to sit second-to-last on the card.
  const impact = extractSection(rcaText, "Impact");
  if (impact) {
    blocks.push(...section(`*⚠️ Impact if Unresolved*\n${impact}`));
    blocks.push(divider());
  }

  // ── Recommended Actions ──────────────────────────────────────────────────
  // `When | Action`, on the same terms as Evidence below: a table when the section really is the
  // three-rung ladder the template asks for, the numbered list when it is anything else.
  const actions = extractSection(rcaText, "Recommended Actions");
  if (actions) {
    const asTable = actionsTable(actions);
    if (asTable) {
      blocks.push(...section("*🔧 Recommended Actions*"), asTable);
    } else {
      blocks.push(...section(`*🔧 Recommended Actions*\n${actions}`));
    }
    blocks.push(divider());
  }

  // ── Root Cause ───────────────────────────────────────────────────────────
  // A numbered causal chain now rather than a paragraph, but the label is unchanged on purpose:
  // isRcaResponse, dashboard/rca.ts and extractRootCause all key on it.
  const rootCause = extractSection(rcaText, "Root Cause");
  if (rootCause) {
    blocks.push(...section(`*📍 Root Cause*\n${rootCause}`));
    blocks.push(divider());
  }

  // ── Evidence ─────────────────────────────────────────────────────────────
  // A real Block Kit table when the section is a list of findings, the bullet list when it is
  // anything else — see evidenceTable for what "anything else" means and why it decides that way.
  // The heading stays its own section block either way: a table carries no title of its own, and
  // every other section here is announced by one.
  const evidence = extractSection(rcaText, "Evidence");
  if (evidence) {
    const asTable = evidenceTable(evidence);
    if (asTable) {
      blocks.push(...section("*📊 Evidence*"), asTable);
    } else {
      blocks.push(...section(`*📊 Evidence*\n${evidence}`));
    }
    blocks.push(divider());
  }

  // ── Ruled Out ────────────────────────────────────────────────────────────
  const ruledOut = extractSection(rcaText, "Ruled Out");
  if (ruledOut) {
    blocks.push(...section(`*🚫 Ruled Out*\n${ruledOut}`));
    blocks.push(divider());
  }


  // ── Confidence ────────────────────────────────────────────────────────────
  const confidenceMatch = rcaText.match(/\*[^*]*Confidence[^*]*\*[^`]*`([^`]+)`[^—–\n]*(—|–)?\s*([^\n]+)?/i);
  if (confidenceMatch) {
    const level = confidenceMatch[1].trim();
    const explanation = confidenceMatch[3]?.trim() ?? "";
    const confText = explanation
      ? `*📈 Confidence:* \`${level}\` — ${explanation}`
      : `*📈 Confidence:* \`${level}\``;
    blocks.push(...section(confText));
  }

  // fallback: if parsing failed, return the raw text — still split, since an unparsed RCA is the
  // longest thing this function ever emits.
  if (blocks.length <= 2) {
    return section(rcaText);
  }

  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });

  return blocks;
}
