import { cell, esc, fmtAgo, fmtDate, fmtDuration, fmtInt, fmtPct, headers, table, timeTag } from "./html.js";
import { renderRca } from "./rca.js";
import { donutChart, lineChart } from "./chart.js";
import { STYLES } from "./styles.js";
import { DEFAULT_RANGE, PAGE_SIZE, RANGES } from "./filters.js";
import type { Filters, Range } from "./filters.js";
import { NAV_COUNT_CAP } from "./queries.js";
import type {
  FeedbackRow, IncidentDetail, IncidentPage, IncidentRow, Overview, RemediationRow, Tokens,
} from "./queries.js";
import { SESSION_TTL_MS } from "./auth.js";
import { rowId } from "./topology.js";
import type { Assets } from "./assets.js";
import type { BackendNode, Capability, Node as TopoNode, Topology } from "./topology.js";
import type { ContextView } from "./context.js";

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

const ICON = {
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
};

// Two groups, because the four destinations are two different KINDS of thing and the rail was
// stating them as one flat list. Monitor is what the cluster did; Agent is what this process
// is — read back from its own configuration and its own prompt, with no database behind either.
// A reader looking for "why did it say that" and a reader looking for "what is on fire" are not
// the same reader, and the caption is what tells them which half to look in.
const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: ICON.overview },
      { href: "/incidents", label: "Incidents", icon: ICON.incidents, badge: "openIncidents" as const },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/topology", label: "Topology", icon: ICON.topology },
      { href: "/context", label: "Context", icon: ICON.context },
    ],
  },
];

// The two theme-color values are the only colours written outside styles.ts, and they are
// literals because a <meta> attribute cannot read a custom property. They are --bg for each
// scheme; change one and change the other, or the phone's browser chrome stops matching the
// page it sits above.
//
// `chrome: "bare"` is for the pages you can reach without a session — the sign-in form and
// the "not configured" notice. Navigation there is a row of links that all bounce straight
// back to where you already are, and a Sign out button for a session you do not have. So the
// rail is not rendered at all rather than rendered empty: a bare column of chrome down the
// side of a one-field form is a frame around nothing.
/**
 * `tools` is the top bar's right-hand slot: markup a page supplies for the controls that
 * govern the WHOLE page rather than a section of it. Today that is the overview's time range
 * and nothing else, which is exactly why it is a slot and not a parameter — a `range` argument
 * on layout() would put a control every page has to opt out of on every page.
 *
 * It is markup, not text, so it is NOT escaped here. Every caller builds it from literals and
 * from values that went through esc() on the way in; the same contract Stat.icon already has.
 */
// How often a page that is watching something re-fetches itself. 60s, matching the query
// cache's TTL exactly: refreshing faster re-renders the same cached numbers, and refreshing
// slower leaves fresh numbers sitting unread.
export const REFRESH_SECONDS = 60;

/**
 * Everything the chrome needs, as one object rather than six positional arguments.
 *
 * It was six, and the seventh — the rail's badge count — is what made the shape untenable:
 * `layout(t, b, "/incidents", "full", "", true, 17)` is a call nobody can read and every
 * caller had to pass the defaults it did not care about to reach the one it did.
 */
export interface Chrome {
  /** The href of the current destination, so the rail can mark it. "" marks nothing. */
  current?: string;
  /** "bare" renders no top bar and no rail — sign-in and the "not configured" notice. */
  chrome?: "full" | "bare";
  /** Markup for the top bar's right-hand slot: controls that govern the whole page. */
  tools?: string;
  /** Whether the page re-requests itself. See REFRESH_SECONDS. */
  refresh?: boolean;
  /**
   * Incidents firing right now, for the rail's badge. `undefined` means this page does not
   * know — a page with no database behind it renders no badge rather than a confident zero.
   */
  openIncidents?: number;
  /**
   * href of an external stylesheet, linked in <head> BEFORE the inline <style>. Only
   * /topology uses it (React Flow's own CSS). The order is the point: both files carry
   * plain class selectors, so the dashboard's overrides win only by coming second.
   */
  stylesheet?: string;
}

