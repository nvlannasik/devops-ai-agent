import { safeNext } from "./auth.js";

// The colour theme, as a preference the SERVER renders.
//
// Every page but the two maps runs no script, so a toggle cannot be a click handler that flips a
// class and writes localStorage. It is three links instead: each is a URL (`/theme/dark`) that
// sets a cookie and redirects back, and every later page is rendered with `data-theme` on <html>
// from that cookie (layout.ts `withTheme`). Nothing flashes on load — the attribute is in the
// first byte of the response, where a script-set theme would arrive after first paint.
//
// "auto" is the absence of a preference, not a third theme: it clears the cookie and the page
// follows `prefers-color-scheme`, which is what the dashboard did before it had a toggle.

export type Theme = "auto" | "light" | "dark";
export const THEMES: readonly Theme[] = ["auto", "light", "dark"];

export const THEME_COOKIE = "dash_theme";
// A year. A preference, not a credential: it should outlive the 12-hour session it has nothing
// to do with, or the dashboard would forget the choice every morning.
const THEME_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Anything but the two real values is "auto" — an absent cookie, an edited one, a value from a
 * build that knew more themes. The result is interpolated into an attribute, so this allowlist
 * is also what keeps a cookie from writing markup.
 */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

/**
 * `Lax`, where the session cookie is `Strict`: this one carries no authority, and Lax is what
 * lets a link followed from Slack open in the theme its reader chose. HttpOnly because nothing
 * in the browser reads it — the maps read the rendered `data-theme` attribute instead.
 */
export function themeCookie(theme: Theme, secure: boolean): string {
  const base = theme === "auto" ? `${THEME_COOKIE}=; Max-Age=0` : `${THEME_COOKIE}=${theme}; Max-Age=${THEME_MAX_AGE_S}`;
  return `${base}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Where a theme link returns to: the page it was clicked on, taken from the Referer.
 *
 * Only the path and query are kept and they go through safeNext(), so whatever the header says
 * the redirect lands on this origin — a Referer is attacker-influenced input like any other.
 * No Referer (a privacy setting, a typed URL) falls back to the overview, and so does a Referer
 * that is itself a theme or sign-in URL, which would otherwise be a loop or a dead end.
 */
export function themeReturn(referer: string | undefined): string {
  if (!referer) return "/";
  let path: string;
  try {
    const u = new URL(referer);
    path = u.pathname + u.search;
  } catch {
    return "/";
  }
  const back = safeNext(path);
  return /^\/(theme|login|logout)(\/|\?|$)/.test(back) ? "/" : back;
}
