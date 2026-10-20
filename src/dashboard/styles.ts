// One stylesheet, inlined into every page. No build step and no CDN — and the CSP this
// server sends (`default-src 'none'`) blocks font-src outright, so every typeface here is
// one the operating system already has. Components read only from the tokens at the top —
// never hard-code a colour below :root.
//
// THIS IS A TEMPLATE LITERAL, so three characters belong to JavaScript before they belong to
// CSS: a backtick, a dollar-brace, and a BACKSLASH. The last one is the quiet one — a CSS
// escape like \2193 for an arrow reads as a legacy octal escape and fails the whole build with
// "Legacy octal escape sequences cannot be used in template literals", nowhere near the line
// that caused it. Write the character itself (↓, ’, ·); the file is UTF-8 and so is the page.
//
// The direction: COLOUR IS RESERVED FOR SIGNAL. The chrome is graphite end to end, and the
// only saturated ink on a page is severity and state. On a console whose job is to make one
// critical row unmissable at 3am, a decorative accent on every link and every heading is
// the thing that hides the alert. Interaction (focus, current page, primary button) gets the
// single teal accent; nothing else does.
//
// TWO faces, two jobs, each earned by the kind of content it carries:
//   --font-ui    the interface, and everything written in sentences
//   --font-data  what the system MEASURED — ids, endpoints, queue names, timestamps, counts
//
// There was a third — a serif reading face for the RCA, on the argument that what the agent
// WROTE is a different kind of content from what it measured. It is, and the frame around it
// already says so. What a serif said on the page was something else: none of these stacks is a
// font this project ships (font-src is blocked outright), so it resolved to Iowan Old Style or
// Times, a print face at 17px on a graphite console, with a colour and a rhythm that belong to
// no other element on the screen. The RCA read as pasted in from somewhere else. The
// distinction is still drawn — the panel, the 68ch measure and the larger size all draw it —
// just not with a face borrowed from a book.
//
// The sheet lives in ./styles/, one file per area, concatenated here in cascade order — the order
// is load-bearing, and styles.test.ts pins the exact bytes.
import { CHROME_CSS } from "./styles/chrome.js";
import { PANELS_CSS } from "./styles/panels.js";
import { TABLES_CSS } from "./styles/tables.js";
import { CONTENT_CSS } from "./styles/content.js";
import { CHARTS_CSS } from "./styles/charts.js";
import { RESPONSIVE_CSS } from "./styles/responsive.js";
import { BENCH_CSS } from "./styles/bench.js";

export const STYLES = CHROME_CSS + PANELS_CSS + TABLES_CSS + CONTENT_CSS + CHARTS_CSS + RESPONSIVE_CSS + BENCH_CSS;
