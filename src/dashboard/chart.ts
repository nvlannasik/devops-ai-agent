import { esc } from "./html.js";

export interface Point {
  label: string;
  value: number;
}

// A hand-rolled line chart. Thirty lines still beats a charting dependency for one chart, and it
// still renders server-side with no JavaScript.
//
// The drawing is an SVG because a line is geometry — bars could be a CSS grid, a polyline cannot.
// This is NOT the old <svg viewBox="0 0 720 168"> that made the chart the least responsive thing
// on the page: that one held its TEXT inside the drawing, so the same 10px caption that read
// fine in a 900px hero rendered near 4px in a 320px one, and its fixed aspect ratio made a
// letterbox strip of the plot at every width. Here the SVG holds the line and nothing else. Every
// piece of text — the per-period value, the axis labels, the caption — is ordinary HTML at the
// page's own sizes, laid over the drawing in the same grid tracks the ticks use. The viewBox is a
// unit square stretched with preserveAspectRatio="none", so the plot's height is a CSS clamp
// rather than a ratio frozen at authoring time, and the stroke stays 2px through that stretch
// because of vector-effect (see styles.ts) instead of turning into a wedge.
//
// So the only geometry computed here is the position of each point, in percent, which is what
// makes it resolution-independent. The dots and the labels are HTML reading the same percentage
// out of --h, which is why they land exactly on the line: one number, two renderers.

// Below this width the period labels cannot all fit, so the markup pre-marks the ones CSS may
// drop. Counted from the END so the newest period is never the one that disappears — it is the
// week in progress, and it is the column a reader looks at first.
const THIN_EVERY = 2;

// Two decimals in the path data. The plot is at most ~900px wide, so a hundredth of a percent is
// a tenth of a pixel — past this the digits are markup weight buying sub-pixel precision.
const round2 = (n: number) => Math.round(n * 100) / 100;

