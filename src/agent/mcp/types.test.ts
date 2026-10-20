import test from "node:test";
import assert from "node:assert/strict";
import type { McpTools } from "./types.js";
import { DevOpsAgent, type AgentDeps } from "../index.js";

// The multi-cluster SqsMCPClient is a second McpTools; the agent must accept any of them, not only
// the HTTP class (whose private fields make it nominal to TypeScript).
test("AgentDeps.mcp accepts any McpTools, not only the HTTP MCPClient", () => {
  const fake: McpTools = {
    connect: async () => {}, disconnect: async () => {}, getTools: () => [],
    callTool: async () => "ok", ping: async () => true,
  };
  const deps: AgentDeps = { mcp: fake };
  assert.ok(new DevOpsAgent(deps));
});
