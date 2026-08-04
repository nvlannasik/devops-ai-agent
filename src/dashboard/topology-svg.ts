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

// A row's boxes can now carry different classes from one another (a backend row mixes
// direct and via-worker backends), so each item names its own class rather than the row
// naming one class for all of them.
interface RowItem {
  label: string;
  cls: string;
}

function row(items: RowItem[], y: number): string {
  if (items.length === 0) return "";
  const w = Math.max(80, Math.floor((W - 2 * PAD - GAP * (items.length - 1)) / items.length));
  return items
    .map((it, i) => box(PAD + i * (w + GAP), y, w, it.label, it.cls))
    .join("");
}

export function topologyDiagram(t: Topology): string {
  const rows: RowItem[][] = [
    t.inbound.map((n) => ({ label: n.label, cls: "topo-in" })),
    [{ label: "devops-ai-agent", cls: "topo-self" }],
    t.outbound.map((n) => ({ label: n.label, cls: "topo-out" })),
  ];
  if (t.backends.length > 0) {
    // chunk backends so twenty of them stack instead of shrinking to slivers
    for (let i = 0; i < t.backends.length; i += 5) {
      rows.push(
        t.backends.slice(i, i + 5).map((b) => ({
          // design §4.2: the one fact this diagram exists to make obvious — only
          // private-llm backends traverse SQS to llm-worker, everything else is called
          // directly. viaWorker was already on BackendNode for exactly this and wasn't
          // being read here; now it drives both the label text and a grouping class.
          //
          // Structurally truer would be via-worker backends hanging off the existing
          // "llm-worker (SQS)" outbound box and direct ones off the agent box, instead of
          // a flat backend row underneath both. That's the better diagram and the shape to
          // grow into — not a layout rewrite this page needs today.
          label: `${b.name} (${b.route} · ${b.viaWorker ? "via llm-worker" : "direct"})`,
          cls: b.viaWorker ? "topo-backend topo-backend-worker" : "topo-backend",
        }))
      );
    }
  }

  const stride = BOX_H + 28;
  const height = PAD * 2 + rows.length * stride;
  const body = rows
    .map((items, i) => {
      const y = PAD + i * stride;
      const arrow =
        i === 0
          ? ""
          : `<line x1="${W / 2}" y1="${y - 24}" x2="${W / 2}" y2="${y - 4}" class="topo-edge"/>`;
      return arrow + row(items, y);
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="agent dependency map">${body}</svg>`;
}
