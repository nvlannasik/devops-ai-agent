import { costUsd, type Price } from "../agent/llm/pricing.js";
import { esc, fmtDuration, fmtInt } from "./html.js";
import { PAGE_SIZE } from "./filters.js";

/** `$1.21`; under a cent is "<$0.01", never a rounded "$0.00" that reads as free. */
export const fmtUsd = (n: number): string => (n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);
/** A backend's cost cell: priced, not priced, or nothing reported to price. */
export const costCell = (prices: ReadonlyMap<string, Price>, b: { backend: string; input: number; output: number; cacheRead: number }): string => {
  if (b.input + b.output === 0) return `<span class="meta">not reported</span>`;
  const c = costUsd(prices.get(b.backend), b);
  return c === null ? `<span class="meta">not priced</span>` : fmtUsd(c);
};

// Each glyph is drawn from the page it opens rather than picked off a generic set: a bar
// series for the weekly chart the overview leads with, an alert triangle for a table whose
// every row is one, three linked nodes for the dependency map. Inline because the CSP sends
// `default-src 'none'` — an icon font or a sprite sheet is a fetch this page cannot make.
// Stroked, not filled: at 18px a solid glyph reads as a blob.
//
// aria-hidden on every one of them. The icon is not the name of the destination; the text
// beside it is, and that text stays in the markup even at the narrow breakpoint where CSS
// clips it out of sight. That is what lets the rail go icon-only without going unlabelled.
const ico = (paths: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"` +
  ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICON = {
  overview: ico(`<path d="M3 21h18"/><path d="M7 21v-7"/><path d="M12 21V4"/><path d="M17 21v-11"/>`),
  incidents: ico(
    `<path d="M10.3 4 2.4 18a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 4a1.9 1.9 0 0 0-3.4 0Z"/>` +
      `<path d="M12 9.5v4"/><path d="M12 17.2h.01"/>`
  ),
  topology: ico(
    `<circle cx="12" cy="5" r="2.6"/><circle cx="5" cy="19" r="2.6"/><circle cx="19" cy="19" r="2.6"/>` +
      `<path d="M10.4 7.3 6.6 16.4"/><path d="M13.6 7.3l3.8 9.1"/>`
  ),
  context: ico(
    `<path d="M4 5.4A1.8 1.8 0 0 1 5.8 3.6H19v13.6H5.8A1.8 1.8 0 0 0 4 19v-13.6Z"/>` +
      `<path d="M4 19a1.8 1.8 0 0 0 1.8 1.8H19"/><path d="M8.4 8h6.4"/><path d="M8.4 11.6h4.2"/>`
  ),
  signout: ico(`<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 16 4-4-4-4"/><path d="M14 12H4"/>`),
  // The two states of the drawer control. Both ship in the markup and CSS shows one at a time:
  // a single glyph that morphed would need a transform per line, and there is nothing to gain
  // from animating a control that is only on screen at phone widths.
  menu: ico(`<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>`),
  close: ico(`<path d="m6 6 12 12"/><path d="m18 6-12 12"/>`),

  // Section and figure glyphs. Same rule as the rail's: each one is drawn from what it labels,
  // and a glyph that would serve two different meanings is redrawn rather than reused. The
  // pairs that DO repeat are deliberate — the wrench is remediation wherever remediation is
  // named, the speech bubble is on-call, the chip is the model — because a reader who learns
  // one on the overview should not have to relearn it on the incident page.
  bench: ico(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>`),
  // Three gates on a line: the code around the model, deciding.
  harness: ico(`<path d="M3 12h18"/><path d="M7 8v8"/><path d="M12 8v8"/><path d="M17 8v8"/>`),
  chip: ico(
    `<rect x="7" y="7" width="10" height="10" rx="1.7"/>` +
      `<path d="M10 3.2v3.4"/><path d="M14 3.2v3.4"/><path d="M10 17.4v3.4"/><path d="M14 17.4v3.4"/>` +
      `<path d="M3.2 10h3.4"/><path d="M3.2 14h3.4"/><path d="M17.4 10h3.4"/><path d="M17.4 14h3.4"/>`
  ),
  repeat: ico(
    `<path d="m17 2.6 3.4 3.4L17 9.4"/><path d="M3.6 11.4V10a4 4 0 0 1 4-4h12.8"/>` +
      `<path d="M7 21.4 3.6 18 7 14.6"/><path d="M20.4 12.6V14a4 4 0 0 1-4 4H3.6"/>`
  ),
  search: ico(`<circle cx="10.5" cy="10.5" r="7"/><path d="m20.5 20.5-5.1-5.1"/>`),
  wrench: ico(
    `<path d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.8 6.8a2.1 2.1 0 0 1-3-3l6.8-6.8a6 6 0 0 1 7.9-7.9Z"/>`
  ),
  speech: ico(`<path d="M20.5 14.5a2 2 0 0 1-2 2H7.8L3.5 20.8V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/>`),
  check: ico(`<circle cx="12" cy="12" r="8.8"/><path d="m8.2 12.3 2.6 2.6 5-5.6"/>`),
  layers: ico(`<path d="m12 2.6 9 4.9-9 4.9-9-4.9 9-4.9Z"/><path d="m3 13 9 4.9 9-4.9"/>`),
  // The two arrows are a pair and are read as one: what went to the model, what came back.
  // Same baseline, same head, mirrored — anything else and the reader has to check each.
  inTokens: ico(`<path d="M12 3.4v11"/><path d="m7.6 10 4.4 4.4 4.4-4.4"/><path d="M4 20.2h16"/>`),
  outTokens: ico(`<path d="M12 20.6v-11"/><path d="m7.6 14 4.4-4.4 4.4 4.4"/><path d="M4 3.8h16"/>`),
  bolt: ico(`<path d="M13.2 2.4 4.4 13.6h7.1l-1 8 8.8-11.2h-7.1l1-8Z"/>`),
  inbound: ico(`<path d="M20.6 12H8.2"/><path d="m12.6 7.2 5 4.8-5 4.8"/><path d="M3.6 4.2v15.6"/>`),
  outbound: ico(`<path d="M3.4 12h12.4"/><path d="m11.4 7.2 5 4.8-5 4.8"/><path d="M20.4 4.2v15.6"/>`),
  plug: ico(
    `<path d="M12 21.6v-4.2"/><path d="M8.8 6.6V2.4"/><path d="M15.2 6.6V2.4"/>` +
      `<path d="M5.8 12.4V6.6h12.4v5.8a5 5 0 0 1-5 5h-2.4a5 5 0 0 1-5-5Z"/>`
  ),
  // Recent changes: a clock running backwards, not the wrench — that one is remediation's and
  // stays remediation's (src/dashboard/CLAUDE.md: "a glyph repeats only where the meaning does").
  changes: ico(
    `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`
  ),
  // Related alerts (agent/correlation): a chain link, new on this page — nothing else here
  // means "another incident merged into this one", so no existing glyph fits.
  link: ico(
    `<path d="M9.5 14.5 14.5 9.5"/>` +
      `<path d="M11 6.2 13 4.2a3.4 3.4 0 0 1 4.8 4.8l-2 2"/>` +
      `<path d="M13 17.8 11 19.8a3.4 3.4 0 0 1-4.8-4.8l2-2"/>`
  ),
  // Memory (/memory): an archive box — what the agent keeps. New, because nothing else here means it.
  memory: ico(`<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>`),
  // A thread's conversation memory: two bubbles. Not `speech` — that one means on-call.
  // A postmortem draft: a page with a folded corner and lines of text.
  postmortem: ico(`<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>`),
  chats: ico(`<path d="M14 9a2 2 0 0 1-2 2H7l-3 3V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2Z"/><path d="M18 9h1a2 2 0 0 1 2 2v9l-3-3h-5a2 2 0 0 1-2-2v-1"/>`),
  // Who may address the agent: an at-sign.
  at: ico(`<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.4v4.8a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>`),
  // The humans the agent pages and waits on: two heads.
  people: ico(`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.2a6.5 6.5 0 0 1 3 5.8"/>`),
};

// `translate="no"` travels with the mono/code role throughout this file. Those cells hold
// namespaces, queue names, model ids and endpoints — values that have to match what you type
// into kubectl. A browser offering to translate the page must not turn `prod` into `produksi`.
// The prose (the RCA, the empty states, the labels) is left translatable on purpose.

// An allowlist, not a pass-through: the value lands in a data-* attribute that selects a
// colour, and severity/status text arrives from Alertmanager and the database. Anything
// unrecognised renders in the neutral tone rather than inventing a class name from input.
const TONE: Record<string, string> = {
  // The four tone names map to themselves, so a caller that already holds a tone — delta()
  // does, and so does the donut's slice mapping — can pass it through the same gate every
  // status string goes through instead of skipping it. Three of the four were already here
  // only because they are also severity values; "ok" is not a severity, so it was missing,
  // and toneAttr("ok") silently produced nothing.
  critical: "critical", warning: "warning", info: "info", ok: "ok",
  // The ASSESSED severities (agent/incidents/parseSeverity: critical | high | medium | low).
  // Three of the four were missing, so every incident the agent did not call Critical rendered
  // a GREY badge, a grey row spine and a grey donut slice — on a dashboard whose premise is
  // that severity carries colour. Severity reaches tone() from three places (severityBadge,
  // the row's toneAttr, the donut's slice) and they all route through here, so this is one map
  // rather than three fixes.
  //
  // Collapsed at the BOTTOM, not the top: telling Critical from High at a glance is what an
  // on-call page is for, while Medium and Low can share blue and be told apart by the word the
  // badge always carries. Nothing maps to `ok` — green would assert a low-severity incident is
  // good news, and this map is deliberately silent (see `inconclusive`) rather than wrong.
  high: "warning", medium: "info", low: "info",
  resolved: "ok", succeeded: "ok", confirmed: "ok", approved: "ok",
  failed: "critical", rejected: "critical",
  executing: "warning", proposed: "info",
  // The post-remediation verdicts (agent/remediation/verify.ts). `worse` is critical because
  // it is the one outcome on this dashboard that says the agent made things WORSE, and
  // `inconclusive` is deliberately absent from this map: it means "we looked and the evidence
  // says nothing either way", and a colour would turn that into a claim.
  recovered: "ok", unchanged: "warning", worse: "critical",
};
export const tone = (s: unknown): string => TONE[String(s ?? "").toLowerCase()] ?? "";

export const toneAttr = (s: unknown): string => {
  const t = tone(s);
  return t ? ` data-tone="${esc(t)}"` : "";
};

export const badge = (label: string, t: string = tone(label)): string =>
  `<span class="badge"${t ? ` data-tone="${esc(t)}"` : ""}>${esc(label)}</span>`;

export const dash = `<span class="meta">—</span>`;

// Firing and resolved, and which of the two the column emphasises.
//
// It used to be the wrong one: `badge("firing", "")` is the neutral badge — --text-dim on
// --surface-2 — while resolved wore green, so in a column whose entire job is "which of these
// is still live" the live rows were the quietest thing in it. `data-live` spends weight rather
// than colour to fix it (full --text, a visible edge), because colour on this page belongs to
// severity and the row already states its severity one cell to the left.
export const stateBadge = (resolvedAt: Date | null): string =>
  resolvedAt
    ? badge("resolved", "ok")
    : `<span class="badge" data-live>firing</span>`;
export const severityBadge = (s: string | null): string => (s ? badge(s) : dash);

// Alert names are one long CamelCase identifier with no space in them, so in a narrow column the
// browser has nowhere to break and falls back to breaking anywhere — PersistentVolumeFillin/gUp.
// <wbr> offers the humps as break opportunities, and a browser takes an offered break before it
// invents one, so the name comes apart at PersistentVolume/FillingUp instead.
//
// Escape first, insert markup second — the same invariant rca.ts is built on. The regex is safe
// against the escaped string on purpose: every entity esc() can emit (&amp; &lt; &gt; &quot;
// &#39;) is lowercase or digits after the ampersand, so a lower-to-upper boundary can never fall
// inside one and split it.
export const breakable = (name: string): string => esc(name).replace(/([a-z0-9])(?=[A-Z])/g, "$1<wbr>");

// Every empty state names the fact and then the next move. An empty screen that only says
// "no data" leaves the reader unsure whether the system is broken or simply quiet.
//
// `icon` is the SECTION's own glyph, passed by the caller — an empty Remediation panel shows
// the wrench, so it stays recognisably the same section whether or not it has rows. Markup,
// not text, so it is not escaped; the same contract Stat.icon has. It is optional because two
// callers (the "nothing on page 7" notice, the error page) are not a section's contents.
//
// A <div>, not a <p>: the glyph rides in a chip, and a chip is a block.
export const empty = (headline: string, next: string, icon = ""): string =>
  `<div class="empty">` +
  (icon ? `<span class="kpi-icon" aria-hidden="true">${icon}</span>` : "") +
  `<strong>${esc(headline)}</strong><span>${esc(next)}</span></div>`;

// A section heading with a glyph. The icon and the label are one flex item so h2's own gap —
// which is sized for the distance out to the hairline — never lands between a picture and the
// word it labels; a trailing link keeps working, it sorts past the hairline as before.
export const section = (icon: string, title: string, trailing = ""): string =>
  `<h2><span class="sec">${icon}${esc(title)}</span>${trailing}</h2>`;

// The icon is markup, not text, so it is passed pre-built by the caller rather than escaped
// here — every value that came from a row or from the LLM still goes through esc().
interface Stat {
  label: string;
  value: string;
  sub?: string;
  icon?: string;
  // The same severity vocabulary the tables use, for the one figure on a shelf that can be bad
  // news. Only set it when the number IS the bad news — a tone on every tile is a tone on none.
  // Passed through toneAttr like every other tone on the page, so it meets the same allowlist.
  tone?: string;
  // Pre-built markup from delta() — the movement against the previous window of equal length.
  // Markup rather than numbers for the same reason `icon` is: it is built by a helper in this
  // file from values that have already been escaped, and a Stat that had to carry four more
  // fields to describe a delta would be describing the delta component, not a statistic.
  delta?: string;
  // Where this figure leads. A figure a reader can act on should be a way in — "17 open" and
  // the list of those seventeen are the same fact at two zoom levels — and before this every
  // tile was a dead end that the restyle then made LOOK clickable.
  // Set it only where a destination genuinely exists; a tile without one stays inert, and the
  // hover lift is scoped to [data-linked] so it promises nothing it cannot keep.
  href?: string;
  // What the link is called, for a reader who hears it rather than sees it. The visible label
  // is two words ("Open") and the destination is a filtered list, so the anchor needs to say
  // more than the tile shows. Required whenever href is set.
  hrefLabel?: string;
}
// Four to a shelf, always. The grid is a fixed 4 → 2 → 1 ladder, so a fifth figure does not wrap
// into a row of its own — it either earns a place among the four or it belongs in a sub-line.
//
// `facts` marks a shelf that carries an incident's identity rather than a measurement — a
// namespace, a confidence, two timestamps. Same shelf, but on a phone each tile lays its label
// and value on one line instead of stacking them: four figures deserve the height, four labels
// do not, and this one sits above the analysis a reader came for.
// `pair` is a two-item shelf inside a panel, where the four-wide ladder has nothing to divide:
// it steps 2 -> 1 instead, and it drops the card treatment because the panel around it is
// already the card. Same component, because the tiles are the same tiles.
export const statList = (items: Stat[], variant: "" | "facts" | "pair" = ""): string =>
  `<dl class="stats${variant ? ` ${variant}` : ""}">` +
  items
    .map(
      (s) => `<div class="stat"${toneAttr(s.tone)}${s.href ? " data-linked" : ""}>` +
        `<dt>` +
        // The glyph gets a chip of its own. Wrapped rather than styled directly, because the
        // chip is a box with padding and a background and .ico is sized by every other caller
        // on the page — the rail, the section headings — which would all inherit the padding.
        (s.icon ? `<span class="kpi-icon" aria-hidden="true">${s.icon}</span>` : "") +
        // The anchor wraps the LABEL and stretches over the card with a ::after (see styles.ts).
        // It cannot wrap the tile from outside: <a> is not a permitted child of <dl>.
        (s.href
          ? `<a class="stat-link" href="${esc(s.href)}"` +
            (s.hrefLabel ? ` aria-label="${esc(s.hrefLabel)}"` : "") +
            `><span class="lbl">${esc(s.label)}</span></a>`
          : `<span class="lbl">${esc(s.label)}</span>`) +
        `${s.delta ?? ""}</dt>` +
        `<dd>${esc(s.value)}` +
        (s.sub ? `<span>${esc(s.sub)}</span>` : "") + `</dd></div>`
    )
    .join("") +
  `</dl>`;

// How many pages sit either side of the current one before the run is elided.
const PAGE_SPAN = 2;

/**
 * The page numbers to offer: `1 … 4 5 [6] 7 8 … 26`. The first and last are always in the
 * list, so both ends of the range stay one click away from anywhere in the middle.
 *
 * A run is only elided when eliding it saves a step. Exactly one hidden page renders as that
 * page rather than as an ellipsis standing in for a single number — `1 … 3 4 5` costs the
 * same width as `1 2 3 4 5` and hides a destination for nothing. `null` is the gap.
 */
export function pageWindow(current: number, last: number): (number | null)[] {
  const want = new Set<number>([1, last]);
  for (let p = current - PAGE_SPAN; p <= current + PAGE_SPAN; p++) {
    if (p >= 1 && p <= last) want.add(p);
  }
  const out: (number | null)[] = [];
  for (const p of [...want].sort((a, b) => a - b)) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (typeof prev === "number" && p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
    out.push(p);
  }
  return out;
}

/**
 * Where you are in the range, and every way out of it.
 *
 * The summary is rendered whenever there are rows, even on a single page — "3 incidents" is
 * an answer, and a reader who filtered to nothing wants the count more than the controls.
 * The controls appear only when there is somewhere to go.
 */
// Generic over what it pages (2026-10-20: /memory pages alert keys) — it reads rows, hasMore, total.
export function pager(
  p: { rows: readonly unknown[]; hasMore: boolean; total: number; capped?: boolean },
  f: { page: number },
  qs: (page: number) => string,
  noun = "incident"
): string {
  if (p.rows.length === 0) return "";
  const first = (f.page - 1) * PAGE_SIZE + 1;
  const shown = first + p.rows.length - 1;
  // The count is bounded (COUNT_CAP), so past the ceiling it is a floor and says so. "5,000+"
  // is true; a hard 5,000 under a table that keeps producing next pages is not.
  const total = `${fmtInt(p.total)}${p.capped ? "+" : ""}`;
  const summary =
    `<p class="pager-count">Showing <b>${esc(fmtInt(first))}–${esc(fmtInt(shown))}</b> of ` +
    `<b>${esc(total)}</b> ${esc(noun)}${p.total === 1 ? "" : "s"}</p>`;

  const last = Math.max(1, Math.ceil(p.total / PAGE_SIZE), f.page);
  if (last === 1 && !p.hasMore) return `<nav class="pager" aria-label="Pagination">${summary}</nav>`;

  // A step that leads nowhere keeps its slot but stops being a control: no href, and hidden
  // from assistive tech rather than announced as a link that does not go anywhere. Holding
  // the position matters — the arrows are what a reader clicks repeatedly, and a Next that
  // slides sideways as the row count changes is a target that moves under the pointer.
  const step = (to: number, live: boolean, glyph: string, label: string, rel: string): string =>
    live
      ? `<li><a class="step" href="${esc(qs(to))}" rel="${rel}" aria-label="${label}">${glyph}</a></li>`
      : `<li><span class="step off" aria-hidden="true">${glyph}</span></li>`;

  const numbers = pageWindow(f.page, last)
    .map((n) =>
      n === null
        ? `<li><span class="gap" aria-hidden="true">…</span></li>`
        : n === f.page
          ? `<li><span class="cur" aria-current="page">${esc(n)}</span></li>`
          : `<li><a href="${esc(qs(n))}" aria-label="Page ${esc(n)}">${esc(n)}</a></li>`
    )
    .join("");

  return (
    `<nav class="pager" aria-label="Pagination">${summary}<ul class="pages">` +
    step(f.page - 1, f.page > 1, "←", "Previous page", "prev") +
    numbers +
    // hasMore comes from the over-fetch, not from the count — so the last page is right even
    // when the count has hit its ceiling and cannot say how many pages there really are.
    step(f.page + 1, p.hasMore, "→", "Next page", "next") +
    `</ul></nav>`
  );
}

/**
 * The topology, handed to the browser as an inert data block.
 *
 * `type="application/json"` is not decoration: the browser never executes such a block, and
 * CSP's script-src does not gate it, so the page keeps the property this dashboard is built
 * around — nothing rendered here can become script execution. The alternative (a nonce'd block
 * assigning `window.__topo`) would have been an executable script carrying interpolated data,
 * which is the exact shape the rest of this codebase avoids.
 *
 * The escaping is still mandatory. A `</script>` inside any string — a reworded node, a
 * redacted URL — would close the element early and drop the remainder of the topology into the
 * document AS MARKUP. `<`, `>` and `&` are all legal as \u escapes inside a JSON string, so the
 * output stays parseable by JSON.parse with no cooperation from the client.
 */
export const jsonBlock = (id: string, nonce: string, value: unknown): string =>
  `<script type="application/json" id="${esc(id)}" nonce="${esc(nonce)}">` +
  JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) +
  `</script>`;

