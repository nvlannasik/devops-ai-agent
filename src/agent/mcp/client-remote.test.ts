import { test } from "node:test";
import assert from "node:assert/strict";
import { MCPClient } from "./client.js";

// A remote cluster that is down at boot must not hold the agent's start for the local client's
// ~30 s of backoff: one attempt, then the background retry (multi-cluster over HTTP, 2026-11-04).
test("a remote cluster's MCP client fails its first connect at once, not after the backoff", async () => {
  const client = new MCPClient({ name: "stg", url: "http://127.0.0.1:9/mcp", retryMs: 60_000 });
  const started = Date.now();
  await assert.rejects(client.connect(), /MCP connection failed/);
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.deepEqual(client.getTools(), []);
});
