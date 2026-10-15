// The Slack card for a postmortem draft, laid out like the RCA (`prompts/skills/rca-format.md`):
// emoji section headers in Slack bold. Built by code, not by the model — the Numbers line is
// numbersOf(f), so Slack can no more carry an invented duration than the stored draft can. The
// model's prose comes from the assembled draft's own sections; the full document lives on the
// dashboard, which is what the link is for.
import type { PostmortemFacts } from "./facts.js";
import { numbersOf } from "./facts.js";
import { sectionOf } from "./draft.js";
import { divider, formatDuration, header, section, type Block } from "../../utils/slack/blocks.js";
import { toMrkdwn } from "../../utils/slack/split.js";

const OWNER_SUFFIX = /\s*_\(draft — needs an owner\)_\s*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ms = (v: number | null): string => `\`${v == null ? "—" : formatDuration(v)}\``;

/** `- a` / `* a` / `1. a` bullets → `1. a`, each without the per-item owner suffix. */
function numbered(body: string): string {
  let n = 0;
  return body
    .split("\n")
    .map((l) => (BULLET.test(l) ? `${++n}. ${l.replace(BULLET, "").replace(OWNER_SUFFIX, "")}` : l.replace(OWNER_SUFFIX, "")))
    .join("\n");
}

/** The card's pieces, shared by the Block Kit card and its plain-text fallback. */
function cardParts(f: PostmortemFacts, markdown: string, link: string | null): { title: string; parts: string[]; footer: string } {
  const i = f.incident;
  const n = numbersOf(f);
  const sec = (h: string): string => sectionOf(markdown, h) ?? "_Not drafted._";
  const footer =
    link === null
      ? "_Draft not stored — the dashboard will not have it._"
      : /^https?:\/\//.test(link)
        ? `🔗 <${link}|Full draft on the dashboard> · _draft — review before sharing; action items need owners_`
        : `Full draft: \`${link}\` · _draft — review before sharing; action items need owners_`;
  return {
    title: `📝 Postmortem draft — ${i.alertname}`,
    parts: [
      `\`${i.alertname}\` · \`${i.namespace ?? "cluster"}\` · ${i.resolvedAt ? "✅ Resolved" : "🔥 Not marked resolved"}`,
      `*⏱️ Numbers*\n• Time to RCA: ${ms(n.timeToRcaMs)} · Time to mitigation: ${ms(n.timeToMitigationMs)} · Duration: ${ms(n.durationMs)}\n• Related alerts: ${n.relatedAlerts} · Remediations: ${n.remediations}`,
      `*⚡ Summary*\n${sec("Summary")}`,
      `*📍 Root cause*\n${sec("Root cause")}`,
      `*🔧 Action items*\n${numbered(sec("Action items"))}`,
    ].map(toMrkdwn),
    footer,
  };
}

/**
 * Plain mrkdwn — the fallback when Slack refuses the blocks, and the notification text.
 * `link` is the dashboard URL (absolute, from DASHBOARD_PUBLIC_URL), a bare path when no public
 * URL is configured, or null when the draft was not stored and there is nothing to link to.
 */
export function postmortemSlackText(f: PostmortemFacts, markdown: string, link: string | null): string {
  const { parts, footer } = cardParts(f, markdown, link);
  return [`*📝 Postmortem draft* — ${parts[0]}`, ...parts.slice(1), footer].join("\n\n");
}

/** The RCA card's shape: a header, a divider after every section, the link in a context footer. */
export function postmortemSlackBlocks(f: PostmortemFacts, markdown: string, link: string | null): Block[] {
  const { title, parts, footer } = cardParts(f, markdown, link);
  // A header's plain_text is capped at 150 characters by Slack, and an alertname is free text.
  const blocks: Block[] = [header(Array.from(title).slice(0, 150).join("")), divider()];
  for (const p of parts) blocks.push(...section(p), divider());
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  return blocks;
}
