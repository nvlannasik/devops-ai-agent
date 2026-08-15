import { test } from "node:test";
import assert from "node:assert/strict";

// topology.test.ts fixes MCP_TRANSPORT=http at module scope, so the stdio branch of
// buildTopology() never runs there — a bug in that branch (or a leak) would sit invisible
// forever. config reads process.env once at module evaluation, and node:test gives this file
// its own process, so a distinct transport requires its own file with its own env set before
// the dynamic import (same structure topology.test.ts itself uses, for the same reason).
process.env.SLACK_BOT_TOKEN = "x";
process.env.SLACK_SIGNING_SECRET = "x";
process.env.ANTHROPIC_API_KEY = "x";
process.env.LLM_PROVIDER = "claude";
process.env.MCP_TRANSPORT = "stdio";
process.env.MCP_STDIO_COMMAND = "run-mcp.js";
// A credential passed as a CLI argument to a wrapper script is an ordinary pattern — the
// finding this file exists to lock in.
process.env.MCP_STDIO_ARGS = "--api-key,SENTINEL-stdio-secret,--verbose";

const { buildTopology } = await import("./topology.js");

test("the stdio MCP branch renders transport only, never the command line", () => {
  const t = buildTopology();
  const mcp = t.outbound.find((n) => /mcp/i.test(n.label));
  assert.ok(mcp, "the MCP server should be an outbound node");
  assert.equal(mcp.detail, "stdio");
  assert.equal(mcp.meta, "stdio");

  const serialised = JSON.stringify(t);
  assert.ok(!serialised.includes("SENTINEL-stdio-secret"), "stdio arg leaked into topology data");
  assert.ok(!serialised.includes("run-mcp.js"), "stdio command leaked into topology data");
  assert.ok(!serialised.includes("--verbose"), "stdio arg leaked into topology data");
});
