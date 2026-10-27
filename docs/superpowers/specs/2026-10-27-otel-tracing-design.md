# OpenTelemetry tracing for the agent stack — design

Date: 2026-10-27 · Status: approved in chat (2026-10-27), written up for planning
Repos: `devops-ai-agent`, `devops-mcp-server`, `devops-ai-agent-worker` (llm-worker),
`devops-ai-helm-charts`, `gitops-devops-ai-manifest`
Related: `2026-10-01-harness-trace-design.md` (the in-process harness trace this complements)

## Intent

Bring the stack's own observability up to standard practice: one distributed trace per
investigation, across the agent, the MCP server and the llm-worker, exported over OTLP to the
Jaeger already running in the dev cluster (`jaeger.monitoring.svc.cluster.local:4318`). The user's
stated goal is best practice, not a specific incident; the design follows OpenTelemetry's own
conventions wherever one exists.

Today none of the three services has OpenTelemetry. The only cross-service join is `traceId` —
the Slack thread id — carried in SQS bodies and logs (workspace `CLAUDE.md`, SQS contracts). The
agent's harness trace (`agent/trace`, `agent_events`) records each investigation for the dashboard
and replay; it is in-process and stops at the agent's boundary.

## Goals

- One trace per investigation that crosses every hop: agent → MCP server (HTTP and the SQS
  bridge) → Kubernetes/Prometheus/Loki/Alertmanager/tracing backends, and agent → llm-worker
  (LLM queue and GitOps queue) → private LLM / GitHub Enterprise.
- Domain spans in the agent that read like the investigation: the investigation, each LLM call,
  each tool call, each gate decision.
- Log ↔ trace correlation: every log line written inside a span carries `trace_id`/`span_id`.
- The dashboard's incident page links to the investigation's trace in Jaeger.
- Off by default; one chart value turns it on.

## Non-goals

- OpenTelemetry metrics or logs export (Prometheus and Loki already cover them).
- Persistent Jaeger storage, Tempo, or a collector tier.
- Tracing `devops-sample-apps` (done separately, 2026-10-27) or the manual
  `devops-mcp-bridge-lab2` Deployment.
- Replacing the harness trace: `agent_events` stays the source for the dashboard and replay.

## Anti-goals — a failure even if traces appear

- **Tracing takes a service down or slows it.** SDK init, the exporter and the preload must fail
  closed to "no tracing", never to a crash; an unreachable Jaeger costs nothing but dropped spans.
- **Content leaks into Jaeger.** Prompts, model output, tool results, Slack text, tool arguments
  and any secret must never become a span attribute or event. Jaeger has a public Ingress
  (`jaeger.annasik.cloud`); treat anything in a span as published.
- **A cross-repo contract changes shape.** The three SQS body contracts in the workspace
  `CLAUDE.md` stay byte-identical; context travels in SQS *message attributes*.
- **Behaviour changes when tracing is off.** With no `OTEL_EXPORTER_OTLP_ENDPOINT`, every service
  behaves exactly as today.

## Decided

### 1. Start-up: a preload, in every service

All three services are Node 24 ESM. Starting the SDK from `index.ts` instruments nothing, because
an entry module's imports are evaluated before its body (`devops-sample-apps` measured this on
2026-10-27: every pod logged "tracing enabled", Jaeger received 0 spans). So each service gets a
preload module started with `node --import <preload> dist/index.js`, which:

1. registers OTel's ESM loader hook first:
   `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` — without it an ESM
   `import * as http` stays unpatched even when the SDK starts first (measured, same day);
2. starts `NodeSDK` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, inside a try/catch that logs
   and continues;
3. exposes the handle so the service's existing shutdown/drain flushes it on SIGTERM.

Reference implementation: `devops-sample-apps/packages/platform/src/tracing-preload.ts` and its
`tracing-preload.test.ts` (a real ESM child process against a fake OTLP receiver).

