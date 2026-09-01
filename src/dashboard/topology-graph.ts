import { rowId } from "./topology-types.js";
import type { BackendNode, Capability, Node, Topology } from "./topology-types.js";

// The graph model the React Flow map is built from. It lives HERE, in a plain .ts module with
// no React import, rather than inside src/dashboard/client/ — because what it encodes is a
// claim about this system, not a drawing decision: which backends the agent calls directly and
// which ones it can only reach over SQS through llm-worker. That claim is the reason the page
// exists (design §4.2), it is the single most common wrong assumption about this stack, and it
// therefore needs a test that runs under `npm test` with the other 56. A .tsx file inside the
// esbuild bundle is typechecked but never executed by node:test, so a rule written there is a
// rule nothing checks.
//
// Positions are deliberately absent. dagre assigns them in the browser (client/layout.ts) —
// see the note there for why the hand-laid coordinates this replaced are not reproduced.

export type TopoNodeKind = "inbound" | "agent" | "outbound" | "backend" | "capability";

// A `type` alias, not an `interface`, and that is a constraint rather than a preference:
// React Flow's Node<T> requires `T extends Record<string, unknown>`, which an interface does
// not satisfy (interfaces have no implicit index signature, type aliases do). Declaring it as
// an interface compiles here and fails only in the client bundle, one layer away.
export type TopoNodeData = {
  kind: TopoNodeKind;
  title: string;
  // The caption under the title. Already redacted upstream by buildTopology(): every endpoint
  // here has been through redactUrl(), so nothing in this module has to know what a secret
  // looks like. Do not add a field that bypasses that.
  sub: string;
  // Secret PRESENCE and flags, never a secret value — same contract as Node.meta, which is
  // where most of these come from. Rendered as the node's tooltip.
  meta: string;
  configured: boolean;
  // Anchor of this node's own row in the tables below the map. Absent only for the agent,
  // which has no row: it is the thing the tables are about. See the id invariant below.
  href?: string;
  viaWorker?: boolean;
  route?: BackendNode["route"];
  tools?: number;
};

export interface TopoNode {
  id: string;
  data: TopoNodeData;
}

// "sqs" is not decoration. It is what the animated edge in the client renders, and the only
// visual difference between a backend the agent dials itself and one that costs a round trip
// through a queue and another pod.
export type TopoEdgeKind = "call" | "sqs";

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  kind: TopoEdgeKind;
}

export interface TopoGraph {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

// The agent is the one node with no row beneath it, so it is also the one id not minted by
// rowId(). Exported because the client's layout ranks from it and the tests assert on it.
export const AGENT_ID = "agent";

/**
 * A node's id IS the id of its row in the tables below, for every node that has one — so the
 * map's link target is `#${node.id}` and no second mapping exists to drift. rowId() is the
 * single definition both sides derive from; views.ts stamps the same value on the `<tr>`.
 *
 * The one place this is load-bearing rather than tidy: backend chips are mapped over the WHOLE
 * backends list before being split by viaWorker. Filtering first and mapping after would
 * number the two groups 0,1,2… independently and send half the links to the wrong row — the
 * same trap the old SVG renderer documented, preserved here because the split still happens.
 */
export function buildGraph(t: Topology): TopoGraph {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];

  const push = (id: string, data: TopoNodeData): string => {
    nodes.push({ id, data });
    return id;
  };
  const link = (source: string, target: string, kind: TopoEdgeKind): void => {
    edges.push({ id: `${source}->${target}`, source, target, kind });
  };

  const agent = push(AGENT_ID, {
    kind: "agent",
    title: "devops-ai-agent",
    sub: `provider ${t.provider}`,
    meta: "this agent",
    configured: true,
  });

  // Inbound fans IN to one agent. Two nodes today (Slack, Alertmanager); the loop is over
  // whatever buildTopology emitted, because a third caller must appear here without an edit.
  t.inbound.forEach((n: Node, i: number) => {
    const id = rowId("in", i);
    push(id, nodeData("inbound", n, id));
    link(id, agent, "call");
  });

  // The agent fans OUT to its dependencies. Two of these are also anchors for a cluster below
  // (llm-worker, devops-mcp-server) — that is resolved after the loop, by id, never by label.
  const outIds = t.outbound.map((n: Node, i: number) => {
    const id = rowId("out", i);
    push(id, nodeData("outbound", n, id));
    link(agent, id, "call");
    return id;
  });

  // By `Node.id`, which exists for exactly this (see the comment on the field). Matching on
  // `label` would work until someone rewords it and would then fail SILENTLY, drawing the
  // edge from the wrong place — a diagram that quietly states the opposite of the truth.
  // Falling back to the agent keeps a half-built Topology renderable (design §6) rather than
  // dropping the cluster's only incoming edge on the floor.
  const anchor = (nodeId: string): string => {
    const i = t.outbound.findIndex((n: Node) => n.id === nodeId);
    return i >= 0 ? outIds[i]! : agent;
  };
  const workerAnchor = anchor("llm-worker");
  const mcpAnchor = anchor("devops-mcp-server");

  t.backends.forEach((b: BackendNode, i: number) => {
    const id = push(rowId("backend", i), {
      kind: "backend",
      title: b.name,
      // The model ONLY. The route is on the card's own chip (client/nodes.tsx) — stating it in
      // both put three lines in a two-line card, and `overflow: hidden` clipped the title.
      sub: b.model,
      meta: b.endpoint,
      configured: true,
      href: `#${rowId("backend", i)}`,
      viaWorker: b.viaWorker,
      route: b.route,
    });
    // The single fact this map is for: a private-llm backend hangs off llm-worker, everything
    // else off the agent. The edge kind follows the same predicate, so the animation and the
    // topology can never disagree about which backends traverse the queue.
    link(b.viaWorker ? workerAnchor : agent, id, b.viaWorker ? "sqs" : "call");
  });

  // NOT a connection the agent probed — the tool families are what devops-mcp-server said it
  // exposes when the client connected. They hang off the MCP server for that reason: an edge
  // from the agent would claim the agent exposes them itself.
  t.capabilities.forEach((c: Capability, i: number) => {
    const id = push(rowId("cap", i), {
      kind: "capability",
      title: c.name,
      sub: `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}`,
      meta: `${c.tools.filter((tool) => tool.write).length} of ${c.tools.length} can change the cluster`,
      configured: true,
      href: `#${rowId("cap", i)}`,
      tools: c.tools.length,
    });
    link(mcpAnchor, id, "call");
  });

  return { nodes, edges };
}

// inbound and outbound are the same shape and differ only in which band they belong to, so one
// helper builds both. `configured: false` is the only state a Node carries, and it is what the
// client draws as the dashed warning outline.
//
// `href` is derived from the id the caller just minted rather than recomputed from the group
// and index, so the anchor cannot name a row the node is not.
function nodeData(kind: "inbound" | "outbound", n: Node, id: string): TopoNodeData {
  return {
    kind,
    title: n.label,
    sub: n.detail,
    meta: n.meta,
    configured: n.configured,
    href: `#${id}`,
  };
}
