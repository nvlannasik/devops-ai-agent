import { esc } from "./html.js";
import { rowId } from "./topology.js";
import type { BackendNode, Node, Topology } from "./topology.js";

// A map, not a stack. The layout states three things the config text alone does not: inbound
// callers fan IN to one agent, the agent fans OUT to its dependencies, and each LLM backend
// hangs off whichever of those two actually reaches it — the direct ones off the agent, the
// private-llm ones off the llm-worker node. That last edge is design §4.2 drawn rather than
// written: you can SEE which backends bypass the worker, which is the single most common
// wrong assumption about this system.
//
// Hand-laid, not a layout engine. The node count is bounded and known — two inbound, five
// outbound, up to twenty backends — so a graph-layout dependency would solve a problem this
// page does not have. Every number below is a constant; nothing here iterates to convergence.
const W = 848;
const PAD = 24;
const BAND_H = 26;
const NODE_W = 208;
const NODE_H = 56;
const V_GAP = 16;
const COL_GAP = 88;
const COL_X = [PAD, PAD + NODE_W + COL_GAP, PAD + 2 * (NODE_W + COL_GAP)];

const SHELF_GAP = 72;
const CLUSTER_GAP = 24;
const CLUSTER_PAD = 14;
const CLUSTER_LABEL_H = 26;
const CHIP_H = 48;
const CHIP_GAP = 12;
// Per-cluster, not global: a backend chip carries a model id ("heavy · claude-sonnet-5") and
// needs the room, a capability chip carries one word and a count ("prometheus / 33 tools").
// Holding them to the same minimum would put capabilities one-per-row in a very empty box.
const CHIP_MIN_W = 150;
const CAP_MIN_W = 96;

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

const midX = (p: Placed): number => Math.round(p.x + p.w / 2);
const midY = (p: Placed): number => Math.round(p.y + p.h / 2);

// SVG has no text metrics and no ellipsis, so a long endpoint would run straight out of its
// card. The full value is always one hover (<title>) or one glance at the table below away —
// design §4.3: the diagram is the glance, the table is the record.
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// `href` turns a box into a link to its own row in the tables below — the map is the glance,
// the row is the record, and this is the trip between them. Wrapped rather than made
// clickable some other way because an <a> is the only thing that works with no script at all
// (the dashboard's CSP is `default-src 'none'`), and it arrives keyboard-focusable for free.
function card(p: Placed, title: string, sub: string, cls: string, href?: string): string {
  const inner = p.w - 28;
  const full = sub ? `${title} — ${sub}` : title;
  const body =
    // The rect and its own label must stay adjacent siblings: styles.ts selects the agent's
    // label with `.topo-self + .topo-label`, and the `~` form would reach every later label
    // in the document (there is no per-node <g> to scope it). Wrapping both in the same <a>
    // keeps them siblings, so those rules are unaffected.
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10" class="topo-box ${cls}">` +
    `<title>${esc(full)}</title></rect>` +
    `<text x="${p.x + 14}" y="${p.y + (sub ? 24 : Math.round(p.h / 2) + 4)}" class="topo-label">` +
    `${esc(clip(title, Math.floor(inner / 6)))}</text>` +
    (sub
      ? `<text x="${p.x + 14}" y="${p.y + 41}" class="topo-sub">${esc(clip(sub, Math.floor(inner / 5.7)))}</text>`
      : "");
  // aria-label on the <a>, not on the shapes: the visible text is clipped to fit the box, so
  // the accessible name is the only place the untruncated value survives.
  return href ? `<a href="${esc(href)}" class="topo-link" aria-label="${esc(full)}">${body}</a>` : body;
}

const band = (x: number, y: number, label: string): string =>
  `<text x="${x}" y="${y}" class="topo-band">${esc(label)}</text>`;

// Left-to-right between columns: leaves each card at its right edge, arrives at the next
// card's left edge, so the arrowhead lands on the thing being called.
function edgeAcross(from: Placed, to: Placed): string {
  const x1 = from.x + from.w;
  const y1 = midY(from);
  const x2 = to.x;
  const y2 = midY(to);
  const dx = Math.round((x2 - x1) / 2);
  return (
    `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" ` +
    `class="topo-edge" marker-end="url(#topo-arrow)"/>`
  );
}

// Downward, into the backend shelf. Leaves by the bottom, unless another card in the same
// column sits underneath — then it leaves by the left edge and drops through the empty corridor
// between the columns instead. A bottom exit from llm-worker would pass straight behind the
// card below it, and an edge that emerges from under a node reads as if it started there,
// which is the exact claim this diagram exists to get right.
function edgeDown(from: Placed, toX: number, toY: number, sideExit: boolean): string {
  const x1 = sideExit ? from.x : midX(from);
  const y1 = sideExit ? midY(from) : from.y + from.h;
  const dy = Math.max(12, Math.round((toY - y1) / 2));
  const c1x = sideExit ? x1 - Math.round(COL_GAP / 2) : x1;
  return (
    `<path d="M ${x1} ${y1} C ${c1x} ${y1 + (sideExit ? 0 : dy)}, ${toX} ${toY - dy}, ${toX} ${toY}" ` +
    `class="topo-edge" marker-end="url(#topo-arrow)"/>`
  );
}

