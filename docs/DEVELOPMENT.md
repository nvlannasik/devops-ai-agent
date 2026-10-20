# Development

## Build, run, test

```bash
cp .env.example .env
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build, so `dist/` stays clean. Note the flip side: a signature change that only breaks a test still passes `npm run build`, so run both.

Covered areas, grouped:

- **Agentic loop plumbing** — history trimming with `tool_use`/`tool_result` pairing, tool-result truncation (head+tail), conversation memory, investigation/tour intent detection, namespace scope lock, alert correlation, trace context, every forced-final-answer ceiling.
- **LLM** — backend registry validation (contiguous indices, overlapping routes, missing fields), router failover being up-only, the `max_tokens` → `max_completion_tokens` retry, the SQS response-release backoff, token accounting, identifier masking, per-backend pricing.
- **Memory** — incident-memory parsing and no-op guards, the three recall tiers, migrations.
- **Remediation** — proposal parsing, the `worthProposing` mention gate (including the negated-vocabulary and Indonesian-stem traps), the full gate chain (`refusalFor`), the durable verification verdicts, GitOps overlay-path detection and PR preview.
- **Slack + dashboard** — the fence-safe splitter, RCA and tour tables, remediation cards, route matching, auth cookies, filter/pagination parsing, HTML escaping, the RCA parser, the topology and cluster maps.
- **Replay** — every case under `replay/cases/` plays a recorded production run back through the current gates (see below).

## Benchmark & replay

Two ways to measure a change before it ships, both driving the **real** loop:

- **Benchmark** (`npm run bench`, `bench/README.md`) — scenario cases under `bench/cases/`
  (alerts and mentions against a real cluster with the sample apps' fault knobs), scored on RCA,
  proposal and grounding; history appears on `/bench`. Scenarios and scoring:
  [`BENCHMARK_agent_stack.md`](BENCHMARK_agent_stack.md).
- **Replay** (`npm run replay`, [`replay/README.md`](../replay/README.md)) — a recorded production run
  played back through the current code. `gates` mode is offline and deterministic and runs under
  `npm test`; `tools` mode re-asks a live model against the recorded tool results.
  `npm run replay:export` turns a run from the dashboard into a redacted case.

## Project structure

```
src/
├── agent/
│   ├── index.ts                  # DevOpsAgent: construction, initialize, recall/timeline/postmortem, delegators; re-exports the helpers below
│   ├── loop/                     # control.ts (iteration/budget ceilings, tool memo, evidence stamps), log-gap.ts
│   │   ├── runner.ts             # InvestigationRunner: the agentic loop, tool rounds, delegation, the tool memo
│   │   ├── answer-gates.ts       # settleAnswer(): every gate that may hold an answer for one more round
│   │   ├── finalize.ts           # finalizeAnswer(): footer meta, confidence cap, the scrubbers, [OFFER] strip
│   │   └── run-state.ts          # InvestigateOptions, RunMeta, RunState, RunCtx
│   ├── confidence/index.ts       # parseConfidence()
│   ├── context/                  # Request assembly — the whole prompt is built per call
│   │   ├── index.ts              # assembleRequest(), injectSkills(), trimToWindow(), sanitizeContentBlocks()
│   │   ├── budget.ts             # estimateTokens(), fitToBudget() — oldest-first drop
│   │   ├── compact.ts            # compactToolResult() — MAX_TOOL_RESULT_CHARS
│   │   └── resolve-budget.ts     # Per-backend context window → Budget
│   ├── skills/                   # index.ts (registry + `when` matching), frontmatter.ts, thread.ts (per-thread selection)
│   ├── correlation/              # index.ts: one webhook = one group = one investigation; topology.ts: cross-alert, call graph
│   ├── changes/index.ts          # Change timeline before an alert (rollouts, HelmReleases, ConfigMaps, GitOps commits)
│   ├── dedup/index.ts            # AlertDeduplicator
│   ├── llm/
│   │   ├── claude.ts, openai-compatible.ts, sqs.ts
│   │   ├── registry.ts, router.ts  # LLM_BACKEND_<N>_* parsing (routerRegistry()); light→heavy up-only failover
│   │   ├── mask.ts               # Identifier masking around every backend
│   │   ├── pricing.ts            # LLM_BACKEND_<N>_PRICE_* → USD
│   │   ├── index.ts              # createLLMClient() factory
│   │   └── types.ts
│   ├── feedback/index.ts         # On-call learning: transcript builder + extraction JSON parser
│   ├── gitops/                   # PR remediation: overlay.ts (path detect), preview.ts, revert.ts, sqs.ts (worker bridge)
│   ├── incidents/index.ts        # Durable incident memory (Postgres) — RCAs + confirmed feedback + similarity tier
│   ├── incidents/lifecycle.ts    # IncidentLifecycle: missed-resolved sweeper, status commands, `@agent learn`
│   ├── intent/index.ts           # wantsInvestigation(), wantsTour(), mentionBudget()
│   ├── injection/index.ts        # Prompt-injection framing of tool results
│   ├── trace/                    # Investigation recorder → agent_events (gates, LLM turns, tool calls)
│   ├── mcp/                      # client.ts (reconnect + mutex + ping), types.ts (McpTools — any MCP transport)
│   ├── onboarding/               # Cluster model for the tour and /cluster: flow, dependencies, where to change it
│   ├── postmortem/               # draft.ts, facts.ts (Postgres timeline/numbers), store.ts, intent.ts, slack.ts
│   ├── remediation/              # Guarded Remediation
│   │   ├── index.ts              # Proposal parser + row-flip store (atomic claim)
│   │   ├── remediator.ts         # Remediator: propose, gate, execute, verify (the agent delegates to it)
│   │   ├── proposal.ts           # worthProposing(), proposeWithRetry(), the gate chain
│   │   ├── evidence-refusals.ts  # Evidence-based refusals (quarantine, scale-out, unseen image, …)
│   │   ├── replace-guard.ts, noop-guard.ts, rollback-gate.ts  # Healthy-target / RBAC / OOM-shrink / no-op / rollback refusals
│   │   └── verify.ts             # Durable post-remediation check + verdict
│   ├── scope/index.ts            # Namespace scope lock helpers
│   ├── grounding/index.ts        # Resource names asserted but never returned by a tool
│   ├── rca-completeness/         # An RCA that stops early, and the one more turn it takes to finish it
│   ├── template-echo/            # RCA template placeholders deleted when printed instead of filled
│   ├── fabricated-note/          # `[system note]` is the system's voice; the model may not borrow it
│   ├── runbook/                  # Only read-only commands reach the RCA's runbook
│   ├── subagent/index.ts         # Delegate tool, fan-out cap, child deadline/marker (SUBAGENT_ENABLED)
│   ├── memory/index.ts           # Redis/in-memory + hasRca/markRcaSent
│   ├── usage/index.ts            # Per-call token accounting → llm_usage
│   └── prompts/system.ts         # Static prompt + time context
├── app/
│   ├── index.ts                  # SlackApp: Bolt + Alertmanager webhook, /health, lifecycle, the shared posts
│   ├── host.ts                   # SlackHost — the one live object every flow reads SlackApp through
│   ├── queue.ts                  # Semaphore, ThreadQueue (one turn per thread), InFlightWork (drain on SIGTERM)
│   ├── alerts.ts                 # AlertFlow: dedup, correlation, background investigation, resolve
│   ├── mention.ts                # MentionFlow: tours, conversation replies, proposals after a mention
│   ├── commands.ts               # ThreadCommands: learn, postmortem, status
│   └── remediation.ts            # RemediationFlow: approval buttons, proposals, the verification poller
├── config/index.ts
├── dashboard/                    # Read-only incident dashboard (own listener, own CSP)
│   ├── server.ts, auth.ts        # Routing + per-route CSP; shared password → signed cookie
│   ├── queries.ts, filters.ts    # Read-only SQL; filter parsing + fixed-size pagination
│   ├── views.ts                  # Barrel over the page modules: parts.ts, layout.ts, *-views.ts (one per page)
│   ├── styles.ts, styles/        # The one stylesheet, as ordered chunks (order = cascade; bytes pinned)
│   ├── html.ts, chart.ts, markdown.ts  # esc(), inline SVG charts, prompt Markdown
│   ├── rca.ts                    # Slack-mrkdwn RCA → per-section cards
│   ├── context.ts                # /context — loaded skills + resolved budget per backend
│   ├── stores.ts                 # What Postgres and Redis actually hold
│   ├── topology.ts, topology-graph.ts  # /topology — the agent stack map
│   ├── cluster-graph.ts, cluster-types.ts  # /cluster — inventory + cluster model → graph (also bundled for the browser)
│   ├── bench.ts                  # /bench — reads bench/results/history.jsonl
│   ├── assets.ts                 # The two client bundles, the only static assets
│   └── client/                   # React Flow bundles (topology.js, cluster.js), built by esbuild
├── bench/                        # npm run bench — scenario runner + scoring
├── replay/                       # npm run replay — recorded runs through the current code
├── db/                           # pool.ts (DB_* → pg.Pool), redis.ts (shared Redis: conversation memory + alert dedup), migrate.ts (advisory-locked runner), migrate-cli.ts
└── utils/
    ├── auth/index.ts             # Constant-time secret comparison
    ├── logger/index.ts           # + errDetail()
    ├── trace/index.ts            # withTrace() — threadId as the cross-service traceId
    ├── truncate/index.ts
    └── slack/                    # blocks.ts, rca-tables.ts, tour-tables.ts, remediation-card.ts, split.ts

migrations/    001…015 — run at pod startup, advisory-locked
prompts/       system.md + skills/*.md — editable without a rebuild
bench/         cases/ + results/history.jsonl (committed)
replay/        cases/ — recorded production runs, redacted
docs/          the topic pages linked from the README, DESIGN_*.md per subsystem, BENCHMARK_agent_stack.md, superpowers/specs (feature designs)
```

## Docker

```bash
docker build -t devops-ai-agent .

docker run -p 3000:3000 \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_APP_TOKEN=xapp-... \
  -e ANTHROPIC_API_KEY=... \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_URL=http://devops-mcp-server:3000/mcp \
  devops-ai-agent
```
