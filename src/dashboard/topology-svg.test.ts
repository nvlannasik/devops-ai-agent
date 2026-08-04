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
