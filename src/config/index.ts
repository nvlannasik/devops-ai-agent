import "dotenv/config";

const env = process.env.NODE_ENV || "dev";

export const DASHBOARD_PORT_DEFAULT = 3001;

// `parseInt(x ?? "3001")` guards only the UNSET case: an empty string, a typo, or an
// out-of-range number all survive it, and http.Server.listen() then throws
// ERR_SOCKET_BAD_PORT synchronously — which used to take the whole pod down over a
// statistics page. Everything else in this file may fail loud at boot; the dashboard
// specifically may not (design §8), so a bad value falls back and says so.
export function dashboardPort(raw: string | undefined): number {
  if (raw === undefined) return DASHBOARD_PORT_DEFAULT;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(
    `[config] DASHBOARD_PORT="${raw}" is not a port number (1-65535) — ` +
    `falling back to ${DASHBOARD_PORT_DEFAULT}`
  );
  return DASHBOARD_PORT_DEFAULT;
}

export const config = {
  env,
  port: parseInt(process.env.PORT ?? "3000"),

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    appToken: process.env.SLACK_APP_TOKEN,
    alertChannel: process.env.SLACK_ALERT_CHANNEL,
    oncallUsers: (process.env.SLACK_ONCALL_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // who may approve/reject remediations — falls back to oncallUsers; both empty =
    // any user may decide (warned in logs; still a human gate + server-side guardrails)
    approverUsers: (process.env.SLACK_APPROVER_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // emoji name that triggers learn-from-thread when reacted inside an investigated
    // thread (needs reactions:read + the reaction_added event subscription)
    learnReaction: process.env.SLACK_LEARN_REACTION ?? "white_check_mark",
  },

  // Shared secret required on POST /alert (Authorization: Bearer <token>). The endpoint
  // triggers investigations AND remediation proposals, so an open port is a real trust
  // boundary. Unset = open + a startup warning (backward-compat, same policy as MCP_AUTH_TOKEN).
  // Configure the sender via Alertmanager `http_config.authorization.credentials`.
  alertWebhook: {
    token: process.env.ALERT_WEBHOOK_TOKEN,
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "claude") as
      "claude" | "openai-compatible" | "private-llm" | "router",
    // Output token ceiling for claude + openai-compatible. SQS path's limit lives in llm-worker.
    maxTokens: parseInt(process.env.MAX_TOKENS ?? "8096"),
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
    },
    openaiCompatible: {
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "none",
      model: process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4",
    },
    sqs: {
      region: process.env.AWS_REGION ?? "ap-southeast-1",
      requestQueueName: process.env.SQS_REQUEST_QUEUE_NAME ?? "llm-request.fifo",
      responseQueueName: process.env.SQS_RESPONSE_QUEUE_NAME ?? "llm-response.fifo",
      // must cover the worker's worst case: a reasoning model burning its token budget
      // (~60-90s) PLUS the worker's one automatic 2x-budget retry — 120s lost the race
      // by 23s in testing (worker delivered a good answer the agent had already abandoned)
      timeoutMs: parseInt(process.env.SQS_LLM_TIMEOUT_SECONDS ?? "240") * 1000,
      pollWaitSeconds: parseInt(process.env.SQS_POLL_WAIT_SECONDS ?? "10"),
    },
  },

  // GitOps PR-flow remediation (DESIGN_gitops_pr_remediation.md). When enabled, a Flux
  // HelmRelease-managed workload's remediation opens a PR via the llm-worker's gitops
  // handler over SQS (request queue below; responses share the LLM response queue, routed
  // by requestId). The agent holds NO GitHub credentials — those live in the worker.
  gitops: {
    enabled: process.env.GITOPS_REMEDIATION_ENABLED === "true",
    requestQueueName: process.env.SQS_GITOPS_REQUEST_QUEUE_NAME ?? "gitops-request.fifo",
    timeoutMs: parseInt(process.env.SQS_GITOPS_TIMEOUT_SECONDS ?? "120") * 1000,
  },

  mcp: {
    transport: (process.env.MCP_TRANSPORT ?? "stdio") as "stdio" | "http",
    stdio: {
      command: process.env.MCP_STDIO_COMMAND ?? "node",
      args: (process.env.MCP_STDIO_ARGS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    http: {
      url: process.env.MCP_HTTP_URL ?? "http://localhost:3001/mcp",
      // Sent as `Authorization: Bearer <token>` when set — must match the server's MCP_AUTH_TOKEN.
      authToken: process.env.MCP_AUTH_TOKEN,
    },
    // per-tool-call timeout (seconds) so a hung MCP server / upstream can't stall an investigation
    toolTimeoutMs: parseInt(process.env.MCP_TOOL_TIMEOUT_SECONDS ?? "45") * 1000,
  },

  // wall-clock budget (seconds) for a single investigation — bounds how long a semaphore slot is held
  investigationTimeoutMs: parseInt(process.env.INVESTIGATION_TIMEOUT_SECONDS ?? "300") * 1000,

  memory: {
    // MEMORY_BACKEND: "inmemory" (default) | "redis"
    backend: (process.env.MEMORY_BACKEND ?? "inmemory") as "inmemory" | "redis",
    redis: {
      host:     process.env.REDIS_HOST     ?? "localhost",
      port:     parseInt(process.env.REDIS_PORT ?? "6379"),
      db:       parseInt(process.env.REDIS_DB   ?? "0"),
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      tls:      process.env.REDIS_TLS === "true",
    },
  },

  // Durable incident memory (Postgres). Disabled unless DB_HOST is set —
  // distinct from conversation memory (Redis cache); this is a long-lived record.
  incidents: {
    enabled: !!process.env.DB_HOST,
    db: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? "5432"),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME ?? "devops_agent",
      sslMode: process.env.DB_SSL_MODE ?? "disable", // disable | require | verify-full
    },
  },

  // Read-only incident dashboard on its own port. Off unless asked for — the agent must
  // be unchanged for anyone not using it. There is no auth: the port simply is not routed
  // by the Ingress (see docs/superpowers/specs/2026-08-03-dashboard-design.md §3.1).
  dashboard: {
    enabled: process.env.DASHBOARD_ENABLED === "true",
    port: dashboardPort(process.env.DASHBOARD_PORT),
  },

  maxConcurrentInvestigations: parseInt(process.env.MAX_CONCURRENT_INVESTIGATIONS ?? "5"),

  // tool-call rounds allowed for plain (non-investigation) mentions before the agent
  // must answer with what it has — the deterministic scope guard for conversation mode.
  // 2 covers the common flows exactly (discover → fetch); a 3rd round only ever fed wandering
  mentionToolRounds: parseInt(process.env.MENTION_TOOL_ROUNDS ?? "2"),
} as const;
