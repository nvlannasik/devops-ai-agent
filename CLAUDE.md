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

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
