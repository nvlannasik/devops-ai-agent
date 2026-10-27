# OpenTelemetry tracing for the agent stack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One OpenTelemetry trace per investigation across devops-ai-agent, devops-mcp-server and llm-worker, exported to the dev Jaeger, with nothing but metadata on any span.

**Architecture:** Each service starts the SDK in a `node --import` preload that first registers OTel's ESM loader hook; official auto-instrumentations cover http/undici/pg/ioredis/express/winston; W3C context crosses SQS as a message attribute injected and extracted by two small explicit helpers; the agent adds `investigate` / `chat` / `execute_tool` spans and `gate` events at the seams the harness trace already uses.

**Tech Stack:** Node 24 ESM TypeScript, `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/instrumentation-*` (one version family per repo), Helm (umbrella chart), Flux.

**Spec:** `devops-ai-agent/docs/superpowers/specs/2026-10-27-otel-tracing-design.md`

**Deviation from the spec (§2, §3), decided here:** no `@opentelemetry/instrumentation-aws-sdk`. Context crosses SQS through explicit `inject`/`extract` helpers (Tasks 2–4) instead. Reason: the spec already flagged that the instrumentation's consumer side may leave a detached `receive` span; explicit helpers are deterministic, testable without AWS, and cannot double-inject `traceparent`. The SQS body contracts are untouched either way.

## Global Constraints

- SQS message **bodies** stay byte-identical; context travels only as message attributes `traceparent` (and `tracestate` when present), `DataType: "String"`.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, no SDK starts and behaviour is exactly today's (no message attributes added either).
- SDK start, export and the preload never throw into the service: failure logs once and continues untraced.
- The preload calls `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` before anything else; it is started with `node --import ./dist/src/tracing/preload.js dist/index.js`.
- `OTEL_SERVICE_NAME`: `devops-ai-agent`, `devops-mcp-server`, `llm-worker` (set in each Dockerfile).
- OTel packages pinned to exact versions, one family per repo; `npm ls @opentelemetry/instrumentation` must show a single version.
- Span content allowlist (spec §5): names, ids, counts, sizes, durations, statuses, model/backend/route, alert name/namespace, thread ts. Never prompts, model output, tool args, tool results, Slack text, RCA text, SQS bodies, credential headers.
- URL attributes (`url.full`, `http.url`, `http.target`) lose everything from `?`; `url.query` is set to `""`.
- Probe paths ignored by the http instrumentation: `/health`, `/healthz`, `/ready`, `/readyz`, `/metrics`.
- Sampler default `parentbased_always_on` (the SDK default; `OTEL_TRACES_SAMPLER` overrides).
- The three repos share no module: the `src/tracing/` files are copied, the same precedent as `toOpenAIMessages` (workspace `CLAUDE.md`). Keep them identical where they overlap.

## Review Focus

1. **Jaeger unreachable or the endpoint wrong** → the service starts and serves; spans are dropped silently. Pinned by the child-process test with an endpoint on a closed port (Task 2 Step 1, copied in Tasks 3–4).
2. **A message without a `traceparent` attribute** (a sender not yet upgraded, a hand-sent probe) → the consumer starts a new root trace and processes normally. Pinned in Task 2/3 `withSqsConsumerSpan` tests.
3. **Tracing off** → `sqsTraceAttributes()` returns `undefined` (not `{}`), so `SendMessage` is unchanged. Pinned in Task 4.
4. **PromQL/LogQL in a URL** → never reaches the exporter. Pinned by the redactor test (Task 2, copied).
5. **An LLM or tool call that throws** (router failover) → the `chat`/`execute_tool` span ends with ERROR status and the original error propagates unchanged. Pinned in Task 4.

---

### Task 1: Jaeger UI behind oauth2-proxy (gitops-devops-ai-manifest)

**Files:**
- Modify: `apps/base/systems/jaeger/release.yaml` (the `ingress.annotations` block, ~line 114)

**Interfaces:** none (precondition, spec §9).

- [ ] **Step 1: Add the three annotations Headlamp uses** (`apps/base/systems/headlamp/release.yaml:58-60`), pointing at `https://headlamp.annasik.cloud/oauth2/auth` and `.../oauth2/start?rd=$scheme://$best_http_host$request_uri`, plus `auth-response-headers: "X-Auth-Request-User, X-Auth-Request-Email"`.
- [ ] **Step 2: Commit and push to main; reconcile** the `flux-system` GitRepository and the `jaeger` HelmRelease (`reconcile.fluxcd.io/requestedAt` annotation).
- [ ] **Step 3: Verify**
  Run: `curl -s -o /dev/null -w '%{http_code}' https://jaeger.annasik.cloud/api/services`
  Expected: `302` (was `200`). And in-cluster `wget -qO- http://localhost:16686/api/services` from the jaeger pod still answers JSON.

