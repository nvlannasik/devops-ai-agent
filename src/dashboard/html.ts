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

// How long ago, in the largest unit that still says something. This is the reading an on-call
// actually needs — "how long has this been firing" is the first question of a page, and an
// absolute UTC stamp answers it only after subtraction done in the reader's head.
//
// Nothing is given up for it: timeTag() below keeps the exact instant in datetime= (machine
// readable) and in title= (one hover away), so the precise value never leaves the page. This
// is the LABEL, not the data.
//
// It stops at 30 days, where a count of days stops being readable — "47d ago" is arithmetic
// again, and the date itself is both shorter and exact. The ladder deliberately has no weeks:
// a week is a unit people convert from days anyway, and the boundary between "13d" and "2w"
// is where a reader has to start trusting the rounding.
//
// `now` is a parameter with a default rather than a bare Date.now() so the tests can pin an
// instant; every caller in the page render passes the one timestamp taken at the top of the
// response, which is also what keeps a list of thirty rows internally consistent.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AGO_CEILING = 30 * DAY;

export function fmtAgo(d: Date | string | null | undefined, now: Date = new Date()): string {
  if (!d) return "—";
  const t = d instanceof Date ? d : new Date(d);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return "—";
  // Clamped at zero rather than signed. The dashboard's clock and Postgres's are two clocks,
  // and a few seconds of skew would otherwise print "-0m ago" on the newest row on the page —
  // which is the row a reader looks at first.
  const delta = Math.max(0, now.getTime() - ms);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < AGO_CEILING) return `${Math.floor(delta / DAY)}d ago`;
  return t.toISOString().slice(0, 10);
}

/**
 * The relative reading as the visible text, the absolute instant as the element's data.
 *
 * `datetime` is the ISO string, which is what makes the value machine-readable at all — the
 * page had no <time> element anywhere before this, so every timestamp on it was prose to a
 * parser. `title` carries the same instant in the page's own UTC format, so the exact value
 * is one hover away and the on-call who needs to paste it into a Loki query still can.
 */
export function timeTag(d: Date | string | null | undefined, now: Date = new Date()): string {
  if (!d) return "—";
  const t = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(t.getTime())) return "—";
  return (
    `<time datetime="${esc(t.toISOString())}" title="${esc(fmtDate(t))}">` +
    `${esc(fmtAgo(t, now))}</time>`
  );
}

/**
 * A duration, read in at most two units.
 *
 * Two, not three: the third is always below the precision anything on this page is measured to,
 * and "2h 14m 9s" is materially harder to compare against the tile beside it than "2h 14m" is.
 * A zero second unit is dropped rather than printed — "2h" is exactly two hours, and "2h 0m"
 * says the same thing while implying the minutes were measured and found to be none.
 *
 * null is not zero. avg() over nothing is NULL, which means "nothing resolved in this window";
 * a zero-millisecond mean time to resolve would mean every incident closed instantly. The two
 * render differently on purpose.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
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

/**
 * `cls` is for a table that needs a rule of its own. Exactly one does — the MCP tools table,
 * which is the only table on this dashboard with a disclosure inside a cell and therefore the
 * only one whose column widths would otherwise move after render. See `table.caps` in styles.ts.
 */
export const table = (head: string, body: string, narrow?: Narrow, cls?: string): string => {
  const [t, rg, r] = narrow
    ? [` role="table"${NARROW_ATTR[narrow]}`, ` role="rowgroup"`, ` role="row"`]
    : ["", "", ""];
  const c = cls ? ` class="${esc(cls)}"` : "";
  return (
    `<div class="table-wrap"><table${t}${c}>` +
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
