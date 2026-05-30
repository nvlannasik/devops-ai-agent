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
    provider: (process.env.LLM_PROVIDER ?? "claude") as "claude" | "openai-compatible",
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.CLAUDE_MODEL ?? "claude-opus-4-5",
    },
    openaiCompatible: {
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "none",
      model: process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4",
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
} as const;
