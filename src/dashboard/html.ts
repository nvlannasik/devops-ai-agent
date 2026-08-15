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

// Lives here rather than in views.ts because rca.ts renders tables too, and views.ts already
// imports rca.ts — a shared helper in either of those makes an import cycle. The wrapper is
// what gives a wide table its own horizontal scroll instead of widening the page.
//
// `narrow` says what this table should become when there is no room for columns — the wrapper's
// sideways scroll is a last resort, not an answer, because what falls off the right edge is
// whichever columns the author put last and there is no affordance pointing at them.
//
//   "cards" — the incident list, and only it. Each row becomes a card whose cells are placed BY
//             NAME, so a table with different columns would come apart under the same rules.
//   "stack" — a record whose values are SENTENCES. Each cell becomes a caption above its value,
//             captioned from its own `data-label`, so the layout knows nothing about which
//             columns it is laying out.
//   "pairs" — a record whose values are all SHORT: an id, an enum, a count, a timestamp. Same
//             stack, caption beside the value instead of above it. What decides between the two
//             is what the cells hold, not how many there are — a caption line of its own doubles
//             the height of a six-field accounting row to say nothing, while beside a sentence
//             the widest label would set a column and the sentence be read through the remainder.
//
// Every one of them costs the table its semantics: a browser derives the table role from the
// computed display, so `display: grid` on a <tr> leaves a screen reader with anonymous groups.
// Hence `role="table"` and its family — the ROLES are what survive the display change, and they
// only work if every level declares one, which is why the caller has to mark up its own cells
// (`role="cell"` / `role="columnheader"`) to be allowed to ask for any of them.
type Narrow = "cards" | "stack" | "pairs";

// `pairs` IS a stack — it takes every rule that block sets and overrides two — so it declares
// both attributes rather than having the stylesheet repeat itself down a selector list.
const NARROW_ATTR: Record<Narrow, string> = {
  cards: " data-cards",
  stack: " data-stack",
  pairs: " data-stack data-pairs",
};

export const table = (head: string, body: string, narrow?: Narrow): string => {
  const [t, rg, r] = narrow
    ? [` role="table"${NARROW_ATTR[narrow]}`, ` role="rowgroup"`, ` role="row"`]
    : ["", "", ""];
  return (
    `<div class="table-wrap"><table${t}>` +
    `<thead${rg}><tr${r}>${head}</tr></thead>` +
    `<tbody${rg}>${body}</tbody></table></div>`
  );
};

export const headers = (...labels: string[]): string =>
  labels.map((h) => `<th role="columnheader">${esc(h)}</th>`).join("");

// A stacked cell is captioned from its own data-label, so the caption travels with the cell
// instead of being counted out positionally from the header row — insert a column and the
// captions still name the right values. The label is escaped like every other attribute value
// here; it is a literal at every call site today, and nothing about that is enforced.
export const cell = (label: string, content: string, cls = ""): string =>
  `<td role="cell"${cls ? ` class="${cls}"` : ""} data-label="${esc(label)}">${content}</td>`;
