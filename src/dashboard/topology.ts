import { config } from "../config/index.js";
import { parseRegistry, type BackendSpec } from "../agent/llm/registry.js";
import { rowId } from "./topology-types.js";
import { postgresTables, redisNamespaces } from "./stores.js";
import type { BackendNode, Capability, IconName, McpTool, Node, Store, Tool, Topology } from "./topology-types.js";

// The shape of this page's data, and the rowId() anchor helper, live in `topology-types.ts` —
// a module with no config import, because the browser bundle needs them (see the note there).
// Re-exported here so `from "./topology.js"` keeps resolving for every existing caller and no
// type in this page ends up with two names.
export { rowId };
export type { BackendNode, Capability, IconName, McpTool, Node, Store, Tool, Topology };

const NOT_CONFIGURED = "not configured";

// devops-mcp-server marks every mutating tool by prefixing its description. The agent reads
// this to decide what needs approval; the dashboard reads it to say so out loud.
const WRITE_PREFIX = "[WRITE]";

// A base URL may legitimately carry credentials (https://user:pass@host/v1), and a query string
// may carry a token. Host, port and path are what identify a dependency; nothing else is needed
// to render it.
//
// WHATWG URL only parses `user:pass@host` into username/password when the scheme is followed by
// `//`. Without it (a bare "user:pass@host:port/path", e.g. a pasted base URL missing its
// "https://"), the string is parsed as an opaque-path URL: `user` becomes the scheme and
// everything after — including the password — becomes an untouched opaque path. Clearing
// u.username/u.password on that shape is a no-op, and the "redacted" output is the raw
// credential. A URL with no host is not a reachable endpoint anyway, so requiring one after
// parsing turns that silent echo into a loud "(unparseable)" instead.
//
// This also makes `file://` URLs come back "(unparseable)" (a file URL's host is legitimately
// empty). Acceptable here: every caller of this function redacts an HTTP(S) endpoint
// (MCP_HTTP_URL, an LLM backend's base URL), never a file path.
export function redactUrl(raw: string | undefined): string {
  if (!raw || !raw.trim()) return NOT_CONFIGURED;
  try {
    const u = new URL(raw);
    if (!u.host) return "(unparseable)";
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}

// Presence, never value. Every secret in this file goes through here.
const present = (v: string | undefined): string => (v && v.trim() ? "set" : "not set");

/**
 * Tool names -> families, by the prefix before the first underscore. devops-mcp-server names
 * every tool for its domain (`k8s_list_pods`, `prometheus_query`, `loki_query_range`,
 * `tracing_search`), so the prefix IS the grouping — no lookup table, which is the point:
 * a table would have to be edited every time the server grows a domain, and would silently
 * bucket the new one as "other" until someone noticed.
 *
 * Sorted by size then name so the list is stable between renders (a Map preserves insertion
 * order, which is server order, which is not something this page should depend on).
 */
export function toolFamilies(tools: readonly McpTool[]): Capability[] {
  const fams = new Map<string, Tool[]>();
  for (const t of tools) {
    const i = t.name.indexOf("_");
    // i > 0, not i >= 0: a name that STARTS with "_" has no prefix to speak of, and slicing
    // at 0 would file every such tool under the empty string.
    const family = i > 0 ? t.name.slice(0, i) : t.name;
    const list = fams.get(family) ?? [];
    list.push({ name: t.name, write: (t.description ?? "").startsWith(WRITE_PREFIX) });
    fams.set(family, list);
  }
  return [...fams.entries()]
    .map(([name, list]) => ({ name, tools: list.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.tools.length - a.tools.length || a.name.localeCompare(b.name));
}

// Number(garbage) is NaN, and NaN reaches a template string as the literal text "NaN" without
// ever throwing — nothing catches it, it just looks wrong on the page. Every config number that
// flows into rendered text goes through here instead.
const num = (n: number): string | number => (Number.isFinite(n) ? n : "?");

/**
 * Config -> a plain structure. This function IS the allowlist: it names every field it emits,
 * one at a time. It must never iterate the config object and never filter a known-bad set out
 * of it — a denylist is correct only until the next secret is added, and it fails silently.
 *
 * `mcpTools` is the one input that is not config: the list the MCP client received from
 * listTools() when it connected, held in memory since. Passed in rather than imported so the
 * dashboard keeps no handle on the agent, and so the default (none discovered — the client
 * is down, or has not connected yet) is a state this page renders rather than a crash.
 */
export function buildTopology(mcpTools: readonly McpTool[] = []): Topology {
  const inbound: Node[] = [
    {
      label: "Slack",
      detail: config.slack.alertChannel ? `channel ${config.slack.alertChannel}` : NOT_CONFIGURED,
      meta: `bot token ${present(config.slack.botToken)}, socket mode ${present(config.slack.appToken)}`,
      configured: !!config.slack.alertChannel,
      icon: "chat",
    },
    {
      label: "Alertmanager",
      detail: `POST /alert on :${num(config.port)}`,
      meta: `webhook token ${present(config.alertWebhook.token)}`,
      configured: true,
      icon: "bell",
    },
  ];

  // Deliberately NOT the command/args: MCP_STDIO_COMMAND / MCP_STDIO_ARGS are free-form,
  // operator-composed strings with no redaction available — a credential passed as a CLI
  // argument to a wrapper script (an ordinary pattern) would render verbatim. The design
  // (topology-design.md §4.1) only asks for transport, redacted URL, and auth-token presence;
  // it never asked for the command line. stdio has no URL and no auth token field, so "stdio"
  // is all there is to say.
  const mcpDetail = config.mcp.transport === "http" ? redactUrl(config.mcp.http.url) : "stdio";

  const outbound: Node[] = [
    {
      label: "Postgres (incident memory)",
      detail: config.incidents.enabled
        ? `${config.incidents.db.host}:${num(config.incidents.db.port)}/${config.incidents.db.database}`
        : NOT_CONFIGURED,
      meta: `ssl ${config.incidents.db.sslMode}`,
      configured: config.incidents.enabled,
      icon: "db",
      // What the incident memory is MADE of, parsed out of the shipped migrations rather than
      // listed here — see stores.ts. Present even when the database is NOT configured: the
      // schema is what this agent would write, and a reader asking "where does an incident go"
      // deserves the answer either way.
      children: postgresTables(),
    },
    {
      label: "Redis (conversation memory)",
      detail:
        config.memory.backend === "redis"
          ? `${config.memory.redis.host}:${num(config.memory.redis.port)} db ${num(config.memory.redis.db)}`
          : "in-memory (no Redis)",
      meta: `tls ${config.memory.redis.tls ? "on" : "off"}`,
      configured: config.memory.backend === "redis",
      icon: "cache",
      // Composed from the constants the writing modules own, so this is a view of the code
      // rather than a copy of it. Shown on the in-memory fallback too, for the same reason the
      // tables are: these are the namespaces this agent uses, Redis configured or not.
      children: redisNamespaces(),
    },
    {
      id: "llm-worker",
      label: "llm-worker (SQS)",
      detail: `${config.llm.sqs.requestQueueName} -> ${config.llm.sqs.responseQueueName}`,
      meta: `region ${config.llm.sqs.region}, timeout ${num(config.llm.sqs.timeoutMs / 1000)}s`,
      configured: true,
      icon: "queue",
    },
    {
      label: "GitOps remediation (SQS)",
      detail: config.gitops.enabled ? config.gitops.requestQueueName : NOT_CONFIGURED,
      meta: `timeout ${num(config.gitops.timeoutMs / 1000)}s`,
      configured: config.gitops.enabled,
      icon: "queue",
    },
    // Last on purpose, and the diagram is why: its tool families hang off it in a cluster of
    // their own, and only the bottom node of this column has a clear run downward — an edge
    // leaving a node that has cards beneath it has to detour out the side. Nothing else reads
    // this order (both tests find this node by label, and the table renders whatever it gets).
    {
      id: "devops-mcp-server",
      label: "devops-mcp-server",
      detail: mcpDetail,
      meta:
        config.mcp.transport === "http"
          ? `http, auth token ${present(config.mcp.http.authToken)}`
          : "stdio",
      configured: true,
      icon: "plug",
    },
  ];

  const { backends, registryError } = routerBackends();

  return {
    inbound,
    outbound,
    provider: config.llm.provider,
    backends,
    capabilities: toolFamilies(mcpTools),
    registryError,
    activeClient: activeClientNode(),
  };
}

// The router's answer to "what LLM backend is reachable" is the `backends` list — each one
// carries its own model/kind/route. The other three providers have exactly one client and no
// registry to list it in, so the page needs this instead (design §4.2: "For the other three
// providers the page shows the one active client and says so").
function activeClientNode(): Node | undefined {
  switch (config.llm.provider) {
    case "claude":
      return {
        label: "LLM backend (claude)",
        detail: config.llm.claude.model,
        meta: `api key ${present(config.llm.claude.apiKey)}`,
        configured: !!config.llm.claude.apiKey,
      };
    case "openai-compatible":
      return {
        label: "LLM backend (openai-compatible)",
        detail: `${config.llm.openaiCompatible.model} @ ${redactUrl(config.llm.openaiCompatible.baseUrl)}`,
        meta: `api key ${present(config.llm.openaiCompatible.apiKey)}`,
        configured: !!config.llm.openaiCompatible.baseUrl,
      };
    case "private-llm":
      return {
        label: "LLM backend (private-llm)",
        detail: "via llm-worker (SQS)",
        meta: `queue ${config.llm.sqs.requestQueueName}`,
        configured: true,
      };
    default:
      // "router" — the backends[] list is the answer, not a single node.
      return undefined;
  }
}

function routerBackends(): { backends: BackendNode[]; registryError: string | null } {
  if (config.llm.provider !== "router") return { backends: [], registryError: null };
  let registry;
  try {
    registry = parseRegistry(process.env);
  } catch (err) {
    // unreachable in a running agent — createLLMClient() parses the same registry at boot and
    // the pod would not have started. Handled anyway: this page must render on any config.
    return { backends: [], registryError: err instanceof Error ? err.message : String(err) };
  }
  const routeOf = (name: string): BackendNode["route"] =>
    registry.heavy.includes(name) ? "heavy" : registry.light.includes(name) ? "light" : "unrouted";

  return {
    backends: registry.backends.map((b: BackendSpec) => ({
      name: b.name,
      kind: b.kind,
      model: b.model ?? "—",
      endpoint: b.kind === "private-llm" ? "via llm-worker (SQS)" : redactUrl(b.baseUrl),
      route: routeOf(b.name),
      // the fact this page exists to make obvious: only private-llm traverses SQS
      viaWorker: b.kind === "private-llm",
    })),
    registryError: null,
  };
}
