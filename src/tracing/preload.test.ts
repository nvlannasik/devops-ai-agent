import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ESM trap (devops-sample-apps, 2026-10-27): started from index.ts the SDK patches nothing, because
// an ESM entry's imports run before its body. Only a real child process started with
// `node --import <preload>` proves the preload works, so this runs one against a fake OTLP receiver.
// Needs the build: `npm run build && npm test`.
const PRELOAD = fileURLToPath(new URL("../../dist/src/tracing/preload.js", import.meta.url));
const INDEX = pathToFileURL(fileURLToPath(new URL("../../dist/src/tracing/index.js", import.meta.url))).href;

const APP = `import * as http from "node:http";
  import { activeTracing } from ${JSON.stringify(INDEX)};
  const srv = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const body = await (await fetch("http://127.0.0.1:" + srv.address().port + "/api/v1/query?query=up")).text();
  srv.close();
  await activeTracing()?.shutdown();
  console.log("APP:" + body);`;

async function runChild(endpoint: string): Promise<{ code: number | null; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "otel-agent-"));
  const app = join(dir, "app.mjs");
  writeFileSync(app, APP);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, ["--import", PRELOAD, app], {
      env: { ...process.env, OTEL_SERVICE_NAME: "devops-ai-agent", OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, NODE_ENV: "production" },
    });
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("with the preload, an ESM server and its fetch are one trace, and the query string never leaves", async () => {
  const bodies: string[] = [];
  const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/traces") bodies.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const { code, out } = await runChild(`http://127.0.0.1:${(receiver.address() as { port: number }).port}`);
  receiver.close();
  assert.equal(code, 0);
  assert.match(out, /APP:ok/);

  const spans = bodies.flatMap((raw) =>
    (JSON.parse(raw).resourceSpans as any[]).flatMap((rs) => {
      const svc = rs.resource.attributes.find((a: any) => a.key === "service.name")?.value.stringValue;
      return rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => ({ ...s, svc })));
    })
  );
  const server = spans.find((s) => s.kind === 2);
  const client = spans.find((s) => s.kind === 3);
  assert.ok(server, "a SERVER span from node:http imported as an ESM namespace");
  assert.ok(client, "a CLIENT span from fetch");
  assert.equal(server.svc, "devops-ai-agent");
  assert.equal(server.traceId, client.traceId, "fetch carried traceparent");
  assert.ok(!bodies.join("").includes("query=up"), "the PromQL-shaped query string was redacted before export");
});

test("an unreachable endpoint costs nothing: the app runs and exits cleanly", async () => {
  const { code, out } = await runChild("http://127.0.0.1:9");
  assert.equal(code, 0);
  assert.match(out, /APP:ok/);
});
