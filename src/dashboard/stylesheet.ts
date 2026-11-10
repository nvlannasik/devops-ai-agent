import { createHash } from "node:crypto";
import { SPACE_GROTESK_WOFF2_BASE64 } from "./fonts/space-grotesk.js";
import { STYLES } from "./styles.js";

// The dashboard's stylesheet and its one font, as content-addressed assets.
//
// STYLES used to be inlined into every page in a <style> block: ~156 KB of CSS re-sent with each
// navigation and each 60-second refresh of the overview, on pages whose own markup is a tenth of
// that. It is now ONE response the browser keeps: the body is hashed into the URL, so it is
// served `immutable` for a year and a new build is simply a new URL. A page is its markup plus
// a <link>.
//
// These are built from constants at module load — no disk, no build step — which is what
// separates them from assets.ts (the React Flow bundles esbuild writes to dist/public, which can
// legitimately be absent in dev). This pair cannot be missing, so layout() links it
// unconditionally.
//
// PUBLIC, unlike the bundles: server.ts serves these ahead of the password gate, because the
// sign-in page and the "password not set" notice are styled by them and neither has a session to
// present. That is a statement about the CONTENT, and it has to stay true: a stylesheet and an
// OFL font, nothing derived from config or data. Never add an asset here that a signed-out
// visitor should not be able to read — the JS bundles stay behind the gate for that reason.

export interface PublicAsset {
  /** The URL this asset is served at, hash included. */
  path: string;
  body: string | Buffer;
  type: string;
}

// Eight hex chars, the same width assets.ts uses and for the same reason: this is a handful of
// files that change with a deploy, not a namespace a collision could matter in.
const hashed = (base: string, ext: string, body: string | Buffer): string =>
  `/assets/${base}.${createHash("sha256").update(body).digest("hex").slice(0, 8)}.${ext}`;

const fontBody = Buffer.from(SPACE_GROTESK_WOFF2_BASE64, "base64");

export const FONT: PublicAsset = {
  path: hashed("space-grotesk", "woff2", fontBody),
  body: fontBody,
  type: "font/woff2",
};

// The @font-face lives here rather than in a styles/ chunk because it names the font's hashed
// URL, and a chunk may not interpolate (styles.test.ts). The family is declared with the full
// weight axis the file carries, so `font-weight: 560` resolves to a real instance instead of a
// synthesised bold. `swap`: the system face draws at once and the display face replaces it —
// a console must never show blank figures while a font is in flight.
const FONT_FACE =
  `@font-face {\n` +
  `  font-family: "Space Grotesk"; font-style: normal; font-weight: 300 700; font-display: swap;\n` +
  `  src: url("${FONT.path}") format("woff2");\n` +
  `}\n`;

const cssBody = FONT_FACE + STYLES;

export const APP_CSS: PublicAsset = {
  path: hashed("app", "css", cssBody),
  body: cssBody,
  type: "text/css; charset=utf-8",
};

/** Keyed by exact path, like the bundles: nothing is resolved against a directory. */
export const PUBLIC_ASSETS: ReadonlyMap<string, PublicAsset> = new Map([FONT, APP_CSS].map((a) => [a.path, a]));
