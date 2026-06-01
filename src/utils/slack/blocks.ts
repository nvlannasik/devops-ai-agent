import type { KnownBlock } from "@slack/types";

type Block = KnownBlock;

const SEVERITY_COLOR: Record<string, string> = {
  critical: "🔴", high: "🟠", medium: "🟡", low: "🟢",
};

function extractSection(text: string, label: string): string {
  // matches "*📍 Root Cause*\n..." up to the next "*emoji Label*" or end
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\*[^*]*${escaped}[^*]*\\*\\n([\\s\\S]*?)(?=\\n\\*[🔴🟠🟡🟢📍📊🚫🔧⚠️📈][^*]*\\*|$)`, "i");
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

export function isRcaResponse(text: string): boolean {
  return /\*[^*]*Severity[^*]*\*[^`]*`\[?(critical|high|medium|low)\]?`/i.test(text) &&
    /\*[^*]*Root Cause[^*]*\*/i.test(text);
}

export function buildRcaBlocks(rcaText: string): Block[] {
  const blocks: Block[] = [];

  // ── Severity ─────────────────────────────────────────────────────────────
  const severityMatch = rcaText.match(/\*[^*]*Severity[^*]*\*[^`]*`\[?([^\]`]+)\]?`/i);
  const severity = severityMatch ? severityMatch[1].trim().toLowerCase() : "";
  const severityEmoji = SEVERITY_COLOR[severity] ?? "⚪";
  const severityLabel = severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : "Unknown";

  blocks.push(header(`${severityEmoji} ${severityLabel} Severity Incident`));
  blocks.push(divider());

  // ── Root Cause ────────────────────────────────────────────────────────────
  const rootCause = extractSection(rcaText, "Root Cause");
  if (rootCause) {
    blocks.push(section(`*📍 Root Cause*\n${rootCause}`));
    blocks.push(divider());
  }

  // ── Evidence ──────────────────────────────────────────────────────────────
  const evidence = extractSection(rcaText, "Evidence");
  if (evidence) {
    blocks.push(section(`*📊 Evidence*\n${evidence}`));
  }

  // ── Ruled Out ─────────────────────────────────────────────────────────────
  const ruledOut = extractSection(rcaText, "Ruled Out");
  if (ruledOut) {
    blocks.push(section(`*🚫 Ruled Out*\n${ruledOut}`));
  }

  if (evidence || ruledOut) blocks.push(divider());

  // ── Recommended Actions ───────────────────────────────────────────────────
  const actions = extractSection(rcaText, "Recommended Actions");
  if (actions) {
    blocks.push(section(`*🔧 Recommended Actions*\n${actions}`));
    blocks.push(divider());
  }

  // ── Impact ────────────────────────────────────────────────────────────────
  const impact = extractSection(rcaText, "Impact");
  if (impact) {
    blocks.push(section(`*⚠️ Impact if Unresolved*\n${impact}`));
  }

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

  return blocks;
}