---

### Task 2: Tracing in devops-mcp-server

**Files:**
- Create: `src/tracing/index.ts`, `src/tracing/preload.ts`, `src/tracing/redact.ts`, `src/tracing/sqs.ts`
- Create: `src/tracing/preload.test.ts`, `src/tracing/redact.test.ts`, `src/tracing/sqs.test.ts`
- Modify: `src/app/sqs-loop.ts:41-58` (receive + per-message handling), `index.ts:5-12` (flush on shutdown), `Dockerfile:62-63`, `package.json`, `CLAUDE.md`

**Interfaces:**
- Produces (same names in Tasks 3–4):
  - `interface TracingHandle { shutdown(): Promise<void> }`
  - `startTracing(opts: { service: string; version: string; environment: string; endpoint: string | null; instrumentations: Instrumentation[] }): TracingHandle | null` — null when `endpoint` is null or start throws (logged).
  - `activeTracing(): TracingHandle | null`
  - `class UrlQueryRedactor implements SpanProcessor` — rewrites URL attributes in `onEnding(span)` (span still writable); no-op otherwise. If the pinned `sdk-trace-base` lacks `onEnding`, wrap the exporter instead (`RedactingExporter(inner)` mapping each span's attributes before `export`) — same tests.
  - `withSqsConsumerSpan<T>(name: string, attrs: Record<string, MessageAttributeValue> | undefined, fn: () => Promise<T>): Promise<T>` — extracts context from `attrs` (`traceparent`, `tracestate`), runs `fn` in an active `SpanKind.CONSUMER` span `name` with `messaging.system=aws_sqs`; ERROR status + rethrow on throw.

- [ ] **Step 1: Write the failing tests**
  - `preload.test.ts` — port of `devops-sample-apps/packages/platform/src/tracing-preload.test.ts`: child `node --import <dist>/src/tracing/preload.js app.mjs`, app imports `node:http` as a namespace, serves, fetches itself with `?query=up`, calls `activeTracing()?.shutdown()`. Assert: exit 0; a SERVER and a CLIENT span; `service.name === "devops-mcp-server"`; same `traceId`; **no span attribute value contains `query=up`**. Second case: endpoint `http://127.0.0.1:9` (closed) → exit 0, app output unchanged.
  - `redact.test.ts` — `UrlQueryRedactor` over an in-memory exporter: a span with `url.full = "http://p:9090/api/v1/query?query=sum(rate(x[5m]))"`, `http.target = "/api/v1/query?query=..."`, `url.query = "query=..."` exports `"http://p:9090/api/v1/query"`, `"/api/v1/query"`, `""`; a span with no URL attributes exports unchanged.
  - `sqs.test.ts` — with an in-memory SDK: `withSqsConsumerSpan("bridge request", { traceparent: { DataType: "String", StringValue: "00-<32hex>-<16hex>-01" } }, fn)` → the CONSUMER span's `traceId` is the attribute's and `parentSpanId` its span id; with `undefined` attrs → a new root span, `fn`'s value returned; `fn` throwing → span status ERROR and the same error rejected.
- [ ] **Step 2: Run** `npm run build && npm test` — Expected: the three new files FAIL (modules missing).
- [ ] **Step 3: Add dependencies** — `@opentelemetry/api`, `sdk-node`, `sdk-trace-base`, `exporter-trace-otlp-http`, `instrumentation-http`, `instrumentation-undici`, `instrumentation-express`, `instrumentation-winston`, `resources`, `semantic-conventions`, all `--save-exact`, one family (pick the newest family in which all exist; the `devops-sample-apps` lesson: `instrumentation-undici` 0.31 ↔ 0.221, 0.34 ↔ 0.300). Run `npm ls @opentelemetry/instrumentation` → one version.
- [ ] **Step 4: Implement `src/tracing/*`** — `preload.ts`: register the hook, then `startTracing({ service: OTEL_SERVICE_NAME, version: SERVICE_VERSION ?? "dev", environment: DEPLOYMENT_ENV ?? "dev", endpoint: OTEL_EXPORTER_OTLP_ENDPOINT || null, instrumentations: [http (ignore probe paths; no header capture), undici, express, winston] })` with `UrlQueryRedactor` ahead of a `BatchSpanProcessor(OTLPTraceExporter({ url: endpoint + "/v1/traces" }))`. Imports in `preload.ts` may not reach `node:http` before the hook (only `./index.js`, `./redact.js`, `@opentelemetry/*`).
- [ ] **Step 5: Wire the consumer** — `sqs-loop.ts`: add `MessageAttributeNames: ["traceparent", "tracestate"]` to `ReceiveMessageCommand`; wrap `d.handle(msg.Body, msg.ReceiptHandle!)` as `withSqsConsumerSpan("bridge request", msg.MessageAttributes, () => d.handle(...))`. `index.ts` shutdown: `await activeTracing()?.shutdown()` after the server closes, inside the existing try.
- [ ] **Step 6: Dockerfile** — `ENV OTEL_SERVICE_NAME=devops-mcp-server`; `CMD ["node", "--import", "./dist/src/tracing/preload.js", "dist/index.js"]`.
- [ ] **Step 7: Run** `npm run build && npm test` — Expected: all PASS, including the three new files.
- [ ] **Step 8: Document** in `CLAUDE.md`: the preload rule (why `index.ts` is too late), the consumer span, the redactor; and that `traceparent` rides as an SQS message attribute (bodies unchanged).
- [ ] **Step 9: Commit and push** (`feat(tracing): ...`); confirm the CI image build succeeds.

---

### Task 3: Tracing in llm-worker (devops-ai-agent-worker)

**Files:**
- Create: `src/tracing/{index,preload,redact,sqs}.ts` + the three tests — copies of Task 2's, `service.name` `llm-worker`
- Modify: `src/worker.ts:226-245` (receive + handling in `pollLoop`), `index.ts:6-12`, `Dockerfile:54-55`, `package.json`, `CLAUDE.md`

**Interfaces:**
- Consumes: Task 2's `src/tracing/*` signatures (copied).
- Produces: CONSUMER spans named `llm request` and `gitops request`; inside `processGitOpsMessage`, `trace.getActiveSpan()?.setAttribute("gitops.op", op)` once the body is parsed.

- [ ] **Step 1: Copy and adapt the three tests** from Task 2 (`service.name === "llm-worker"`; the preload test's app also imports the `undici` package and calls `undici.request` once — assert a CLIENT span for it too).
- [ ] **Step 2: Run** `npm run build && npm test` — Expected: new tests FAIL.
- [ ] **Step 3: Dependencies** as Task 2 Step 3, minus express. One `@opentelemetry/instrumentation`.
- [ ] **Step 4: Copy `src/tracing/*`**; instrumentations: http, undici, winston.
- [ ] **Step 5: Wire `pollLoop`** — `MessageAttributeNames` as Task 2; wrap `handle(msg.Body!, msg.ReceiptHandle!)` in `withSqsConsumerSpan(<the loop's span name>, msg.MessageAttributes, ...)`, the name passed in by `startWorker` alongside `label`; `gitops.op` as above. Shutdown flushes `activeTracing()`.
- [ ] **Step 6: Dockerfile** — `ENV OTEL_SERVICE_NAME=llm-worker`; CMD with the preload.
- [ ] **Step 7: Run** `npm run build && npm test` — all PASS.
- [ ] **Step 8: Document** in `CLAUDE.md` (same three points as Task 2).
- [ ] **Step 9: Commit and push**; CI image build succeeds.

---

### Task 4: Tracing in devops-ai-agent — infrastructure, SQS producers, domain spans

**Files:**
- Create: `src/tracing/{index,preload,redact}.ts` (copies), `src/tracing/sqs.ts` (producer helper), `src/tracing/spans.ts`
- Create: `src/tracing/preload.test.ts`, `src/tracing/redact.test.ts`, `src/tracing/sqs.test.ts`, `src/tracing/spans.test.ts`
- Modify: `src/agent/llm/sqs.ts:139-142`, `src/agent/gitops/sqs.ts:87-90`, `src/agent/mcp/sqs-client.ts:85-88` (add `MessageAttributes`)
- Modify: `src/agent/trace/index.ts:187-224` (`instrumentLLM`, `instrumentMCP`), `src/agent/trace/index.ts:127` (`gate`), `src/agent/loop/runner.ts:52-66` (`run`)
- Modify: `index.ts:40-41` (flush), `Dockerfile:92-93`, `package.json`, `CLAUDE.md`, `MEMORY_BANK.md`, workspace `CLAUDE.md`

**Interfaces:**
- Consumes: Task 2's `startTracing`, `activeTracing`, `UrlQueryRedactor` (copied).
- Produces:
  - `sqsTraceAttributes(): Record<string, MessageAttributeValue> | undefined` — `propagation.inject` into a carrier; `undefined` when the carrier is empty.
  - `withInvestigateSpan<T>(threadTs: string, opts: { mode: string; depth: number; namespace: string | null; alertName: string | null; source: string }, fn: () => Promise<T>): Promise<T>` — `root: true` and a link to the then-active span when `depth === 0`; a child span (no `root`) with `agent.delegate=true` when `depth > 0`.
  - `withChatSpan(fn: () => Promise<LLMResponse>): Promise<LLMResponse>` — span starts as `chat` (CLIENT) and is renamed `chat ${response.model}` on success (the model is only known from the response); sets `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `llm.backend`, `llm.route`.
  - `withToolSpan(name: string, fn: () => Promise<string>): Promise<string>` — span `execute_tool ${name}` (CLIENT), `gen_ai.tool.name`, `tool.result.chars`.
  - `gateEvent(name: string, outcome: string): void` — `trace.getActiveSpan()?.addEvent("gate", { "gate.name": name, "gate.outcome": outcome })`.
  - `currentOtelTraceId(): string | null` — the active span's trace id, null when none/invalid.
  - `ALLOWED_ATTRIBUTES: ReadonlySet<string>` — the allowlist the test enforces.

- [ ] **Step 1: Write the failing tests**
  - `preload.test.ts`, `redact.test.ts` — copies (`service.name === "devops-ai-agent"`).
  - `sqs.test.ts` — inside an active span, `sqsTraceAttributes()` returns `{ traceparent: { DataType: "String", StringValue } }` whose trace id is the span's; with no SDK/active span it returns `undefined`.
  - `spans.test.ts` — with an in-memory SDK and the scripted-client `DevOpsAgent` used by `src/agent/trace/wiring.test.ts` (`new DevOpsAgent({ llm, mcp, recorder, remediations })`), one alert-mode investigation that calls one tool and fires one gate produces: one `investigate` span (attributes `slack.thread_ts`, `agent.run_mode=alert`, `agent.source`), its children `chat …` and `execute_tool k8s_list_pods`, and a `gate` event; **every attribute key is in `ALLOWED_ATTRIBUTES` and no string value is longer than 200 chars**; the scripted user message and tool result text appear in no attribute or event. A scripted LLM that throws once → a `chat` span with status ERROR and the same error surfaces where it did before (the run's existing failure path). The run's `agent_events` start payload carries `otelTraceId` equal to the `investigate` span's trace id.
- [ ] **Step 2: Run** `npm test` — Expected: new tests FAIL.
- [ ] **Step 3: Dependencies** as Task 2 Step 3 plus `instrumentation-pg`, `instrumentation-ioredis`; minus express. One `@opentelemetry/instrumentation`.
- [ ] **Step 4: Implement `src/tracing/*`**; instrumentations: http (probe paths ignored), undici, pg, ioredis, winston.
- [ ] **Step 5: Producers** — each of the three `SendMessageCommand`s gets `MessageAttributes: sqsTraceAttributes()`; bodies untouched.
- [ ] **Step 6: Domain spans** — `runner.run` body runs inside `withInvestigateSpan(threadId, {...}, ...)` and adds `otelTraceId: currentOtelTraceId()` to the `begin` payload; `instrumentLLM` wraps `llm.chat` in `withChatSpan`; `instrumentMCP` wraps `call` in `withToolSpan`; `TraceRecorder.gate` calls `gateEvent(name, outcome)` **before** its `if (!this.sink)` early return (tracing must not depend on the harness sink). `alertName` comes from structured opts only (null when none) — never parsed from the issue text.
- [ ] **Step 7: Flush and image** — `index.ts` shutdown awaits `activeTracing()?.shutdown()` after `agent.shutdown()`; Dockerfile `ENV OTEL_SERVICE_NAME=devops-ai-agent`, CMD with the preload (ENTRYPOINT unchanged).
- [ ] **Step 8: Run** `npm run build && npm test` — the full suite PASS.
- [ ] **Step 9: Document** — `CLAUDE.md` gotcha (preload; spans live in the `agent/trace` seams; allowlist; SQS attributes) and the workspace `CLAUDE.md` three SQS contract sections: "`traceparent`/`tracestate` ride as message attributes; bodies unchanged".
- [ ] **Step 10: Commit and push**; CI image build succeeds.

---

### Task 5: "Open in Jaeger" on the incident page (devops-ai-agent dashboard)

**Files:**
- Modify: `src/config/index.ts` (`dashboard.tracingUiUrl` from `TRACING_UI_URL`, default null), `src/dashboard/queries.ts` (`detail()` returns `otelTraceId: string | null` from the incident thread's newest `start` event payload), `src/dashboard/incident-views.ts` (the `.page-actions` block), `src/dashboard/server.ts` (pass the URL), tests in `src/dashboard/views.test.ts` and `queries.test.ts`

**Interfaces:**
- Consumes: `otelTraceId` in the `agent_events` start payload (Task 4).
- Produces: `IncidentDetail.otelTraceId?: string | null`; `detailPage(d, now, open, prices, tracingUiUrl?: string | null)`.

- [ ] **Step 1: Failing tests** — `detailPage` with a 32-hex `otelTraceId` and `tracingUiUrl: "https://jaeger.annasik.cloud"` renders `<a class="standalone" href="https://jaeger.annasik.cloud/trace/<id>">Open in Jaeger</a>` inside `.page-actions`; no link when either is null; a trace id that is not 32 hex chars renders no link. `queries.detail` maps the payload field (mocked pool, as the existing detail tests do).
- [ ] **Step 2–4: Run (FAIL) → implement → run (PASS)** `npm test`.
- [ ] **Step 5: Commit and push.**

---

### Task 6: `global.tracing` in the umbrella chart (devops-ai-helm-charts)

**Files:**
- Modify: `charts/devops-ai-stack/values.yaml` (`global.tracing: { enabled: false, endpoint: "", sampler: "" }`, agent `tracingUiUrl: ""`), `templates/_shared-env.tpl` (new `devops-ai.tracingEnv`), `templates/_validate.tpl`, the three `charts/*/templates/deployment.yaml` env blocks, `Chart.yaml` (minor bump), chart docs

**Interfaces:**
- Produces: env `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_TRACES_SAMPLER` when `sampler` is set) on all three Deployments when `global.tracing.enabled`; `TRACING_UI_URL` on the agent; a service's own `env` wins (the existing helper rule).

- [ ] **Step 1: Failing render checks** — in the chart's existing test mechanism: enabled + endpoint → the three Deployments carry `OTEL_EXPORTER_OTLP_ENDPOINT`; disabled → none do; enabled without endpoint → render fails with a message naming `global.tracing.endpoint`; a service `env.OTEL_EXPORTER_OTLP_ENDPOINT` overrides the global.
- [ ] **Step 2–4: Run (FAIL) → implement → run (PASS).**
- [ ] **Step 5: Commit, push, release** the new chart version the way 0.7.0 was released.

---

### Task 7: Enable in dev and verify end to end (gitops-devops-ai-manifest)

**Files:**
- Modify: `apps/base/applications/devops-ai-stack/release.yaml` (chart version → Task 6's) and the dev values: `global.tracing.enabled: true`, `endpoint: http://jaeger.monitoring.svc.cluster.local:4318`, agent `tracingUiUrl: https://jaeger.annasik.cloud`

- [ ] **Step 1: Commit, push, reconcile**; wait for the three rollouts (the HelmRelease upgrade changes their env, so no manual restart).
- [ ] **Step 2: Verify the pods** — each `/proc/1/cmdline` shows `--import ./dist/src/tracing/preload.js`; each has `OTEL_EXPORTER_OTLP_ENDPOINT`.
- [ ] **Step 3: Verify one trace end to end** — trigger one investigation (a Slack mention in the test channel); then from the jaeger pod: `wget -qO- localhost:16686/api/services` lists `devops-ai-agent`, `devops-mcp-server`, `llm-worker`; the newest `devops-ai-agent` `investigate` trace holds spans from all three services under one trace id, including a `llm request` CONSUMER span whose parent is a `chat` span.
- [ ] **Step 4: Verify no content** — over that trace's JSON, no span tag or log field contains the mention text, a PromQL `query=`, or an `authorization` header.
- [ ] **Step 5: Verify the link** — the incident's dashboard page shows "Open in Jaeger" and it resolves (behind the login) to that trace.
- [ ] **Step 6: Update** the workspace `CLAUDE.md` (the chart version line) and the Confluence docs README if its pages describe observability; commit and push.