export function layout(title: string, body: string, o: Chrome = {}): string {
  const { current = "", chrome = "full", tools = "", refresh = false, openIncidents, stylesheet } = o;
  const count =
    openIncidents === undefined || openIncidents <= 0
      ? ""
      // A zero badge is noise: "nothing is on fire" is what an ABSENT badge already says, and a
      // rail that always carries a number trains the eye to stop reading it.
      : `<span class="rail-count">${esc(openIncidents > NAV_COUNT_CAP ? `${NAV_COUNT_CAP}+` : openIncidents)}` +
        // The number alone would be announced as "Incidents 17", which is ambiguous about what
        // is being counted. The qualifier is in the accessible name only.
        `<span class="sr-only"> open</span></span>`;
  const nav = NAV_GROUPS.map((g, gi) => {
    const id = `rail-g${gi}`;
    const items = g.items
      .map(
        (n) => `<li><a href="${n.href}"${n.href === current ? ` aria-current="page"` : ""}>` +
          `${n.icon}<span class="lbl">${n.label}</span>` +
          ("badge" in n && n.badge === "openIncidents" ? count : "") +
          `</a></li>`
      )
      .join("");
    // The caption is associated with its own list rather than floating above it, so the
    // grouping exists for a screen reader too and not only for the eye.
    return `<p class="rail-group" id="${id}">${g.label}</p>` +
      `<ul aria-labelledby="${id}">${items}</ul>`;
  }).join("");
  // The brand is a link to the overview rather than a label. It is the top-left mark on every
  // page, which is the one position every reader already expects to be a way home.
  const topbar =
    chrome === "full"
      ? `<header class="topbar">` +
        // The drawer's control. A <label> for the checkbox above, because a checkbox is the
        // only disclosure a page with no script-src can toggle — the same mechanism the
        // topology page's zoom control already uses, and for the same reason.
        // It carries no accessible name of its own: the checkbox has it, and naming both would
        // announce the control twice.
        `<label class="nav-toggle" for="nav-open" aria-hidden="true">` +
        `<span class="nav-toggle-open">${ICON.menu}</span>` +
        `<span class="nav-toggle-close">${ICON.close}</span></label>` +
        `<a class="brand" href="/">` +
        `<span class="brand-mark" aria-hidden="true">${ICON.bolt}</span>` +
        `<span translate="no">devops-ai-agent</span></a>` +
        `<div class="topbar-tools">${tools}` +
        // Only the live indicator stays in the bar: it describes THIS page (whether it is
        // re-requesting itself), which is what the bar is for. The session note describes the
        // whole visit and now lives at the foot of the rail.
        (refresh ? `<span class="topbar-note live">updates every ${REFRESH_SECONDS}s</span>` : "") +
        `</div></header>`
      : "";
  // The note moved here from the top bar. It belongs at the foot of the rail — the position
  // every SaaS console puts session state in — and the bar it left is now free for controls
  // that govern the page. It was also the first thing the bar dropped when it ran out of room,
  // which is a poor place for the only statement that this dashboard cannot change anything.
  const rail =
    chrome === "full"
      ? `<header class="rail">` +
        `<nav aria-label="Primary">${nav}</nav>` +
        `<div class="rail-foot">` +
        `<p class="rail-note">Read-only · session ${SESSION_HOURS}h</p>` +
        `<form class="signout" method="post" action="/logout">` +
        `<button type="submit">${ICON.signout}<span class="lbl">Sign out</span></button></form>` +
        `</div></header>`
      : "";
  const note =
    chrome === "full"
      ? `Read-only. This session ends after ${SESSION_HOURS} hours.`
      : `Read-only incident dashboard.`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f6f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
${refresh ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">\n` : ""}<title>${esc(title)} — DevOps AI Agent</title>
${stylesheet ? `<link rel="stylesheet" href="${esc(stylesheet)}">\n` : ""}<style>${STYLES}</style>
</head><body${chrome === "bare" ? ` class="bare"` : ""}>
<a class="skip" href="#main">Skip to content</a>
${chrome === "full" ? `<input type="checkbox" id="nav-open" class="nav-state" aria-label="Navigation menu">` : ""}
${topbar}${chrome === "full" ? `<label class="nav-scrim" for="nav-open" aria-hidden="true"></label>` : ""}${rail}
<div class="pane">
<main id="main">${body}</main>
<footer class="bottom">${note} The password is one lock; not routing this port from the Ingress is the other. Keep both.</footer>
</div>
</body></html>`;
}

/**
 * The overview's time range, as three links.
 *
 * Links rather than a form: every range is a URL, so it is bookmarkable, it survives the back
 * button, and it needs neither a submit nor a line of script under a CSP that forbids one.
 * `aria-current="true"` is the same mechanism the rail uses to say where you are — the value is
 * "true" rather than "page" because these are not pages.
 */
const RANGE_LABEL: Record<Range, string> = { "24h": "24h", "7d": "7d", "30d": "30d" };
// The same three ranges written out, for the places that put them in a sentence. The control
// says "7d" because it is a control and the row has to stay narrow; a heading says "7 days"
// because it is prose.
const WINDOW_LABEL: Record<Range, string> = {
  "24h": "24 hours", "7d": "7 days", "30d": "30 days",
};
function rangeControl(current: Range): string {
  const items = RANGES.map((r) => {
    // The default range is the bare path: a URL that restates the default is a query string a
    // reader has to read past to see whether anything is actually filtered.
    const href = r === DEFAULT_RANGE ? "/" : `/?range=${esc(r)}`;
    const mark = r === current ? ` aria-current="true"` : "";
    return `<a href="${href}"${mark}>${esc(RANGE_LABEL[r])}</a>`;
  }).join("");
  return `<nav class="seg" aria-label="Time range">${items}</nav>`;
}

const SESSION_HOURS = Math.round(SESSION_TTL_MS / 3_600_000);

/**
 * The sign-in form. `error` is shown verbatim to the person typing, so it says what to do
 * next and nothing about which half was wrong — "no such user" and "wrong password" are the
 * same sentence here, and with one shared password there is not even a user to name.
 */
export function loginPage(opts: { error?: string; next?: string } = {}): string {
  const body =
    `<section class="signin">` +
    `<h1>Sign in</h1>` +
    `<p class="signin-lede">Incident history and the agent's live dependency map. ` +
    `Enter the shared dashboard password to continue.</p>` +
    (opts.error ? `<p class="formerror" role="alert">${esc(opts.error)}</p>` : "") +
    `<form method="post" action="/login" class="signin-form">` +
    (opts.next && opts.next !== "/" ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : "") +
    `<label for="password">Dashboard password</label>` +
    // autocomplete="current-password" is what makes a password manager offer to fill this;
    // without it browsers guess, and a form with one field is exactly where they guess wrong.
    `<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>` +
    `<button type="submit">Sign in</button>` +
    `</form>` +
    `</section>`;
  return layout("Sign in", body, { chrome: "bare" });
}

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
  resolved: "ok", succeeded: "ok", confirmed: "ok", approved: "ok",
  failed: "critical", rejected: "critical",
  executing: "warning", proposed: "info",
  // The post-remediation verdicts (agent/remediation/verify.ts). `worse` is critical because
  // it is the one outcome on this dashboard that says the agent made things WORSE, and
  // `inconclusive` is deliberately absent from this map: it means "we looked and the evidence
  // says nothing either way", and a colour would turn that into a claim.
  recovered: "ok", unchanged: "warning", worse: "critical",
};
const tone = (s: unknown): string => TONE[String(s ?? "").toLowerCase()] ?? "";

const toneAttr = (s: unknown): string => {
  const t = tone(s);
  return t ? ` data-tone="${esc(t)}"` : "";
};

const badge = (label: string, t: string = tone(label)): string =>
  `<span class="badge"${t ? ` data-tone="${esc(t)}"` : ""}>${esc(label)}</span>`;

const dash = `<span class="meta">—</span>`;

// Firing and resolved, and which of the two the column emphasises.
//
// It used to be the wrong one: `badge("firing", "")` is the neutral badge — --text-dim on
// --surface-2 — while resolved wore green, so in a column whose entire job is "which of these
// is still live" the live rows were the quietest thing in it. `data-live` spends weight rather
// than colour to fix it (full --text, a visible edge), because colour on this page belongs to
// severity and the row already states its severity one cell to the left.
const stateBadge = (resolvedAt: Date | null): string =>
  resolvedAt
    ? badge("resolved", "ok")
    : `<span class="badge" data-live>firing</span>`;
const severityBadge = (s: string | null): string => (s ? badge(s) : dash);

// Alert names are one long CamelCase identifier with no space in them, so in a narrow column the
// browser has nowhere to break and falls back to breaking anywhere — PersistentVolumeFillin/gUp.
// <wbr> offers the humps as break opportunities, and a browser takes an offered break before it
// invents one, so the name comes apart at PersistentVolume/FillingUp instead.
//
// Escape first, insert markup second — the same invariant rca.ts is built on. The regex is safe
// against the escaped string on purpose: every entity esc() can emit (&amp; &lt; &gt; &quot;
// &#39;) is lowercase or digits after the ampersand, so a lower-to-upper boundary can never fall
// inside one and split it.
const breakable = (name: string): string => esc(name).replace(/([a-z0-9])(?=[A-Z])/g, "$1<wbr>");

// Every empty state names the fact and then the next move. An empty screen that only says
// "no data" leaves the reader unsure whether the system is broken or simply quiet.
//
// `icon` is the SECTION's own glyph, passed by the caller — an empty Remediation panel shows
// the wrench, so it stays recognisably the same section whether or not it has rows. Markup,
// not text, so it is not escaped; the same contract Stat.icon has. It is optional because two
// callers (the "nothing on page 7" notice, the error page) are not a section's contents.
//
// A <div>, not a <p>: the glyph rides in a chip, and a chip is a block.
const empty = (headline: string, next: string, icon = ""): string =>
  `<div class="empty">` +
  (icon ? `<span class="kpi-icon" aria-hidden="true">${icon}</span>` : "") +
  `<strong>${esc(headline)}</strong><span>${esc(next)}</span></div>`;

