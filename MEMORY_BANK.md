# Memory Bank — devops-ai-agent

## Project Overview
AI Agent for DevOps incident investigation and Root Cause Analysis (RCA). Uses Slack as the interface, Claude/private LLM as the reasoning engine, and devops-mcp-server as the observability data source.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM)
- **Slack:** `@slack/bolt` v4 (Socket Mode or HTTP Mode)
- **LLM:** `@anthropic-ai/sdk` v0.100.1 (Claude) + `openai` SDK (OpenAI-compatible) + `SQSLLMClient` (private LLM)
- **MCP Client:** `@modelcontextprotocol/sdk` v1.29.0
- **Memory:** In-memory Map or Redis (`ioredis`)
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Architecture

```
Slack mention / Alertmanager webhook
        ↓
   AlertDeduplicator (fingerprint + TTL 12h)
        ↓
   DevOpsAgent.investigate(threadId, message)
        ↓ (checks hasRca flag → prepend [FOLLOW-UP] if true)
   LLM.chat(history, tools, systemPrompt)
        ↓ (agentic loop, max 10 iterations, parallel tool calls)
   MCPClient.callTool() → devops-mcp-server
        ↓
   RCA text → isRcaResponse() → Block Kit or plain mrkdwn
        ↓
   markRcaSent(threadId) → Redis key rca:{threadId}
        ↓
   parseConfidence() → notify oncall users if Low
```

## Key Design Decisions

### Response Mode = per-message markers (do not remove any of them)
Distant system-prompt rules alone do NOT hold — the model defaults to RCA format for any
first message. Every entry point stamps a marker; the system prompt keys its mode rules on them:
- **Alert path** (`investigateAlertInBackground`) → `[SOURCE: Alertmanager webhook — automated incident investigation]` → investigation mode mandatory.
- **Mention path** (`handleMention`) → `[USER MESSAGE — conversation mode by default ...]` → conversational unless the human explicitly asks to investigate. Added after testing showed "check status semua pod" produced a full Critical-severity RCA about a routine rolling deploy.
- **Follow-up** (after `markRcaSent(threadId)` flags `rca:{threadId}`) → `[FOLLOW-UP — conversation mode, do NOT use RCA format ...]` prepended in `investigate()`.
Prompt-side rules live in `prompts/system.md` §Response Mode (also forbids inventing an "incident" from routine activity like a rolling deploy).

### Domain guardrail (out-of-scope requests)
The markers above pick the *format*; nothing picked the *topic*. A mention like "tolong debug
code ini" was answered as a normal coding question — the agent has a general-purpose LLM behind
it and no rule said the DevOps role was exclusive. Three places, changed together:
- `prompts/system.md` §**Scope of Work** (placed FIRST, before §Response Mode): in scope = the connected clusters, workloads, observability data, incidents, deploys, GitOps state. Out = source code, general programming, systems with no tools behind them, everything non-infra. Explicit rule that pasted code/stack traces don't make a request in scope — read what is being *asked* ("this pod keeps OOMKilling, here's the log" = in; "debug this function" = out, even if it runs in a pod). Decline = one line in the user's language, no partial help; mixed message = answer the in-scope half, decline the rest; genuinely unsure = one clarifying question.
- `[USER MESSAGE ...]` marker (`app/index.ts`) carries the scope clause too — same reason the mode rules are duplicated there: a distant prompt section alone doesn't hold on a small model.
- `[FOLLOW-UP ...]` marker (`agent/index.ts`) as well, so a thread can't drift off-topic after the first answer.

No deterministic backstop here (unlike the RCA-format leak): classifying the *input* by regex
would false-positive on legitimate asks ("debug the deployment"), and out-of-scope isn't
detectable from the output. If the small model still leaks, the next rung is a cheap
classifier call before the loop, not keyword matching.

