import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, THEME_COOKIE, parseTheme, themeCookie, themeReturn } from "./theme.js";
import { layout, loginPage, withTheme } from "./layout.js";

test("parseTheme is a two-value allowlist; everything else is auto", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  for (const raw of [undefined, null, "", "auto", "DARK", " dark", "sepia", `"><script>`]) {
    assert.equal(parseTheme(raw), "auto", String(raw));
  }
  assert.deepEqual([...THEMES], ["auto", "light", "dark"]);
});

// Lax where the session cookie is Strict — it carries no authority — and HttpOnly because no
// script reads it. "auto" is the absence of a choice, so it deletes the cookie.
test("the theme cookie is long-lived, HttpOnly and Lax, and auto clears it", () => {
  assert.equal(themeCookie("dark", true), `${THEME_COOKIE}=dark; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(themeCookie("light", false), `${THEME_COOKIE}=light; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`);
  assert.equal(themeCookie("auto", false), `${THEME_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
});

test("a theme link returns to the Referer's path on THIS origin, or to the overview", () => {
  assert.equal(themeReturn("https://dash.example/incidents?severity=critical&page=2"), "/incidents?severity=critical&page=2");
  assert.equal(themeReturn("https://dash.example/incidents/42"), "/incidents/42");
  // the host is dropped whatever it says — only the path is carried
  assert.equal(themeReturn("https://evil.example/harness"), "/harness");
  // nothing to go back to
  for (const ref of [undefined, "", "not a url", "about:blank"]) assert.equal(themeReturn(ref), "/", String(ref));
  // protocol-relative once resolved: safeNext() refuses it
  assert.equal(themeReturn("https://dash.example//evil.example/x"), "/");
  // a loop or a dead end is not somewhere to return to
  for (const ref of ["https://x/theme/dark", "https://x/login?next=%2F", "https://x/logout", "https://x/theme"]) {
    assert.equal(themeReturn(ref), "/", ref);
  }
  // …but a page that merely starts with the word is a page
  assert.equal(themeReturn("https://x/themes"), "/themes");
});

const page = (): string => layout("Test", "<p>hi</p>", { current: "/incidents" });

test("layout renders the auto form: no data-theme, both theme-color metas, Auto current", () => {
  const html = page();
  assert.match(html, /^<!doctype html>\n<html lang="en"><head>/);
  assert.equal(html.match(/<meta name="theme-color"/g)?.length, 2);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<a href="\/theme\/auto" aria-current="true">Auto<\/a><a href="\/theme\/light">Light<\/a><a href="\/theme\/dark">Dark<\/a>/);
  assert.equal(withTheme(html, "auto"), html, "auto is the page as rendered");
});

test("withTheme swaps the three theme-dependent fragments and nothing else", () => {
  const auto = page();
  for (const theme of ["light", "dark"] as const) {
    const html = withTheme(auto, theme);
    assert.match(html, new RegExp(`^<!doctype html>\\n<html lang="en" data-theme="${theme}"><head>`));
    // one colour, with no media condition: the reader's choice outranks the system's
    assert.equal(html.match(/<meta name="theme-color"/g)?.length, 1);
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}">/);
    assert.equal(html.match(/<a href="\/theme\/[a-z]+" aria-current="true">/g)?.length, 1);
    assert.match(html, new RegExp(`<a href="/theme/${theme}" aria-current="true">`));
    // the page itself is untouched: same body, same rail position
    assert.equal(html.slice(html.indexOf("<main")), auto.slice(auto.indexOf("<main")));
    assert.match(html, /<a href="\/incidents" aria-current="page">/);
  }
  assert.notEqual(withTheme(auto, "light"), withTheme(auto, "dark"));
});

// The theme-color metas must be the page background, or the browser chrome is a different
// colour from the page under it — and the bar is what a phone shows first.
test("the theme-color metas are --bg in each scheme", async () => {
  const { STYLES } = await import("./styles.js");
  const { DARK_TOKENS_CSS } = await import("./styles/dark.js");
  const lightBg = /:root \{[^}]*?--bg: (#[0-9a-f]{6});/.exec(STYLES)?.[1];
  const darkBg = /--bg: (#[0-9a-f]{6});/.exec(DARK_TOKENS_CSS)?.[1];
  assert.ok(lightBg && darkBg);
  assert.match(withTheme(page(), "light"), new RegExp(`<meta name="theme-color" content="${lightBg}">`));
  assert.match(withTheme(page(), "dark"), new RegExp(`<meta name="theme-color" content="${darkBg}">`));
});

// A bare page has no rail and so no theme links, but it is still themed.
test("the sign-in page takes the theme and offers no control it cannot honour", () => {
  const html = loginPage({ next: "/" });
  assert.doesNotMatch(html, /class="theme"/);
  assert.match(withTheme(html, "dark"), /^<!doctype html>\n<html lang="en" data-theme="dark"><head>/);
});

test("a response that is not one of layout()'s documents is returned untouched", () => {
  for (const other of ["ok", "<html><body>x</body></html>", `{"a":1}`, ""]) assert.equal(withTheme(other, "dark"), other);
});

// Everything a page interpolates goes through esc(), so text that LOOKS like the fragments
// cannot be what withTheme() rewrites.
test("page content that quotes the theme markup is not rewritten", () => {
  const bait = `<a href="/theme/auto" aria-current="true">Auto</a>`;
  const html = layout(bait, `<p>${bait.replace(/</g, "&lt;")}</p>`, { current: "/" });
  const dark = withTheme(html, "dark");
  assert.equal(dark.match(/<a href="\/theme\/dark" aria-current="true">/g)?.length, 1);
  assert.equal(dark.slice(dark.indexOf("<main")), html.slice(html.indexOf("<main")), "the quoted copy is left as written");
});