export function lineChart(points: Point[], opts: { label?: string } = {}): string {
  const chartLabel = opts.label ?? "chart";
  const caption = `${esc(chartLabel)} · the last point is the period in progress`;

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
  const values = points.map((p) => {
    const n = Number(p.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  // max || 1 keeps an all-zero series (and therefore a fresh install) from dividing by zero
  const max = Math.max(...values) || 1;
  const last = points.length - 1;

  // ONE number per point, rounded once, and both renderers read it: --h drives the HTML dot and
  // its value label, 100 - h is the SVG's y. Rounding separately for each is how a dot ends up
  // sitting a hair off its own line.
  const h = values.map((v) => Math.round((v / max) * 1000) / 10);
  // The x of a point is the CENTRE of its column, so the line's vertices sit under the axis
  // labels — which is why the plot grid has no gap: with one, a track centre is a percentage the
  // markup cannot know (the gap is a clamp in px) and the dots would drift off the line.
  const x = points.map((_, i) => round2(((i + 0.5) / points.length) * 100));

  const cols = points
    .map((p, i) => {
      // The final point is the period in progress. Marking it is information, not decoration:
      // unmarked, a partial week reads as a collapse in incident volume.
      const current = i === last ? ` data-current` : "";
      return (
        `<div class="chart-col" style="--h:${h[i]}%" title="${esc(p.label)}: ${esc(p.value)}"${current}>` +
        `<span class="chart-value">${esc(p.value)}</span>` +
        `<i class="chart-dot"></i>` +
        `</div>`
      );
    })
    .join("");

  // A single point is a dot, not a line: a one-vertex polyline draws nothing and a one-vertex
  // area is a sliver of noise, so neither is emitted. The column above still renders it.
  const line =
    points.length < 2
      ? ""
      : (() => {
          const verts = points.map((_, i) => `${x[i]},${round2(100 - h[i]!)}`).join(" ");
          // The area is the same vertices closed down to the baseline. It is a fill, so the
          // non-uniform stretch costs it nothing.
          const area = `${x[0]},100 ${verts} ${x[last]},100`;
          return (
            `<svg class="chart-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
            `<polygon class="chart-area" points="${area}"/>` +
            `<polyline class="chart-stroke" points="${verts}"/>` +
            `</svg>`
          );
        })();

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
    `<div class="chart-plot" role="img" aria-label="${esc(`${chartLabel}: ${readOut}`)}">${line}${cols}</div>` +
    `<div class="chart-axis" aria-hidden="true">${ticks}</div>` +
    `<figcaption class="chart-caption">${caption}</figcaption>` +
    `</figure>`
  );
}

// ---------- donut ----------

export interface Slice {
  label: string;
  value: number;
  /** The page's severity vocabulary — "critical" | "warning" | "info" | "ok" — or "" for none. */
  tone: string;
}

// The circumference trick, and the reason this needs no arc maths at all: a circle of radius
// 100/(2π) has a circumference of exactly 100 units, so `stroke-dasharray: <share> <rest>`
// draws an arc of <share> PERCENT and `stroke-dashoffset` rotates it into place. No sin, no
// cos, no path commands — one <circle> per slice, each a share and a rotation.
//
// 15.9155 is 100/(2π) to four places; at the sizes this renders (a ~180px ring) the error is
// under a hundredth of a pixel.
const R = 15.9155;
// The viewBox is square and the ring is centred in it. 42 leaves room for the stroke width
// without the arcs being clipped at the edges of the box.
const BOX = 42;

/**
 * A ring of severity shares, drawn server-side with no script.
 *
 * The ring is NOT the reading — the legend beside it is. Severity is the one thing on this
 * dashboard that must never rest on colour alone (WCAG 1.4.1), so every slice prints its name
 * and its count as text; the arc is what makes the proportion visible at a glance, and it
 * carries the same `data-tone` the table rows and the badges use, so the whole page draws
 * "critical" in one colour.
 *
 * Rotated -90deg in CSS so the first arc starts at twelve o'clock rather than at three.
 */
export function donutChart(slices: Slice[], opts: { label?: string } = {}): string {
  const chartLabel = opts.label ?? "breakdown";

  // Re-derived with Number() for the same reason lineChart does it: these counts come out of
  // Postgres, and a non-numeric one must land on 0 rather than on a NaN inside an attribute.
  const values = slices.map((s) => {
    const n = Number(s.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = values.reduce((a, b) => a + b, 0);

  if (slices.length === 0 || total === 0) {
    // The normal state of a fresh deployment, and of any window nothing fired in.
    return (
      `<figure class="donut">` +
      `<p class="donut-blank">no data yet</p>` +
      `</figure>`
    );
  }

  // Shares are rounded to one decimal, and the running offset is accumulated from the ROUNDED
  // values — not from the exact ones. Accumulating the exact share and rounding each offset
  // separately leaves a sub-pixel gap or overlap at every boundary; carrying the rounding
  // forward means each arc starts exactly where the drawn edge of the previous one is.
  let cursor = 0;
  const arcs = slices
    .map((s, i) => {
      const share = Math.round((values[i]! / total) * 1000) / 10;
      const offset = cursor;
      cursor = Math.round((cursor + share) * 10) / 10;
      const tone = s.tone ? ` data-tone="${esc(s.tone)}"` : "";
      return (
        `<circle class="donut-arc"${tone} cx="${BOX / 2}" cy="${BOX / 2}" r="${R}"` +
        // The dash pattern is the arc and the gap that closes the ring; the offset is negative
        // because dashoffset runs against the direction the arc is drawn in.
        ` stroke-dasharray="${share} ${Math.round((100 - share) * 10) / 10}"` +
        ` stroke-dashoffset="${offset === 0 ? 0 : -offset}"/>`
      );
    })
    .join("");

  const legend = slices
    .map(
      (s, i) =>
        `<li${s.tone ? ` data-tone="${esc(s.tone)}"` : ""}>` +
        `<span class="donut-swatch" aria-hidden="true"></span>` +
        `<span class="donut-name">${esc(s.label)}</span>` +
        `<span class="donut-n">${esc(values[i])}</span></li>`
    )
    .join("");

  // One accessible name for the whole figure, the same way lineChart states its series — a ring
  // of <circle>s is unreadable one element at a time.
  const readOut = slices.map((s, i) => `${s.label} ${values[i]}`).join(", ");

  return (
    `<figure class="donut">` +
    `<div class="donut-ring" role="img" aria-label="${esc(`${chartLabel}: ${readOut}`)}">` +
    `<svg viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true" focusable="false">` +
    // The track behind the arcs, so a ring that does not close (it always does) or a single
    // tiny slice still reads as a ring rather than as a stray mark.
    `<circle class="donut-track" cx="${BOX / 2}" cy="${BOX / 2}" r="${R}"/>${arcs}</svg>` +
    `<p class="donut-total"><b>${esc(total)}</b><span>total</span></p>` +
    `</div>` +
    `<ul class="donut-legend">${legend}</ul>` +
    `</figure>`
  );
}
