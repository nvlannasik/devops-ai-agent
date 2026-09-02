import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../topology-graph.js";
import type { Topology } from "../topology-types.js";
import { layoutGraph, NODE_SIZE } from "./layout.js";

// The only part of the browser bundle that can be executed under node:test, and worth doing
// because it is the part with arithmetic in it. dagre is pure JavaScript and `@xyflow/react`
// is imported here for TYPES only (erased at compile time), so this file loads with no DOM.
//
// What is NOT covered, and is stated so nobody reads a green suite as more than it is: React
// Flow's rendering, the drag behaviour and the CSS all need a browser. This pins the positions
// and the structure they encode.

const base: Topology = {
  inbound: [
    { label: "Slack", detail: "channel C1", meta: "", configured: true },
    { label: "Alertmanager", detail: "POST /alert", meta: "", configured: true },
  ],
  outbound: [
    { label: "Postgres", detail: "pg:5432/db", meta: "", configured: true },
    { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "", configured: true },
    { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "", configured: true },
  ],
  provider: "router",
  backends: [
    { name: "sonnet", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
    { name: "private", kind: "private-llm", model: "m", endpoint: "sqs", route: "light", viaWorker: true },
  ],
  capabilities: [{ name: "k8s", tools: [{ name: "k8s_list_pods", write: false }] }],
  registryError: null,
};

const at = (nodes: ReturnType<typeof layoutGraph>["nodes"], id: string) => {
  const n = nodes.find((x) => x.id === id);
  assert.ok(n, `no node ${id}`);
  return n!;
};

// The old hand-laid SVG had a test asserting it "never emits NaN". Same failure, new engine:
// dagre returns undefined coordinates for a node it was never given, and `undefined / 2`
// reaches a style attribute as the literal text "NaN" without anything throwing.
test("every node gets a finite position and its declared size", () => {
  const { nodes } = layoutGraph(buildGraph(base));
  assert.equal(nodes.length, 9, "agent + 2 inbound + 3 outbound + 2 backends + 1 capability");
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.position.x), `${n.id} has a non-finite x`);
    assert.ok(Number.isFinite(n.position.y), `${n.id} has a non-finite y`);
    // The size table is read by BOTH dagre and React Flow; if they disagreed, dagre would be
    // laying out one box while the browser painted another.
    assert.equal(n.width, NODE_SIZE[n.data.kind].width);
    assert.equal(n.height, NODE_SIZE[n.data.kind].height);
  }
});

// The reading order IS the claim: callers fan in on the left, the agent is the middle, its
// dependencies fan out on the right. rankdir LR gets that from buildGraph()'s edge directions,
// so this asserts the two agree rather than that dagre was configured a particular way.
test("the layout reads left to right: callers, agent, dependencies, then what hangs off them", () => {
  const { nodes } = layoutGraph(buildGraph(base));
  const agentX = at(nodes, "agent").position.x;

  for (const id of ["in-0", "in-1"]) {
    assert.ok(at(nodes, id).position.x < agentX, `${id} should sit left of the agent`);
  }
  for (const id of ["out-0", "out-1", "out-2"]) {
    assert.ok(at(nodes, id).position.x > agentX, `${id} should sit right of the agent`);
  }
  // A backend reached over SQS hangs off llm-worker, so it ranks BEYOND it — the one structural
  // fact this page exists to make obvious, restated as a coordinate.
  assert.ok(
    at(nodes, "backend-1").position.x > at(nodes, "out-1").position.x,
    "the via-worker backend should rank past llm-worker"
  );
  assert.ok(
    at(nodes, "cap-0").position.x > at(nodes, "out-2").position.x,
    "a tool family should rank past the MCP server that exposes it"
  );
});

// Two cards on top of each other is a map that has stopped being one. dagre separates by rank
// and within a rank, and this is the cheap assertion that it was given enough to do both.
test("no two cards overlap", () => {
  const { nodes } = layoutGraph(buildGraph(base));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      const apart =
        a.position.x + a.width! <= b.position.x ||
        b.position.x + b.width! <= a.position.x ||
        a.position.y + a.height! <= b.position.y ||
        b.position.y + b.height! <= a.position.y;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }
  }
});

// Every edge animates, so motion says the map is live and says nothing about a particular
// edge. That makes the CLASS the whole of the SQS distinction — it is what the accent stroke
// and the extra weight key on — so it has to land on exactly the one edge that crosses a
// queue, and on no other. This test is what is left holding that after the animation stopped
// carrying it.
test("motion is uniform, and the SQS class marks exactly the edge that crosses a queue", () => {
  const { edges } = layoutGraph(buildGraph(base));
  assert.ok(edges.length > 1, "there should be edges to compare");
  assert.ok(edges.every((e) => e.animated), "every edge animates");

  const sqs = edges.filter((e) => /topo-edge-sqs/.test(e.className!));
  assert.equal(sqs.length, 1, "exactly one edge is the SQS hop");
  assert.equal(sqs[0]!.source, "out-1", "and it leaves llm-worker");
  assert.equal(sqs[0]!.target, "backend-1", "landing on the private-llm backend");
});

// A fresh agent is a normal state, not an edge case: dagre is handed one node and no edges.
test("an empty topology lays out without throwing", () => {
  const { nodes, edges } = layoutGraph(
    buildGraph({ inbound: [], outbound: [], provider: "claude", backends: [], capabilities: [], registryError: null })
  );
  assert.equal(nodes.length, 1);
  assert.equal(edges.length, 0);
  assert.ok(Number.isFinite(nodes[0]!.position.x));
});
