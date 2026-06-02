import "dotenv/config";

const env = process.env.NODE_ENV || "dev";

export const config = {
  env,
  port: parseInt(process.env.PORT ?? "3000"),

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    appToken: process.env.SLACK_APP_TOKEN,
    alertChannel: process.env.SLACK_ALERT_CHANNEL,
    oncallUsers: (process.env.SLACK_ONCALL_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "claude") as "claude" | "openai-compatible" | "private-llm",
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.CLAUDE_MODEL ?? "claude-opus-4-5",
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
      timeoutMs: parseInt(process.env.SQS_LLM_TIMEOUT_MS ?? "120000"),
      pollWaitSeconds: parseInt(process.env.SQS_POLL_WAIT_SECONDS ?? "10"),
    },
  },

  mcp: {
    transport: (process.env.MCP_TRANSPORT ?? "stdio") as "stdio" | "http",
    stdio: {
      command: process.env.MCP_STDIO_COMMAND ?? "node",
      args: (process.env.MCP_STDIO_ARGS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    http: {
      url: process.env.MCP_HTTP_URL ?? "http://localhost:3001/mcp",
    },
  },

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

  maxConcurrentInvestigations: parseInt(process.env.MAX_CONCURRENT_INVESTIGATIONS ?? "5"),
} as const;
