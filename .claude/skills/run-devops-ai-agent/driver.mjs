#!/usr/bin/env node
// Smoke driver for devops-ai-agent.
//
// The agent is a Slack bot with no standalone UI — its only programmatically drivable
// surface is the HTTP server (`/health` + the Alertmanager `/alert` webhook). This driver
// boots the REAL app in HTTP mode (dummy Slack creds, no live Slack connection needed at
// startup) with the sibling devops-mcp-server as its stdio child (the agent hard-requires an
// MCP connection at startup — `await mcp.connect()` is fatal), then drives the HTTP surface
// with fetch and asserts the responses. No cluster / Slack / LLM / DB needed: the /alert
// webhook acks 200 BEFORE any Slack/LLM call, so the async investigation failing on the dummy
// creds never affects the smoke assertions.
//
// Run with Node 24:  node .claude/skills/run-devops-ai-agent/driver.mjs
// Env overrides: PORT (default 4319), MCP_DIR (default ../devops-mcp-server), STARTUP_TIMEOUT_MS.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "../../.."); // .claude/skills/run-devops-ai-agent -> repo root
const MCP_DIR = process.env.MCP_DIR ? resolve(process.env.MCP_DIR) : resolve(AGENT_DIR, "../devops-mcp-server");
const PORT = Number(process.env.PORT ?? 4319);
const TOKEN = "smoke-secret-token";
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS ?? 45000);
const BASE = `http://127.0.0.1:${PORT}`;

const agentEntry = resolve(AGENT_DIR, "dist/index.js");
const mcpEntry = resolve(MCP_DIR, "dist/index.js");
for (const [label, p] of [["agent", agentEntry], ["mcp-server", mcpEntry]]) {
  if (!existsSync(p)) {
    console.error(`✗ ${label} build missing: ${p}\n  Build it first: (cd ${label === "agent" ? AGENT_DIR : MCP_DIR} && npm run build)`);
    process.exit(2);
  }
}

const logLines = [];
const record = (chunk) => { for (const l of chunk.toString().split("\n")) if (l.trim()) logLines.push(l); };

const slackStub = resolve(HERE, "slack-stub.mjs");

// process.execPath == the Node 24 running this driver → force the same Node for the agent AND
// its stdio MCP child (MCP_STDIO_COMMAND), sidestepping the machine's default (older) node.
// `--import <slackStub>` neutralizes Bolt's startup auth.test so the bot boots offline.
const child = spawn(process.execPath, ["--import", slackStub, agentEntry], {
  cwd: AGENT_DIR,
  detached: true, // own process group so we can reap the stdio grandchild (mcp-server) too
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    LOG_LEVEL: "info",
    // HTTP mode (NO SLACK_APP_TOKEN) — the Express receiver serves /alert + /health.
    SLACK_BOT_TOKEN: "xoxb-dummy-not-used",
    SLACK_SIGNING_SECRET: "dummy-signing-secret",
    SLACK_ALERT_CHANNEL: "C_SMOKE_DUMMY",
    SLACK_APP_TOKEN: "",
    // Background investigation (fires after the 200 ack) points at a dead local URL so the
    // smoke stays fully offline — it fails fast + caught, never touching the internet.
    LLM_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1",
    OPENAI_COMPATIBLE_API_KEY: "dummy",
    // MCP over stdio → spawn the sibling mcp-server (starts fine with no cluster).
    MCP_TRANSPORT: "stdio",
    MCP_STDIO_COMMAND: process.execPath,
    MCP_STDIO_ARGS: mcpEntry,
    // the feature under test: /alert requires this bearer token.
    ALERT_WEBHOOK_TOKEN: TOKEN,
    MEMORY_BACKEND: "inmemory",
    // no DB_HOST → incident memory disabled (no Postgres needed)
    DB_HOST: "",
  },
});
child.stdout.on("data", record);
child.stderr.on("data", record);

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000).unref();
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`agent exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      return await r.json();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server did not answer /health within ${STARTUP_TIMEOUT_MS}ms`);
}

// --- assertions ---
let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const post = (body, headers = {}) =>
  fetch(`${BASE}/alert`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const validPayload = {
  groupLabels: { alertname: "KubePodCrashLooping", namespace: "demo" },
  commonLabels: { alertname: "KubePodCrashLooping", namespace: "demo", severity: "critical" },
  commonAnnotations: { summary: "pods crashlooping in demo" },
  alerts: [
    { status: "firing", labels: { alertname: "KubePodCrashLooping", namespace: "demo", severity: "critical", pod: "web-a" }, startsAt: "2026-07-27T10:00:00Z" },
    { status: "firing", labels: { alertname: "KubePodCrashLooping", namespace: "demo", severity: "critical", pod: "web-b" }, startsAt: "2026-07-27T10:00:00Z" },
  ],
};

async function main() {
  console.log(`→ launching agent on ${BASE} (mcp-server stdio child from ${MCP_DIR})`);
  const health = await waitForHealth();
  console.log(`→ up. /health = ${JSON.stringify(health)}\n`);

  console.log("health:");
  check("/health reports http mode", health.mode === "http", `got mode=${health.mode}`);
  check("/health exposes dependency checks", health.checks && typeof health.checks === "object");
  check("MCP stdio child connected (checks.mcp=up)", health.checks?.mcp === "up", `got ${health.checks?.mcp}`);

  console.log("/alert auth gate (the feature under test):");
  const noAuth = await post(validPayload);
  check("no Authorization header → 401", noAuth.status === 401, `got ${noAuth.status}`);
  const wrong = await post(validPayload, { authorization: "Bearer wrong-token" });
  check("wrong bearer token → 401", wrong.status === 401, `got ${wrong.status}`);

  console.log("/alert happy path + validation:");
  const ok = await post(validPayload, { authorization: `Bearer ${TOKEN}` });
  const okBody = await ok.json().catch(() => ({}));
  check("correct bearer + valid payload → 200 {ok:true}", ok.status === 200 && okBody.ok === true, `got ${ok.status} ${JSON.stringify(okBody)}`);
  const bad = await post({ not: "an alertmanager payload" }, { authorization: `Bearer ${TOKEN}` });
  check("correct bearer + invalid payload → 400", bad.status === 400, `got ${bad.status}`);

  // the 200 above kicked off a background group investigation (2 pods → ONE group); it will
  // fail on the dummy Slack/LLM creds AFTER the ack — give it a beat and confirm the log shows
  // the correlation grouped both pods into a single investigation.
  await sleep(1500);
  const grouped = logLines.some((l) => /processing alert group: KubePodCrashLooping .*firing=2/.test(l));
  check("correlation grouped 2 pods into one investigation (log)", grouped, "expected 'processing alert group: ... firing=2'");

  console.log(`\n${failures.length ? "✗ FAIL" : "✓ PASS"} — ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\n--- last 25 agent log lines ---");
    console.log(logLines.slice(-25).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n✗ driver error: ${err.message}`);
  console.log("\n--- last 30 agent log lines ---");
  console.log(logLines.slice(-30).join("\n"));
  process.exitCode = 1;
}).finally(cleanup);
