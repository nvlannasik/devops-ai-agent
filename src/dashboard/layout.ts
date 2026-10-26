import { esc } from "./html.js";
import { STYLES } from "./styles.js";
import { DEFAULT_RANGE, RANGES } from "./filters.js";
import type { Range } from "./filters.js";
import { NAV_COUNT_CAP } from "./queries.js";
import { SESSION_TTL_MS } from "./auth.js";
import { ICON, empty } from "./parts.js";

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
      { href: "/postmortems", label: "Postmortems", icon: ICON.postmortem },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/topology", label: "Topology", icon: ICON.topology },
      { href: "/cluster", label: "Cluster", icon: ICON.layers },
      { href: "/memory", label: "Alert memory", icon: ICON.memory },
      { href: "/memory/threads", label: "Conversation memory", icon: ICON.chats },
      { href: "/context", label: "Context", icon: ICON.context },
      { href: "/bench", label: "Benchmark", icon: ICON.bench },
      { href: "/harness", label: "Harness", icon: ICON.harness },
      { href: "/people", label: "People", icon: ICON.people },
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
export const WINDOW_LABEL: Record<Range, string> = {
  "24h": "24 hours", "7d": "7 days", "30d": "30 days",
};
export function rangeControl(current: Range): string {
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

export function errorPage(title: string, message: string, chrome: "full" | "bare" = "full"): string {
  return layout(title, `<h1>${esc(title)}</h1>${empty(title, message)}`, { chrome });
}
