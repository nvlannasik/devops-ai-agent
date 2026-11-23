// --- /digests: the daily health digests that were posted (agent/digest, migrations/026) ---
// Slack is not an archive: the digest is a message in a busy channel, gone from view in a day. This
// renders what was posted, newest first, from the text the agent stored with the claim.

import { esc, fmtInt } from "./html.js";
import { ICON, empty, panel } from "./parts.js";
import { layout } from "./layout.js";

/**
 * The digest's Slack mrkdwn as HTML — the subset agent/digest/build.ts writes: `*bold*`, `_italic_`,
 * `` `code` ``, `•` bullets, `↳` lines under them, Slack date tokens. Escaped FIRST, so nothing in the
 * text can become markup that the patterns below did not make.
 */
export function digestHtml(text: string): string {
  // `<!date^<epoch>^<format>|<fallback>>` → its fallback, before escaping eats the angle brackets.
  const plain = text.replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, "$1");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code translate="no">$1</code>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;])/g, "$1<strong>$2</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,:;])/g, "$1<em>$2</em>");
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.join("")}</ul>`);
    list = [];
  };
  for (const line of plain.split("\n")) {
    const t = line.trim();
    if (t.startsWith("• ")) list.push(`<li>${inline(t.slice(2))}</li>`);
    else if (t.startsWith("↳ ")) {
      const last = list.pop() ?? "<li></li>";
      list.push(last.replace(/<\/li>$/, `<p class="meta">↳ ${inline(t.slice(2))}</p></li>`));
    } else {
      flush();
      if (t) out.push(`<p>${inline(t)}</p>`);
    }
  }
  flush();
  return out.join("");
}

export function digestsPage(rows: Array<{ day: string; text: string }>, openIncidents?: number): string {
  const list = rows.length
    ? rows.map((r) => panel(r.day, `<div class="doc">${digestHtml(r.text)}</div>`, "", `digest-${r.day}`)).join("")
    : empty("No digest yet.", "The first one is posted to the alert channel at DIGEST_TIME (08:00 Asia/Jakarta on dev); @agent digest shows today's in Slack.", ICON.repeat);
  return layout(
    "Daily digests",
    `<div class="doc">
       <p class="eyebrow">Monitor</p>
       <h1>Daily digests</h1>
       <p class="meta">${rows.length ? `${esc(fmtInt(rows.length))} day${rows.length === 1 ? "" : "s"} · ` : ""}what the agent posted each morning, newest
         first: hosts, control plane, what was firing, GitOps, the last day's investigations and the noisy alerts. Built from data, no model.</p>
     </div>
     ${list}`,
    { current: "/digests", openIncidents }
  );
}
