import { config } from "../config/index.js";
import { parseRegistry, type BackendKind, type BackendSpec } from "../agent/llm/registry.js";

export interface Node {
  label: string;
  detail: string;   // already redacted — safe to render
  meta: string;     // secret presence and other flags, never a secret value
  configured: boolean;
}

export interface BackendNode {
  name: string;
  kind: BackendKind;
  model: string;
  endpoint: string;
  route: "heavy" | "light" | "unrouted";
  viaWorker: boolean;
}

export interface Topology {
  inbound: Node[];
  outbound: Node[];
  provider: string;
  backends: BackendNode[];
  registryError: string | null;
  // populated only when the provider is NOT "router" — the router's answer to "what LLM is
  // reachable" is the `backends` list instead. See activeClientNode().
  activeClient?: Node;
}

const NOT_CONFIGURED = "not configured";

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

// Number(garbage) is NaN, and NaN reaches a template string as the literal text "NaN" without
// ever throwing — nothing catches it, it just looks wrong on the page. Every config number that
// flows into rendered text goes through here instead.
const num = (n: number): string | number => (Number.isFinite(n) ? n : "?");

/**
 * Config -> a plain structure. This function IS the allowlist: it names every field it emits,
 * one at a time. It must never iterate the config object and never filter a known-bad set out
 * of it — a denylist is correct only until the next secret is added, and it fails silently.
 */
export function buildTopology(): Topology {
  const inbound: Node[] = [
    {
      label: "Slack",
      detail: config.slack.alertChannel ? `channel ${config.slack.alertChannel}` : NOT_CONFIGURED,
      meta: `bot token ${present(config.slack.botToken)}, socket mode ${present(config.slack.appToken)}`,
      configured: !!config.slack.alertChannel,
    },
    {
      label: "Alertmanager",
      detail: `POST /alert on :${num(config.port)}`,
      meta: `webhook token ${present(config.alertWebhook.token)}`,
      configured: true,
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
      label: "devops-mcp-server",
      detail: mcpDetail,
      meta:
        config.mcp.transport === "http"
          ? `http, auth token ${present(config.mcp.http.authToken)}`
          : "stdio",
      configured: true,
    },
    {
      label: "Postgres (incident memory)",
      detail: config.incidents.enabled
        ? `${config.incidents.db.host}:${num(config.incidents.db.port)}/${config.incidents.db.database}`
        : NOT_CONFIGURED,
      meta: `ssl ${config.incidents.db.sslMode}`,
      configured: config.incidents.enabled,
    },
    {
      label: "Redis (conversation memory)",
      detail:
        config.memory.backend === "redis"
          ? `${config.memory.redis.host}:${num(config.memory.redis.port)} db ${num(config.memory.redis.db)}`
          : "in-memory (no Redis)",
      meta: `tls ${config.memory.redis.tls ? "on" : "off"}`,
      configured: config.memory.backend === "redis",
    },
    {
      label: "llm-worker (SQS)",
      detail: `${config.llm.sqs.requestQueueName} -> ${config.llm.sqs.responseQueueName}`,
      meta: `region ${config.llm.sqs.region}, timeout ${num(config.llm.sqs.timeoutMs / 1000)}s`,
      configured: true,
    },
    {
      label: "GitOps remediation (SQS)",
      detail: config.gitops.enabled ? config.gitops.requestQueueName : NOT_CONFIGURED,
      meta: `timeout ${num(config.gitops.timeoutMs / 1000)}s`,
      configured: config.gitops.enabled,
    },
  ];

  const { backends, registryError } = routerBackends();

  return {
    inbound,
    outbound,
    provider: config.llm.provider,
    backends,
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