Each Dockerfile's `CMD` gains the `--import`; `ENTRYPOINT ["/entrypoint.sh"]` already execs
`"$@"`. Each image sets `OTEL_SERVICE_NAME`: `devops-ai-agent`, `devops-mcp-server`, `llm-worker`.

### 2. Auto-instrumentation (official `@opentelemetry/instrumentation-*`, one version family)

| Service | Instrumentations |
|---|---|
| agent | http, undici (fetch: Anthropic/OpenAI-compatible clients, MCP HTTP client), pg, ioredis, aws-sdk (SQS), winston |
| mcp-server | http, express, undici, aws-sdk (SQS bridge), winston (axios and `@kubernetes/client-node` ride on http/undici) |
| llm-worker | http, undici (the `undici` package and fetch), aws-sdk (SQS), winston |

Pin every OTel package to one compatible family per repo (exact versions, as
`devops-sample-apps` does) so only one `@opentelemetry/instrumentation` is installed. The winston
instrumentation is what puts `trace_id`/`span_id` on log lines.

### 3. Propagation across SQS

W3C `traceparent` travels as an SQS **message attribute**, never in the body. The aws-sdk
instrumentation injects it on `SendMessage`. On the consuming side — llm-worker's LLM and GitOps
loops, the mcp-server's SQS bridge — each message is processed inside a CONSUMER span whose parent
is extracted from that message's attributes. If the instrumentation's own receive handling does
not bind per-message processing to the producer's context (verify; it is easy to get a detached
`receive` span and nothing else), extract explicitly with `propagation.extract` over the message
attributes. The reply on the shared response queue needs no propagation: the agent span waiting
for it is still open.

Message attributes require `MessageAttributeNames: ["All"]` (or `traceparent`) on every
`ReceiveMessage`; check each consumer.

### 4. Agent domain spans

Built in the wrappers that already see every call — `instrumentLLM` / `instrumentMCP` in
`agent/trace/index.ts` (constructed once in the `DevOpsAgent` constructor) — and beside each
existing `this.trace.gate(...)`. No call site changes, the rule the harness trace already follows.

- **`investigate`** (INTERNAL) — one per investigation run, started where `withTrace` starts it.
  Attributes: `slack.thread_ts`, `alert.name`, `alert.namespace`, `agent.run_mode`
  (alert | investigation | conversation), `agent.source` (prod | bench | replay). An alert run is
  a new trace with a span **link** to the `POST /alert` server span (the webhook acks before the
  investigation starts); a Slack-mention run is a new root. Delegate runs (`depth > 0`) are child
  `investigate` spans with `agent.delegate=true`.
- **`chat {model}`** (CLIENT), OTel GenAI semantic conventions: `gen_ai.operation.name=chat`,
  `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus
  `llm.backend`, `llm.route` (light | heavy), `llm.via_worker`. Router failover shows as sibling
  `chat` spans, the failed one with ERROR status.
- **`execute_tool {tool}`** (CLIENT), GenAI conventions: `gen_ai.tool.name`, `mcp.cluster` when
  routed to a bridge, `tool.result.chars`, ERROR status on a tool error.
- **Gates** — a span event `gate` on the current `investigate` span with `gate.name`,
  `gate.outcome`. Never the gate's `detail` text.

### 5. What may be on a span

Allowlist, enforced by a unit test that runs an investigation with scripted clients into an
in-memory exporter and fails on any attribute key outside the allowlist or any value longer than a
short bound: names, ids, counts, sizes, durations, statuses, model/backend/route, alert name and
namespace, thread ts. Explicitly never: prompt or system-prompt text, model output, tool arguments,
tool results, Slack message text, RCA text, SQS bodies, headers carrying credentials
(`authorization`, `x-api-key` — configure the http/undici instrumentations not to record headers),
and anything from `agent/llm/mask.ts`'s input.

Auto-instrumented HTTP spans are the other leak path: the mcp-server's calls to Prometheus and Loki
carry the PromQL/LogQL in the query string, and `url.full` records it. Each preload installs a span
processor that strips the query string from `url.full`/`http.url` and drops `url.query` before
export (builder's call, 2026-10-27). Paths stay — `/api/v1/namespaces/x/pods` is the useful part.

### 6. Harness trace and dashboard

`agent_events`' run start payload gains `otelTraceId` (the `investigate` span's trace id) — no
migration, the payload is JSONB. The dashboard incident page shows an "Open in Jaeger" action when
the run has one and `TRACING_UI_URL` is configured (`https://jaeger.annasik.cloud` in dev),
linking `${TRACING_UI_URL}/trace/${otelTraceId}`. Same `.page-actions` button pattern as the other
incident actions.

