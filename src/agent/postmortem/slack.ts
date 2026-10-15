// The Slack card for a postmortem draft, laid out like the RCA (`prompts/skills/rca-format.md`):
// emoji section headers in Slack bold. Built by code, not by the model — the Numbers line is
// numbersOf(f), so Slack can no more carry an invented duration than the stored draft can. The
// model's prose comes from the assembled draft's own sections; the full document lives on the
// dashboard, which is what the link is for.
import type { PostmortemFacts } from "./facts.js";
import { numbersOf } from "./facts.js";
import { sectionOf } from "./draft.js";
import { formatDuration } from "../../utils/slack/blocks.js";
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

/**
 * `link` is the dashboard URL (absolute, from DASHBOARD_PUBLIC_URL), a bare path when no public
 * URL is configured, or null when the draft was not stored and there is nothing to link to.
 */
export function postmortemSlackText(f: PostmortemFacts, markdown: string, link: string | null): string {
  const i = f.incident;
  const n = numbersOf(f);
  const section = (h: string): string => sectionOf(markdown, h) ?? "_Not drafted._";
  const footer =
    link === null
      ? "_Draft not stored — the dashboard will not have it._"
      : /^https?:\/\//.test(link)
        ? `🔗 <${link}|Full draft on the dashboard> · _draft — review before sharing; action items need owners_`
        : `Full draft: \`${link}\` · _draft — review before sharing; action items need owners_`;
  return toMrkdwn(
    [
      `*📝 Postmortem draft* — \`${i.alertname}\` · \`${i.namespace ?? "cluster"}\` · ${i.resolvedAt ? "✅ Resolved" : "🔥 Not marked resolved"}`,
      `*⏱️ Numbers*\n• Time to RCA: ${ms(n.timeToRcaMs)} · Time to mitigation: ${ms(n.timeToMitigationMs)} · Duration: ${ms(n.durationMs)}\n• Related alerts: ${n.relatedAlerts} · Remediations: ${n.remediations}`,
      `*⚡ Summary*\n${section("Summary")}`,
      `*📍 Root cause*\n${section("Root cause")}`,
      `*🔧 Action items*\n${numbered(section("Action items"))}`,
      footer,
    ].join("\n\n")
  );
}
