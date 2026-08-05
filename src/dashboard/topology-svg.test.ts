import { test } from "node:test";
import assert from "node:assert/strict";
import { topologyDiagram } from "./topology-svg.js";
import type { Topology } from "./topology.js";

const base: Topology = {
  inbound: [{ label: "Slack", detail: "channel C1", meta: "bot token set", configured: true }],
  outbound: [{ label: "Postgres", detail: "pg:5432/db", meta: "ssl disable", configured: true }],
  provider: "router",
  backends: [
    { name: "sonnet", kind: "claude", model: "claude-sonnet-5", endpoint: "https://api.anthropic.com",
      route: "heavy", viaWorker: false },
  ],
  capabilities: [],
  registryError: null,
};

test("the diagram renders one box per node and never emits NaN", () => {
  const svg = topologyDiagram(base);
  assert.match(svg, /<svg[^>]+viewBox=/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("labels are escaped — a node label is not trusted markup", () => {
  const nasty: Topology = { ...base, inbound: [{ ...base.inbound[0], label: `<script>x</script>` }] };
  const svg = topologyDiagram(nasty);
  assert.doesNotMatch(svg, /<script>x<\/script>/);
  assert.match(svg, /&lt;script&gt;/);
});

// A fresh or minimally-configured agent is a normal state, not an edge case.
test("an empty topology still renders a valid diagram", () => {
  const empty: Topology = {
    inbound: [], outbound: [], provider: "claude", backends: [], capabilities: [], registryError: null,
  };
  const svg = topologyDiagram(empty);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(svg, /<svg/);
});

test("many backends do not overflow the canvas", () => {
  const many: Topology = {
    ...base,
    backends: Array.from({ length: 20 }, (_, i) => ({
      name: `b${i}`, kind: "openai-compatible" as const, model: "m",
      endpoint: "https://x", route: "heavy" as const, viaWorker: false,
    })),
  };
  const svg = topologyDiagram(many);
  assert.doesNotMatch(svg, /NaN/);
  const heights = [...svg.matchAll(/viewBox="0 0 (\d+) (\d+)"/g)].map((m) => Number(m[2]));
  assert.ok(heights[0] > 300, "the canvas should grow with the backend count");
});

// design §4.2: the one fact this diagram exists to make obvious — only private-llm
// backends traverse SQS to llm-worker. BackendNode.viaWorker was populated correctly but
// never read by the rendering layer until this fix; nothing at the render layer pinned it
// down, so the fix was one silent revert away from being undone.
//
// The map states that fact by GROUPING rather than by a parenthetical after each name, so
// this test checks the grouping the way a reader does: it reads the cluster's label, then
// checks that the chip actually sits inside that cluster's box. Asserting the label text
// alone would pass on a diagram that draws the right captions over the wrong boxes.
test("the diagram states each backend's path and classes via-worker backends apart from direct ones", () => {
  const mixed: Topology = {
    ...base,
    backends: [
      { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  };
  const svg = topologyDiagram(mixed);

  // Each <rect> and the text that belongs to it, not a substring match against the whole
  // document: a cluster can hold several backends, so a chip's label, class and position
  // have to be read together, per box, not as "does this string appear somewhere".
  const chunks = svg.split("<rect").slice(1).map((s) => "<rect" + s);
  const rect = (chunk: string): { x: number; y: number; w: number; h: number } => {
    const m = /x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/.exec(chunk);
    assert.ok(m, "every rect should carry numeric geometry");
    return { x: Number(m![1]), y: Number(m![2]), w: Number(m![3]), h: Number(m![4]) };
  };
  const encloses = (outer: string, inner: string): boolean => {
    const o = rect(outer), i = rect(inner);
    return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  };

  const directCluster = chunks.find((c) => c.includes("topo-cluster") && c.includes("CALLED DIRECTLY BY THE AGENT"));
  const workerCluster = chunks.find((c) => c.includes("topo-cluster") && c.includes("REACHED OVER SQS VIA LLM-WORKER"));
  const direct = chunks.find((c) => c.includes(">direct1<"));
  const worker = chunks.find((c) => c.includes(">worker1<"));

  assert.ok(directCluster, "the diagram should name the group the agent calls directly");
  assert.ok(workerCluster, "the diagram should name the group reached over SQS");
  assert.ok(direct, "the direct backend should be drawn");
  assert.ok(worker, "the via-worker backend should be drawn");

  assert.ok(encloses(directCluster!, direct!), "direct1 should sit inside the direct cluster");
  assert.ok(encloses(workerCluster!, worker!), "worker1 should sit inside the via-worker cluster");
  assert.ok(!encloses(workerCluster!, direct!), "direct1 must not sit inside the via-worker cluster");

  assert.match(direct!, /class="topo-box topo-backend"/);
  assert.doesNotMatch(direct!, /topo-backend-worker/);
  assert.match(worker!, /class="topo-box topo-backend topo-backend-worker"/);
});

// The map's other structural claim: the SQS cluster hangs off llm-worker, not off the agent.
// topology.ts carries an `id` for exactly this edge, and matching on the display label instead
// would fail silently — drawing a plausible arrow from the wrong node.
test("the via-worker cluster's edge starts at llm-worker, not at the agent", () => {
  const t: Topology = {
    ...base,
    // llm-worker deliberately in the middle: a card sits below it, which is what forces the
    // edge to leave sideways instead of straight down. Asserting on the START POINT rather
    // than on the path's shape keeps this test about which node the edge claims, so a future
    // change to the routing cannot quietly turn it into a test of nothing.
    outbound: [
      { label: "Postgres", detail: "pg:5432/db", meta: "ssl disable", configured: true },
      { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "region x", configured: true },
      { label: "GitOps (SQS)", detail: "gitops.fifo", meta: "timeout 300s", configured: true },
    ],
    backends: [
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  };
  const svg = topologyDiagram(t);

  const box = (re: RegExp): { x: number; y: number; w: number; h: number } => {
    const m = re.exec(svg);
    assert.ok(m, `expected a rect matching ${re}`);
    return { x: Number(m![1]), y: Number(m![2]), w: Number(m![3]), h: Number(m![4]) };
  };
  const geom = String.raw`x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"`;
  const agent = box(new RegExp(`<rect ${geom}[^>]*class="topo-box topo-self"`));
  const outs = [...svg.matchAll(new RegExp(`<rect ${geom}[^>]*class="topo-box topo-out"`, "g"))]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
  assert.equal(outs.length, 3, "all three outbound nodes should be drawn");
  const worker = outs[1]; // emitted in Topology.outbound order

  const on = (b: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
    x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

  // The shelf holds one cluster here, so exactly one edge should reach it — and it should be
  // anchored on llm-worker's own box.
  const edges = [...svg.matchAll(/<path d="M (\d+) (\d+) C ([^"]+)" class="topo-edge"/g)];
  const intoShelf = edges.filter((m) => on(worker, Number(m[1]), Number(m[2])));
  assert.equal(intoShelf.length, 1, "exactly one edge should start on the llm-worker card");
  assert.ok(
    !on(agent, Number(intoShelf[0][1]), Number(intoShelf[0][2])),
    "that edge must not also be anchored on the agent"
  );

  // ...and it must land on the cluster, not merely head off in its direction.
  const end = intoShelf[0][3].split(",").pop()!.trim().split(/\s+/).map(Number);
  const cluster = box(new RegExp(`<rect ${geom}[^/]*class="topo-cluster"`));
  assert.ok(end[0] >= cluster.x && end[0] <= cluster.x + cluster.w, "the edge should end over the cluster");
  assert.equal(end[1], cluster.y, "the edge should meet the cluster at its top edge");
});

// The same structural claim as the test above, for the other tier: the tool families belong to
// devops-mcp-server. An edge drawn from the agent would say the agent exposes them itself,
// which is the misreading this whole page exists to prevent.
test("tool families are drawn in their own cluster, anchored on the MCP card", () => {
  const t: Topology = {
    ...base,
    outbound: [
      { label: "Postgres", detail: "pg:5432/db", meta: "ssl disable", configured: true },
      { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "stdio", configured: true },
    ],
    capabilities: [
      { name: "k8s", tools: Array.from({ length: 12 }, (_, i) => ({ name: `k8s_t${i}`, write: false })) },
      { name: "prometheus", tools: [{ name: "prometheus_query", write: false }] },
    ],
  };
  const svg = topologyDiagram(t);

  const chunks = svg.split("<rect").slice(1).map((s) => "<rect" + s);
  const rect = (chunk: string): { x: number; y: number; w: number; h: number } => {
    const m = /x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/.exec(chunk);
    assert.ok(m, "every rect should carry numeric geometry");
    return { x: Number(m![1]), y: Number(m![2]), w: Number(m![3]), h: Number(m![4]) };
  };
  const encloses = (outer: string, inner: string): boolean => {
    const o = rect(outer), i = rect(inner);
    return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  };

  const capCluster = chunks.find((c) => c.includes("topo-cluster") && c.includes("EXPOSED BY DEVOPS-MCP-SERVER"));
  const backendCluster = chunks.find((c) => c.includes("topo-cluster") && c.includes("CALLED DIRECTLY BY THE AGENT"));
  const k8s = chunks.find((c) => c.includes(">k8s<"));
  assert.ok(capCluster, "the diagram should name the group the MCP server exposes");
  assert.ok(k8s, "each tool family should be drawn");
  assert.ok(encloses(capCluster!, k8s!), "k8s should sit inside the capability cluster");
  assert.ok(!encloses(backendCluster!, k8s!), "a tool family must not sit inside an LLM-backend cluster");

  // Singular/plural, because "1 tools" on a live dashboard is the kind of detail that makes a
  // reader distrust everything else on the page.
  assert.match(svg, />12 tools</);
  assert.match(svg, />1 tool</);

  // No colour: the agent knows the server ADVERTISED these, not that calling them works.
  assert.match(k8s!, /class="topo-box topo-capability"/);

  // Anchored on the MCP card, exactly as the SQS cluster is anchored on llm-worker.
  const geom = String.raw`x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"`;
  const outs = [...svg.matchAll(new RegExp(`<rect ${geom}[^>]*class="topo-box topo-out"`, "g"))]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
  const mcp = outs[1]; // emitted in Topology.outbound order
  const on = (b: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
    x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  const edges = [...svg.matchAll(/<path d="M (\d+) (\d+) C ([^"]+)" class="topo-edge"/g)];
  const fromMcp = edges.filter((m) => on(mcp, Number(m[1]), Number(m[2])));
  assert.equal(fromMcp.length, 1, "exactly one edge should start on the devops-mcp-server card");

  const end = fromMcp[0][3].split(",").pop()!.trim().split(/\s+/).map(Number);
  const cap = rect(capCluster!);
  assert.ok(end[0] >= cap.x && end[0] <= cap.x + cap.w, "the edge should end over the capability cluster");
  assert.equal(end[1], cap.y, "the edge should meet the cluster at its top edge");
});

// The shelf holds 0-3 clusters depending on config, and the arithmetic that splits it has to
// hold for each count — an earlier version hard-coded "two or one" and would have put three
// clusters on top of each other.
test("three clusters share the shelf without overlapping or leaving the canvas", () => {
  const t: Topology = {
    ...base,
    outbound: [
      { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "region x", configured: true },
      { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "stdio", configured: true },
    ],
    backends: [
      { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "sqs", route: "light", viaWorker: true },
    ],
    capabilities: [{ name: "k8s", tools: [{ name: "k8s_list_pods", write: false }] }],
  };
  const svg = topologyDiagram(t);
  assert.doesNotMatch(svg, /NaN/);

  const width = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
  const clusters = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="12" class="topo-cluster"/g)]
    .map((m) => ({ x: Number(m[1]), w: Number(m[3]) }))
    .sort((a, b) => a.x - b.x);
  assert.equal(clusters.length, 3, "one cluster per populated group");
  for (let i = 1; i < clusters.length; i++) {
    assert.ok(clusters[i].x >= clusters[i - 1].x + clusters[i - 1].w, "clusters must not overlap");
  }
  assert.ok(clusters[0].x > 0, "the shelf should keep the left margin");
  assert.ok(clusters[2].x + clusters[2].w <= width, "the shelf must not run off the canvas");
});

// The map is the glance and the table is the record; the link is the trip between them. Read
// label-first, the way the reader does — an assertion that merely counts anchors would pass on
// a diagram where every box links to the same row.
test("every box links to its own row, and the agent's own card links nowhere", () => {
  const t: Topology = {
    ...base,
    outbound: [
      { label: "Postgres", detail: "pg:5432/db", meta: "ssl disable", configured: true },
      // plain text in the details on purpose: this test reads aria-label attributes raw, and
      // esc() would turn a "->" into "-&gt;". What escaping does to them is its own test.
      { id: "llm-worker", label: "llm-worker (SQS)", detail: "req then res", meta: "region x", configured: true },
      { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "stdio", configured: true },
    ],
    backends: [
      { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "sqs", route: "light", viaWorker: true },
      // The one that matters: a direct backend AFTER a via-worker one. The chips are split into
      // two clusters to draw, and numbering each cluster's chips from zero would send this to
      // row 1 — the row belonging to worker1.
      { name: "direct2", kind: "openai-compatible", model: "m", endpoint: "https://y", route: "heavy", viaWorker: false },
    ],
    capabilities: [
      { name: "k8s", tools: [{ name: "k8s_list_pods", write: false }] },
      { name: "loki", tools: [{ name: "loki_query", write: false }] },
    ],
  };
  const svg = topologyDiagram(t);

  // aria-label carries the untruncated label, so this maps what a box SAYS to where it goes.
  const href = new Map(
    [...svg.matchAll(/<a href="#([\w-]+)" class="topo-link" aria-label="([^"]+)">/g)].map((m) => [m[2], m[1]])
  );
  assert.equal(href.get("Slack — channel C1"), "in-0");
  assert.equal(href.get("Postgres — pg:5432/db"), "out-0");
  assert.equal(href.get("llm-worker (SQS) — req then res"), "out-1");
  assert.equal(href.get("devops-mcp-server — stdio"), "out-2");
  assert.equal(href.get("direct1 — heavy · m"), "backend-0");
  assert.equal(href.get("worker1 — light · m"), "backend-1");
  assert.equal(href.get("direct2 — heavy · m"), "backend-2");
  assert.equal(href.get("k8s — 1 tool"), "cap-0");
  assert.equal(href.get("loki — 1 tool"), "cap-1");

  // The agent has no row of its own — every other card is a link to one, and a link to nothing
  // is worse than no link.
  assert.equal(href.get("devops-ai-agent — provider router"), undefined);
  assert.doesNotMatch(svg, /<a[^>]*>\s*<rect[^>]*class="topo-box topo-self"/);
});

// role="img" hides the subtree from assistive technology, which would leave every link above
// Tab-reachable and announced as nothing at all.
test("the figure is a group, not an image, now that it contains links", () => {
  const svg = topologyDiagram(base);
  assert.match(svg, /<svg[^>]+role="group"/);
  assert.doesNotMatch(svg, /role="img"/);
  assert.match(svg, /<svg[^>]+aria-label="[^"]+"/);
});
