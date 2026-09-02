import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ID, buildGraph } from "./topology-graph.js";
import type { TopoEdge, TopoGraph } from "./topology-graph.js";
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

const into = (g: TopoGraph, target: string): TopoEdge[] => g.edges.filter((e) => e.target === target);
const idsOf = (g: TopoGraph): string[] => g.nodes.map((n) => n.id);

// The invariant the map's links stand on: a node's id IS its row's id, so the anchor is
// `#${id}` and nothing has to keep a second mapping in step. views.ts stamps the same value on
// the <tr> from the same rowId() helper.
test("every node but the agent anchors its own row, and the href matches the id", () => {
  const g = buildGraph(base);
  for (const n of g.nodes) {
    if (n.id === AGENT_ID) {
      assert.equal(n.data.href, undefined, "the agent has no row: it is what the rows are about");
      continue;
    }
    assert.equal(n.data.href, `#${n.id}`, `${n.id} should anchor its own row`);
  }
  assert.ok(idsOf(g).includes("in-0"));
  assert.ok(idsOf(g).includes("out-0"));
  assert.ok(idsOf(g).includes("backend-0"));
});

// No edge may name a node that is not in the graph. React Flow drops a dangling edge silently,
// so a wrong anchor would not throw — it would just quietly draw one arrow fewer.
test("every edge connects two nodes that exist", () => {
  const g = buildGraph({
    ...base,
    outbound: [
      { label: "Postgres", detail: "pg", meta: "", configured: true },
      { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "", configured: true },
      { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "", configured: true },
    ],
    backends: [
      { name: "w", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
    capabilities: [{ name: "k8s", tools: [{ name: "k8s_list_pods", write: false }] }],
  });
  const ids = new Set(idsOf(g));
  for (const e of g.edges) {
    assert.ok(ids.has(e.source), `edge source ${e.source} should be a node`);
    assert.ok(ids.has(e.target), `edge target ${e.target} should be a node`);
  }
});

test("inbound callers fan in to the agent and the agent fans out to its dependencies", () => {
  const g = buildGraph(base);
  assert.deepEqual(into(g, AGENT_ID).map((e) => e.source), ["in-0"]);
  assert.deepEqual(into(g, "out-0").map((e) => e.source), [AGENT_ID]);
});

// design §4.2, and the whole reason this page exists: only private-llm backends traverse SQS.
// In the SVG this was a claim about which box a chip sat inside; here it is the edge itself,
// which is both stronger and what the animation reads.
test("a via-worker backend hangs off llm-worker over an sqs edge; a direct one hangs off the agent", () => {
  const g = buildGraph({
    ...base,
    // llm-worker deliberately in the middle — in the old hand-laid SVG that position changed
    // how the edge was routed, and the anchoring bug it guarded against was a silent one.
    outbound: [
      { label: "Postgres", detail: "pg", meta: "", configured: true },
      { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "", configured: true },
      { label: "GitOps (SQS)", detail: "gitops.fifo", meta: "", configured: true },
    ],
    backends: [
      { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
      { name: "worker1", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  });

  const direct = into(g, "backend-0");
  const worker = into(g, "backend-1");
  assert.deepEqual(direct.map((e) => [e.source, e.kind]), [[AGENT_ID, "call"]]);
  assert.deepEqual(worker.map((e) => [e.source, e.kind]), [["out-1", "sqs"]]);
  assert.notEqual(worker[0]!.source, AGENT_ID, "the SQS backend must not appear to be dialled directly");
});

// The anchor is found by Node.id, never by label. Matching on the display string would work
// until someone reworded it and would then fail SILENTLY — a plausible arrow from the wrong
// node is worse than a missing one.
test("the llm-worker anchor survives a reworded label", () => {
  const g = buildGraph({
    ...base,
    outbound: [{ id: "llm-worker", label: "Private LLM bridge — renamed", detail: "q", meta: "", configured: true }],
    backends: [
      { name: "w", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  });
  assert.deepEqual(into(g, "backend-0").map((e) => e.source), ["out-0"]);
});

// A half-built Topology renders rather than losing an edge (design §6). The fallback is the
// agent, which is wrong-but-visible; dropping the edge would be wrong-and-invisible.
test("a via-worker backend falls back to the agent when there is no llm-worker node", () => {
  const g = buildGraph({
    ...base,
    outbound: [],
    backends: [
      { name: "w", kind: "private-llm", model: "m", endpoint: "via llm-worker (SQS)", route: "light", viaWorker: true },
    ],
  });
  assert.deepEqual(into(g, "backend-0").map((e) => [e.source, e.kind]), [[AGENT_ID, "sqs"]]);
});

// The numbering trap the old SVG renderer documented, preserved because the split still happens:
// chips are mapped over the WHOLE list before being split by viaWorker. Filter-then-map would
// number the two groups 0,1,2… independently and send half the links to the wrong row.
test("backend ids follow the original list order, not the order within each group", () => {
  const g = buildGraph({
    ...base,
    outbound: [{ id: "llm-worker", label: "llm-worker", detail: "q", meta: "", configured: true }],
    backends: [
      { name: "w0", kind: "private-llm", model: "m", endpoint: "e", route: "light", viaWorker: true },
      { name: "d1", kind: "claude", model: "m", endpoint: "e", route: "heavy", viaWorker: false },
      { name: "w2", kind: "private-llm", model: "m", endpoint: "e", route: "light", viaWorker: true },
    ],
  });
  const title = (id: string): string => g.nodes.find((n) => n.id === id)!.data.title;
  assert.equal(title("backend-0"), "w0");
  assert.equal(title("backend-1"), "d1");
  assert.equal(title("backend-2"), "w2");
  // ...and the second via-worker one is still anchored on the worker, not renumbered into it.
  assert.deepEqual(into(g, "backend-2").map((e) => e.source), ["out-0"]);
});

// The tool families belong to the MCP server. An edge from the agent would claim the agent
// exposes them itself.
test("capabilities hang off devops-mcp-server, not off the agent", () => {
  const g = buildGraph({
    ...base,
    outbound: [
      { label: "Postgres", detail: "pg", meta: "", configured: true },
      { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "", configured: true },
    ],
    capabilities: [
      { name: "k8s", tools: [{ name: "k8s_list_pods", write: false }, { name: "k8s_scale", write: true }] },
    ],
  });
  assert.deepEqual(into(g, "cap-0").map((e) => e.source), ["out-1"]);
  const cap = g.nodes.find((n) => n.id === "cap-0")!;
  assert.equal(cap.data.sub, "2 tools");
  // The write count is the one number on this page that says "this family can change the
  // cluster" — read back from the agent's own [WRITE] predicate, never re-derived.
  assert.match(cap.data.meta, /1 of 2/);
});

test("one tool is singular", () => {
  const g = buildGraph({ ...base, capabilities: [{ name: "loki", tools: [{ name: "loki_query", write: false }] }] });
  assert.equal(g.nodes.find((n) => n.id === "cap-0")!.data.sub, "1 tool");
});

// A fresh or minimally-configured agent is a normal state, not an edge case.
test("an empty topology yields just the agent and no edges", () => {
  const g = buildGraph({
    inbound: [], outbound: [], provider: "claude", backends: [], capabilities: [], registryError: null,
  });
  assert.deepEqual(idsOf(g), [AGENT_ID]);
  assert.deepEqual(g.edges, []);
});

// `configured: false` is the only state an inbound/outbound Node carries, and it is what the
// client draws as the dashed warning outline. It has to survive the trip.
test("an unconfigured dependency stays unconfigured in the graph", () => {
  const g = buildGraph({
    ...base,
    outbound: [{ label: "Postgres", detail: "not configured", meta: "ssl disable", configured: false }],
  });
  assert.equal(g.nodes.find((n) => n.id === "out-0")!.data.configured, false);
});

// ---------- expanding a tool family ----------

const withTools: Topology = {
  ...base,
  outbound: [{ id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "", configured: true }],
  capabilities: [
    { name: "k8s", tools: [{ name: "k8s_list_pods", write: false }, { name: "k8s_scale", write: true }] },
    { name: "loki", tools: [{ name: "loki_query", write: false }] },
  ],
};

// The default is the map as it loads. A closed family is a count, not a promise of nodes —
// 34 tools under k8s would otherwise be on screen before anyone asked for them.
test("no tools are drawn until a family is expanded", () => {
  const g = buildGraph(withTools);
  assert.equal(g.nodes.filter((n) => n.data.kind === "tool").length, 0);
  assert.equal(g.nodes.find((n) => n.id === "cap-0")!.data.expanded, false);
});

// A tool hangs off the family that exposes it, which hangs off the MCP server. Two hops, and
// the second is what makes the claim: this family, not the agent and not another family.
test("an expanded family gets one child node per tool, hanging off itself", () => {
  const g = buildGraph(withTools, new Set(["cap-0"]));
  const tools = g.nodes.filter((n) => n.data.kind === "tool");
  assert.deepEqual(tools.map((n) => n.data.title), ["k8s_list_pods", "k8s_scale"]);
  for (const t of tools) {
    assert.deepEqual(into(g, t.id).map((e) => e.source), ["cap-0"], `${t.id} should hang off its family`);
  }
  assert.equal(g.nodes.find((n) => n.id === "cap-0")!.data.expanded, true);
  // ...and only the family that was named. loki stays closed.
  assert.equal(g.nodes.find((n) => n.id === "cap-1")!.data.expanded, false);
  assert.ok(!tools.some((t) => t.data.title.startsWith("loki")));
});

// The agent's OWN predicate for "this can change the cluster", carried through rather than
// re-derived — same rule as the tools table below the map.
test("a tool carries whether it can change the cluster, and has no row to link to", () => {
  const g = buildGraph(withTools, new Set(["cap-0"]));
  const [read, write] = g.nodes.filter((n) => n.data.kind === "tool");
  assert.equal(read!.data.write, false);
  assert.equal(write!.data.write, true);
  // The tables list a tool inside its family's <details>, which has no id of its own, so there
  // is nothing for these to anchor. A wrong href would be a link that silently goes nowhere.
  assert.equal(read!.data.href, undefined);
  assert.equal(write!.data.href, undefined);
});

test("two families can be open at once without their tools mixing", () => {
  const g = buildGraph(withTools, new Set(["cap-0", "cap-1"]));
  assert.equal(g.nodes.filter((n) => n.data.kind === "tool").length, 3);
  const loki = g.nodes.find((n) => n.data.title === "loki_query")!;
  assert.deepEqual(into(g, loki.id).map((e) => e.source), ["cap-1"]);
});

// Expansion must not disturb the ids everything else is anchored on.
test("expanding changes nothing about the rest of the graph", () => {
  const closed = buildGraph(withTools);
  const open = buildGraph(withTools, new Set(["cap-0"]));
  const nonTool = open.nodes.filter((n) => n.data.kind !== "tool").map((n) => n.id);
  assert.deepEqual(nonTool, closed.nodes.map((n) => n.id));
  for (const e of closed.edges) {
    assert.ok(open.edges.some((o) => o.id === e.id), `${e.id} should survive expansion`);
  }
});

// An id nobody minted must not open anything, and must not throw.
test("an unknown id in the expanded set is ignored", () => {
  const g = buildGraph(withTools, new Set(["cap-99", "backend-0", ""]));
  assert.equal(g.nodes.filter((n) => n.data.kind === "tool").length, 0);
});
