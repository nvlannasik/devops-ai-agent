import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { STYLES } from "./styles.js";

// 2026-10-21 split: STYLES is seven ordered chunks. Order is the cascade, so the bytes are pinned —
// a chunk moved or a line lost changes which rule wins with no error anywhere. A NEW rule re-pins
// both numbers on purpose (2026-10-26: /people, the harness bars and bench folds, then the incident header and params).
test("STYLES bytes are pinned", () => {
  assert.equal(STYLES.length, 183747);
  assert.equal(createHash("sha256").update(STYLES).digest("hex"), "5d63d5d5c8764757fc517b7d143540f31f25508b9401bc08bdd77f11631ba9d6");
});

test("no stylesheet chunk interpolates", () => {
  for (const f of readdirSync(new URL("./styles/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8"), /\$\{/, f);
  }
});

// ---------- the dark scheme, and the asset the sheet is served as ----------

// The dark values are set down twice — once for a system that asks for dark, once for a reader
// who chose it — and the two blocks must be the SAME bytes or the schemes drift apart with
// nothing failing. They are assembled from one constant, and this is what says so.
test("the dark tokens appear under both selectors, byte for byte", async () => {
  const { DARK_TOKENS_CSS } = await import("./styles/dark.js");
  assert.ok(DARK_TOKENS_CSS.length > 200);
  const system = `@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {${DARK_TOKENS_CSS}}\n}\n`;
  const chosen = `:root[data-theme="dark"] {\n  color-scheme: dark;${DARK_TOKENS_CSS}}\n`;
  assert.equal(STYLES.split(system).length, 2, "the system-preference block, once");
  assert.equal(STYLES.split(chosen).length, 2, "the reader's-choice block, once");
  assert.ok(STYLES.indexOf(system) < STYLES.indexOf(chosen));
  // A reader on a dark system who picked light must get light form controls and scrollbars too.
  assert.match(STYLES, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  // The light scheme is the :root block and nothing else: no rule restates it for a chosen theme.
  assert.doesNotMatch(STYLES, /:root\[data-theme="light"\] \{[^}]*--(bg|surface|text):/);
  // …and the tokens come after :root, or the light values would win the cascade.
  assert.ok(STYLES.indexOf(":root {") < STYLES.indexOf(system));
});

// Every token the dark block sets must exist in the light one: a name only dark defines is a
// typo, and it would leave the light page reading an undefined variable.
test("the dark block redefines light tokens and invents none", async () => {
  const { DARK_TOKENS_CSS } = await import("./styles/dark.js");
  const root = /:root \{([\s\S]*?)\n\}/.exec(STYLES)?.[1] ?? "";
  const light = new Set([...root.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const dark = [...DARK_TOKENS_CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]!);
  assert.ok(dark.length > 20);
  for (const name of dark) assert.ok(light.has(name), `${name} is set in dark but never in :root`);
  for (const must of ["--bg", "--surface", "--text", "--text-dim", "--brand-600", "--on-accent", "--rail"]) {
    assert.ok(dark.includes(must), `${must} has no dark value`);
  }
});

// The ink rail is legible because .rail re-points the generic tokens at its own ramp; a
// component inside it never asks which ground it is on. Below 60rem the top bar does the same.
test("the rail is an ink scope, and so is the top bar once it lies over the page", () => {
  const rail = /^\.rail \{([^}]*)\}/m.exec(STYLES)?.[1] ?? "";
  for (const t of ["--text: var(--rail-text)", "--text-dim: var(--rail-dim)", "--accent: var(--rail-accent)", "--on-accent: var(--rail)"]) {
    assert.ok(rail.includes(t), `.rail does not set ${t}`);
  }
  assert.match(rail, /background: var\(--rail\)/);
  assert.match(STYLES, /^\.topbar \{\n  --text: var\(--rail-text\);/m);
  // the frosted bar is gone with the light chrome it belonged to
  assert.doesNotMatch(STYLES, /--glass/);
});

// The filled tile inverts its own colours, so each thing inside it has to be told. The sub-line
// is the one that is easy to lose: --text-dim on the accent is unreadable in both schemes.
test("the lead tile restates every colour it inverts", () => {
  const rule = (selector: string): string => {
    const at = STYLES.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return STYLES.slice(at, STYLES.indexOf("}", at));
  };
  const tile = rule(".stat[data-lead]");
  assert.match(tile, /background: var\(--accent\)/);
  assert.match(tile, /color: var\(--on-accent\)/);
  assert.match(rule(".stat[data-lead] dt, .stat[data-lead] dd span"), /color: color-mix\(in srgb, var\(--on-accent\) 85%, var\(--accent\)\)/);
  // untoned, the chip is a wash of the tile's own ink; toned (incidents are open), the
  // severity chip keeps its own vocabulary on a tile that is otherwise the accent
  assert.match(rule(".stat[data-lead]:not([data-tone]) .kpi-icon"), /color: var\(--on-accent\)/);
  assert.match(rule(".stat[data-lead][data-tone] .kpi-icon"), /background: var\(--tint\); color: var\(--ink\)/);
});

test("the sheet is served under a name that is a hash of its own bytes", async () => {
  const { APP_CSS, FONT, PUBLIC_ASSETS } = await import("./stylesheet.js");
  const hash = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 8);
  assert.equal(APP_CSS.path, `/assets/app.${hash(APP_CSS.body)}.css`);
  assert.equal(FONT.path, `/assets/space-grotesk.${hash(FONT.body)}.woff2`);
  assert.deepEqual([...PUBLIC_ASSETS.keys()].sort(), [APP_CSS.path, FONT.path].sort(), "two public files, and only two");

  const css = String(APP_CSS.body);
  assert.ok(css.endsWith(STYLES), "the sheet is STYLES behind one @font-face rule");
  const face = css.slice(0, css.length - STYLES.length);
  assert.equal(face.match(/@font-face/g)?.length, 1);
  assert.ok(face.includes(`src: url("${FONT.path}") format("woff2")`));
  // swap: the display face is four elements, and none of them may hold the page back
  assert.match(face, /font-display: swap/);
  // The sheet must not reach outside this origin: font-src and style-src are 'self' only.
  assert.doesNotMatch(css, /url\(\s*["']?(https?:|\/\/|data:)/);
  assert.doesNotMatch(css, /@import/);

  // woff2 magic, and small enough to be worth shipping for display type alone
  assert.equal((FONT.body as Buffer).subarray(0, 4).toString("latin1"), "wOF2");
  assert.ok((FONT.body as Buffer).length < 40_000);
  assert.match(STYLES, /--font-display: "Space Grotesk", var\(--font-ui\);/);
});