### Tool budget (deterministic scope guard for conversation mode)
Prompt scope-rules alone did NOT stop the model from chasing anomalies (nginx logs full of
"upstream timed out" → it wandered into `monitoring`/Prometheus/Loki on a plain "show me
logs" question). Enforced in code instead:
- `investigate(threadId, msg, { maxToolRounds })` — plain mentions get **3 tool rounds**; after that `llm.chat` is called with **no tools** + a `[TOOL BUDGET REACHED ...]` note appended to the last tool_results, so the model must answer from gathered data (anomaly → one line + offer to investigate).
- If the model still emits `tool_use` with no tools offered, synthesized error tool_results keep the pairing intact and the loop continues (bounded by `MAX_ITERATIONS`).
- `wantsInvestigation(text)` (`agent/intent/`, keyword regex en+id, unit-tested) grants the full budget for explicit requests ("investigate", "investigasi", "kenapa", "why", "rca", ...). Alert path always has the full budget.
- All three LLM paths **omit the `tools` param when the array is empty** (claude.ts, openai-compatible.ts, and llm-worker/src/llm.ts) — some OpenAI-compatible backends reject `tools: []`. **llm-worker needs its own rebuild/redeploy for this.**
- **Format backstop (deterministic):** even with the budget note, the model sometimes composed its FINAL answer in RCA format when tool results looked alarming (nginx logs full of errors → `response type=rca` for a "show me logs" mention). `handleMention` now detects `!wantsInvestigation && isRcaResponse(reply)` and calls `agent.reformatToConversation(reply)` — one tool-less LLM call with a **minimal** system prompt (the full one is what primes the RCA structure). Falls back to the original text on failure. This is the last line: prompt rules → budget note → programmatic reformat.
- **Slack splitter (`utils/slack/split.ts`):** Slack hard-splits messages >~4000 chars and breaks ``` fences (continuation renders raw). Non-RCA mention replies are posted via `splitForSlack()` — newline-boundary chunks with fence re-balancing (close at chunk end, reopen at next chunk start). Unit-tested.
- **Log fan-out guard (deterministic):** in conversation mode, `k8s_get_pod_logs` for > `MAX_LOG_FANOUT` (2) distinct pods in one round is refused with a synthesized "list the pods and ask the user" error (other calls in the round still execute). Stops "show me log metallb" (matches 8 pods) from dumping every pod's logs; the model asks which one instead.
- **Namespace scope lock (deterministic, `agent/scope/`):** in conversation mode, the FIRST tool round defines the question's namespaces (the model's initial targeting has always been correct); later rounds calling into other namespaces are refused ("out of scope — answer with what you have / ask before expanding"). Kills the recurring failure where logs full of "upstream timed out" lured the model into `monitoring` on a plain "show me nginx logs" question. Namespace-less calls (prometheus/loki queries) and an empty first-round scope are never blocked. Unit-tested.
- `MENTION_TOOL_ROUNDS` default is **2** (was 3): discover → fetch covers the common flows exactly; a 3rd round only ever fed wandering. Tunable via env without rebuild.

### Reasoning-model token exhaustion (private-llm)
The private LLM is a reasoning model: `completion_tokens` includes hidden thinking, which
once consumed the ENTIRE 8096 budget → `finish_reason=length`, empty content, and the user
got a blank-response fallback. Chain of defenses:
- **llm-worker maps `finish_reason=length` → `max_tokens`** (was disguised as `end_turn`).
- **llm-worker auto-retry safeguard:** empty content + `max_tokens` → one retry with **2× token budget** (`isEmptyTokenExhaustion`, unit-tested). Partial answers are never retried.
- Agent's empty-response fallback names the fix (`LLM_MAX_TOKENS` / `LLM_REASONING_EFFORT`).
- Tuning (worker env): raise `LLM_MAX_TOKENS` (16384 recommended), optionally `LLM_REASONING_EFFORT=low` (only sent when set; remove if the backend rejects it).
- **Timeout coherence:** `SQS_LLM_TIMEOUT_SECONDS` default is **240** (was 120). A reasoning compose can take 60–90s, and the worker's 2× retry doubles that — 120s lost the race by 23s in testing (worker delivered a good answer 10:06:55; agent had timed out 10:06:32). The agent-side timeout must cover attempt + retry.
- **Tool-result truncation keeps head AND tail** (`truncateToolResult`, 4k+4k): logs are chronological — head-only truncation silently dropped the recent lines that "show me the logs" needs.

### System Prompt from Markdown
- `prompts/system.md` at project root — edit this file to update the prompt without rebuilding TypeScript
- `buildStaticSystemPrompt()` reads and caches the file on first call
- Path resolution supports both dev (`src/agent/prompts/`) and prod (`dist/src/agent/prompts/`)
- Dockerfile copies `prompts/` directory to image alongside `dist/`

### Truncated Log Formatting
- `src/utils/truncate/index.ts` — `truncate(value, max?)` helper
- Format: `...[truncated N chars]` — shows exactly how much was cut
- Used in: issue preview (120 chars), tool input log (200 chars)
- Tool result truncation in `context/index.ts` uses same format
- Log output itself is never truncated — only field values within log messages

### System Prompt Strategy
- `buildStaticSystemPrompt()` — large static prompt cached by Anthropic (`cache_control: ephemeral`)
- `buildTimeContext()` — called once per investigation, injects unix timestamps for tool params
- Time context prepended to first message only

### Block Kit Rendering
- `isRcaResponse(text)` — detects RCA via regex matching Severity + Root Cause labels
- Regex handles `Critical` and `[Critical]` (LLM sometimes adds brackets)
- `buildRcaBlocks(text)` — parses RCA text into Slack Block Kit blocks
- Fallback: if parsing fails (blocks <= 2), returns single section block with raw text

### MCP Client Reconnect
- Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 5 retries)
- `reconnectMutex` — prevents race condition when parallel tool calls hit disconnect simultaneously
- Double-check pattern: verify `connected` state before and after acquiring mutex

### Timeouts (don't let one investigation stall the agent)
- `MCP_TOOL_TIMEOUT_SECONDS` (default 45) → passed as the MCP SDK `callTool` request `timeout`; a hung MCP server/upstream rejects the call instead of blocking. Set below the SDK's 60s default and above the MCP server's own upstream timeout so the server's specific error surfaces first.
- `INVESTIGATION_TIMEOUT_SECONDS` (default 300) → wall-clock budget checked at the top of each agentic-loop iteration in `investigate()`. Bounds how long a `Semaphore` slot is held (`MAX_ITERATIONS=10` only bounds iteration count, not time). Combined with the per-tool timeout, total runtime is bounded to ~budget + one in-flight call.
- **Env vars are in seconds; config converts to ms internally** (`* 1000`) since `setTimeout`/SDK/axios take ms. Internal field names keep the `Ms` suffix.

### Context Window Management
- Tool results truncated to 8000 chars before entering history
- `trimToWindow(messages, max)` in `context/index.ts` is the single pairing-aware trimmer: keeps first message (original issue) + most recent, and advances the window past any leading orphaned `tool_result`
- Used by both layers: model window = 40 (`trimHistory`), storage cap = 50 (`memory.append`)
- **Never reintroduce a blind `slice`/`splice`** — it can drop the issue or split a `tool_use`/`tool_result` pair, which the Anthropic API rejects with a 400 on long investigations

### Alert Deduplication (multi-pod safe)
- Fingerprint: all labels sorted and joined → stable string
- TTL: 12 hours (matches Alertmanager `repeat_interval`)
- **Redis-backed when `MEMORY_BACKEND=redis`:** the claim is an atomic `SET dedup:{fp} 1 EX <ttl> NX` — returns `"OK"` only for the first pod to see the alert, so under autoscaling N pods can't all investigate the same alert. In-memory `Map` is the **single-pod fallback** when Redis isn't configured.
- Reuses the **one shared Redis connection** (`src/redis.ts` singleton, `getRedis()`), same client as conversation memory — zero new deps, zero extra connection. `shouldProcess()` is now **async** (Redis call); caller `await`s it in `handleAlert`.
- `dedup/index.test.ts` covers the in-memory fallback path (first-vs-repeat, label-order stability, TTL expiry).

### Alert Correlation (one investigation per Alertmanager group)
`src/agent/correlation/index.ts` (pure, unit-tested). **One Alertmanager webhook = one group**
(its `group_by`, typically `alertname`+`namespace`), so every alert in the payload shares a
root cause. `handleAlert` now investigates the group **once** instead of looping per-alert —
N crashlooping pods used to spawn N threads / N investigations / N remediation cards / N× LLM cost.
- **Group identity** = `groupIdentity(payload)`: prefer Alertmanager's `commonLabels`, then
  `groupLabels`, else the computed `commonLabels(alerts)` (label intersection), else the first
  alert's labels. Guaranteed non-empty (an empty key would collide unrelated groups in Redis).
  For a **single** alert this is its full labels → identical behavior to before.
- Dedup, `storeIncident`, `resolveIncident`, and remediation all key on this group identity —
  which is exactly the `(alertname, namespace)` granularity recall already used, so grouping
  *aligns* the thread with the recall key instead of fragmenting it per pod.
- `buildGroupAlertText` lists the affected pods (capped at 10, `+N more`) in the issue text so
  the investigation sees every target; the identity labels drop `pod` for a multi-pod group, so
  the pod list in the **text** is how the agent learns which pods to `describe_pod`.
- **Its output has two readers: Slack and the LLM.** `app/index.ts` posts the string *and* feeds
  the same string to `investigate()` — so nothing may be dropped for looking ugly, only
  re-rendered. That is the rule behind the annotation cleanup: rule packs template
  `\n VALUE = …\n LABELS = map[…]` onto the description, and the Go map is cut (`ANNOTATION_NOISE`)
  only because a sorted `*Labels:*` line puts the same labels back in a readable form. `container`
  is promoted to its own field — for an OOMKill it is the most important field and used to exist
  only inside the prose — and is rendered from `commonLabels`, so a group spanning two containers
  shows none rather than the first one's. Labels already rendered as fields are excluded, plus
  `uid` (unqueryable, changes every restart). Summary/description prose is otherwise left alone:
  stripping the `(instance …)` suffix would need parenthesis heuristics, and `instance` is the
  node on node-level alerts.
- Resolved path (`handleResolvedAlert(groupLabels, resolved)`): a group with **no firing alerts
  left** runs the resolved loop once (clear dedup + `resolveIncident` + ✅). A mixed payload with
  any firing alert is still treated as an active group.
- **Deliberately NOT** correlating across different alertnames/webhooks (node-down fan-out) —
  that heuristic risks merging unrelated incidents (Tier-3 backlog).

### Alert Webhook Auth (`ALERT_WEBHOOK_TOKEN`)
`POST /alert` now triggers investigations **and** remediation proposals, so an open port is a
real trust boundary. `_authorizeAlert` requires `Authorization: Bearer <ALERT_WEBHOOK_TOKEN>`
when the env var is set; unset = open + a **startup warning** (backward-compat, same policy as
`MCP_AUTH_TOKEN`). Compare via `timingSafeEqualStr` (`src/utils/auth/index.ts`: sha256 →
`crypto.timingSafeEqual`, constant-time, never leaks token length). Alertmanager sends it via
`http_config.authorization.credentials`. `/health` stays unauthenticated for probes.
`utils/auth` is unit-tested (`timingSafeEqualStr` match/mismatch/length-safety, `bearerToken` parsing).

### Readiness `/health`
- `GET /health` calls `agent.healthCheck()` → checks MCP (`isConnected()` flag) + Postgres (`SELECT 1`, only if incidents enabled) + Redis (`PING`, only if backend=redis).
- Returns **`503`** when any configured dependency is down, `200` + `{checks}` when all up — so K8s readiness probes stop routing to a pod that can't investigate. Wire `readinessProbe: httpGet /health` in the Deployment.
- MCP check is a **real MCP `ping` request** (5s timeout) — upgraded from the cached connect flag after testing hit the dead-but-flagged-up case (MCP down after startup, `/health` still 200). On ping failure it also flips `connected` so the next tool call takes the reconnect path.
- The **MCP server itself** probes its upstreams (Prometheus/Loki/tracing) at startup and logs `Upstream UNREACHABLE` warnings — non-fatal by design (Prometheus down must not take k8s tools down). Surfaces wrong `PROMETHEUS_URL`-style misconfig at deploy time instead of first tool call.

### MCP HTTP Auth (shared bearer token)
- Set the **same `MCP_AUTH_TOKEN`** on the agent and the MCP server (from one K8s Secret).
- Agent: `StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: \`Bearer <token>\` } } })` when set (`mcp/client.ts`).
- Server (`devops-mcp-server/src/app/index.ts`): middleware on `/mcp` requires the bearer token, returns `401` otherwise; `/health` stays open for probes. Compare via `timingSafeEqualStr` (sha256 → `crypto.timingSafeEqual`) — constant-time, never leaks token length. Token unset → open but logs a **warning** in http mode (never silently open). `auth.test.ts` covers match / equal-length-mismatch / different-length-no-throw.
- **Prerequisite for write/remediation tools** — never expose a state-changing tool behind an unauthenticated transport.

### LLM Output Tokens / Model
- `MAX_TOKENS` env (default `8096`) caps output for the **claude + openai-compatible** paths (`config.llm.maxTokens`); was hardcoded in `claude.ts` and entirely missing in `openai-compatible.ts` (so it used the provider default and could truncate).
- `CLAUDE_MODEL` default is `claude-opus-4-8` (latest opus tier). SQS path's model + token limit live in **llm-worker**, not here — don't push them from the agent (two sources of truth).

### Incident Memory (durable, `agent/incidents/index.ts`)
- **Purpose:** learn from past RCAs — recall prior resolved incidents for the same `(alertname, namespace)` and inject a compact digest into the prompt so recurring incidents aren't re-diagnosed cold.
- **Store = Postgres (`pg`), NOT Redis.** Redis here is a cache (conversation memory, 24h TTL, evictable); incident memory is a system-of-record that must persist for months. Enabled only when `DB_HOST` is set (discrete `DB_*` vars → `pg.Pool` via `db/pool.ts`; `DB_SSL_MODE` maps to pg's `ssl`); `IncidentMemory(null)` is a safe no-op otherwise (single-pod dev works without Postgres).
- **Schema = versioned migrations, NOT inline DDL.** `migrations/*.sql` applied by a framework-free runner (`db/migrate.ts`, uses installed `pg`): tracks applied files in `schema_migrations`, each in a txn, guarded by a **`pg_advisory_lock`** so concurrent pod startups (autoscaling) serialize instead of racing on `CREATE TABLE`. `runMigrations()` runs on agent startup AND via `npm run migrate` / `migrate:prod` (for a K8s Job/initContainer). `migrations/` is copied into the Docker image. Add changes as `002_*.sql`. `pendingMigrations()` (pure: filter/sort/skip-applied) is unit-tested. `IncidentMemory` no longer does DDL.
- **Wiring:** owned by `DevOpsAgent` (alongside Redis/memory init), exposed as `recallIncidents(labels)` / `storeIncident(labels, rca)`. App calls them only on the **alert path** (`investigateAlertInBackground`) where `alert.labels` give `alertname`/`namespace`; recall + store are best-effort (`.catch`) so a DB failure never breaks an investigation. Mentions have no labels → not stored.
- **Recall = exact label match, no vector DB** (`// ponytail:` add embeddings only if too coarse). Past incidents framed as **Hypothesis to verify** (system prompt + injected block) to avoid anchoring on a stale root cause.
- `parseConfidence` reused; `parseSeverity` + `extractRootCause` are local, unit-tested in `incidents/index.test.ts`.

### Incident Dashboard (`src/dashboard/`, phase 1)
Read-only, server-rendered, second HTTP listener in the agent process (`DASHBOARD_PORT`,
default 3001, off unless `DASHBOARD_ENABLED=true`). Design:
`docs/superpowers/specs/2026-08-03-dashboard-design.md`; §3.1 of that spec ("no auth") is
superseded by `docs/DESIGN_dashboard_auth.md`.

**Auth: one shared password, session in a signed cookie** (`src/dashboard/auth.ts`). The token is
`v1.<exp>.<base64url hmac>` and the HMAC key is `scryptSync(DASHBOARD_PASSWORD, fixed salt)` — a
*derived* key rather than a random one, so sessions survive a restart and are valid on every
replica (a Map of session ids would sign everyone out on each rolling update, which lands during
an incident, which is when the page is open). scrypt rather than a bare HMAC over the password
because the token is two thirds public, so its signature is an offline oracle for the key.
Rotating the password invalidates every session; that is the revocation mechanism.
- **Unset password = 503 on every route but `/healthz`** — never anonymous content. The probe
  stays open so a missing Secret cannot take the pod out of service.
- Route order in `handle()`: parse → **method gate** (405, before auth: a stranger's POST and an
  operator's get the same answer) → `/healthz` → 503 gate → `/login` → session gate → 404 →
  `/topology` → DB gate. The 404 is deliberately *behind* the session now: an unauthenticated
  caller learns nothing about which paths exist.
- Cookie: `HttpOnly; SameSite=Strict; Secure` (`DASHBOARD_COOKIE_SECURE=false` only for plain
  HTTP on a hostname — browsers exempt localhost, so a port-forward is unaffected).
- `safeNext()` guards the post-login redirect (rejects `//host`, `/\host`, absolute URLs, control
  characters) — it lands in a `Location` header and arrives from a URL anyone can send an operator.
- `LoginThrottle` keyed on `remoteAddress`: 10 failures / 5 min → 429 + `Retry-After`. Behind a
  proxy every client shares one bucket, deliberately — trusting `X-Forwarded-For` would make the
  throttle decorative.
- CSP gained `form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. `form-action` does
  **not** inherit from `default-src`, so the login form worked without it; it is there to pin
  where the password may be posted now that there is a session to steal. The policy is built by
  `csp(nonce?)` and is **per route**: only `/topology` passes a nonce and so gets a `script-src`
  at all. Everywhere else there is no exemption, which is what keeps a missed `esc()` inert on
  the pages that render an RCA.

**Its own pool, `max: 3`, with `statement_timeout = 3s`.** Sharing the agent's pool would let
one slow dashboard query starve `storeIncident` of connections — the investigation finishes and
the result is silently lost. Every query carries a `LIMIT` (page size 50, hard cap 200) and the
overview aggregates are cached for 60s: a held-down refresh key is otherwise unthrottled load on
the same event loop that handles alerts, and a signed-in operator can hold one down as easily as
a stranger could.

**Nothing rendered is trusted input.** `rca`/`root_cause` are LLM output and the labels come from
Alertmanager, so every interpolation goes through `esc()` in `html.ts`. That helper's test is the
security-relevant one in this module.

**`/topology`** renders the agent's declared dependencies from `config` — no probe, no outbound
call, no database read, so it is the one page that still works while Postgres is down. Design:
`docs/superpowers/specs/2026-08-04-topology-design.md`.

`buildTopology()` (`src/dashboard/topology.ts`) **is the allowlist**: it names every field it
emits, one at a time. It must never iterate the config object and never filter a known-bad set
out of it — the config holds every secret this service has, one shared password stands between a
leak and all of them, and a denylist stops being correct the moment someone adds the next secret,
silently (`DASHBOARD_PASSWORD` is itself in the sentinel list). Secrets
render as "set"/"not set"; endpoints go through `redactUrl()` (userinfo and query stripped).
`topology.test.ts` seeds every secret-bearing env var with a sentinel and fails if one reaches
either the data structure or the rendered HTML — that test is what keeps the allowlist honest
as the config grows.

**Interactive map (`src/dashboard/topology-script.ts`).** Drag to pan, ctrl/cmd + wheel or the
toolbar to zoom; one inline `<script>` carrying a **per-response nonce** (`randomBytes(16)`,
base64url), never `'unsafe-inline'` — see `docs/DESIGN_dashboard_auth.md`. It is progressive
enhancement: the page still ships the script-free three-radio scale control, and the script
removes it, flips `data-live="on"`, and drives the **`viewBox`** instead (not a CSS transform —
the SVG keeps its own box, so a pointer position converts to user units by one ratio and pan
needs no scroll container). With scripting off the map still renders, scales, and links.
Non-obvious, and each one is load-bearing:
- Pointer capture is taken **after 4px of movement**, not on `pointerdown` — capturing early
  retargets the following `click`, and every box in the map is a link to its own table row. A
  `dragged` flag (cleared by the click it swallows) stops a drag that ends on a box from also
  opening it.
- `aria-disabled`, not `disabled`, on the zoom buttons: a disabled button drops focus the moment
  the keyboard reaches the limit, and the next Tab restarts from the top of the document.
- **Ctrl/cmd + wheel only.** A bare wheel keeps scrolling the page — the map sits mid-document,
  and a figure that swallowed the wheel would trap the reader every time the pointer crossed it.
  `touch-action: pan-y` does the same job for one-finger drags on a phone.
- A `focusin` handler pans a focused box back inside the viewBox. Nothing else can: the viewBox
  clips it, so there is no scroll for the browser to do.
- The script-free controls are removed **last**, after every listener is wired, so a throw on any
  line leaves the page with a zoom control that still works.
- `topology-script.test.ts` guards the cross-file couplings nothing else would catch: the script
  can't close its own `<script>`; it builds no markup and evaluates no strings (the nonce buys
  one trusted block, not a licence for that block to reopen the injection surface); every
  selector it queries is derived from its own source and asserted against the rendered page; and
  the `data-live`/`data-drag` attributes it sets are the ones `styles.ts` reacts to.

**`llm_usage`** (migration 004) records one row per LLM call, with the router's backend and route.
`incident_id` is NULL at insert — the usage rows are written during the investigation, the
incident row only exists after — and is backfilled by `IncidentMemory.store()` via the
`onStored` callback. Rows for conversation-mode replies stay NULL forever, which is correct.

### On-call Feedback Learning (`@agent learn` — trust-tiered memory)
Design: `docs/DESIGN_oncall_feedback_learning.md`. Two tiers, never flattened:
**hypothesis** (agent RCA, `incidents`) vs **CONFIRMED** (human, `incident_feedback`).
- **Trigger (v1): explicit** — `@agent learn` inside an alert thread (keyword-routed in `handleMention`, `/^learn\b/i`). No broad `message.channels` scope; the human decides what's worth learning. `reaction_added` (✅) is the planned second trigger; passive capture is v2.
- **Flow:** thread → `findIncidentByThread(channel, thread_ts)` (linked since migration 002) → `conversations.replies` transcript (`buildTranscript`: humans vs agent labeled, tail-biased 6k cap) → ONE tool-less extraction LLM call (minimal system prompt) → `parseFeedbackJson` (tolerant: fences/prose, outcome normalized, null when nothing substantive) → `storeFeedback`.
- **Idempotent:** `trigger_key` = ts of the learn message; unique `(incident_id, trigger_key)` → code `23505` mapped to "duplicate". Re-learning after a correction = new message ts = new row (latest rows win in recall).
- **Recall renders CONFIRMED first** as a strong prior ("check this hypothesis FIRST, mention the past fix in Recommended Actions"), hypotheses after ("verify before reuse"). Framing lives in both the injected block and `prompts/system.md` Evidence Rules.
- The ack echoes what was learned so on-call can correct mistakes (extraction quality mitigation). `raw_excerpt` stored for provenance.
- Feeds Guarded Remediation later: `action_taken` history informs/annotates action proposals.

### Alert flow is format-agnostic (recurrence shortcut)
- An alert investigation may return either the full RCA template (rendered as Block Kit card) **or** a concise conversational reply — a recognized recurrence of a CONFIRMED prior is explicitly ALLOWED to skip the template ("known recurrence + confirmed root cause + verified evidence + concrete fix"). Non-RCA replies post as fence-safe split plain text.
- **Incident store, `markRcaSent`, and remediation proposal run unconditionally** — none of them need the template. `store()` falls back to the alert label's severity and the reply's opening 300 chars as `root_cause` when the RCA labels are absent.
- **Do NOT reintroduce a "reformat to RCA" LLM call.** Tried twice, failed twice with the private LLM: (1) output labels without the emoji prefixes `buildRcaBlocks` parses by → card rendered nearly empty; (2) model echoed the bare template skeleton (`[one paragraph]`) and dropped all investigation content — and it passed the `isRcaResponse` gate because a placeholder is a non-empty section. Format-agnostic pipeline replaced it (net less code).
- Rendering gate = `isRcaResponse(t) && extractSection(t, "Root Cause")` (`extractSection` exported for this) — `isRcaResponse` alone let through texts that rendered as an empty card.

### Guarded Remediation (approval-gated execution)
Design: `docs/DESIGN_guarded_remediation.md`. 6 typed actions (`k8s_rollout_restart`,
`k8s_set_image`, `k8s_set_resources`, `k8s_scale`, `k8s_delete_pod`, `flux_reconcile`).
`flux_reconcile` is proposed only by the **drift path** (below), never by the proposal LLM —
it is not in `parseProposal`'s whitelist. `k8s_delete_pod`
(v1.3) deletes ONE wedged pod so its controller recreates it — refused for pods without a
recreating controller (ReplicaSet/StatefulSet/DaemonSet; naked/Job pods = no replacement =
outage); GitOps-safe like restart, so NOT behind the GitOps guard. Needs RBAC
`get`+`delete` on pods. Its 90s status check strips the pod's random suffix so the filter
matches the replacement pod.
Enforcement layering (never trust a single layer): **RBAC** (floor) → **MCP server**
(namespace allowlist + always-blocked kube-system/kube-public/kube-node-lease/flux-system;
write tools not even REGISTERED unless `MCP_ENABLE_WRITE_TOOLS=true`) → **agent**
(action whitelist in `parseProposal`; UX only).
- **Proposal flow** (alert path, after `storeIncident`): separate structured-output LLM call → `parseProposal` (whitelist gate, unit-tested) → **mandatory dry-run** via MCP (server-side `dryRun: "All"` — bad target/blocked namespace = no card) → `RemediationStore.propose` (partial unique index = one active card per incident, cross-pod) → Block Kit card. Every early-exit returns null: **no card = nothing can execute**. Agent auto-detects write tools via `getTools()` — zero agent config.
- **Approval flow** (`app.action` approve/reject): `ack()` first (Slack 3s limit) → approver gate (`SLACK_APPROVER_USERS` fallback oncall; both empty = anyone + warn) → **atomic claim** `UPDATE ... WHERE status='proposed' AND created_at > now()-15min RETURNING` (double-click/multi-pod: exactly one wins; losers told "taken"; late clicks told "expired" and the row is closed out) → card shows ⏳ → execute MCP tool → `finish()` records succeeded/failed + result → card shows ✅/❌.
- Requires Slack app **Interactivity ON** (Socket Mode — no public URL).
- Statuses: proposed → executing → succeeded/failed, or rejected (incl. expiry). `approved_by`, `executed_at`, `result` = audit trail.
- Rollout restart = patch `kubectl.kubernetes.io/restartedAt` annotation (honors rolling-update strategy + readiness probes; same as `kubectl rollout restart`).
- **SECURITY — write tools never enter the agentic loop.** Auto-discovery would otherwise hand `k8s_rollout_restart` to the model during ANY investigation, bypassing the approval gate. Two layers in `agent/index.ts`: (1) tools whose description starts with **`[WRITE]`** are filtered out of the `llm.chat` tools list; (2) `executeToolCalls` refuses them with a synthesized error if the model hallucinates the name anyway. **Convention: every write tool's description MUST start with `[WRITE]`** (enforce when adding scale/rollback). Write tools are reachable only via `proposeRemediation` (dry-run) and `executeRemediation` (post-approval), both direct `callTool`.
- **Mention-driven investigations get the same remediation flow**: `handleMention` calls `maybeProposeRemediation` with `incidentId=null` (no alert labels → no incident row; `remediations.incident_id` is nullable). Note: NULLs are distinct in the partial unique index, so the one-active-card guard only applies to alert-driven remediations.
- **Proposal observability:** every null path in `proposeRemediation` logs why (raw model output on parse failure, unregistered action, dry-run refusal, duplicate/store failure) — silent no-card failures cost a full debugging round during live testing.
- **Remediations are recalled as agent memory** (`recallRemediations` → `RemediationStore.recallForAlert`): on the alert path, past executed remediations for the same `(alertname, namespace)` — joined via `remediations.incident_id = incidents.id` — are injected alongside `recallIncidents` into BOTH the investigation and the proposal context ("Previously remediated — same alert: 2026-07-23 set image → repo:v2 — succeeded (PR: ...)"). So a recurrence recalls what was actually DONE (+ the PR/outcome), not just the diagnosis, and the proposal model avoids re-proposing an already-applied fix. Everything's already stored in `remediations` (`params.changes` from→to, `path`, `valuesKey`, `result`=PR URL, `status`) — no schema change; rollback data lives there too (revert the PR = natural GitOps rollback). Keyed by alert → mention-driven flows (no labels) don't recall.
- **Dry-run refusals are posted to the thread** (`{ refused }` return → "🚫 Remediation not proposed — <server reason>"): the model wanted to act but the MCP server refused (GitOps guard / blocked namespace / bad target) — the human deserves the reason, especially "managed by Flux/Helm, change it in the GitOps repo".
- **`parseProposal` normalizes `kind` case** — a correct proposal was dropped over `"kind":"Deployment"` (K8s convention capitalizes; our zod enums are lowercase).
- **Partial RCA leaks are reformatted too** (`leaksRcaStructure`, unit-tested): a change-request reply once shipped as a wall of text — "Proposed plan Immediate/Short-term", "Impact if Unresolved", "Confidence: High", closing "proceed?" question — WITHOUT the Severity label `isRcaResponse` keys on. ≥2 distinct section markers now trigger `reformatToConversation` (which also strips proceed-questions, command instructions, and caps length). system.md caps direct change-request replies at 5 lines. **Mutating kubectl/helm command dumps** (`kubectl rollout/scale/set/patch/...`, `helm upgrade/rollback`) are a leak class of their own — one hit triggers the reformat alone; read-only commands in passing don't.
- **Remediation lifecycle events are appended to thread memory** (`noteInThread` → `[system note] ...` assistant message): card posted / refused / executed / rejected happen OUTSIDE the LLM conversation, and the model once answered "yes" (to its own question) with "I'll open an approval card" right after the server refused one — it had never seen the refusal. system.md tells the model `[system note]` semantics and forbids "do you want me to proceed?" / "I'll open a card".
- **`container` is optional** in `k8s_set_image`/`k8s_set_resources`, both in the proposal schema and the MCP tool: the proposal model CANNOT know container names (not in its context) and guessed one from the workload name (`dev-auth-svc-be` vs actual `auth`). The MCP server auto-resolves single-container workloads and refuses multi-container ones with the name list. Proposal prompt rules: NEVER guess a container name; workload = Deployment/StatefulSet/DaemonSet name, NOT a pod name; an explicit user request ("ganti tag ke latest") is sufficient evidence for any whitelisted action — user-given tag + current repo from context.
- **Approval card mentions the approvers** (`<@Uxx>` in the section block → real Slack notification): `SLACK_APPROVER_USERS` fallback `SLACK_ONCALL_USERS`; both empty = no mention line.
- **GitOps overlay path is auto-detected from Flux** (`resolveOverlayPath`, `gitops/overlay.ts`): a Flux HelmRelease workload's HR CR carries `kustomize.toolkit.fluxcd.io/{name,namespace}` labels (the HR CR is applied by kustomize-controller, so it — unlike the Helm-rendered workload — has them). The agent reads the HR CR → the Kustomization CR → `spec.path` (e.g. `apps/dev/applications`) via the read-only `k8s_get_custom_resources` tool, and sends it as `pathPrefix` in the gitops request so the worker scopes the file search to the right per-env overlay (dev/stg/prd, applications vs systems — all automatic, zero config). Best-effort → falls back to the worker's `GITOPS_PATH_PREFIX`. This also resolves the base+overlay ambiguity (both define the HR; the prefix picks the overlay). **Detection itself needs no manifest change** — Flux auto-adds `helm.toolkit.fluxcd.io/name` to Flux-managed workloads (plain `helm install` like a standalone ingress-nginx lacks it → correctly refused).
- **GitOps PR flow (v2, `DESIGN_gitops_pr_remediation.md`, opt-in `GITOPS_REMEDIATION_ENABLED`):** for a Flux HelmRelease-managed workload the MCP dry-run returns a structured PR preview (not a plain refusal). `parseGitOpsPreview` detects it → `proposeGitOpsPr` asks the **llm-worker** over a second SQS queue (`SqsGitOpsClient`) to prepare the PR (`dry_run` → diff), stores a PR-flavored remediation (`params.gitops=true` + helmRelease/action/changes/path/valuesKey), and posts a GitOps card variant (diff block + file/key). Approve → `executeRemediation` branches on `params.gitops` → `executeGitOpsPr` (`open_pr` → PR URL in `result`; **no 90s status check** — nothing is live until merge+Flux sync). `SqsGitOpsClient` is a **standalone mirror** of `SQSLLMClient` (NOT a shared base — the LLM client is the battle-tested critical path; two dispatchers cooperate via the shared response queue's release-non-owned mechanism). The agent holds **no GitHub credentials** — those live in the worker. GitOps action names in the preview/request are the SHORT forms (`set_image`/`scale`/`set_resources`), distinct from the DB `action` column's tool name (`k8s_set_image`).
- **Cluster/GitOps drift → `flux_reconcile`, not a PR.** Someone changes the cluster directly (`kubectl set image` on a Flux-managed workload); an alert fires; the RCA is fine; then the remediation died with *"the value is not set in the overlay and can't be auto-added for this action — set it in the overlay values first"*. That message was wrong: the incident context's `from` is the **drifted cluster value**, which naturally isn't in Git, and the worker's line search (key AND value) couldn't tell that apart from "the key isn't there". The worker now returns `drift:{path, valuesKey, gitValue, clusterValue}` (see llm-worker `detectDrift`), and `proposeGitOpsPr` branches to `proposeFluxReconcile` **before** treating it as a refusal:
  - proposes the MCP `flux_reconcile` write tool on the workload (parsed out of the preview's `kind/ns/name` by `workloadOf`), after the same mandatory dry-run;
  - card reads *"Flux reconcile `ns/name` — restore `image.tag` to `v1.4.0` (cluster drifted to `v9.9.9`)"*;
  - **still approval-gated** — the drifted value is occasionally the intended one, in which case the human wants a PR declaring it, not a reconcile discarding it;
  - if the MCP server is older and lacks the tool, the refusal text spells out the `flux reconcile helmrelease <ns>/<name> --force` command instead.
  Direction is fixed on purpose: the GitOps repo is the source of truth, so a reconcile RESTORES what Git declares rather than writing the drifted value into Git.
- **Post-remediation status check** — 90s after a successful execution (`STATUS_CHECK_DELAY_MS`), the app posts the target workload's pod status into the thread (deterministic: `k8s_list_pods` filtered by workload-name prefix, no LLM call). `executeRemediation` returns `{ text, target? }` for this. `// ponytail:` in-process timer, lost on pod restart within the window.
- **Proposal context = head+tail of the RCA** (`buildProposalPrompt`), never head-only: long RCAs put the concrete fix in Recommended Actions at the END — a head-only `slice(0,4000)` cut it off and the model proposed nothing. The alert path also prepends the CONFIRMED prior (first 1200 chars) — a recurrence's proven fix is exactly what the proposal model needs. A user request without a concrete value (e.g. "ganti image tag" with no tag) correctly yields `{"action": null}` — never-invent beats a guessed card.

## LLM Providers

| `LLM_PROVIDER` | Class | Notes |
|----------------|-------|-------|
| `claude` | `ClaudeClient` | Anthropic SDK, prompt caching |
| `openai-compatible` | `OpenAICompatibleClient` | Any OpenAI-compatible API |
| `private-llm` | `SQSLLMClient` | Event-driven via SQS, for strict private networks |
| `router` | `RouterLLMClient` | Workload-routed, up-only failover across the other three — see below |

### LLM Router (workload routing + up-only failover)
`LLM_PROVIDER=router` selects `RouterLLMClient` (`src/agent/llm/router.ts`), a fourth branch in
`createLLMClient()` (`src/agent/llm/index.ts`) alongside `claude`/`openai-compatible`/`private-llm`.
It carries no LLM logic of its own — it holds instances of the three existing clients and picks
which one answers a given call. Full design: `docs/superpowers/specs/2026-07-30-llm-router-design.md`.

**Registry (`src/agent/llm/registry.ts`).** Backends are declared with indexed env vars
`LLM_BACKEND_<N>_NAME|KIND|MODEL|BASE_URL|KEY` (`KIND` is one of `claude`, `openai-compatible`,
`private-llm`; only `private-llm` needs no extra fields — its queues/credentials come from the
existing SQS/AWS config, shared by every replica). The backend **name is a value, never part of a
key** — adding a backend never means inventing a new env var name, and routes reference the name so
renumbering indices never breaks routing. Each field is its **own** env var rather than one JSON/YAML
blob, specifically so `_KEY` can come from a K8s Secret while `_NAME`/`_KIND`/`_MODEL`/`_BASE_URL`
come from the HelmRelease's plain `extraEnvVars` — a blob containing a key would force the whole blob
into a Secret. Indices are scanned 1→20 and must be **contiguous from 1** (a gap throws — most likely
a copy/paste or deleted-entry mistake, caught at boot instead of silently skipping a backend).
Whitespace-only values are rejected. A backend name may not appear in both `LLM_ROUTE_HEAVY` and
`LLM_ROUTE_LIGHT`, nor twice within the same list — each backend is tried at most once per `chat()`.

**Routes.** `LLM_ROUTE_HEAVY` is required (comma-separated backend names). `LLM_ROUTE_LIGHT` is
optional — when unset, light-marked calls fall straight through to the heavy chain, which reduces the
router to failover-only across strong backends and is a legitimate way to run it (no separate off
switch needed).

**Routing signal (`withRoute`/`currentRouteContext`, `src/utils/trace/index.ts`).** `chat()`'s
signature carries no workload parameter, and it must not — that would touch three client
implementations and every call site for a concern none of them own. Reuses the exact
`AsyncLocalStorage` pattern already built for `traceId`: `withRoute(route, fn)` stores a mutable
`{ route, escalated }` context over the async subtree. **Default is heavy; light must be requested
explicitly.** Exactly two call sites opt into light: conversation-mode mentions in `handleMention`
(`src/app/index.ts`) and `reformatToConversation` (`src/agent/index.ts`). Everything else — alert
investigation, remediation proposal parsing, feedback extraction — stays heavy untouched. The
asymmetry is deliberate: anyone adding a new LLM call later gets the strong model by default, not a
silent downgrade. Reading the `[USER MESSAGE ...]` prompt marker to infer route was considered and
rejected — markers are prompt text, so a rename would silently disable routing with no error, and
`reformatToConversation` uses a minimal system prompt with no marker at all.

**Three failure signals** (`router.ts`, all pre-existing failure modes in this codebase, none new):
1. a thrown error (network, 5xx, timeout, SQS deadline);
2. an empty response (small reasoning models exhausting their token budget on hidden thinking — see
   *Reasoning-model token exhaustion* above);
3. a response that is raw serialized content-block JSON (the same regex detector `agent/index.ts`
   already used, reused not rewritten).

A `stopReason: "tool_use"` response legitimately carries no text and is deliberately **not** treated
as empty — treating it as a failure would escalate every single tool round of every investigation.
Signal 3's meaning was corrected during this work: the JSON originally seen in Slack was our own bug
(`JSON.stringify` in `toOpenAIMessages`, since fixed — see *Anthropic content blocks → OpenAI chat*
below), not evidence the model is weak. Today it means **this backend's tool-call channel is dead** —
either our translation regressed, or the backend runs without a tool-call parser (e.g. vLLM started
without `--enable-auto-tool-choice --tool-call-parser`). Escalating on it is right either way, but it
does mean a translation regression would be masked by quietly falling up to the expensive model —
mitigated by logging this case at `warn` with its own distinct message naming the likely cause, never
folded into the generic failover line.

**Direction — one-directional, up only. This is the single rule that must never be "improved" into
bidirectional failover.** The effective chain for `light` is the light list followed by the heavy
list; the effective chain for `heavy` is the heavy list alone — heavy **never** descends into light.
Lateral failover between strong backends (e.g. `opus` → a second heavy entry) is preserved, since
that isn't a capability downgrade. The reason is asymmetric risk, not convenience: a failed strong
model is a visible outage — it throws, the investigation fails loudly, someone notices immediately. A
weak model answering a complex investigation may not throw at all — it can return a confident, wrong
RCA that gets posted straight to Slack, and nobody notices until the fix doesn't work. Falling up
trades an outage for a slower answer; falling down would trade a visible failure for an invisible
one. This is enforced by `router.test.ts`'s "a throwing heavy backend propagates and NEVER falls down
to light" case, plus "withRoute('heavy') uses the heavy chain and never touches light" — without
tests asserting it, the rule lives only in this document and the next person who finds bidirectional
failover "more robust" will change it with nothing objecting.

**Stickiness.** Each backend is tried at most once per `chat()` call — the underlying clients already
retry/backoff on their own, stacking router-level retries would only slow the failure down (route
lists may not overlap; `parseRegistry` rejects a name appearing in both). `ctx.escalated` flips true
only when a call **succeeds on a backend past the end of the light list** — i.e. it actually crossed
into the heavy tier. A lateral hop within light (`light1` fails, `light2` answers) does not set it,
and neither does a chain that exhausts entirely, so the next call re-pays the light attempt. Once
set, every remaining call in that investigation skips the light tier and goes straight to heavy;
without it a multi-round investigation against a dead light backend would pay one wasted light
attempt per round. The context lives in `AsyncLocalStorage`, so concurrent investigations sharing the
one `RouterLLMClient` never see each other's flag — asserted by "escalation in one flow does not leak
into a concurrent one", the only test that fails if the context is replaced by a module-level object.

**Boot-time validation.** `parseRegistry` runs once at startup inside `createLLMClient()`, not lazily
on first request — an env-var typo (bad `KIND`, missing required field, duplicate name, a route
naming an unregistered backend, empty `LLM_ROUTE_HEAVY`) throws and stops the pod, so the failure
shows up as a pod that won't come up rather than the first alert of the day silently misrouting.
`RouterLLMClient.shutdown()` calls every registered backend's optional `shutdown()` with
`Promise.allSettled` — one failing backend (e.g. `SQSLLMClient`'s queue teardown) can't leak the
others on restart. `createLLMClient()` also rejects an unknown `LLM_PROVIDER` instead of falling
through to `claude` — same rule, so `LLM_PROVIDER=rooter` stops the pod rather than quietly running
on a provider nobody selected.

**Per-backend knobs are name, kind, model, base URL and key — nothing else.** A backend has no own
`maxTokens`: `MAX_TOKENS` stays global (`config.llm.maxTokens`) and applies to every `claude` and
`openai-compatible` backend alike, while a `private-llm` backend gets its ceiling from the
llm-worker's own `LLM_MAX_TOKENS`. Adding a new public backend (DeepSeek, Mistral, an OpenRouter
entry) is therefore three env vars plus a key, with no code change — but if two of them need
different output ceilings, `MAX_TOKENS` is the thing that has to grow a per-index override first.

Spec: `docs/superpowers/specs/2026-07-30-llm-router-design.md`.

### Anthropic content blocks → OpenAI chat (`toOpenAIMessages`)
Both OpenAI-shaped paths (`openai-compatible.ts` here, `llm.ts` in llm-worker) must translate
our Anthropic-style `Message[]` into native OpenAI: `tool_use` → `assistant.tool_calls[]`,
`tool_result` → `role:"tool"` with `tool_call_id`, tool messages emitted **before** any new
user text in the same turn.
- **This was `JSON.stringify(m.content)` in both files.** The literal `[{"type":"tool_use",...}]`
  reached the model as TEXT; a small private LLM imitated it and answered with that JSON
  instead of calling a tool. `finish_reason` was then `stop`, so the agent treated it as the
  final answer and posted the raw array to Slack — which re-entered history and got
  stringified again, so escaping nested one layer deeper every turn.
- Two copies in two repos, no shared module: **keep them in sync**.
- `openai-compatible.ts` also maps `finish_reason: "length"` → `max_tokens` (it mapped
  everything non-tool to `end_turn`, so a truncated RCA was posted as if complete even though
  the agentic loop already had a `max_tokens` handler).
- Malformed tool-call arguments keep the `tool_use` block with `input: {}` + a warning
  (dropping it would break tool_use/tool_result pairing); the tool's schema then corrects the model.
- The final answer is checked against `/^\s*\[\s*\{\s*"type"\s*:\s*"(text|tool_use)"/` and a
  warning names the likely cause (backend tool-call parser off) — otherwise the only symptom
  is a wall of JSON in Slack with nothing in the log.

### Private LLM via SQS
- Agent publishes `{ requestId, messages, tools, systemPrompt, traceId? }` to the shared SQS Request Queue
- **Shared response queue + one dispatcher per process:** a single `dispatchLoop()` per replica polls the shared response queue and routes each message to the waiting `chat()` call via `Map<requestId, waiter>` (`pending`). Replaces the old design where every concurrent investigation polled independently and **skipped non-matching messages without releasing them** — leaving them invisible for the whole visibility timeout and stalling the rightful waiter.
- **Poison-pill guard on the reply side (`parseResponseBody`, shared by both dispatchers).** `routeMessage` used a bare `JSON.parse(msg.Body!)`. One unparseable body on the shared response queue threw out of `routeMessage`, **aborted the rest of the receive batch (up to 9 valid responses skipped)**, and left the bad message undeleted — so it came straight back and the dispatcher hot-looped on it every 2s while every in-flight investigation timed out. Unroutable bodies (bad JSON, no `requestId`) are now deleted with the body logged, each message is routed inside its own try/catch, and an envelope with neither `response` nor `error` rejects the waiter loudly instead of resolving `undefined` into the agentic loop. The identical bug existed in `gitops/sqs.ts`.
- SQS has no selective receive, so a replica can pull another replica's response. Routing in `routeMessage()`:
  - ours & awaited → delete + resolve/reject
  - ours & already done (timed out) → delete — `issued` tombstone (TTL 2× timeout) recognises our own late/duplicate responses so they aren't bounced around
  - not ours → `ChangeMessageVisibility` release so the owner can grab it: `releaseVisibilitySeconds()` returns `0` (instant) up to `RELEASE_FAST_LIMIT=20` receives, then `60`s backoff so a true orphan (requester died) can't hot-loop the queue — SQS retention eventually clears it
- `chat()` registers the waiter, publishes, awaits a promise resolved by the dispatcher; per-request `setTimeout` enforces `SQS_LLM_TIMEOUT_SECONDS` (default 120)
- **Shutdown:** `SQSLLMClient.shutdown()` (via optional `LLMClient.shutdown?()`, called from `DevOpsAgent.shutdown()`) aborts the dispatcher and rejects pending waiters. No queues to delete — the response queue is shared, so **no per-replica queue sprawl** even under autoscaling.
- **SQSClient has explicit timeouts** (`requestHandler: { connectionTimeout, requestTimeout }`, `maxAttempts: 3`). Critical: the dispatcher is the **single** deliverer of all LLM responses — a hung SQS call (no timeout) once froze it permanently, so it delivered a couple of responses then silently stalled and every later investigation timed out. `requestTimeout = (pollWaitSeconds + 15)s` so the long-poll receive isn't cut short.
- IAM (private-llm provider): `sqs:SendMessage/ReceiveMessage/DeleteMessage/ChangeMessageVisibility/GetQueueUrl/CreateQueue` on `llm-*.fifo`
- Rejected alternative: per-instance reply-to queue (`llm-response-<podname>.fifo`). Cleaner routing but creates one queue per pod → list grows, orphans on hard crash. Chose the shared-queue dispatcher to keep the queue count constant at 3.

## Slack Modes

### Socket Mode (recommended for K8s)
- Set `SLACK_APP_TOKEN=xapp-...`
- Bolt connects outbound WebSocket — no public URL / Ingress needed
- Alertmanager webhook runs on separate Express server on same port

### HTTP Mode
- No `SLACK_APP_TOKEN`
- Requires publicly reachable Ingress/LoadBalancer
- `SLACK_SIGNING_SECRET` verifies request authenticity

## Environment Variables
```
SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN
SLACK_ALERT_CHANNEL, SLACK_ONCALL_USERS

LLM_PROVIDER            # claude | openai-compatible | private-llm
ANTHROPIC_API_KEY, CLAUDE_MODEL   # default claude-opus-4-8
OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_MODEL
MAX_TOKENS              # output ceiling for claude + openai-compatible (default 8096)

# Private LLM (SQS)
SQS_REGION, SQS_REQUEST_QUEUE_NAME, SQS_RESPONSE_QUEUE_NAME
SQS_LLM_TIMEOUT_SECONDS, SQS_POLL_WAIT_SECONDS
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  # local dev only; use IRSA on EKS

MCP_TRANSPORT, MCP_STDIO_ARGS, MCP_HTTP_URL
MCP_AUTH_TOKEN          # bearer token for MCP http transport; must match the server's MCP_AUTH_TOKEN
MEMORY_BACKEND, REDIS_HOST, REDIS_PORT, REDIS_DB, REDIS_PASSWORD, REDIS_TLS   # conversation cache + multi-pod dedup
DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD, DB_SSL_MODE   # durable incident memory; disabled if DB_HOST unset
MAX_CONCURRENT_INVESTIGATIONS
LOG_LEVEL   # error | warn | info | http | debug
```

## File Structure
```
src/
├── agent/
│   ├── index.ts                  # Orchestrator — agentic loop, parallel tool calls
│   ├── confidence/index.ts       # parseConfidence() — anchored regex, no false positives
│   ├── context/index.ts          # trimHistory(), sanitizeContentBlocks()
│   ├── correlation/index.ts      # groupIdentity(), commonLabels(), buildGroupAlertText() — one investigation per Alertmanager group
│   ├── dedup/index.ts            # AlertDeduplicator: fingerprint + TTL
│   ├── llm/
│   │   ├── index.ts              # createLLMClient() factory
│   │   ├── claude.ts             # Anthropic + prompt caching
│   │   ├── openai-compatible.ts
│   │   ├── sqs.ts                # SQSLLMClient: queue name resolution + auto-create
│   │   └── types.ts
│   ├── incidents/index.ts        # IncidentMemory: durable recall/store (Postgres) + ping()
│   ├── mcp/client.ts             # MCPClient: reconnect + mutex + isConnected() + bearer auth
│   ├── memory/index.ts           # Redis/in-memory, hasRca/markRcaSent
│   └── prompts/system.ts         # buildStaticSystemPrompt(), buildTimeContext()
├── app/index.ts                  # SlackApp: Bolt + ExpressReceiver + /health readiness + error handler
├── config/index.ts
├── redis.ts                      # Shared Redis singleton (conversation memory + alert dedup)
├── db/                           # pool.ts (DB_* → pg.Pool), migrate.ts (advisory-locked runner), migrate-cli.ts
└── utils/
    ├── auth/index.ts             # timingSafeEqualStr(), bearerToken() — /alert webhook auth
    ├── logger/index.ts           # Winston, LOG_LEVEL support
    └── slack/blocks.ts           # isRcaResponse(), buildRcaBlocks()
```

## AWS Authentication

Controlled by `AWS_AUTH_MODE` env var (read by `entrypoint.sh`):

| Mode | Setup | Use case |
|------|-------|----------|
| `iam-anywhere` | Writes `~/.aws/config` with `credential_process` pointing to `aws_signing_helper` | On-premise / private network with X.509 cert |
| `irsa` | No setup — IRSA injects credentials via projected service account token | EKS with IRSA |
| `env` | No setup — `AWS_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` already in env | Local dev, CI/CD |
| `instance-profile` | No setup — EC2 instance metadata used | EC2, ECS |

Default is `iam-anywhere` for backward compat — **set `AWS_AUTH_MODE=irsa` on EKS**.

Required only for `iam-anywhere`: `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH`.

## Bugs Fixed
1. **"Already connected to transport"** — MCP server HTTP mode creates new McpServer per request
2. **Follow-up always returns RCA format** — `[FOLLOW-UP]` prefix + `markRcaSent` Redis flag
3. **Block Kit not rendering** — LLM outputs `[Critical]`; regex handles both forms
4. **Race condition on reconnect** — `reconnectMutex` in MCPClient
5. **False positive confidence** — regex anchored to label
6. **Orphaned `tool_result` on long investigations** — two independent trimmers (`trimHistory` keep-first + `memory.append` blind splice) could drop the issue or split a `tool_use`/`tool_result` pair → Anthropic 400. Unified into pairing-aware `trimToWindow()`; covered by `context/index.test.ts`
7. **`/alert` webhook held open during investigation** — awaited the full multi-minute investigation before replying, causing Alertmanager timeouts/retries and late notifications for batched alerts. Now acks `200` immediately and investigates in the background (see Alert Webhook is Async)
8. **SQS response polling stalled waiters across concurrent investigations / replicas** — every concurrent investigation polled the shared response queue and skipped non-matching messages **without releasing them**, so they stayed invisible for the visibility timeout and the rightful waiter stalled (worse under autoscaling). Now a single dispatcher per process + `ChangeMessageVisibility` release with orphan backoff (see Private LLM via SQS); `releaseVisibilitySeconds` covered by `llm/sqs.test.ts`
9. **Empty RCA → Slack `no_text`** — when the model's final turn had no text, `investigate()` returned `""` and `chat.postMessage({ text: "" })` failed with `no_text`. `investigate()` now substitutes a fallback message so the return is never empty.
10. **Remediation proposals silently produced no card** — 4 null paths in `proposeRemediation` had no logging; a `{"action": null}` response was indistinguishable from a bug. All paths now log (incl. the raw model output).
11. **Proposal model guessed the container name** from the workload name → dry-run refused every `set_image`. Fixed structurally: `container` optional end-to-end, MCP server auto-resolves single-container workloads (`findContainer`, unit-tested).
12. **Model emits Markdown `**bold**`, Slack renders it literally** — Slack mrkdwn bolds with *single* asterisks. `toMrkdwn()` (in `utils/slack/split.ts`, fence-aware so log excerpts stay raw) normalizes every investigate() response up front — also fixes RCA-format detection when the model bolds the labels with `**`.
13. **CONFIRMED prior context broke the alert RCA format** — model shortcut to "known issue" replies; two reformat-to-RCA attempts produced garbage (see *Alert flow is format-agnostic*). Fixed by making the pipeline format-agnostic and allowing the concise recurrence reply on purpose. Garbage rows stored during testing were cleaned manually from `incidents`.
14. **Private LLM answered with our own content-block JSON** — `JSON.stringify(m.content)` in `openai-compatible.ts` (and the worker's `llm.ts`) put `[{"type":"tool_use",...}]` into the prompt as text; the small model copied it, the agent posted it to Slack, and the escaping nested one level deeper each turn. Fixed by `toOpenAIMessages` on both sides.
15. **One bad message on the shared response queue wedged the dispatcher** — unguarded `JSON.parse` in `routeMessage` (both `llm/sqs.ts` and `gitops/sqs.ts`); see the poison-pill note under *Private LLM via SQS*.
16. **A failed Slack post silently lost an alert for 12h** — `handleAlert` claims the dedup key BEFORE posting; if `chat.postMessage` threw (`channel_not_found`, `not_in_channel`, `invalid_auth`, rate limit) the claim sat for its full TTL and Alertmanager's repeat was suppressed, so a real incident was never investigated. The claim is now released on post failure with an explicit log.
17. **A corrupt Redis conversation entry wedged a thread permanently** — `ConversationMemory.get` parsed without a guard, and `append()` calls `get()`, so every message in that thread failed with an opaque parse error. Now logs and starts fresh.
18. **MCP reconnect masked the original tool error** — if the reconnect also failed, only the connect error surfaced. Both are reported now, and the tool name is in every MCP log line.
19. **Malformed tool-call arguments killed the investigation** with `Unexpected token` naming no tool — now kept as an empty-input `tool_use` + warning.

## Observability
- `logger` (`utils/logger/index.ts`) exports **`errDetail(err)`** — `${err}` in a template prints only `Error: message` and drops every frame. Use `errDetail` in catch blocks; `format.errors({stack:true})` handles Errors logged directly.
- **`traceId` = the Slack `threadId`**, carried implicitly via `AsyncLocalStorage` (`utils/trace/index.ts`) so `SQSLLMClient` can stamp it on outbound requests without growing `LLMClient.chat()`'s signature for a logging concern. `investigate()` wraps the run in `withTrace`. One grep now spans Slack thread → agent log → llm-worker log:
  ```
  [sqs-llm] → requestId=abc-123 trace=1785135868.123 msgs=7 tools=24 awaiting=2
  ```
- The LLM response's content-block types (+ a text preview) are logged per iteration — previously the log said only `stop=end_turn`, so garbled Slack output had no trace at all.
- Does NOT reach the MCP server: `StreamableHTTPClientTransport` takes headers only at construction. Join on tool name + input + timestamp.

## Testing
- `npm test` → `node --import tsx --test 'src/**/*.test.ts'` (Node >= 24 built-in runner + tsx, zero new deps)
- Test files (`*.test.ts`) excluded from `tsc` build so `dist/` stays clean
- Covered so far: `trimToWindow`/`trimHistory` pairing invariants, `truncateToolResult`, `sanitizeContentBlocks`, `ConversationMemory` (in-memory backend), `toOpenAIMessages` (tool round-trip + ordering), `parseResponseBody` (poison-pill), `releaseVisibilitySeconds`, `parseProposal`, Slack split/mrkdwn/Block Kit, gitops overlay + preview

### Alert Webhook is Async (do not re-block it)
- `POST /alert` validates the payload, returns `200` **immediately**, then processes in the background
- Inside `handleAlert`: each alert's Slack notification is posted up front (sequential, fast); the investigation is fired via `void investigateAlertInBackground(...)` so it never delays the next alert's notification or the webhook ack
- Background concurrency is bounded by the existing `Semaphore`; failures are caught and posted into the alert thread
- **Why:** investigations take minutes — awaiting them held the connection open past Alertmanager's seconds-long webhook timeout (causing retries) and serialized notifications so later alerts in a batched payload appeared late
- Trade-off: after the `200` ack a crash loses the in-flight RCA (not the alert — it's already in Slack); Alertmanager `repeat_interval` + in-memory dedup reset on restart re-trigger it. Graceful-shutdown drain of in-flight investigations is a possible follow-up.

## Alertmanager Config Notes
- `group_by: ["alertname", "namespace"]` — one webhook per alert+namespace. **Load-bearing for correlation:** the agent treats each webhook payload as one group and investigates it once (see *Alert Correlation*). Widen `group_by` → coarser incidents; per-pod grouping (adding `pod`) defeats correlation.
- `http_config.authorization.credentials: <ALERT_WEBHOOK_TOKEN>` on the webhook_config — must equal the agent's `ALERT_WEBHOOK_TOKEN` (see *Alert Webhook Auth*). Omit only if the token is unset.
- `repeat_interval: 12h` — agent dedup TTL matches this
- **`send_resolved: true` required for the resolved-alert loop** (D) — without it the agent never sees `status: resolved`, threads stay open and the dedup claim holds for the full TTL
- Label templating in `labels:` block NOT resolved by Prometheus — use `annotations:` only
- `startsAt` included in issueText as unix timestamp for query anchoring

## Roadmap / Backlog

### Done (recent)
- [x] **Distributed tracing** (3rd observability pillar) — Tempo/Jaeger adapters in devops-mcp-server (`tracing_search` / `tracing_get_trace` / `tracing_list_services`)
- [x] **Durable incident memory** (Postgres + framework-free migrations)
- [x] **Multi-pod alert dedup** (Redis `SET NX`) — replaces the old in-memory-only dedup
- [x] **Readiness `/health`** (503 when MCP/Postgres/Redis down)
- [x] **Configurable `MAX_TOKENS` + model default refresh** (`claude-opus-4-8`)
- [x] **MCP HTTP auth** (shared bearer token, constant-time check)
- [x] **Migration 002** — `remediations` + `incident_feedback` tables, `incidents.thread_ts/channel`, `storeIncident` returns id (shared prerequisite for C + E)
- [x] **Conversation-mode hardening** (chatbot UX for non-alert mentions) — response-mode markers, tool budget, namespace scope lock, log fan-out guard, RCA-format backstop, fence-safe Slack splitter, head+tail truncation, name-resolution/confirmation + 10-line log display rules
- [x] **Reasoning-model resilience** (llm-worker) — `finish_reason=length` surfaced as `max_tokens`, empty-exhaustion auto-retry with 2× budget, `LLM_REASONING_EFFORT` passthrough, `SQS_LLM_TIMEOUT_SECONDS` default 240
- [x] **MCP server ops polish** — startup upstream probe (non-fatal warn), `conciseCause` error trimming, no stack for expected errors; agent `/health` does a real MCP ping
- [x] **Remediation live-test hardening** (from on-cluster testing) — proposal null-path logging, optional auto-resolved `container`, workload≠pod + never-guess prompt rules, approver mentions on the card, format-agnostic alert flow with recurrence shortcut (reformat-to-RCA removed)
- [x] **Remediation UX & coherence round** — containers/images in workload listings, head+tail proposal context + CONFIRMED prior included, kind case normalization, dry-run refusals posted to the thread, lifecycle `[system note]`s in thread memory, post-execution 90s status check, `leaksRcaStructure` + command-dump reformat backstop, `toMrkdwn`, backticked/clean server refusal messages
- [x] **GitOps guard** (`assertNotGitOpsManaged`) + **D. resolved-alert loop** + **E step 5 reaction-learn** — see their sections

### Next — ordered
- [x] **D. Resolved-alert loop** ✅ shipped — `status: resolved` now: releases the dedup claim (`AlertDeduplicator.clear` — a re-fire re-investigates instead of being suppressed 12h), marks the newest unresolved incident (`markResolved`, migration `003_resolved_at.sql`), posts "✅ Alert resolved" into the thread with a learn-reaction hint.
- [ ] **C. Guarded Remediation** — Design → **`docs/DESIGN_guarded_remediation.md`**. ✅ **v1.1 shipped**: schema + proposal flow + approval buttons + **4 typed actions** (`k8s_rollout_restart` dep/sts/ds, `k8s_set_image`, `k8s_set_resources`, `k8s_scale` with `MAX_SCALE_DELTA` + no scale-to-zero) + mention-path support (`incident_id` nullable) + write tools excluded from the agentic loop (`[WRITE]` prefix convention). Remaining: Step 5 (ops: least-privilege RBAC — now needs `patch` on deployments/statefulsets/daemonsets + `get` in allowed namespaces), then v2 (rollback action, rate limiting, resolved-loop outcome tracking).
  - ✅ **GitOps guard shipped (2026-07-17, design doc §10):** the MCP server refuses direct spec-mutating patches on Flux-managed workloads (`kustomize.toolkit.fluxcd.io/name` / `helm.toolkit.fluxcd.io/name` labels — error names the owning object) and plain Helm-managed ones (`app.kubernetes.io/managed-by: Helm`); `rollout_restart`/`delete_pod` stay allowed.
  - ✅ **GitOps PR flow shipped (2026-07-23, `DESIGN_gitops_pr_remediation.md`, IMPLEMENTED):** for a Flux HelmRelease the dry-run returns a structured PR preview → agent opens a **PR** via the llm-worker over SQS (GHE is private-network-only). PAT auth for the initial phase; all 3 mutating actions supported (image/scale single-scalar, set_resources nested via parent-stack). See the Guarded Remediation section above for the runtime path. Remaining: ops (mount PAT in worker, create `gitops` queue, RBAC for Flux CRDs), live E2E.
- [x] **E. On-call feedback learning** ✅ steps 1–5 shipped — v1 (migration 002, feedback store/recall, `@agent learn` router + extraction, confirmed-tier recall + prompt framing) + step 5: `reaction_added` trigger (`SLACK_LEARN_REACTION` default `white_check_mark`; needs `reactions:read` + event subscription). Reaction-learn is **silent** when the thread has no stored incident or was already learned (`trigger_key = reaction:<message ts>`); the reaction payload has no `thread_ts` → resolved via `conversations.replies(ts, limit 1)`. Remaining: v2 ideas (passive capture).
- Migration **`002_remediations_and_feedback.sql`** ships the shared schema for C+E in one transaction; `store()` now takes an optional `{channel, threadTs}` and returns `incidents.id` (`Number()`-cast — pg returns BIGSERIAL as string).

### Parked (design captured, revisit when prioritized)
- **FinOps** (cost Q&A, waste audit, cost-anomaly-as-incident, rightsizing) — mostly config/prompt via OpenCost→Prometheus; see **`docs/DESIGN_finops.md`**.
- **VM/baremetal execution** via Ansible-backed MCP tools — deemed too complex for now; K8s + observability scope only. Key notes: whitelist = curated playbooks (never generic exec), `--check` = dry-run, plain-CLI-vs-AWX decides the architecture.

### Tech debt — Loki + tracing paths untested live (env not ready)
The investigation prompt already HAS the observability playbooks — Failure Mode Playbooks
(error-rate → `loki_query_range` LogQL; latency → `tracing_search` → `tracing_get_trace` →
`loki_query_range`), a Loki LogQL-patterns section, a tracing section with the Jaeger-vs-Tempo
nuance — and the tool names in the prompt MATCH the registered MCP tools (verified). BUT the
Loki/Jaeger backends aren't set up in the target env yet, so these paths are **untested against
real data**. Two concrete risks to resolve when the env is ready:
1. **LogQL label schema** — `prompts/system.md` assumes `{namespace="X", app="Y"}`; real Loki
   may key on `pod`/`container`/`job`/`compose_service`/etc. A mismatch returns empty → the
   agent concludes "no logs" while logs exist. Verify the actual label schema and tune the
   LogQL patterns in the prompt.
2. **Tracing** — only triggers on the latency playbook; `tracing_search` (Jaeger) needs the
   exact `service` (the prompt tells it to `tracing_list_services` first). Verify vs the real
   Jaeger/Tempo backend.
When ready: live-test both scenarios → tune the prompt → encode as the first golden cases in
the eval framework. (Prompt is theory until exercised against real Loki/Jaeger.)

### Tier 3 — skip until justified (YAGNI)
- [ ] Semantic/vector recall for incident memory (exact-label match is enough until incidents number in the hundreds)
- [x] **Alert correlation/grouping** ✅ shipped — one investigation per Alertmanager group (see *Alert Correlation* below)
- [ ] Self-metrics endpoint (agent exposes its own Prometheus metrics; token usage already logged)
- [ ] `/clear` Slack command to reset thread history
- [ ] Configurable confidence threshold via env var
- [x] **Webhook auth for the `/alert` endpoint** ✅ shipped — `ALERT_WEBHOOK_TOKEN` bearer gate (see *Alert Webhook Auth* below)
- [ ] Graceful-shutdown drain of in-flight investigations
- [ ] Cross-alertname correlation (node-down fan-out → KubeNodeNotReady + many KubePodNotReady across namespaces into one incident) — needs a time-window + shared-cause heuristic; risk of merging unrelated incidents. Revisit only if same-group correlation proves insufficient.
