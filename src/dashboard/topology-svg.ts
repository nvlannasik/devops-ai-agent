import { esc } from "./html.js";
import type { Topology } from "./topology.js";

// Hand-laid, not a layout engine. The node count is bounded and known — two inbound, five
// outbound, up to twenty backends — so a graph-layout dependency would solve a problem this
// page does not have. Rows are stacked; the agent sits between inbound and outbound.
const W = 760;
const BOX_H = 34;
const GAP = 12;
const PAD = 16;

function box(x: number, y: number, w: number, label: string, cls: string): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${BOX_H}" rx="6" class="topo-box ${cls}"/>` +
    `<text x="${x + w / 2}" y="${y + BOX_H / 2 + 4}" class="topo-label" text-anchor="middle">${esc(label)}</text>`
  );
}

function row(labels: string[], y: number, cls: string): string {
  if (labels.length === 0) return "";
  const w = Math.max(80, Math.floor((W - 2 * PAD - GAP * (labels.length - 1)) / labels.length));
  return labels
    .map((l, i) => box(PAD + i * (w + GAP), y, w, l, cls))
    .join("");
}

export function topologyDiagram(t: Topology): string {
  const rows: { labels: string[]; cls: string }[] = [
    { labels: t.inbound.map((n) => n.label), cls: "topo-in" },
    { labels: ["devops-ai-agent"], cls: "topo-self" },
    { labels: t.outbound.map((n) => n.label), cls: "topo-out" },
  ];
  if (t.backends.length > 0) {
    // chunk backends so twenty of them stack instead of shrinking to slivers
    for (let i = 0; i < t.backends.length; i += 5) {
      rows.push({
        labels: t.backends.slice(i, i + 5).map((b) => `${b.name} (${b.route})`),
        cls: "topo-backend",
      });
    }
  }

  const stride = BOX_H + 28;
  const height = PAD * 2 + rows.length * stride;
  const body = rows
    .map((r, i) => {
      const y = PAD + i * stride;
      const arrow =
        i === 0
          ? ""
          : `<line x1="${W / 2}" y1="${y - 24}" x2="${W / 2}" y2="${y - 4}" class="topo-edge"/>`;
      return arrow + row(r.labels, y, r.cls);
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="agent dependency map">${body}</svg>`;
}
