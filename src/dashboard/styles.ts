// One stylesheet for every page. No build step and no CDN: stylesheet.ts serves this string
// (behind one @font-face rule) as a content-hashed, immutable asset, and every page links it
// rather than carrying ~160 KB of it inline. Components read only from the tokens at the top —
// never hard-code a colour below :root.
//
// THIS IS A TEMPLATE LITERAL, so three characters belong to JavaScript before they belong to
// CSS: a backtick, a dollar-brace, and a BACKSLASH. The last one is the quiet one — a CSS
// escape like \2193 for an arrow reads as a legacy octal escape and fails the whole build with
// "Legacy octal escape sequences cannot be used in template literals", nowhere near the line
// that caused it. Write the character itself (↓, ’, ·); the file is UTF-8 and so is the page.
//
// The direction ("Atlas", 2026-11-10): an INK RAIL beside a light page. The rail is the whole
// chrome above 60rem — the brand heads it, the theme control and sign out foot it, and there is
// no bar across the top; below that width a top bar carries the burger and the brand and the
// rail lies down or becomes a drawer. Both are ink in both colour schemes; the page is a cool
// off-white (or a deep indigo-black) with white cards on it, and one indigo accent carries
// links, the current range, focus, and the single filled tile that opens the overview. A
// page's own controls (the overview's range) sit in its title row, not in the chrome. Severity
// keeps its own four-tone vocabulary end to end and never rests on colour alone. The rail is
// legible through an "ink scope" — .rail and .topbar re-point the generic tokens at their own
// ramp (styles/chrome.ts) — so no component knows, or needs to know, which ground it is on.
//
// THREE faces, three jobs, each earned by the kind of content it carries:
//   --font-ui       the interface, and everything written in sentences
//   --font-data     what the system MEASURED — ids, endpoints, queue names, timestamps, counts
//   --font-display  the page title, the KPI figures, the chart count and the brand
//
// The first two are stacks of fonts the operating system already has. The third is the one
// typeface this project ships: Space Grotesk (OFL 1.1, ./fonts/), a 22 KB latin variable woff2
// served from /assets beside the stylesheet. It is display type only — nothing a reader has to
// READ is set in it, so a browser that never fetches the file loses the character of four
// elements and none of the text.
//
// There was once a serif reading face for the RCA, on the argument that what the agent WROTE
// is a different kind of content from what it measured. It resolved to Iowan Old Style or
// Times — whatever the system had — and the RCA read as pasted in from somewhere else. That
// is the lesson the display face is built on: a face this page names has to be a face this
// page delivers.
//
// The sheet lives in ./styles/, one file per area, concatenated here in cascade order — the order
// is load-bearing, and styles.test.ts pins the exact bytes.
import { CHROME_CSS } from "./styles/chrome.js";
import { DARK_TOKENS_CSS } from "./styles/dark.js";
import { PANELS_CSS } from "./styles/panels.js";
import { TABLES_CSS } from "./styles/tables.js";
import { CONTENT_CSS } from "./styles/content.js";
import { CHARTS_CSS } from "./styles/charts.js";
import { RESPONSIVE_CSS } from "./styles/responsive.js";
import { BENCH_CSS } from "./styles/bench.js";

// The dark values, set down twice — and this is the one place in the sheet that is assembled
// rather than written, because a chunk may not interpolate and the two blocks must be the same
// bytes or the schemes drift.
//   1. The system asks for dark and the reader has not chosen light.
//   2. The reader chose dark (data-theme="dark" on <html>, from the cookie theme.ts reads),
//      whatever the system asks for.
// :root:not([data-theme="light"]) rather than a later override that restates the LIGHT values:
// the light scheme is the :root block in chrome.ts and nothing else, so there is exactly one
// copy of it to keep right. color-scheme follows the choice too, or a reader on a dark system
// who picked light would keep dark form controls and scrollbars on a light page.
const DARK_CSS =
  `\n@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {` + DARK_TOKENS_CSS + `}\n}\n` +
  `:root[data-theme="light"] { color-scheme: light; }\n` +
  `:root[data-theme="dark"] {\n  color-scheme: dark;` + DARK_TOKENS_CSS + `}\n`;

export const STYLES =
  CHROME_CSS + DARK_CSS + PANELS_CSS + TABLES_CSS + CONTENT_CSS + CHARTS_CSS + RESPONSIVE_CSS + BENCH_CSS;
