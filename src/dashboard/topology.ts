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
}

const NOT_CONFIGURED = "not configured";

// A base URL may legitimately carry credentials (https://user:pass@host/v1), and a query string
// may carry a token. Host, port and path are what identify a dependency; nothing else is needed
// to render it.
export function redactUrl(raw: string | undefined): string {
  if (!raw || !raw.trim()) return NOT_CONFIGURED;
  try {
    const u = new URL(raw);
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
      detail: `POST /alert on :${config.port}`,
      meta: `webhook token ${present(config.alertWebhook.token)}`,
      configured: true,
    },
  ];

  const mcpDetail =
    config.mcp.transport === "http"
      ? redactUrl(config.mcp.http.url)
      : `stdio: ${config.mcp.stdio.command} ${config.mcp.stdio.args.join(" ")}`.trim();

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
        ? `${config.incidents.db.host}:${config.incidents.db.port}/${config.incidents.db.database}`
        : NOT_CONFIGURED,
      meta: `ssl ${config.incidents.db.sslMode}`,
      configured: config.incidents.enabled,
    },
    {
      label: "Redis (conversation memory)",
      detail:
        config.memory.backend === "redis"
          ? `${config.memory.redis.host}:${config.memory.redis.port} db ${config.memory.redis.db}`
          : "in-memory (no Redis)",
      meta: `tls ${config.memory.redis.tls ? "on" : "off"}`,
      configured: config.memory.backend === "redis",
    },
    {
      label: "llm-worker (SQS)",
      detail: `${config.llm.sqs.requestQueueName} -> ${config.llm.sqs.responseQueueName}`,
      meta: `region ${config.llm.sqs.region}, timeout ${config.llm.sqs.timeoutMs / 1000}s`,
      configured: true,
    },
    {
      label: "GitOps remediation (SQS)",
      detail: config.gitops.enabled ? config.gitops.requestQueueName : NOT_CONFIGURED,
      meta: `timeout ${config.gitops.timeoutMs / 1000}s`,
      configured: config.gitops.enabled,
    },
  ];

  const { backends, registryError } = routerBackends();

  return { inbound, outbound, provider: config.llm.provider, backends, registryError };
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