// A section heading with a glyph. The icon and the label are one flex item so h2's own gap —
// which is sized for the distance out to the hairline — never lands between a picture and the
// word it labels; a trailing link keeps working, it sorts past the hairline as before.
const section = (icon: string, title: string, trailing = ""): string =>
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
const statList = (items: Stat[], variant: "" | "facts" | "pair" = ""): string =>
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
function delta(
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

// Every cell carries a class, including the two that hold nothing but a badge. Below 46rem the
// stylesheet stops laying this out as a table and lays each row out as a card instead, and it
// addresses the cells by name to do it — a positional selector would silently re-target the day
// someone inserts a column, which is the kind of break no test written against the columns as a
// SET would catch.
function incidentTable(rows: IncidentRow[], whenEmpty: string, now: Date = new Date()): string {
  if (rows.length === 0) return whenEmpty;
  const body = rows
    .map(
      (r) => `<tr role="row"${toneAttr(r.severity)}>
      <td role="cell" class="when">${timeTag(r.created_at, now)}</td>
      <td role="cell" class="primary"><a href="/incidents/${esc(r.id)}">${breakable(r.alertname)}</a>${
        r.root_cause ? `<div class="sub">${esc(r.root_cause)}</div>` : ""
      }</td>
      <td role="cell" class="ns mono" translate="no">${esc(r.namespace ?? "—")}</td>
      <td role="cell" class="sev">${severityBadge(r.severity)}</td>
      <td role="cell" class="state">${stateBadge(r.resolved_at)}</td>
    </tr>`
    )
    .join("");
  return table(headers("When", "Alert", "Namespace", "Severity", "State"), body, "cards");
}

// What the investigations cost. The stats are totals over the window; the table is per
// backend AND model, because under the router "which model did that" is the question — a
// heavy backend answering what a light one could have is the finding this section exists for.
function tokenUsage(t: Tokens): string {
  if (t.calls === 0) {
    return empty(
      "No LLM calls recorded in this window.",
      "Accounting starts with the next investigation the agent runs.",
      ICON.chip
    );
  }
  // Six columns is the widest table on the site, and the two that fall off a phone first are
  // Output and Cache read — the halves of the ratio this section exists to show. Stacked, a
  // backend's whole accounting is one captioned block.
  const rows = t.byBackend
    .map(
      (b) => `<tr role="row">` +
        cell("Backend", esc(b.backend), "primary") +
        cell("Model", `<span translate="no">${esc(b.model)}</span>`, "mono") +
        cell("Calls", fmtInt(b.calls), "num") +
        cell("Input", fmtInt(b.input), "num") +
        cell("Output", fmtInt(b.output), "num") +
        cell("Cache read", fmtInt(b.cacheRead), "num") +
        `</tr>`
    )
    .join("");
  return (
    statList(
      [
        // The call count rides in the sub-line rather than taking a fifth tile: it is the
        // denominator of the figure above it ("how much, over how many calls"), and as its own
        // tile it was the odd one out on a four-wide shelf — a count of events among three
        // counts of tokens.
        { icon: ICON.layers, label: "Total tokens", value: fmtInt(t.input + t.output), sub: `input + output over ${fmtInt(t.calls)} calls` },
        // The split, not just the two counts. An investigation that is 95% input is a caching
        // problem; one that is 40% output is a verbosity problem. The shares say which.
        { icon: ICON.inTokens, label: "Input", value: fmtInt(t.input), sub: `${fmtPct(t.input, t.input + t.output)} of tokens` },
        { icon: ICON.outTokens, label: "Output", value: fmtInt(t.output), sub: `${fmtPct(t.output, t.input + t.output)} of tokens` },
        // Cache reads are the tokens that were NOT re-sent, so the pair reads as a saving
        // and its price. Writes sit in the sub-line: you pay for them once, deliberately.
        { icon: ICON.bolt, label: "Cache reads", value: fmtInt(t.cacheRead), sub: `${fmtInt(t.cacheCreation)} written` },
      ]
    ) +
    table(
      headers("Backend", "Model", "Calls", "Input", "Output", "Cache read"),
      rows,
      "pairs"
    )
  );
}

// `now` is the instant the response is being built, taken once by the caller and threaded
// through every relative timestamp on the page. Defaulted so a test (and any caller that does
// not care) needs no argument — but passing ONE value is what keeps thirty rows internally
// consistent: computed per row, a list rendered across a minute boundary would say "1h ago"
// and "59m ago" about two incidents a second apart.
export function overviewPage(
  o: Overview,
  recent: IncidentRow[],
  now: Date = new Date(),
  openIncidents?: number
): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  // The figure this panel used to report was `status = succeeded` over all remediations — which
  // is how many MCP calls did not error, NOT how many fixes worked. A restart that returns 200
  // and changes nothing scored as a success. The verdicts are the answer to the question the
  // tile was already appearing to ask, so the tile now reports them; the call counts survive in
  // the sub-line, where they are what they always were — a fact about the API, not the cluster.
  const recovered = o.verdicts.recovered ?? 0;
  const unchanged = o.verdicts.unchanged ?? 0;
  const worse = o.verdicts.worse ?? 0;
  const inconclusive = o.verdicts.inconclusive ?? 0;
  // The denominator is checks that REACHED a verdict. A pending check is not a failure and
  // not a success; counting it as either moves the percentage for a reason nobody did.
  const verdicts = recovered + unchanged + worse + inconclusive;

  const recurring =
    o.recurring.length === 0
      ? empty("Nothing has recurred.", `Every alert in the last ${WINDOW_LABEL[o.range]} fired exactly once.`, ICON.repeat)
      : table(
          headers("Alert", "Namespace", "Times", "Last seen"),
          o.recurring
            .map(
              (r) => `<tr role="row">` +
                // The alert name is a link into the list filtered to it. It is the one obvious
                // question this table raises — "show me those twelve" — and before this the
                // answer was to read the name, go to Incidents, and type it back in.
                cell(
                  "Alert",
                  // Both layers, the same pair detailPage's Slack link takes: encodeURIComponent
                  // makes the value safe INSIDE the URL (a stray & cannot open a second query
                  // parameter), esc makes the whole string safe inside the attribute.
                  `<a href="${esc(`/incidents?alertname=${encodeURIComponent(r.alertname)}`)}">${breakable(r.alertname)}</a>`,
                  "primary"
                ) +
                cell("Namespace", `<span translate="no">${esc(r.namespace ?? "—")}</span>`, "mono") +
                cell("Times", fmtInt(r.n), "num") +
                cell("Last seen", timeTag(r.last_seen, now), "when") +
                `</tr>`
            )
            .join(""),
          "pairs"
        );

  // The severity mix, and what came back from the humans who read the RCAs. Two figures of the
  // same kind — what the window turned out to BE — set beside the ring that shows the first of
  // them. The on-call numbers moved here from the state shelf when MTTR took their place on it:
  // a reply is not the state of an incident, it is an outcome, and this is the outcomes panel.
  const severitySlices = o.severity.map((r) => ({
    label: r.severity,
    value: r.n,
    // The last dead end on this panel. A severity IS a filter the list already has a field
    // for, so following one lands on a page that explains itself — the Severity select comes
    // up set to the value that was clicked.
    href: `/incidents?severity=${encodeURIComponent(r.severity)}`,
    // Through the same allowlist every other tone on the page goes through. A typo in an alert
    // rule, or a severity label this dashboard has never seen, draws in the neutral stroke
    // rather than being passed into an attribute selector that would not match it anyway.
    tone: tone(r.severity),
  }));

  // State first, then volume, then cost. The panel across the top is where the page answers the
  // only question that can need an answer right now — how many are still open — and it answers
  // it in the first line of the page rather than below a chart. It carries the page's single
  // toned figure: open incidents wear the critical spine when there are any, and nothing else on
  // the shelf is coloured, so the tone means "look here" and not "this tile is a stat".
  //
  // The hero below it is one composed object and nothing else: the 30-day count set against the
  // weekly series it summarises, because the count and the shape of it are one fact. The outcome
  // figures used to sit in a section of their own between the two; they are the state of those
  // incidents, so they belong in the state panel, and repeating them in both places would make
  // the page say the same thing twice.
  const open = o.totalIncidents - o.resolvedIncidents;
  const resolvedPct = o.totalIncidents ? (o.resolvedIncidents / o.totalIncidents) * 100 : null;
  const prevResolved = o.prev.totalIncidents
    ? ((o.prev.totalIncidents - o.prev.openIncidents) / o.prev.totalIncidents) * 100
    : null;
  return layout(
    "Overview",
    `<h1 class="eyebrow">${ICON.overview}Incidents · last ${esc(WINDOW_LABEL[o.range])}</h1>
     ${statList(
       [
         {
           icon: ICON.incidents, label: "Open", value: fmtInt(open),
           sub: `of ${fmtInt(o.totalIncidents)} investigated`,
           tone: open > 0 ? "critical" : undefined,
           delta: delta(open, o.prev.openIncidents, { better: "lower" }),
           // The tile and the list are the same fact at two zoom levels, so the tile is the way
           // in. This is the page's most-wanted next step: the reader who sees a count of open
           // incidents wants to know WHICH.
           href: "/incidents?resolved=false",
           hrefLabel: `Open — see the ${fmtInt(open)} incidents still firing`,
         },
         {
           icon: ICON.check, label: "Resolved", value: fmtPct(o.resolvedIncidents, o.totalIncidents),
           sub: `${o.resolvedIncidents} of ${o.totalIncidents}`,
           delta: delta(resolvedPct, prevResolved, { better: "higher", unit: "pp" }),
           href: "/incidents?resolved=true",
           hrefLabel: `Resolved — see the ${fmtInt(o.resolvedIncidents)} incidents that closed`,
         },
         // The figure this dashboard existed for a year without: how long an incident stays
         // open. Everything else on the shelf counts incidents; this one is the only tile that
         // says anything about how well they are being handled.
         {
           icon: ICON.repeat, label: "Mean time to resolve", value: fmtDuration(o.mttrMs),
           sub: `over ${fmtInt(o.resolvedIncidents)} resolved`,
           delta: delta(o.mttrMs, o.prev.mttrMs, { better: "lower", unit: "duration" }),
         },
         {
           icon: ICON.wrench, label: "Remediation verified", value: fmtPct(recovered, verdicts),
           sub: `${fmtInt(o.remediationSucceeded)} of ${fmtInt(remediationTotal)} calls succeeded`,
           // A single remediation that left the workload worse outranks whatever the percentage
           // says. The tone is what makes the tile impossible to skim past; the count is in the
           // outcomes panel below.
           tone: worse > 0 ? "critical" : undefined,
         },
       ]
     )}
     <section class="hero">
       <div class="hero-body">
         <p class="hero-figure">
           <span class="hero-value">${esc(fmtInt(o.totalIncidents))}</span>
           <span class="hero-unit">investigated</span>
         </p>
         <div class="hero-chart">${lineChart(o.weekly, { label: `incidents ${o.seriesUnit}` })}</div>
       </div>
     </section>
     ${section(ICON.layers, "Outcomes")}
     <div class="split">
       <section class="card">
         <p class="eyebrow">By severity</p>
         ${donutChart(severitySlices, { label: "incidents by severity" })}
       </section>
       <section class="card">
         <p class="eyebrow">On-call feedback</p>
         ${statList(
           [
             {
               icon: ICON.speech, label: "Replies", value: fmtInt(feedbackTotal),
               sub: `${fmtInt(o.feedback.resolved ?? 0)} confirmed fixed`,
               delta: delta(feedbackTotal, o.prev.feedbackTotal, { better: "higher" }),
             },
             // Not "failed" — that was the call erroring, and it is in the tile above. This is
             // the workload ending up WORSE after a change the agent proposed, which is the most
             // consequential thing this system can do and had no representation on the page at
             // all. It keeps its place even at zero: a reader has to be able to see that the
             // answer is none, rather than infer it from an absence.
             {
               icon: ICON.wrench, label: "Made it worse", value: fmtInt(worse),
               sub: `${fmtInt(unchanged)} not fixed · ${fmtInt(inconclusive + o.verdictsPending)} unverified`,
               tone: worse > 0 ? "critical" : undefined,
               // Only when there are any. A tile reading zero has nothing to show, and a link
               // to an empty list is the dead end this was supposed to stop being.
               ...(worse > 0
                 ? {
                     href: "/incidents?verdict=worse",
                     hrefLabel: `Made it worse — see the ${fmtInt(worse)} incidents a remediation left worse`,
                   }
                 : {}),
             },
           ],
           "pair"
         )}
       </section>
     </div>
     ${section(ICON.chip, "Token usage")}
     ${tokenUsage(o.tokens)}
     ${section(ICON.repeat, "Most recurring")}
     ${recurring}
     ${section(ICON.incidents, "Recent incidents", `<a class="standalone" href="/incidents">All incidents →</a>`)}
     ${incidentTable(recent, empty("No incidents yet.", "The agent posts here once it has investigated its first alert.", ICON.incidents), now)}`,
    {
      current: "/",
      tools: rangeControl(o.range),
      // The overview is the page someone leaves open on a second monitor, so it refreshes
      // itself. A <meta> refresh rather than a script: the CSP sends no script-src on this
      // route, and a full re-request is also what re-runs the queries — a fetch would need an
      // endpoint that does not exist. It discards nothing, because there is nothing on this
      // page to discard: no form, no scroll position worth keeping, no selection.
      refresh: true,
      openIncidents,
    }
  );
}

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
function pager(p: IncidentPage, f: Filters, qs: (page: number) => string): string {
  if (p.rows.length === 0) return "";
  const first = (f.page - 1) * PAGE_SIZE + 1;
  const shown = first + p.rows.length - 1;
  // The count is bounded (COUNT_CAP), so past the ceiling it is a floor and says so. "5,000+"
  // is true; a hard 5,000 under a table that keeps producing next pages is not.
  const total = `${fmtInt(p.total)}${p.capped ? "+" : ""}`;
  const summary =
    `<p class="pager-count">Showing <b>${esc(fmtInt(first))}–${esc(fmtInt(shown))}</b> of ` +
    `<b>${esc(total)}</b> incident${p.total === 1 ? "" : "s"}</p>`;

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

export function listPage(
  p: IncidentPage,
  f: Filters,
  now: Date = new Date(),
  openIncidents?: number
): string {
  const qs = (page: number): string => {
    const q = new URLSearchParams();
    if (f.from) q.set("from", f.from.toISOString().slice(0, 10));
    if (f.to) q.set("to", f.to.toISOString().slice(0, 10));
    if (f.alertname) q.set("alertname", f.alertname);
    if (f.namespace) q.set("namespace", f.namespace);
    if (f.severity) q.set("severity", f.severity);
    if (f.resolved !== null) q.set("resolved", String(f.resolved));
    if (f.verdict) q.set("verdict", f.verdict);
    // page=1 is omitted: a link that restates the default is a query string the reader has to
    // read past to see which filters are actually on.
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/incidents?${s}` : "/incidents";
  };

  // Dropping a filter always returns to page 1: the result set is about to be larger, and
  // page 7 of the old one is not a place in the new one.
  const qsWithout = (key: string): string => {
    const q = new URLSearchParams(qs(1).split("?")[1] ?? "");
    q.delete(key);
    const out = q.toString();
    return out ? `/incidents?${out}` : "/incidents";
  };

  const sel = (v: string, cur: string | null, label: string): string =>
    `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;

  const filtered = !!(f.from || f.to || f.alertname || f.namespace || f.severity || f.resolved !== null || f.verdict);

  // The one filter with no field in the form, so the one that would otherwise be invisible:
  // a reader who followed "Made it worse" would land on a shortened list with nothing saying
  // why. A chip states it and removes it — the × drops the verdict and keeps everything else,
  // which is what makes it a chip rather than a second Clear.
  const chips = f.verdict
    ? `<ul class="chips"><li><span class="chip-key">verdict</span>${esc(f.verdict)}` +
      `<a href="${esc(qsWithout("verdict"))}" aria-label="Remove the ${esc(f.verdict)} verdict filter">×</a>` +
      `</li></ul>`
    : "";

  // Two different absences. No rows on page 1 means the filters matched nothing; no rows on
  // page 7 means the range ended earlier than the URL claims — usually a bookmark outliving
  // the rows it pointed at — and the way out of that is a link, not a suggestion to filter.
  const nothing =
    f.page > 1
      ? `<p class="empty"><strong>Nothing on page ${esc(f.page)}.</strong>` +
        `This filter matches ${esc(fmtInt(p.total))} incident${p.total === 1 ? "" : "s"}. ` +
        `<a href="${esc(qs(1))}">Go to the first page</a>.</p>`
      : empty("No incidents match these filters.", "Widen the date range, or clear a filter to see more.", ICON.search);

  // The two free-text fields take identifiers, not words: autocomplete off (the browser has
  // no saved value that belongs in "Namespace"), autocapitalize off (a phone would send
  // `Prod`, which matches nothing), spellcheck off (every alert name is a red squiggle).
  return layout(
    "Incidents",
    `<h1>Incidents</h1>
     <form class="filters" method="get" action="/incidents">
       <label>From<input type="date" name="from" value="${esc(f.from ? f.from.toISOString().slice(0, 10) : "")}"></label>
       <label>To<input type="date" name="to" value="${esc(f.to ? f.to.toISOString().slice(0, 10) : "")}"></label>
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Severity<select name="severity">
         ${sel("", f.severity ?? "", "any")}${sel("critical", f.severity ?? "", "critical")}${sel("warning", f.severity ?? "", "warning")}${sel("info", f.severity ?? "", "info")}
       </select></label>
       <label>State<select name="resolved">
         ${sel("", f.resolved === null ? "" : String(f.resolved), "any")}
         ${sel("true", f.resolved === null ? "" : String(f.resolved), "resolved")}
         ${sel("false", f.resolved === null ? "" : String(f.resolved), "firing")}
       </select></label>
       <div class="actions">
         <button type="submit">Apply filters</button>
         ${filtered ? `<a href="/incidents">Clear</a>` : ""}
       </div>
     </form>
     ${chips}
     ${incidentTable(p.rows, nothing, now)}
     ${pager(p, f, qs)}`,
    {
      current: "/incidents",
      // Only while nothing is filtered and nothing is paged. A refresh reloads the URL, so a
      // filtered view would survive it — but the reader is then WORKING, and a page that
      // reloads under someone mid-way through reading row seven is worse than a stale one.
      // Unfiltered page 1 is the watch view; everything else is a query someone typed.
      refresh: !filtered && f.page === 1,
      openIncidents,
    }
  );
}

/**
 * What the cluster did about a remediation, or why that is not known yet.
 *
 * Four states, and they are not four shades of the same thing:
 *   a verdict          — the check ran and concluded. Badge plus the evidence it read.
 *   still waiting      — a check exists and has not finished. It says when to look again,
 *                        because "pending" with no horizon is indistinguishable from stuck.
 *   never scheduled    — the remediation was proposed and not approved, so nothing was ever
 *                        going to be verified. A dash, not a "pending" that will never resolve.
 *
 * `inconclusive` gets no tone (see the TONE map): it means the evidence said nothing either
 * way, and colouring it would turn an absence of evidence into a finding.
 */
function verdictCell(r: RemediationRow, now: Date): string {
  if (r.verdict) {
    return (
      badge(r.verdict) +
      (r.verdict_detail ? `<div class="sub">${esc(r.verdict_detail)}</div>` : "")
    );
  }
  if (r.check_status) {
    // fmtAgo is no use here: due_at is in the FUTURE, and fmtAgo clamps a future instant to
    // "just now" so a check due in four minutes would read as one that already ran. The wait
    // is a duration, so it is formatted as one — and a due time already past says so rather
    // than counting backwards, because that is a poller that has stopped.
    const wait = r.due_at ? r.due_at.getTime() - now.getTime() : null;
    const sub =
      wait === null ? "" : wait > 0 ? `next check in ${fmtDuration(wait)}` : "check overdue";
    return (
      `<span class="badge">checking</span>` +
      (sub ? `<div class="sub">${esc(sub)}</div>` : "")
    );
  }
  return dash;
}

export function detailPage(
  d: {
    incident: IncidentDetail;
    remediations: RemediationRow[];
    feedback: FeedbackRow[];
  },
  now: Date = new Date(),
  openIncidents?: number
): string {
  const i = d.incident;
  // app_redirect needs no workspace domain, so the deep link costs no configuration.
  // encodeURIComponent() first (safe *inside* the URL — a stray & or # in a component
  // can't inject a second query param or a fragment), then esc() on the whole string
  // (safe *inside* the href attribute). Both layers are required; neither is redundant.
  const slack =
    i.channel && i.thread_ts
      ? `<a class="standalone" href="${esc(`https://slack.com/app_redirect?channel=${encodeURIComponent(i.channel)}&message_ts=${encodeURIComponent(i.thread_ts)}`)}">Open the Slack thread →</a>`
      : "";

  // Both of these are records of five fields, not lists to scan, so below 46rem they stack into
  // captioned pairs rather than scrolling sideways — five columns on a phone put Result and
  // Executed past the right edge, which on a remediation table means the outcome of the change
  // is the part you cannot see. Five is also why the threshold is the incident list's and not
  // the lower one these tables used to take: they ask for ~740px of columns, so between 40 and
  // 46rem they were still a table and still scrolling. headers() keeps the <th> text and the
  // cell captions the same
  // string: they are the same label, and a table whose captions have drifted from its headers
  // is one nobody notices is wrong.
  const remediations =
    d.remediations.length === 0
      ? empty("No remediation proposed.", "The agent investigated this alert but suggested no change.", ICON.wrench)
      : table(
          headers("Action", "Status", "Verdict", "Approved by", "Executed"),
          d.remediations
            .map(
              // The row is toned by its VERDICT, and the fallback is narrower than it looks.
              // They disagree exactly where it matters: a restart that returned 200 and fixed
              // nothing is a green status over an amber verdict, and the spine has to carry the
              // one that describes the cluster.
              //
              // A check that exists but has not concluded tones the row NOT AT ALL — it does not
              // fall back to the status. Falling back put a green spine on a row whose outcome
              // is still being measured, which is the exact masquerade this feature exists to
              // stop: `succeeded` reading as "it worked" before anything has looked.
              // The status is only the whole story where no check will ever run — an unapproved
              // proposal, or an action that errored before one was scheduled.
              (r) => `<tr role="row"${toneAttr(r.verdict ?? (r.check_status ? "" : r.status))}>` +
                cell("Action", `<span translate="no">${esc(r.action)}</span><div class="sub" translate="no">${esc(JSON.stringify(r.params))}</div>`, "mono") +
                // `result` is what the call said, so it belongs under the call's own badge
                // rather than in a column of its own — which is also what makes room for the
                // verdict without taking this table to six columns.
                cell(
                  "Status",
                  badge(r.status) + (r.result ? `<div class="sub">${esc(r.result)}</div>` : "")
                ) +
                cell("Verdict", verdictCell(r, now)) +
                cell("Approved by", esc(r.approved_by ?? "—")) +
                cell("Executed", timeTag(r.executed_at, now), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  const feedback =
    d.feedback.length === 0
      ? empty("No on-call feedback yet.", "Reply in the Slack thread to record what actually fixed it.", ICON.speech)
      : table(
          headers("From", "Confirmed root cause", "Action taken", "Outcome", "When"),
          d.feedback
            .map(
              (r) => `<tr role="row"${toneAttr(r.outcome)}>` +
                cell("From", esc(r.slack_user ?? "—")) +
                cell("Confirmed root cause", esc(r.confirmed_root_cause ?? "—")) +
                cell("Action taken", esc(r.action_taken ?? "—")) +
                cell("Outcome", r.outcome ? badge(r.outcome) : dash) +
                cell("When", timeTag(r.created_at, now), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  return layout(
    i.alertname,
    // The id is a real identifier, so it earns the caption slot above the title. The sections
    // below it are not numbered: they are facts about one incident, not a sequence.
    // .doc is the same wrapper the skill page uses, and for the same reason: laid straight into
    // <main> these blocks are loose full-width bands sized only by their content, not one
    // document. See the .doc rule in styles.ts.
    `<div class="doc">
     <p class="eyebrow">Incident #${esc(i.id)}</p>
     <!-- breakable(), not esc(): the same CamelCase break points the list offers. The h1's
          overflow-wrap: anywhere is only the floor, and a floor breaks mid-word —
          "KubernetesContainerOo / mKiller" at 390px, while the same string in the table below
          broke at the hump. One name, two break rules, on one page. -->
     <h1>${breakable(i.alertname)}</h1>
     <div class="title-meta">
       ${severityBadge(i.severity)}
       ${stateBadge(i.resolved_at)}
       ${slack}
     </div>
     ${statList(
       [
         { label: "Namespace", value: i.namespace ?? "—", sub: i.confidence ? `${i.confidence} confidence` : "unrated" },
         // The figure this page made a reader compute. Both timestamps were on the shelf and
         // the interval between them — the only number that says how bad this incident WAS —
         // was not, so it had to be worked out by subtracting one tile from another.
         // Still firing is not a duration of zero: the incident has been open for this long and
         // is not finished, which the sub-line says rather than the value pretending otherwise.
         {
           label: i.resolved_at ? "Time to resolve" : "Open for",
           value: fmtDuration(
             (i.resolved_at ? i.resolved_at.getTime() : now.getTime()) - i.created_at.getTime()
           ),
           sub: i.resolved_at ? "fired to resolved" : "still firing",
           tone: i.resolved_at ? undefined : "warning",
         },
         { label: "Fired", value: fmtAgo(i.created_at, now), sub: fmtDate(i.created_at) },
         { label: "Resolved", value: i.resolved_at ? fmtAgo(i.resolved_at, now) : "—", sub: i.resolved_at ? fmtDate(i.resolved_at) : "not yet" },
       ],
       "facts"
     )}
     ${section(ICON.search, "Root cause analysis")}
     ${
       i.rca && i.rca.trim()
         ? renderRca(i.rca)
         : empty("No analysis recorded.", "The investigation ended before it produced one — the Slack thread has the run.", ICON.search)
     }
     ${section(ICON.wrench, "Remediation")}
     ${remediations}
     ${section(ICON.speech, "On-call feedback")}
     ${feedback}
     </div>`,
    { current: "/incidents", openIncidents }
  );
}

export function errorPage(title: string, message: string, chrome: "full" | "bare" = "full"): string {
  return layout(title, `<h1>${esc(title)}</h1>${empty(title, message)}`, { chrome });
}

// `group` is only ever the anchor prefix: each box in the diagram links to its own row here,
// and rowId() is the single definition both sides derive that id from. Optional because the
// activeClient table reuses this helper for a row the diagram never draws (non-router
// providers have no backend chips), and an anchor nothing can link to is just dead markup.
const nodeRows = (nodes: TopoNode[], group?: "in" | "out"): string =>
  nodes.length === 0
    ? empty("Nothing configured in this group.", "Set the matching environment variables to wire one up.", ICON.plug)
    : table(
        headers("Dependency", "Endpoint", "Notes"),
        nodes
          .map(
            (n, i) => `<tr role="row"${group ? ` id="${rowId(group, i)}"` : ""}${n.configured ? "" : ` data-tone="warning"`}>` +
              cell("Dependency", esc(n.label), "primary") +
              cell("Endpoint", `<span translate="no">${esc(n.detail)}</span>`, "mono") +
              cell(
                "Notes",
                `${esc(n.meta)}${n.configured ? "" : ` ${badge("not configured", "warning")}`}`,
                "meta"
              ) +
              `</tr>`
          )
          .join(""),
        // Stacked, not paired: every one of these three is a phrase rather than a value —
        // "Postgres (incident memory)", a queue pair with an arrow between them, "bot token
        // present, socket mode present". A caption beside them would leave each phrase a third
        // of the screen to wrap in.
        "stack"
      );

// Paired rather than stacked: a backend row is a spec sheet — a name, two identifiers, an enum
// and an endpoint. Only the endpoint is long, and it is the one field a reader scans down rather
// than reads, so it keeps the column the other four set.
const backendRows = (backends: BackendNode[]): string =>
  table(
    headers("Backend", "Kind", "Model", "Route", "Reached via"),
    backends
      .map(
        (b, i) => `<tr role="row" id="${rowId("backend", i)}">` +
          cell("Backend", esc(b.name), "primary") +
          cell("Kind", `<span translate="no">${esc(b.kind)}</span>`, "mono") +
          cell("Model", `<span translate="no">${esc(b.model)}</span>`, "mono") +
          cell("Route", badge(b.route, "")) +
          cell("Reached via", `<span translate="no">${esc(b.endpoint)}</span>`, "mono") +
          `</tr>`
      )
      .join(""),
    "pairs"
  );

// The one table on this page whose source is NOT config: these families are derived from the
// tool list devops-mcp-server returned when the agent connected. So the empty state is a real
// state, not a misconfiguration — the agent may simply not have connected yet — and it must not
// read like the "set the environment variable" copy the config tables use.
// A family can hold thirty tools, and thirty names per row would bury the four numbers that
// answer "what can this agent see". <details> gives the family line as the glance and the
// names on demand — native, keyboard-operable, and the only disclosure widget that works
// under a `default-src 'none'` CSP, which forbids the script every other one needs.
const capabilityRows = (caps: Capability[]): string =>
  caps.length === 0
    ? empty(
        "No tools discovered yet.",
        "The agent lists them when it connects to devops-mcp-server. If this persists, the server is unreachable.",
        ICON.plug
      )
    // The one table on this page that stays a table at every width, and deliberately. Two
    // columns — a family name and a count — fit 320px with room to spare, so there is nothing to
    // rescue; and stacking it would put the expanded tool list BETWEEN the family and its count,
    // which is the pair the row exists to show. A narrow layout is for columns that fall off the
    // edge, not for every table.
    : table(
        `<th>Family</th><th>Tools</th>`,
        caps
          .map(
            (c, i) => `<tr id="${rowId("cap", i)}"><td class="primary">` +
              // The name is wrapped rather than styled on the <summary> itself: the disclosure
              // triangle lives inside that box, and every property that would set it off from
              // the name (padding, indent) moves the triangle with it. A span is the one thing
              // the marker cannot follow.
              `<details><summary><span class="mono" translate="no">${esc(c.name)}</span></summary>` +
              `<ul class="toollist">${c.tools
                .map(
                  (t) => `<li class="mono" translate="no">${esc(t.name)}` +
                    // The most consequential fact on this page: which of these can change the
                    // cluster. It is marked, not filtered — a reader who sees no marks has
                    // been told something, and a reader who sees one knows to look.
                    `${t.write ? ` ${badge("write", "warning")}` : ""}</li>`
                )
                .join("")}</ul></details></td>` +
              `<td class="num">${fmtInt(c.tools.length)}</td></tr>`
          )
          .join(""),
        undefined,
        // The only table here with a <details> in a cell, and so the only one whose columns
        // would move when a reader opens one. See table.caps in styles.ts.
        "caps"
      );

// The map's visual vocabulary, stated on the page that uses it.
//
// It was not stated anywhere: an amber dashed box meant "not configured", a teal edge meant
// "reached over SQS via llm-worker" — which CLAUDE.md calls the one fact the diagram exists to
// make obvious — and a reader had to already know. The "not configured" case was at least
// recoverable from the Notes column of the tables below; the teal edge was explained in a
// paragraph under LLM backends that never mentions the colour.
//
// Each swatch is drawn with the SAME classes the diagram draws with, so the key cannot come to
// disagree with the drawing — restyle a stroke and the legend restyles with it.
//
// Conditional on what was actually drawn. A legend that explains a colour which is not on
// screen is a legend that has to be read past: `not configured` only appears when something
// is, and the worker edge only when a backend takes it.
function topoLegend(t: Topology): string {
  const key = (mark: string, text: string): string => `<li>${mark}${esc(text)}</li>`;
  // Same classes AND the SAME ELEMENT — the rule survived the move from SVG to React Flow, and
  // it is the reason this is a <div> rather than the <span> that would read better here: the
  // map's nodes are `<div class="topo-node …">` (client/nodes.tsx), so a swatch that is
  // anything else takes its border from a different rule and is one restyle away from telling
  // the reader something the map does not. `.topo-swatch` overrides size and padding ONLY;
  // every property the key is actually explaining is inherited from the map's own selectors.
  const boxKey = (cls: string): string =>
    `<div class="topo-node ${cls} topo-swatch" aria-hidden="true"></div>`;

  const unconfigured = [...t.inbound, ...t.outbound].some((n) => !n.configured);
  const viaWorker = t.backends.some((b) => b.viaWorker);

  return (
    `<ul class="topo-legend">` +
    key(boxKey("topo-self"), "this agent") +
    (viaWorker ? key(boxKey("topo-backend topo-backend-worker"), "reached over SQS via llm-worker") : "") +
    (unconfigured ? key(boxKey("topo-off"), "not configured") : "") +
    // React Flow's <Controls> gives zoom and fit buttons but says nothing about the gestures,
    // and none of these is discoverable: the wheel is deliberately NOT captured (see
    // zoomOnScroll in client/topology.tsx — a map that swallows the scroll traps a reader
    // trying to reach the tables below it), a card can be moved, and a tool family opens.
    // "every card links to its row" was retired here rather than reworded: it stopped being
    // true when tools became nodes, and a tool has no row of its own — the tables list it
    // inside its family's <details>. The arrow names the affordance that IS still on the card.
    `<li class="topo-legend-note">Drag to move · Ctrl + scroll to zoom · click a tool family to list its tools · ↓ jumps to a card's row below.</li>` +
    `</ul>`
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
const jsonBlock = (id: string, nonce: string, value: unknown): string =>
  `<script type="application/json" id="${esc(id)}" nonce="${esc(nonce)}">` +
  JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) +
  `</script>`;

/**
 * The map itself: a mount point, the data, and the bundle that joins them.
 *
 * The mount is NOT empty. It holds the one sentence a reader gets if the bundle never runs —
 * scripting off, the script blocked, a stale cached asset 404ing — and `client/topology.tsx`
 * clears it as its first act after a successful parse. This is a smaller promise than the SVG
 * it replaced, which drew the whole map with no script at all, and it is the trade this rewrite
 * makes: the map is script-only now, so the page SAYS so rather than showing an empty frame.
 * The four tables below are unaffected and still carry every fact the map draws.
 *
 * `defer` so the DOM the script queries is parsed before it runs — both the mount point and the
 * data block sit above it today, and defer is what keeps this true if either ever moves.
 */
function topoFrame(t: Topology, nonce: string, assets: Assets | null): string {
  // Not an error state. `npm run dev` runs tsx against the source and never bundles, so this is
  // what a developer who has not run `npm run build:client` sees — and what a broken image build
  // shows instead of a blank frame nobody can diagnose from the page itself.
  if (!assets) {
    return (
      `<div class="card topo-frame">` +
      empty(
        "The dependency map is not built.",
        "Run npm run build:client to bundle it. Every fact it draws is in the tables below.",
        ICON.plug
      ) +
      `</div>`
    );
  }
  return (
    `<div class="card flush topo-frame">` +
    `<div id="topo-root" class="topo-view" data-fallback>` +
    `<p class="topo-fallback">The dependency map needs JavaScript. ` +
    `The tables below carry the same facts.</p>` +
    `</div>` +
    topoLegend(t) +
    `</div>` +
    jsonBlock("topo-data", nonce, t) +
    `<script src="${esc(assets.js.path)}" nonce="${esc(nonce)}" defer></script>`
  );
}

/**
 * `nonce` is required, not optional: it is what the response's own `script-src 'nonce-…'`
 * names, and a page built without one would render a <script> that every browser then refuses
 * to run — an interactive map that silently is not one. It covers BOTH tags on this page: the
 * external bundle and the JSON data block. The only caller mints it per response (see csp()
 * in server.ts).
 *
 * `assets` is nullable because the bundle is a build artifact, and its absence is a state this
 * page renders rather than a crash — see topoFrame().
 */
export function topologyPage(
  t: Topology,
  nonce: string,
  assets: Assets | null,
  openIncidents?: number
): string {
  // The brief's original version rendered only the bare provider name for the three
  // non-router providers ("Provider claude — one client, no routing."). Task 1's review
  // added `activeClient` (populated for claude / openai-compatible / private-llm, undefined
  // for router — the router's answer is `backends[]` instead) precisely so this page could
  // show the one active client, not merely name it (design §4.2). Reusing nodeRows() here —
  // the same helper the inbound/outbound tables use — means this table and those tables
  // can never render a node's fields differently from one another.
  const router =
    t.provider !== "router"
      ? `<p class="meta">Provider <code translate="no">${esc(t.provider)}</code> — one client, no routing.</p>` +
        nodeRows(t.activeClient ? [t.activeClient] : [])
      : t.registryError
        ? empty("The backend registry could not be read.", t.registryError, ICON.chip)
        : backendRows(t.backends) +
          `<p class="meta">Only <code translate="no">private-llm</code> backends traverse SQS to ` +
          `<code translate="no">llm-worker</code>; <code translate="no">claude</code> and ` +
          `<code translate="no">openai-compatible</code> backends are called directly from the agent.</p>`;

  return layout(
    "Topology",
    `<h1>Dependency map</h1>
     <p class="meta">Read from this agent's own configuration, plus the tool list
       <code translate="no">devops-mcp-server</code> sent when the agent connected. Nothing here is
       probed — no call leaves the process.</p>
     ${topoFrame(t, nonce, assets)}
     ${section(ICON.inbound, "Inbound")}
     ${nodeRows(t.inbound, "in")}
     ${section(ICON.outbound, "Outbound")}
     ${nodeRows(t.outbound, "out")}
     ${section(ICON.plug, "MCP tools")}
     ${capabilityRows(t.capabilities)}
     ${section(ICON.chip, "LLM backends")}
     ${router}`,
    // The one page with an external stylesheet. It is linked ahead of the inline <style> so
    // the dashboard's own rules win over React Flow's at equal specificity.
    { current: "/topology", openIncidents, stylesheet: assets?.css.path }
  );
}

// Numbers go through `fmtInt`, already imported at the top of views.ts (line 1) and used twenty
// times below. Do NOT add a local `const num = (n) => n.toLocaleString("en-US")` — that is
// html.ts:32-34 rewritten, in the one file that already imports the original, and it would put a
// function named `num` beside the CSS class named "num" that these very cells pass.

// A skill row is a name, a pattern, a size and a sentence — the sentence is what makes this a
// stack rather than pairs. The body does NOT hang off the row: it is 8000 chars at most and a
// <details> inside a table cell expands the row it sits in, so opening one pushed every skill
// below it off the screen and gave the text the width of one column to wrap in. It gets its own
// page instead (skillPage), which the name links to.
function skillRows(skills: ContextView["skills"]): string {
  // No empty state on purpose: loadSkills throws at boot on a directory with no .md files, so a
  // running agent always has skills. An "empty" table here would be a state the process cannot
  // reach — do not add one later.
  return table(
    headers("Skill", "When", "Size", "Description"),
    skills
      .map((s) =>
        `<tr role="row">` +
        // The name is the link, not a "view" column: it is what the reader is already looking
        // at, and a row whose target is named twice reads as two destinations. `skillHref`
        // encodes because nothing here may assume the loader's name rule still holds.
        cell("Skill", `<a href="${esc(skillHref(s.name))}"><code translate="no">${esc(s.name)}</code></a>`, "primary") +
        cell("When", s.when === "always"
          ? `<span class="badge">ALWAYS</span>`
          : `<code translate="no">${esc(s.when)}</code>`) +
        cell("Size", `${fmtInt(s.chars)} chars`) +
        cell("Description", esc(s.description)) +
        `</tr>`
      )
      .join(""),
    "stack"
  );
}

// encodeURIComponent inside the path segment, esc() on the whole attribute at the call site —
// the same two layers the incident page's Slack link takes. A skill name matches [a-z0-9-] at
// load time (NAME_RE in agent/skills), so today neither layer has anything to do; that rule
// lives in another module and this one does not get to assume it.
const skillHref = (name: string): string => `/context/${encodeURIComponent(name)}`;

/**
 * One skill, whole. The body is the text the model is handed verbatim, so it is rendered
 * preformatted and escaped — never parsed as markdown. What the agent reads and what this page
 * shows have to be the same string, and a renderer is a second interpretation of it.
 */
/**
 * The core prompt, in full.
 *
 * On its own page rather than inline on /context, and for the reason skillPage exists: 24,000
 * characters in a <pre> would bury the budget table under four screens of prompt, which is the
 * same failure a <details> in a table row caused for skills.
 *
 * The text is the RUNNING process's copy. buildStaticSystemPrompt() reads prompts/system.md
 * once and caches it, and the file is editable without a rebuild — so git, the pod's disk and
 * this string can all disagree, and only this one decides what the agent says. The page states
 * that, because a reader who takes it for "what the repo holds" would be reading the wrong
 * thing at the exact moment it matters.
 */
export function promptPage(v: ContextView, openIncidents?: number): string {
  return layout(
    "System prompt",
    `<div class="doc">
     <p class="eyebrow">Core prompt</p>
     <h1 translate="no">prompts/system.md</h1>
     <div class="title-meta">
       <span class="badge">EVERY ITERATION</span>
       <span class="meta">${fmtInt(v.core.lines)} lines · ${fmtInt(v.core.chars)} chars · about ${fmtInt(v.core.tokens)} tokens</span>
       <a class="standalone" href="/context">← Context and skills</a>
     </div>
     <p class="meta">Sent whole at the head of every request, on every iteration of every
       investigation — the largest and the only unconditional part of what this agent is told.</p>

     ${section(ICON.layers, "What you are reading")}
     <p class="meta">This is the copy <strong>this process is holding</strong>, not the file as it
       stands on disk: it is read once at boot and cached for the life of the pod, and
       <code translate="no">prompts/system.md</code> is editable without a rebuild. If someone
       changed the file after this pod started, the change is not here — and it is not reaching
       the model either. That is the question this page exists to answer.</p>

     ${section(ICON.context, "Prompt text")}
     <pre class="skill-body">${esc(v.core.body)}</pre>
     </div>`,
    { current: "/context", openIncidents }
  );
}

export function skillPage(s: ContextView["skills"][number], openIncidents?: number): string {
  const always = s.when === "always";
  // Everything below is ONE block, not a stack of strips laid straight into <main>. The
  // difference is real: loose children each take the column's full width and their own content
  // height, so a page of them is a run of full-bleed bands (an eyebrow renders 880x11) with
  // nothing declaring that they are one document. .doc is that declaration — it establishes the
  // block formatting context the sections' margins collapse inside, and it is the element the
  // width rule attaches to, so the page follows the column instead of a measure of its own.
  return layout(
    s.name,
    `<div class="doc">
     <p class="eyebrow">Skill</p>
     <h1 translate="no">${esc(s.name)}</h1>
     <div class="title-meta">
       ${always ? `<span class="badge">ALWAYS</span>` : `<span class="badge" data-tone="info">MATCHED</span>`}
       <span class="meta">${fmtInt(s.chars)} chars</span>
       <a class="standalone" href="/context">← All skills</a>
     </div>
     <p class="meta">${esc(s.description)}</p>

     ${section(ICON.bolt, "Trigger")}
     <p class="meta">${
       always
         ? `Carried into every investigation, whatever the alert says.`
         : `Carried when this pattern matches the alert text. The match is case-insensitive, and ` +
           `it is distinct matches that rank a skill against the others, not how often one word repeats.`
     }</p>
     ${always ? "" : `<pre class="skill-body" translate="no">${esc(s.when)}</pre>`}

     ${section(ICON.context, "Skill text")}
     <p class="meta">Injected verbatim into the first user message of an investigation — never into
       the system prompt, which is cached whole and would miss on every call if it varied.</p>
     <pre class="skill-body">${esc(s.body)}</pre>
     </div>`,
    { current: "/context", openIncidents }
  );
}

// Seven short numbers and two identifiers: the spec-sheet shape pairs was built for.
function budgetRows(backends: ContextView["backends"]): string {
  return table(
    headers("Backend", "Model", "Window", "Reserve", "Core", "Tools", "Available"),
    backends
      .map((b) =>
        `<tr role="row">` +
        cell("Backend", `<code translate="no">${esc(b.name)}</code>`) +
        cell("Model", `<code translate="no">${esc(b.model)}</code>`) +
        // "num" is the class every other numeric cell in this file carries (see the Token usage
        // table, views.ts:273-276) — also a `pairs` table, so the combination is already proven.
        cell("Window", fmtInt(b.window), "num") +
        cell("Reserve", fmtInt(b.reserve), "num") +
        cell("Core", fmtInt(b.core), "num") +
        cell("Tools", fmtInt(b.tools), "num") +
        cell("Available", fmtInt(b.available), "num") +
        `</tr>`
      )
      .join(""),
    "pairs"
  );
}

export function contextPage(v: ContextView, openIncidents?: number): string {
  return layout(
    "Context",
    `<h1>Context and skills</h1>
     <p class="meta">What this agent knows before it reads a single metric, and how much room it
       has to say it. Read from the running process — no database, no call leaves it.</p>

     ${section(ICON.layers, "Core prompt", `<a class="standalone" href="/prompt">Read the prompt →</a>`)}
     <p class="meta"><code translate="no">prompts/system.md</code> — ${fmtInt(v.core.lines)} lines,
       ${fmtInt(v.core.chars)} chars, about ${fmtInt(v.core.tokens)} tokens. Sent on every iteration of
       every investigation. The skills below are shown in full; so is this.</p>

     ${section(ICON.context, "Skills")}
     <p class="meta">Selected from the alert text and carried in the first user message, never in
       the system prompt — a system prompt that varied per investigation would miss the model's
       prompt cache on every call. Open a skill to read the text the model is handed.</p>
     ${skillRows(v.skills)}

     ${section(ICON.chip, "Budget per backend")}
     <p class="meta">Every request is built to fit <code translate="no">${esc(v.effective.backend)}</code>,
       the smallest window — about ${fmtInt(v.effective.available)} tokens for skills and conversation.
       The router picks a backend after the request is assembled, so the request has to fit the
       smallest one it might land in.</p>
     ${budgetRows(v.backends)}`,
    { current: "/context", openIncidents }
  );
}
