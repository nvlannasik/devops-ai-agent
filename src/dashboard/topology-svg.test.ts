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
  const empty: Topology = { inbound: [], outbound: [], provider: "claude", backends: [], registryError: null };
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
// down, so the fix was one silent revert away from being undone. This test failed (see
// task-2-report.md's mutation check) when the label/class logic was reverted to its
// pre-fix form, confirming it actually exercises the fix rather than passing regardless.
test("the diagram states each backend's path and classes via-worker backends apart from direct ones", () => {
  const mixed: Topology = {
    ...base,
    backends: [
      { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  };
  const svg = topologyDiagram(mixed);

  // Each backend's own <rect>...<text> pair, not a substring match against the whole
  // document — a row can mix direct and via-worker backends, so label and class must be
  // checked together, per box, not just "does this string appear somewhere".
  const boxes = svg.split("<rect").slice(1).map((s) => "<rect" + s);
  const direct = boxes.find((b) => b.includes(">direct1 (heavy · direct)<"));
  const worker = boxes.find((b) => b.includes(">worker1 (light · via llm-worker)<"));

  assert.ok(direct, "the direct backend's label should state its path");
  assert.ok(worker, "the via-worker backend's label should state its path");
  assert.match(direct!, /class="topo-box topo-backend"/);
  assert.doesNotMatch(direct!, /topo-backend-worker/);
  assert.match(worker!, /class="topo-box topo-backend topo-backend-worker"/);
});
