import type { BackendKind } from "../agent/llm/registry.js";

// The topology's shape and the one helper that derives an anchor from it — everything about
// this page that is a TYPE or a pure function, with no import that reaches config.
//
// Split out of topology.ts for one concrete reason: `topology-graph.ts` is compiled into the
// browser bundle, and it needs `rowId` plus these types. Importing them from topology.ts would
// drag `config/index.js` — dotenv, every env var this agent reads, the LLM registry parser —
// into a file served to a browser. Nothing secret would be *rendered*, but shipping the config
// module to the client is not a line worth being near. `import type` is erased, so only the
// six lines of rowId() actually cross into the bundle.
//
// topology.ts re-exports all of it, so every existing `from "./topology.js"` import still
// resolves and there is no second name for any of these.

/** One thing a dependency HOLDS: a Postgres table, a Redis key namespace. Derived, never
 *  transcribed — see `stores.ts` for why that distinction is the whole point. */
export interface Store {
  label: string;
  detail: string;
  /**
   * Opt-in shared identity. Two parents naming the same id get ONE node with two incoming
   * edges rather than a copy each — which is the whole point for the SQS response queue: the
   * LLM path and the GitOps path use the same one, routed by `requestId`, and drawing it twice
   * would state the opposite of the contract this page exists to make obvious.
   *
   * Optional because sharing has to be DECLARED. Deduping by label instead would silently
   * merge two dependencies that happen to be spelled alike.
   */
  id?: string;
}

/** Named rather than free-form so the client can only draw glyphs it actually has, and so
 *  `buildTopology` naming one is the same kind of explicit act as naming a field. */
export type IconName = "chat" | "bell" | "db" | "cache" | "queue" | "plug" | "chip";

export interface Node {
  label: string;
  detail: string;   // already redacted — safe to render
  meta: string;     // secret presence and other flags, never a secret value
  configured: boolean;
  // Stable handle for the diagram, which has to anchor an edge to ONE specific node: the
  // private-llm backends hang off llm-worker, not off the agent. Matching on `label` would
  // work until someone rewords it, and would fail silently by drawing the edge from the
  // wrong place. Optional because only the nodes the diagram references need one.
  id?: string;
  /** What this dependency holds, if it is the kind that holds anything. A card with children
   *  becomes expandable on the map; one without stays a leaf. */
  children?: Store[];
  icon?: IconName;
}

export interface BackendNode {
  name: string;
  kind: BackendKind;
  model: string;
  endpoint: string;
  route: "heavy" | "light" | "unrouted";
  viaWorker: boolean;
}

export interface Tool {
  name: string;
  // The agent's OWN predicate for "this can change the cluster", read back rather than
  // re-derived: agent/index.ts gates the write path on description.startsWith("[WRITE]").
  // Reading the same test means the page cannot disagree with the thing it describes — a
  // server that sends no description is non-write to the agent, and non-write here too.
  write: boolean;
}

// A family of tools the MCP server told us it exposes, e.g. { name: "k8s", tools: [...] }.
// NOT a connection: the agent has no idea what the MCP server's own Prometheus URL is —
// that lives in another pod's config. What it does know, for free, is the tool list it
// received on connect. The name is the tool-name prefix, verbatim, so a family the server
// adds tomorrow appears here without anyone editing a mapping table.
export interface Capability {
  name: string;
  tools: Tool[];
}

export interface Topology {
  inbound: Node[];
  outbound: Node[];
  provider: string;
  backends: BackendNode[];
  capabilities: Capability[];
  registryError: string | null;
  // populated only when the provider is NOT "router" — the router's answer to "what LLM is
  // reachable" is the `backends` list instead. See activeClientNode().
  activeClient?: Node;
}

// Structural, not the agent's ToolDefinition: this is the whole dependency the dashboard has
// on the MCP client, and keeping it to the two fields actually read means neither module has
// to import the other's types. `description` is optional because a page that renders on a
// half-built input is the requirement here (see buildTopology's default below).
export interface McpTool {
  name: string;
  description?: string;
}

/**
 * The anchor the map uses to link a box to its own row in the tables below. Both sides
 * derive it from the same array position, so this is a contract between topology-graph.ts and
 * views.ts — one definition, imported by both, rather than two string templates that can
 * drift apart into links that quietly point at nothing.
 *
 * Positional, never label-derived: a node label is rendered text that may contain anything
 * (the tests feed it a <script> tag), and slugging one would need escaping and could still
 * collide. This is [a-z0-9-] by construction.
 */
export const rowId = (group: "in" | "out" | "backend" | "cap", i: number): string => `${group}-${i}`;
