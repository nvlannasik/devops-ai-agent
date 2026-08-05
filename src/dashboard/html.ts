// Every value the dashboard interpolates goes through esc(). The RCA text is LLM output
// and the labels come from Alertmanager, so neither is trusted input.
const ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  // the character class puts & first only for readability — the regex replaces each
  // character exactly once, so double-escaping is impossible regardless of order
  return String(v).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// Deliberately not Intl.DateTimeFormat: this column is read next to kubectl, Prometheus and
// Loki output, all of which speak UTC, and a locale-formatted local time would have to be
// converted back by hand every time. The trailing Z is the whole point — an on-call in WIB
// reading a bare "09:14" is seven hours out and has no way to tell.
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = d instanceof Date ? d : new Date(d);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return "—";
  const iso = t.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

export function fmtPct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
