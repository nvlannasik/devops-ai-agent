import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { vmRoutes } from "./vm-routes.js";

// The three routes over a real HTTP server: identity is the token's, never the body's.
async function serve(store: Record<string, unknown>, results: unknown[]) {
  const app = express();
  app.use(express.json());
  app.use(vmRoutes({ tokens: new Map([["vm-a", "tok-a"], ["vm-b", "tok-b"]]), store: store as never, onResult: async (...a: unknown[]) => void results.push(a) }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const call = (path: string, token: string | null, body: unknown = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("an unknown or missing token is 401", async () => {
  const s = await serve({}, []);
  assert.equal((await s.call("/vm/actions/claim", null)).status, 401);
  assert.equal((await s.call("/vm/actions/claim", "nope")).status, 401);
  await s.close();
});

test("claim answers for the token's host, whatever the body says", async () => {
  const asked: string[] = [];
  const s = await serve({ claim: async (h: string) => (asked.push(h), h === "vm-a" ? { id: 3, unit: "nginx.service", action: "restart" } : null) }, []);
  const r = await s.call("/vm/actions/claim", "tok-a", { host: "vm-b" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 3, unit: "nginx.service", action: "restart" });
  assert.equal((await s.call("/vm/actions/claim", "tok-b")).status, 204);
  assert.deepEqual(asked, ["vm-a", "vm-b"]);
  await s.close();
});

test("heartbeat records the units; result calls onResult once with the remediation id", async () => {
  const beats: unknown[] = [];
  const results: unknown[] = [];
  const s = await serve(
    { heartbeat: async (...a: unknown[]) => void beats.push(a), finish: async (id: number, host: string) => (id === 3 && host === "vm-a" ? { remediationId: 12 } : null) },
    results
  );
  assert.equal((await s.call("/vm/heartbeat", "tok-a", { units: ["nginx.service"], version: "1" })).status, 204);
  assert.deepEqual(beats, [["vm-a", ["nginx.service"], "1"]]);
  const body = { status: "succeeded", exitCode: 0, active: "active", journal: "ok" };
  assert.equal((await s.call("/vm/actions/3/result", "tok-a", body)).status, 204);
  assert.deepEqual(results, [["vm-a", 3, 12, body]]);
  assert.equal((await s.call("/vm/actions/3/result", "tok-b", body)).status, 404);
  await s.close();
});