/**
 * The same figure, one window ago.
 *
 * Direction and judgement are two separate inputs and neither is derived from the other,
 * because on this page they disagree: more incidents is bad, a shorter time to resolve is
 * good. `better` says which direction counts as good news — it is what decides the colour;
 * the arrow only ever reports the direction the number moved.
 *
 * Returns "" when there is nothing to compare against. A previous window of zero is not a
 * baseline — every figure is then up by infinity, which is a rendering artefact rather than a
 * finding — and neither is a null (see Previous in queries.ts).
 */
export function delta(
  current: number | null,
  previous: number | null,
  opts: { better: "lower" | "higher"; unit?: "pp" | "count" | "duration" }
): string {
  if (current === null || previous === null || previous === 0) return "";
  const diff = current - previous;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  // A tone only when the movement has a direction. An unchanged figure is neither good news
  // nor bad, and colouring it either way is a claim the number does not make.
  const tone =
    dir === "flat" ? "" : (dir === "up") === (opts.better === "higher") ? "ok" : "critical";
  const size = Math.abs(diff);
  const text =
    opts.unit === "duration"
      ? fmtDuration(size)
      : opts.unit === "pp"
        // Percentage POINTS, not percent: the figure above is already a percentage, and "12%
        // more" of a percentage is a different quantity from "12 points more".
        ? `${fmtInt(Math.round(size))}pp`
        : fmtInt(size);
  return `<span class="delta" data-dir="${dir}"${toneAttr(tone)}>${esc(text)}</span>`;
}
