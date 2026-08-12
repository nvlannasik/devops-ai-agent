import { esc } from "./html.js";

export interface Point {
  label: string;
  value: number;
}

// A hand-rolled bar chart, drawn as a CSS grid rather than an SVG. Sixty lines still beats a
// charting dependency for one chart, and it still renders server-side with no JavaScript.
//
// It used to be an <svg viewBox="0 0 720 168">, and that is exactly what made it the least
// responsive thing on the page: an SVG scales its TEXT with its drawing, so the same 10px
// caption that reads fine in a 900px hero renders near 4px in a 320px one. The chart was a
// fixed 4.3:1 letterbox at every width — a flat strip on a desktop, an illegible sliver on a
// phone, with twelve period labels collapsing into one run of digits. A viewBox cannot be
// changed from a media query; a CSS grid can be changed from anything.
//
// So: the bar HEIGHTS are the only thing this function computes (as percentages, which is what
// makes them resolution-independent), and every proportion the reader actually sees — the plot
// height, the bar gap, which labels survive a narrow column — is a CSS decision in styles.ts,
// taken against the chart's own width via a container query. Text is text again, at the size
// the rest of the page uses.

// Below this width the period labels cannot all fit, so the markup pre-marks the ones CSS may
// drop. Counted from the END so the newest period is never the one that disappears — it is the
// week in progress, and it is the column a reader looks at first.
const THIN_EVERY = 2;

export function barChart(points: Point[], opts: { label?: string } = {}): string {
  const chartLabel = opts.label ?? "chart";
  const caption = `${esc(chartLabel)} · the last column is the period in progress`;

  if (points.length === 0) {
    // An empty series is the normal state of a fresh deployment, not an edge case.
    return (
      `<figure class="chart">` +
      `<p class="chart-plot chart-blank">no data yet</p>` +
      `<figcaption class="chart-caption">${caption}</figcaption>` +
      `</figure>`
    );
  }

  // Postgres hands an int8 back as a string, and a hostile label reaches this function with the
  // same trust level as anything else out of the database — so the number that drives layout is
  // re-derived with Number() (non-numeric lands on 0, never on a NaN in a style attribute) while
  // the number the reader sees goes through esc() like every other rendered value.
  const heights = points.map((p) => {
    const n = Number(p.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  // max || 1 keeps an all-zero series (and therefore a fresh install) from dividing by zero
  const max = Math.max(...heights) || 1;
  const last = points.length - 1;

  const cols = points
    .map((p, i) => {
      // A non-zero period that rounds to nothing still gets a visible stub (min-height in CSS);
      // a genuinely empty one stays empty, because a bar where there were no incidents is a lie.
      const pct = Math.round((heights[i]! / max) * 1000) / 10;
      const zero = heights[i] === 0 ? ` data-zero` : "";
      // The final bar is the period in progress. Marking it is information, not decoration:
      // unmarked, a partial week reads as a collapse in incident volume.
      const current = i === last ? ` data-current` : "";
      return (
        `<div class="chart-col" title="${esc(p.label)}: ${esc(p.value)}">` +
        `<div class="chart-bar" style="--h:${pct}%"${zero}${current}>` +
        `<span class="chart-value">${esc(p.value)}</span>` +
        `</div></div>`
      );
    })
    .join("");

  const ticks = points
    .map((p, i) => {
      const thin = (last - i) % THIN_EVERY === 0 ? "" : ` data-thin`;
      return `<span class="chart-tick"${thin}>${esc(p.label)}</span>`;
    })
    .join("");

  // One label carrying the whole series. A screen reader gets the shape as numbers here rather
  // than twelve unreadable <div>s, and the per-column title= stays for a pointer.
  const readOut = points.map((p) => `${p.label} ${p.value}`).join(", ");

  return (
    `<figure class="chart" style="--n:${points.length}">` +
    `<div class="chart-plot" role="img" aria-label="${esc(`${chartLabel}: ${readOut}`)}">${cols}</div>` +
    `<div class="chart-axis" aria-hidden="true">${ticks}</div>` +
    `<figcaption class="chart-caption">${caption}</figcaption>` +
    `</figure>`
  );
}
