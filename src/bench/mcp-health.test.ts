import { test } from "node:test";
import assert from "node:assert/strict";
import { healthUrl, mcpReachable, waitForMcp } from "./mcp-health.js";

test("the health route is the MCP server's own, whatever path the MCP endpoint has", () => {
  assert.equal(healthUrl("http://localhost:13000/mcp"), "http://localhost:13000/health");
  assert.equal(healthUrl("http://devops-mcp-server.devops-tools:3000/mcp"), "http://devops-mcp-server.devops-tools:3000/health");
});

test("reachable means an OK answer — a refused connection and a 502 are both down", async () => {
  const answering = (async () => new Response("ok")) as unknown as typeof fetch;
  const badGateway = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
  const refused = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal(await mcpReachable("http://x/health", answering), true);
  assert.equal(await mcpReachable("http://x/health", badGateway), false);
  assert.equal(await mcpReachable("http://x/health", refused), false);
});

test("waiting returns as soon as the server is back, and gives up at the timeout", async () => {
  let calls = 0;
  const back = await waitForMcp("u", { timeoutMs: 60_000, intervalMs: 5_000, probe: async () => ++calls >= 3, sleep: async () => {} });
  assert.equal(back, true);
  assert.equal(calls, 3);

  calls = 0;
  const gone = await waitForMcp("u", { timeoutMs: 10_000, intervalMs: 5_000, probe: async () => (calls++, false), sleep: async () => {} });
  assert.equal(gone, false);
  assert.equal(calls, 3); // at 0s, 5s and 10s
});
