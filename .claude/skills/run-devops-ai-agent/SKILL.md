---
name: run-devops-ai-agent
description: Build, launch, and smoke-test the devops-ai-agent Slack bot. Use when asked to run, start, boot, or drive the agent, hit its /alert or /health HTTP endpoints, or verify the alert-webhook auth / alert-correlation behavior offline (no Slack/LLM/cluster needed).
---

# Run devops-ai-agent

The agent is a Slack bot + agentic investigation loop. It has **no standalone UI** — its only
programmatically drivable surface is an HTTP server: the Alertmanager `POST /alert` webhook and
`GET /health`. It also hard-requires an MCP connection at startup (`await mcp.connect()` is
fatal) and normally runs the sibling **devops-mcp-server** as its stdio child.

**Driver:** `.claude/skills/run-devops-ai-agent/driver.mjs` boots the real app in HTTP mode with
dummy Slack creds, spawns devops-mcp-server over stdio, and asserts the HTTP surface with
`fetch`. It needs no Slack workspace, no LLM, no Kubernetes cluster, no Postgres/Redis.

All paths below are relative to the repo root (`devops-ai-agent/`). **Node 24 is required** —
the default shell `node` on this machine is v14 (ESM syntax errors), so put Node 24 on PATH first:

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
```

## Prerequisites

- Node.js >= 24 (see PATH line above). No OS packages needed on macOS.
- The sibling repo `../devops-mcp-server` checked out and built (the agent's MCP data source).

## Build

Build both the agent and the mcp-server it spawns:

```bash
npm run build
(cd ../devops-mcp-server && npm run build)
```

## Run (agent path) — the driver

```bash
node .claude/skills/run-devops-ai-agent/driver.mjs
```

Boots the agent on `http://127.0.0.1:4319` (mcp-server as a stdio child), runs 8 assertions,
then tears everything down (process-group kill — no strays). Expected output:

```
→ up. /health = {"ok":true,"mode":"http","checks":{"mcp":"up"}}
health:
  ✓ /health reports http mode
  ✓ MCP stdio child connected (checks.mcp=up)
/alert auth gate (the feature under test):
  ✓ no Authorization header → 401
  ✓ wrong bearer token → 401
/alert happy path + validation:
  ✓ correct bearer + valid payload → 200 {ok:true}
  ✓ correct bearer + invalid payload → 400
  ✓ correlation grouped 2 pods into one investigation (log)

✓ PASS — 8 passed, 0 failed
```

Exit code 0 on pass, 1 on any failed assertion (prints the last 25 agent log lines), 2 if a
build is missing. Env knobs: `PORT` (default 4319), `MCP_DIR` (default `../devops-mcp-server`),
`STARTUP_TIMEOUT_MS` (default 45000).

**What it covers:** the two behaviors most likely to change here — the `/alert` bearer-token gate
(`ALERT_WEBHOOK_TOKEN`) and alert correlation (N pods in one Alertmanager group → **one**
investigation). To poke a single endpoint by hand while the driver's app is up, temporarily raise
`STARTUP_TIMEOUT_MS` or add your own `fetch` calls in `main()`.

## Unit tests

```bash
npm test
```

`node:test` + tsx, zero extra deps — 79 tests, all pure/deterministic (no app boot). Fast sanity
check; the driver is the real integration check.

## Run (human path) — real deployment

`npm start` (prod, `dist/`) or `npm run dev` (tsx watch) run the actual bot, which connects to
**real** Slack + LLM + MCP from env (`SLACK_BOT_TOKEN`, `LLM_PROVIDER`+creds, `MCP_*`, optional
`DB_*`/`REDIS_*`). Useless headless without those — not run in this smoke context. See
`README.md` for the full env matrix and `MEMORY_BANK.md` for architecture.

## Gotchas

- **Bolt calls `auth.test` at startup** (`node_modules/@slack/bolt/dist/App.js:219`, when
  `tokenVerificationEnabled` defaults true). A dummy `SLACK_BOT_TOKEN` → `invalid_auth` →
  the boot **crashes**. The driver preloads `slack-stub.mjs` via `node --import` to stub
  `@slack/web-api` so every Slack call no-ops offline. Product code is untouched; the stub is
  applied only to the agent, not the mcp-server child. Run the app without that shim and it
  dies before serving a request.
- **MCP is a hard startup dependency** — `agent.initialize()` does `await this.mcp.connect()`
  and exits(1) on failure. The driver spawns `../devops-mcp-server/dist/index.js` over stdio;
  if that build is missing it fails fast with a clear message. (mcp-server itself starts fine
  with no cluster — its upstream probes are non-fatal warnings.)
- **Node version trap.** Default shell `node` here is v14 → `openid-client`/optional-chain ESM
  syntax errors. The driver forces `process.execPath` (the Node 24 running it) for BOTH the
  agent and the stdio MCP child (`MCP_STDIO_COMMAND`), so you only need Node 24 to launch the
  driver itself.
- **The HTTP server starts only AFTER `mcp.connect()` resolves** (`main()` awaits initialize
  then start). So the first successful `/health` already implies MCP connected — the driver's
  health poll is the readiness signal; there's no separate MCP-ready wait.
- **`/alert` acks 200 before investigating** (async by design). The background group
  investigation then fails on the offline LLM (dead `127.0.0.1:1` URL) and stubbed Slack — that
  is expected and caught. The smoke asserts the ack + the pre-investigation
  `processing alert group: … firing=2` log line, not the investigation outcome.
- **`EPIPE` from a `winston` transport under `devops-mcp-server`** in the logs = the agent
  already crashed and broke the stdio pipe. It's a *symptom*, not the cause — the real error is
  a few lines above it.

## Troubleshooting

- `agent exited early (code 1)` with `invalid_auth` → the Slack stub didn't load. Confirm the
  driver spawns with `--import <slack-stub.mjs>` (you ran the app directly instead of via the
  driver).
- `✗ mcp-server build missing: …/dist/index.js` → `(cd ../devops-mcp-server && npm run build)`.
- `server did not answer /health within …ms` → the agent crashed during boot; the driver prints
  the last agent log lines — read them (usually a missing build or a config/env issue).
- Port already in use → `PORT=5000 node .claude/skills/run-devops-ai-agent/driver.mjs`.
