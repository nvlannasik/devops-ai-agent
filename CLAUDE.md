# devops-ai-agent

Slack bot + agentic loop for incident investigation & RCA. Part of a 3-repo system:
`devops-ai-agent` (this), `devops-mcp-server` (tools), `llm-worker` (private-LLM SQS consumer).

**Read `MEMORY_BANK.md` before changing the agentic loop, memory, SQS dispatcher, or
incident memory** — it holds the architecture, design decisions, and bugs already fixed.
Deeper design in `docs/` (e.g. `DESIGN_guarded_remediation.md`).

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (`node:test` + tsx, zero extra deps)
- Dev: `npm run dev`
- DB migrate: `npm run migrate` (dev) / `npm run migrate:prod` (prod)
- **Node 24 required.** Default shell node is v14 — use `~/.nvm/versions/node/v24.16.0/bin` on the PATH.

## Conventions
- TypeScript ESM (NodeNext). Test files `*.test.ts` are excluded from the build.
- Match surrounding style. Prefer stdlib / already-installed deps over new dependencies.

## Gotchas (see MEMORY_BANK.md for the full list)
- **Follow-up mode:** `markRcaSent` + the `[FOLLOW-UP ...]` prefix keep the LLM out of RCA format. Do not remove.
- **History trimming:** always use the pairing-aware `trimToWindow()` — never a blind `slice`/`splice` (splits `tool_use`/`tool_result` → Anthropic 400).
- **SQS:** the response queue is **shared** across replicas (one dispatcher per process, routed by `requestId`). Don't add per-pod queues.
- **`/alert` is async:** acks 200 immediately, investigates in the background. Don't re-block it.
- **System prompt** lives in `prompts/system.md` — editable without rebuild.
- **Incident memory = Postgres** (durable, `DB_*`), schema via `migrations/*.sql`. **Conversation memory = Redis** (24h cache). Don't conflate them.
- **`toOpenAIMessages` (`agent/llm/openai-compatible.ts`)** must stay in sync with llm-worker's copy. Never flatten content blocks with `JSON.stringify` — a small model imitates the JSON it sees instead of calling a tool, and the output ends up in Slack.
- **Logging:** use `errDetail(err)` from `utils/logger`, not `${err}` (which drops the stack). Investigations run inside `withTrace(threadId, …)` so SQS requests carry `traceId` — that's the join key between the agent log, the llm-worker log, and the Slack thread.
- **Cluster/GitOps drift** returns `drift` from the worker instead of a plain refusal; the agent proposes `flux_reconcile` (restore what Git declares), still approval-gated.
- **Domain guardrail:** `## Scope of Work` in `prompts/system.md` + a scope clause in BOTH per-message markers (`[USER MESSAGE ...]` in `app/index.ts`, `[FOLLOW-UP ...]` in `agent/index.ts`). The prompt section alone doesn't hold on a small model — off-topic asks ("debug this code") got answered. Change all three together.
- **LLM router:** failover is **up-only** (light → heavy, never the reverse) — a weak model fails by answering confidently, not by throwing. `router.test.ts` is what enforces it. Backends come from indexed `LLM_BACKEND_<N>_*` env vars validated at boot.
- **Dashboard auth** (`src/dashboard/auth.ts`, `DASHBOARD_PASSWORD`): one shared password, session in a signed cookie (`v1.<exp>.<hmac>`, key = `scryptSync(password)` so sessions survive restarts and work on every replica). Unset password = **503, never anonymous content**; `/healthz` stays open so the probe can't be taken out by a missing Secret. The port is still not routed by the Ingress — that is a second lock, not a replaced one. Design: `docs/DESIGN_dashboard_auth.md`. Still the one component exempt from "a config mistake stops the pod": a failed listener logs and the agent keeps investigating.
- **Dashboard CSP is per route** (`csp(nonce?)` in `src/dashboard/server.ts`). Only `/topology` passes a nonce and so gets a `script-src`; every other page has none, which is what keeps a missed `esc()` inert where LLM output is rendered. The interactive map's script (`topology-script.ts`) is inline under a **per-response** nonce — never `'unsafe-inline'`, and never a second script. It is progressive enhancement over the script-free radio scale control; don't delete the fallback.

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
