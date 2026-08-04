import { test } from "node:test";
import assert from "node:assert/strict";

// Every secret-bearing env var gets a unique sentinel BEFORE config is imported — config reads
// process.env at module evaluation, so a static import would already have snapshotted the real
// (empty) environment. node:test gives each file its own process, so this affects nothing else.
const SECRETS: Record<string, string> = {
  SLACK_BOT_TOKEN: "SENTINEL-slack-bot",
  SLACK_SIGNING_SECRET: "SENTINEL-slack-signing",
  SLACK_APP_TOKEN: "SENTINEL-slack-app",
  ALERT_WEBHOOK_TOKEN: "SENTINEL-alert-webhook",
  ANTHROPIC_API_KEY: "SENTINEL-anthropic",
  OPENAI_COMPATIBLE_API_KEY: "SENTINEL-openai",
  MCP_AUTH_TOKEN: "SENTINEL-mcp-auth",
  REDIS_PASSWORD: "SENTINEL-redis-pass",
  REDIS_USERNAME: "SENTINEL-redis-user",
  DB_PASSWORD: "SENTINEL-db-pass",
  DB_USERNAME: "SENTINEL-db-user",
  LLM_BACKEND_1_KEY: "SENTINEL-backend1-key",
  LLM_BACKEND_2_KEY: "SENTINEL-backend2-key",
  // Free-form, operator-composed — not secret-shaped env vars like the ones above, but a
  // credential passed as a CLI arg to a stdio wrapper script is an ordinary pattern (see the
  // "MCP stdio command line rendered raw" finding). This file fixes MCP_TRANSPORT=http, so the
  // stdio branch that would render these never runs here — that absence is exercised for real,
  // with its own env, in topology.stdio.test.ts. Kept here too so nothing in this file's own
  // rendering path ever echoes them regardless of transport.
  MCP_STDIO_COMMAND: "SENTINEL-stdio-cmd",
  MCP_STDIO_ARGS: "run-mcp.js,--api-key,SENTINEL-stdio-arg",
};
for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;

// a fully-wired agent, so every branch of buildTopology() has something to render
process.env.DB_HOST = "postgresql.postgresql";
process.env.MEMORY_BACKEND = "redis";
process.env.REDIS_HOST = "devops-agent-redis.devops-tools";
process.env.MCP_TRANSPORT = "http";
process.env.MCP_HTTP_URL = "http://devops-mcp-server.devops-tools:3000/mcp";
process.env.SLACK_ALERT_CHANNEL = "C09R0F6F891";
process.env.GITOPS_REMEDIATION_ENABLED = "true";
process.env.LLM_PROVIDER = "router";
process.env.LLM_BACKEND_1_NAME = "sonnet";
process.env.LLM_BACKEND_1_KIND = "claude";
process.env.LLM_BACKEND_1_MODEL = "claude-sonnet-5";
process.env.LLM_BACKEND_2_NAME = "qwen";
process.env.LLM_BACKEND_2_KIND = "private-llm";
process.env.LLM_ROUTE_HEAVY = "sonnet";
process.env.LLM_ROUTE_LIGHT = "qwen";

const { buildTopology, redactUrl } = await import("./topology.js");
const { topologyPage } = await import("./views.js");

// THE test this page exists to pass. The dashboard has no authentication, so anything rendered
// here is readable by anything that can reach the port. An allowlist is only trustworthy if
// something fails when it stops being one.
test("no configured secret reaches the topology data or the rendered page", () => {
  const t = buildTopology();
  const serialised = JSON.stringify(t);
  const html = topologyPage(t);
  for (const [key, sentinel] of Object.entries(SECRETS)) {
    assert.ok(!serialised.includes(sentinel), `${key} leaked into the topology data`);
    assert.ok(!html.includes(sentinel), `${key} leaked into the rendered page`);
  }
});

test("secrets are reported as presence, never as value", () => {
  const t = buildTopology();
  const mcp = t.outbound.find((n) => /mcp/i.test(n.label));
  assert.ok(mcp, "the MCP server should be an outbound node");
  assert.match(mcp.meta, /\bset\b/);
});

test("redactUrl strips credentials and the query, keeps host and path", () => {
  assert.equal(redactUrl("https://user:pass@gw.internal:8443/v1"), "https://gw.internal:8443/v1");
  assert.equal(redactUrl("http://host/mcp?token=abc"), "http://host/mcp");
  assert.equal(redactUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
});

test("redactUrl handles the missing and the malformed case without throwing", () => {
  assert.equal(redactUrl(undefined), "not configured");
  assert.equal(redactUrl(""), "not configured");
  assert.equal(redactUrl("://nonsense"), "(unparseable)");
});

// WHATWG URL only splits `user:pass@host` into username/password when `//` follows the scheme.
// Without it, everything after the first `:` — including the password — becomes an opaque path
// that u.username/u.password can't touch, and the "redacted" output used to echo it verbatim.
test("redactUrl fails safe on a scheme-less credential (no // after the scheme)", () => {
  const leaked = redactUrl("user:FAKE-TOKEN-abc123@gw.internal:8443/v1");
  assert.equal(leaked, "(unparseable)");
  assert.ok(!leaked.includes("FAKE-TOKEN-abc123"));
});

test("redactUrl fails safe on a bare hostname (no scheme at all)", () => {
  assert.equal(redactUrl("gw.internal"), "(unparseable)");
});

// The single fact this page exists to make obvious: with the router active, only private-llm
// backends traverse SQS to llm-worker; claude and openai-compatible are called directly.
test("the router's backends carry their route and whether they go via llm-worker", () => {
  const t = buildTopology();
  assert.equal(t.provider, "router");
  const sonnet = t.backends.find((b) => b.name === "sonnet");
  const qwen = t.backends.find((b) => b.name === "qwen");
  assert.ok(sonnet && qwen);
  assert.equal(sonnet.route, "heavy");
  assert.equal(sonnet.viaWorker, false);
  assert.equal(qwen.route, "light");
  assert.equal(qwen.viaWorker, true);
});

test("every inbound and outbound dependency is present, configured or not", () => {
  const t = buildTopology();
  const labels = [...t.inbound, ...t.outbound].map((n) => n.label.toLowerCase()).join(" ");
  for (const expected of ["slack", "alertmanager", "mcp", "postgres", "redis", "llm-worker", "gitops"]) {
    assert.match(labels, new RegExp(expected), `${expected} should appear`);
  }
  // an absent dependency is indistinguishable from a forgotten one, so nothing is omitted
  assert.ok([...t.inbound, ...t.outbound].every((n) => n.detail.length > 0));
});

test("buildTopology never throws, whatever the config says", () => {
  assert.doesNotThrow(() => buildTopology());
});
