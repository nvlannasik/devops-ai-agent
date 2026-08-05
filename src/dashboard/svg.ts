import { esc } from "./html.js";

export interface Point {
  label: string;
  value: number;
}

// A hand-rolled bar chart. Sixty lines beats a charting dependency for one chart, and it
// renders server-side so the page needs no JavaScript at all.
//
// Exactly one <rect> per point — the baseline and the half-scale rule are <line>s. svg.test.ts
// counts rects to prove no point is silently dropped, so a decorative rect would break that
// count for a reason that has nothing to do with the data.
export function barChart(points: Point[], opts: { width?: number; height?: number; label?: string } = {}): string {
  const w = opts.width ?? 720;
  const h = opts.height ?? 168;
  const chartLabel = opts.label ?? "chart";
  // top gutter holds the value labels, bottom gutter the period labels
  const pad = { top: 22, right: 4, bottom: 20, left: 4 };
  const plotH = h - pad.top - pad.bottom;
  const plotW = w - pad.left - pad.right;
  const baseY = pad.top + plotH;

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="no data">` +
      `<line x1="${pad.left}" y1="${baseY}" x2="${w - pad.right}" y2="${baseY}" class="chart-rule"/>` +
      `<text x="${w / 2}" y="${pad.top + plotH / 2}" class="chart-empty" text-anchor="middle">no data yet</text></svg>`;
  }

  // max || 1 keeps an all-zero series (and therefore a fresh install) from dividing by zero
  const max = Math.max(...points.map((p) => p.value)) || 1;
  const slot = plotW / points.length;
  const barW = Math.max(2, slot * 0.56);
  const scale = (v: number): number => Math.round((v / max) * plotH);

  const bars = points
    .map((p, i) => {
      const raw = scale(p.value);
      // a non-zero week that rounds to nothing still gets a visible stub; a genuinely empty
      // week stays empty, because a bar where there were no incidents would be a lie
      const barH = p.value > 0 ? Math.max(2, raw) : 0;
      const x = Math.round(pad.left + i * slot + (slot - barW) / 2);
      const bw = Math.round(barW);
      const y = baseY - barH;
      // The final bar is the period in progress. Marking it is information, not decoration:
      // unmarked, a partial week reads as a collapse in incident volume.
      const cls = i === points.length - 1 ? "chart-bar chart-bar-current" : "chart-bar";
      return (
        `<rect x="${x}" y="${y}" width="${bw}" height="${barH}" rx="3" class="${cls}">` +
        `<title>${esc(p.label)}: ${esc(p.value)}</title></rect>` +
        `<text x="${Math.round(x + bw / 2)}" y="${y - 6}" class="chart-value" text-anchor="middle">${esc(p.value)}</text>` +
        `<text x="${Math.round(x + bw / 2)}" y="${h - 6}" class="chart-label" text-anchor="middle">${esc(p.label)}</text>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(chartLabel)}">` +
    `<line x1="${pad.left}" y1="${Math.round(baseY - plotH / 2)}" x2="${w - pad.right}" ` +
    `y2="${Math.round(baseY - plotH / 2)}" class="chart-rule-soft"/>` +
    `<line x1="${pad.left}" y1="${baseY}" x2="${w - pad.right}" y2="${baseY}" class="chart-rule"/>` +
    bars +
    `</svg>`
  );
}
