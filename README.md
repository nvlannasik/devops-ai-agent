# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, Loki, Alertmanager and Jaeger via MCP.

## Live demo

<!--
  Replace the placeholder below with the demo video. GitHub renders an uploaded .mp4 inline:
  drag the file into a comment/PR on github.com, copy the resulting
  https://github.com/user-attachments/assets/... URL and paste it on its own line here.
  A YouTube/Loom link works too, as a thumbnail image wrapped in a link:
  [![Live demo](docs/media/demo-thumbnail.png)](https://youtu.be/<id>)
-->

> 🎬 **Video coming soon** — the recording will be added here.

What the demo walks through:

1. **Alert → RCA.** A fault knob in the sample apps (e.g. `GATEWAY_TIMEOUT_MS=50`) fires an
   Alertmanager alert; the agent opens a Slack thread, investigates over MCP and posts the RCA card.
2. **Approval-gated remediation.** The agent proposes one fix; an approver clicks *Approve*; the
   change is executed (or opened as a GitOps PR for a Flux-managed workload) and verified ~5 min later.
3. **Follow-up and `learn`.** A conversational follow-up in the thread, then `@agent learn` stores
   the human-confirmed cause for the next recurrence.
4. **Cluster tour.** `@agent explain this cluster` — inventory tables built from the cluster itself,
   plus how each workload is deployed.
5. **Dashboard.** The incident page (RCA, remediation verdict, LLM cost), `/harness` (every gate,
   per run) and the `/cluster` map.

## How it works

```
Slack mention / Alertmanager webhook
   → correlate + dedup → change timeline + incident memory
   → agentic loop over MCP tools (K8s, Prometheus, Loki, Alertmanager, Tracing)
   → RCA in Slack → one approval-gated remediation → verdict checked later
   → whole run recorded, replayable
```

The full pipeline, step by step: [docs/INVESTIGATION.md](docs/INVESTIGATION.md).

## Features

- **RCA in Slack** from alerts and mentions, with a confidence level that pages on-call when Low — [USAGE](docs/USAGE.md)
- **Guarded remediation** — one whitelisted fix, gate chain, mandatory dry-run, human Approve, durable verification; GitOps PR / revert PR for Flux workloads — [REMEDIATION](docs/REMEDIATION.md)
- **Incident memory** — human-confirmed causes (`@agent learn`), past RCAs, possibly-related incidents, past remediations with verdicts — [MEMORY](docs/MEMORY.md)
- **Change timeline and cross-alert correlation** — what changed in the last 24h; a neighbouring alert joins the open incident's thread — [INVESTIGATION](docs/INVESTIGATION.md)
- **Cluster tour** — onboarding tables built from the cluster, request flow, and where in Git to change a workload — [USAGE](docs/USAGE.md#cluster-tour-onboarding)
- **Postmortem draft** — `@agent postmortem`, with the timeline and numbers rendered from Postgres — [USAGE](docs/USAGE.md#postmortem-draft)
- **Multi-LLM** — Claude, OpenAI-compatible, a private LLM over SQS, or a light/heavy router with up-only failover; cost per investigation; identifier masking — [LLM](docs/LLM.md)
- **Skills and an editable prompt** — Markdown playbooks per symptom, no rebuild — [PROMPTS](docs/PROMPTS.md)
- **Read-only dashboard** — incidents, remediation verdicts, LLM cost, stack topology, cluster map, gate activity — [DASHBOARD](docs/DASHBOARD.md)
- **Benchmark and replay** — measure a change against real scenarios and recorded production runs — [DEVELOPMENT](docs/DEVELOPMENT.md#benchmark--replay)

## Quickstart

**Requirements**

- Node.js >= 24
- A running [devops-mcp-server](../devops-mcp-server)
- Slack app with scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:read`, `users:read` (names on the dashboard's /people page)
- Optional: Postgres (incident memory, dashboard) and Redis (multi-pod conversation memory + dedup)

**Run**

```bash
cp .env.example .env           # every variable: docs/CONFIGURATION.md
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

**Slack app setup**

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App
2. **OAuth & Permissions** → scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:read`, `users:read` (names on the dashboard's /people page)
3. **Event Subscriptions** → subscribe to `app_mention`, `reaction_added`
4. Copy Bot Token + Signing Secret to `.env`
5. Socket Mode: enable + generate App Token with `connections:write`
6. **Interactivity & Shortcuts** → toggle ON (needed for remediation Approve/Reject buttons; over Socket Mode no Request URL is required)

**Alertmanager:** point a webhook receiver at `http://your-agent:3000/alert` with
`send_resolved: true` — full snippet in [docs/USAGE.md](docs/USAGE.md#alertmanager-integration).

## Using it in Slack

| You write | What happens |
|---|---|
| `@devops-agent pods in namespace payment-service are crashing with OOMKilled` | An investigation and an RCA |
| `@devops-agent show me the logs` (in the thread) | A conversational follow-up |
| `@devops-agent explain this cluster` / `jelasin namespace sample-apps` | A cluster tour |
| `@devops-agent learn` (or react ✅) | Stores the thread's confirmed cause |
| `@devops-agent postmortem` | A postmortem draft |

Details for each: [docs/USAGE.md](docs/USAGE.md).

## Documentation

| Page | What is in it |
|---|---|
| [USAGE](docs/USAGE.md) | Slack commands, the tour, `learn`, postmortems, resolved alerts, Alertmanager config, the RCA format |
| [REMEDIATION](docs/REMEDIATION.md) | Whitelisted actions, the gate chain, the approval flow, verification, the GitOps guard |
| [INVESTIGATION](docs/INVESTIGATION.md) | How one investigation runs: dedup, correlation, change timeline, context assembly, guards, sub-agents, reliability |
| [LLM](docs/LLM.md) | Providers, the router, private LLM via SQS, cost per investigation, identifier masking |
| [MEMORY](docs/MEMORY.md) | Incident memory tiers and database migrations |
| [DASHBOARD](docs/DASHBOARD.md) | Routes, auth, rendering safety |
| [PROMPTS](docs/PROMPTS.md) | The system prompt, the query contract, skills |
| [CONFIGURATION](docs/CONFIGURATION.md) | Every environment variable, and AWS authentication |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | Tests, benchmark & replay, project structure, Docker |

Design records per subsystem: `docs/DESIGN_*.md`; feature specs: `docs/superpowers/specs/`.
