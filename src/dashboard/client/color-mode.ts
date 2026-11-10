// Which scheme React Flow should draw its own chrome in (controls, attribution, the minimap).
//
// The page's scheme has one source: <html data-theme="light|dark"> when the reader chose one
// (theme.ts, from a cookie), and prefers-color-scheme when they did not — which is what the
// stylesheet keys on. React Flow has to read the SAME signal, or a reader who picked light on
// a dark system gets a light page around dark map controls. "system" is React Flow reading the
// media query itself, and is right exactly when no choice was made.
//
// Read once, at mount: the theme changes by navigation (/theme/dark redirects back), never
// under a mounted map.
export type MapColorMode = "light" | "dark" | "system";

export const mapColorMode = (root: { dataset: { theme?: string } } = document.documentElement): MapColorMode => {
  const chosen = root.dataset.theme;
  return chosen === "light" || chosen === "dark" ? chosen : "system";
};
