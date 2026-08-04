import { esc } from "./html.js";

export interface Point {
  label: string;
  value: number;
}

// A hand-rolled bar chart. Forty lines beats a charting dependency for one chart, and it
// renders server-side so the page needs no JavaScript at all.
export function barChart(points: Point[], opts: { width?: number; height?: number; label?: string } = {}): string {
  const w = opts.width ?? 720;
  const h = opts.height ?? 180;
  const chartLabel = opts.label ?? "chart";
  const pad = { top: 8, right: 8, bottom: 22, left: 8 };
  const plotH = h - pad.top - pad.bottom;
  const plotW = w - pad.left - pad.right;

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="no data">` +
      `<text x="${w / 2}" y="${h / 2}" class="chart-empty" text-anchor="middle">no data yet</text></svg>`;
  }

  // max || 1 keeps an all-zero series (and therefore a fresh install) from dividing by zero
  const max = Math.max(...points.map((p) => p.value)) || 1;
  const slot = plotW / points.length;
  const barW = Math.max(2, slot * 0.62);

  const bars = points
    .map((p, i) => {
      const barH = Math.round((p.value / max) * plotH);
      const x = Math.round(pad.left + i * slot + (slot - barW) / 2);
      const y = pad.top + plotH - barH;
      return (
        `<rect x="${x}" y="${y}" width="${Math.round(barW)}" height="${barH}" rx="2" class="chart-bar">` +
        `<title>${esc(p.label)}: ${esc(p.value)}</title></rect>` +
        `<text x="${Math.round(x + barW / 2)}" y="${h - 6}" class="chart-label" text-anchor="middle">${esc(p.label)}</text>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(chartLabel)}">${bars}</svg>`;
}