### 7. Resource and sampling

Resource: `service.name` (above), `service.version` (the image's git SHA where the Dockerfile has a
`GIT_SHA` build arg, else `dev`), `deployment.environment.name` (from the release). Sampler:
`parentbased_always_on` by default, overridable with the standard `OTEL_TRACES_SAMPLER` /
`OTEL_TRACES_SAMPLER_ARG`. Exporter: OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`, batch processor.
Kubelet probe paths (`/health`, `/healthz`, readiness/liveness) are ignored by the http
instrumentation.

### 8. Deployment

Umbrella chart `devops-ai-stack`: a `global.tracing` block — `enabled` (default false),
`endpoint`, `sampler` — rendered into all three Deployments by a helper in `_shared-env.tpl`
(same precedence rule: a service's own `env` wins). `_validate.tpl` fails the render when
`enabled` is true without an `endpoint`. Agent gets `TRACING_UI_URL` from its own values. A service that cannot reach the shared endpoint —
the llm-worker in a private network, outside the lab — sets its own `OTEL_EXPORTER_OTLP_ENDPOINT`
or leaves it empty; the service's own `env` already wins over the global helper (builder's call). New
chart minor version; the GitOps `devops-ai-stack` release turns it on for dev with
`http://jaeger.monitoring.svc.cluster.local:4318` and bumps the chart version.

### 9. Precondition: Jaeger's UI behind the login (builder's call, 2026-10-27)

`https://jaeger.annasik.cloud/api/services` answers 200 to anyone (checked 2026-10-27). Once the agent
exports, alert names, namespaces, workload names, Kubernetes paths and Slack thread ids are readable
there. Before tracing is enabled anywhere, the Jaeger Ingress gets the same three nginx annotations
that put Headlamp behind oauth2-proxy (`auth-url`, `auth-signin`, `auth-response-headers` on
`headlamp.annasik.cloud/oauth2/...`; oauth2-proxy's cookie and whitelist domain are `.annasik.cloud`,
so one proxy covers both hosts). The agent and the MCP server read Jaeger through the in-cluster
Service on `:16686`, not the Ingress, so the tracing tools are unaffected. The dashboard's "Open in
Jaeger" link then goes through the same login. Prometheus' Ingress has the same exposure and the
same fix, but it is a separate change.

## Left to the builder

- Exact OTel package versions per repo (one family each), and the instrumentation options that
  stop header recording.
- Where each repo's preload lives and its built path (the agent compiles to `dist/src/...`).
- Whether the aws-sdk instrumentation's consumer handling is enough (§3) — measure it.
- The tests in each repo: a `tracing-preload.test.ts`-style ESM child-process test per service, the
  agent's attribute-allowlist test, and an SQS propagation test (send through the real client
  against a stub endpoint and assert the `traceparent` attribute; consume a message carrying one
  and assert the parent).
- Rollout order: consumers first (mcp-server, llm-worker), then the agent, then chart + GitOps.
  A consumer that reads an absent attribute must simply start a new trace.
- Documentation: each repo's `CLAUDE.md`/`MEMORY_BANK.md`, the workspace `CLAUDE.md` contract
  sections (note the attribute, stress the bodies are unchanged), and the Confluence docs README
  if its pages describe observability.