// What a cluster holds. Backends and MCP tool families are different facts about the system,
// but on the shelf they are the same shape — a name, a caption, and a box — so they share one
// type and one layout pass rather than two that drift apart.
interface Chip {
  title: string;
  sub: string;
  cls: string;
  href: string;
}

interface Group {
  label: string;
  chips: Chip[];
  from: Placed;
  sideExit: boolean;
  minW: number;
}

interface Cluster extends Group {
  x: number;
  w: number;
  perRow: number;
  chipW: number;
  h: number;
}

export function topologyDiagram(t: Topology): string {
  const colH = (n: number): number => (n === 0 ? 0 : n * NODE_H + (n - 1) * V_GAP);
  const mapH = Math.max(colH(t.inbound.length), NODE_H, colH(t.outbound.length));
  const mapTop = PAD + BAND_H;
  const place = (col: number, count: number, i: number): Placed => ({
    x: COL_X[col],
    y: Math.round(mapTop + (mapH - colH(count)) / 2 + i * (NODE_H + V_GAP)),
    w: NODE_W,
    h: NODE_H,
  });

  const inPlaced = t.inbound.map((_, i) => place(0, t.inbound.length, i));
  const outPlaced = t.outbound.map((_, i) => place(2, t.outbound.length, i));
  const agent: Placed = { x: COL_X[1], y: Math.round(mapTop + (mapH - NODE_H) / 2), w: NODE_W, h: NODE_H };

  // The whole reason Node carries an id: this edge must start at llm-worker specifically.
  // Falling back to the agent keeps a half-built Topology renderable (design §6) rather than
  // dropping the cluster's only incoming edge on the floor.
  const workerIdx = t.outbound.findIndex((n: Node) => n.id === "llm-worker");
  const workerAnchor = workerIdx >= 0 ? outPlaced[workerIdx] : agent;

  // Same reasoning as llm-worker above, one shelf over: the tool families belong to the MCP
  // server, not to the agent, so the edge has to start there or the diagram claims the agent
  // exposes them itself.
  const mcpIdx = t.outbound.findIndex((n: Node) => n.id === "devops-mcp-server");
  const mcpAnchor = mcpIdx >= 0 ? outPlaced[mcpIdx] : agent;

  // Mapped over the whole list BEFORE the split, so each chip keeps the index of its own row
  // in the backends table. Filtering first and mapping after would number the two groups
  // 0,1,2… independently and send half the links to the wrong row.
  const backendChips = t.backends.map((b: BackendNode, i: number) => ({
    title: b.name,
    sub: `${b.route} · ${b.model}`,
    cls: b.viaWorker ? "topo-backend topo-backend-worker" : "topo-backend",
    href: `#${rowId("backend", i)}`,
    viaWorker: b.viaWorker,
  }));

  const shelfW = W - 2 * PAD;
  const pending: Group[] = [
    // Nothing is ever drawn below the agent, so its edge always has a clear run downward.
    {
      label: "CALLED DIRECTLY BY THE AGENT",
      chips: backendChips.filter((c) => !c.viaWorker),
      from: agent,
      sideExit: false,
      minW: CHIP_MIN_W,
    },
    {
      label: "REACHED OVER SQS VIA LLM-WORKER",
      chips: backendChips.filter((c) => c.viaWorker),
      from: workerAnchor,
      sideExit: workerIdx >= 0 && workerIdx < t.outbound.length - 1,
      minW: CHIP_MIN_W,
    },
    // Last, so it sits under the right-hand column its anchor lives in — the edge drops
    // more or less straight down rather than crossing the two backend clusters.
    {
      label: "EXPOSED BY DEVOPS-MCP-SERVER",
      chips: t.capabilities.map((c, i) => ({
        title: c.name,
        sub: `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}`,
        cls: "topo-capability",
        href: `#${rowId("cap", i)}`,
      })),
      from: mcpAnchor,
      sideExit: mcpIdx >= 0 && mcpIdx < t.outbound.length - 1,
      minW: CAP_MIN_W,
    },
  ].filter((g) => g.chips.length > 0);

  // Equal widths, however many survived the filter. A provider with no router has no backend
  // clusters at all and an agent that has not connected to MCP yet has no capability cluster,
  // so this row is 0..3 wide and the arithmetic has to hold for each.
  const n = pending.length;
  const clusterW = n ? Math.floor((shelfW - (n - 1) * CLUSTER_GAP) / n) : shelfW;
  const clusters: Cluster[] = pending.map((g, i) => {
    const inner = clusterW - 2 * CLUSTER_PAD;
    const perRow = Math.max(1, Math.floor((inner + CHIP_GAP) / (g.minW + CHIP_GAP)));
    const rows = Math.ceil(g.chips.length / perRow);
    return {
      ...g,
      x: PAD + i * (clusterW + CLUSTER_GAP),
      w: clusterW,
      perRow,
      chipW: Math.floor((inner - CHIP_GAP * (perRow - 1)) / perRow),
      h: CLUSTER_LABEL_H + CLUSTER_PAD + rows * CHIP_H + (rows - 1) * CHIP_GAP + CLUSTER_PAD,
    };
  });

  const shelfTop = mapTop + mapH + SHELF_GAP;
  const height = clusters.length
    ? shelfTop + Math.max(...clusters.map((c) => c.h)) + PAD
    : mapTop + mapH + PAD;

  const bands =
    (t.inbound.length ? band(COL_X[0], PAD + 14, "INBOUND") : "") +
    band(COL_X[1], PAD + 14, "AGENT") +
    (t.outbound.length ? band(COL_X[2], PAD + 14, "OUTBOUND") : "");

  // Containers before edges before nodes: edges then run underneath the cards they connect,
  // so an arrowhead never draws on top of a label.
  const containers = clusters
    .map(
      (c) =>
        `<rect x="${c.x}" y="${shelfTop}" width="${c.w}" height="${c.h}" rx="12" class="topo-cluster"/>` +
        band(c.x + CLUSTER_PAD, shelfTop + 18, c.label)
    )
    .join("");

  const edges =
    inPlaced.map((p) => edgeAcross(p, agent)).join("") +
    outPlaced.map((p) => edgeAcross(agent, p)).join("") +
    clusters.map((c) => edgeDown(c.from, Math.round(c.x + c.w / 2), shelfTop, c.sideExit)).join("");

  // `configured` is the only state this page can honestly report — it reads config, it never
  // probes — so it is the only thing that earns a colour here. See the topology block in
  // styles.ts for why role does not.
  const off = (n: Node, cls: string): string => (n.configured ? cls : `${cls} topo-off`);
  // The agent's own box is the only one with no link: it is the subject of the map, not an
  // entry in any of the tables, so there is nowhere for it to go.
  const nodes =
    t.inbound.map((n, i) => card(inPlaced[i], n.label, n.detail, off(n, "topo-in"), `#${rowId("in", i)}`)).join("") +
    card(agent, "devops-ai-agent", `provider ${t.provider}`, "topo-self") +
    t.outbound.map((n, i) => card(outPlaced[i], n.label, n.detail, off(n, "topo-out"), `#${rowId("out", i)}`)).join("");

  const chips = clusters
    .map((c) =>
      c.chips
        .map((chip, i) =>
          card(
            {
              x: c.x + CLUSTER_PAD + (i % c.perRow) * (c.chipW + CHIP_GAP),
              y: shelfTop + CLUSTER_LABEL_H + CLUSTER_PAD + Math.floor(i / c.perRow) * (CHIP_H + CHIP_GAP),
              w: c.chipW,
              h: CHIP_H,
            },
            chip.title,
            chip.sub,
            chip.cls,
            chip.href
          )
        )
        .join("")
    )
    .join("");

  // The label has to carry the SHAPE of the figure rather than name it. Every value in it is
  // repeated in the tables below (design §4.3), which is where a non-visual reader gets the
  // detail — the label's job is to say what was drawn and whether it is worth going and
  // reading. role="group", not the role="img" this carried before the boxes became links:
  // role="img" makes a screen reader treat the whole subtree as one opaque graphic, which
  // would leave every one of those links reachable by Tab but announced as nothing.
  const viaWorker = t.backends.filter((b) => b.viaWorker).length;
  const toolCount = t.capabilities.reduce((sum, c) => sum + c.tools.length, 0);
  const summary =
    `dependency map: ${t.inbound.length} inbound, ${t.outbound.length} outbound, ` +
    `${t.backends.length} LLM backends` +
    (t.backends.length ? ` (${viaWorker} reached over SQS via llm-worker)` : "") +
    (t.capabilities.length
      ? `, ${toolCount} MCP tools in ${t.capabilities.length} families`
      : "");

  return (
    `<svg viewBox="0 0 ${W} ${height}" class="topo" role="group" aria-label="${esc(summary)}">` +
    `<defs>` +
    `<pattern id="topo-grid" width="22" height="22" patternUnits="userSpaceOnUse">` +
    `<circle cx="1" cy="1" r="1" class="topo-dot"/></pattern>` +
    `<marker id="topo-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" ` +
    `markerWidth="9" markerHeight="9" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" class="topo-arrow"/></marker>` +
    `</defs>` +
    `<rect x="0" y="0" width="${W}" height="${height}" fill="url(#topo-grid)"/>` +
    bands + containers + edges + nodes + chips +
    `</svg>`
  );
}
