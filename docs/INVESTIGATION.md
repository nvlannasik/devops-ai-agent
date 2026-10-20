# How an investigation runs

```
Slack mention (allowlisted users) / Alertmanager webhook
        ↓
   Correlation (one webhook = one alert group = one investigation, not N pods → N threads)
        ↓
   Alert deduplication (fingerprint + 12h TTL; Redis-backed = atomic across pods)
        ↓
   Change timeline + cross-alert correlation (is this a known incident's neighbour?)
        ↓
   Recall past incidents (Postgres) — confirmed fixes, prior RCAs, possibly-related leads
        ↓
   Agent investigates (agentic loop, max 10 iterations, parallel tool calls, per-symptom skills)
        ↓
   LLM calls MCP tools (K8s, Prometheus, Loki, Alertmanager, Tracing)
   — identifiers masked before any backend sees the request, restored in the reply
        ↓
   RCA posted as Slack Block Kit  →  Confidence Low? → mention on-call users
        ↓
   Remediation proposed → gate chain → dry-run → approval card → click → execute → verdict checked later
        ↓
   Whole run recorded (agent_events) → /harness on the dashboard, replayable as a regression case
```

Budgets and switches: [CONFIGURATION.md](CONFIGURATION.md#investigation-budgets).

## Entry points

- **Async alert webhook.** `/alert` acks `200` immediately and investigates in the background — no
  Alertmanager timeout, notifications never wait behind another alert's investigation.
- **Alert correlation.** One webhook = one Alertmanager group = one investigation; see
  [USAGE.md](USAGE.md#alertmanager-integration).
- **Alert deduplication.** Same alert processed once per 12h. With `MEMORY_BACKEND=redis` the claim
  is an atomic `SET NX` in Redis, so under multi-pod autoscaling only one pod investigates;
  in-memory fallback is single-pod only.
- **Mention allowlist.** `SLACK_ALLOWED_USERS` — only registered users can mention the agent or
  ✅-learn; others get an ephemeral refusal.
- **Response-mode markers.** Every entry point stamps a per-message marker
  (`[SOURCE: Alertmanager ...]` / `[USER MESSAGE ...]` / `[FOLLOW-UP ...]`) — alerts always
  investigate, plain mentions stay conversational. Follow-up mode: the `markRcaSent` flag prevents
  RCA format on follow-ups.

## Context before the first LLM call

- **Change timeline.** Before an alert's investigation, what changed in its namespace in the
  previous 24h — rollouts with the pod-template diff, HelmRelease upgrades, ConfigMap updates,
  GitOps commits — goes to the model as data, onto the RCA card as `🕑 Recent changes`, and into
  the incident row; a source that could not be read says so.
- **Incident and remediation memory.** Recalled prior RCAs, human-confirmed causes and past
  remediations with their verdicts; see [MEMORY.md](MEMORY.md).

### Cross-alert correlation

A new alert group whose service is the same as, or one call-graph edge from, an open incident's in
the same namespace within the last 30 minutes is posted as `🔗 Related alert` into that incident's
thread instead of opening a new one — stored as a child row (never its own card, one follow-up
question), and the dashboard's incident page lists a parent's children under Related alerts and
links a child back with Merged into #N. Fails open to today's path on any failure (no graph, no
subject, a failed post).

## The loop

- **Agentic loop.** Max 10 iterations; independent tool calls are executed in parallel.
- **Context assembly.** Every request is assembled, not accumulated: tool results compacted to 8000
  chars, conversation history trimmed to 50 messages, then the whole thing fitted to a per-backend
  token budget (`fitToBudget()`) that drops oldest-first rather than letting the provider reject
  the call. Long field values are shown as `...[truncated N chars]`.
- **Skills.** Per-symptom playbooks in `prompts/skills/*.md`, selected by a `when` regex and
  injected as a separate message — top 3 per turn, system prompt stays byte-identical so the
  prompt cache holds. See [PROMPTS.md](PROMPTS.md#skills-promptsskills).
- **Prompt caching.** Anthropic ephemeral cache reduces token cost.
- **Conversation guards.** Deterministic, for plain mentions: tool budget (`MENTION_TOOL_ROUNDS`),
  namespace scope lock (first tool round fixes the scope), log fan-out guard (>2 pods → ask instead
  of dump), RCA-format backstop (auto-reformat), fence-safe message splitting.
- **Cluster tour.** Onboarding answers from `k8s_cluster_inventory`: Slack tables built from the
  tool result (never the model), plus what each workload does and how it is deployed; see
  [USAGE.md](USAGE.md#cluster-tour-onboarding).
- **Sub-agent delegation.** Off by default (`SUBAGENT_ENABLED`), and off means *unregistered* — the
  tool never reaches the model. When on, an Alertmanager group whose alerts name **two or more
  different services** is a deterministic trigger: the loop appends a hint asking for one
  `delegate_investigation` per service, up to `SUBAGENT_MAX_FANOUT` (3) in parallel. A delegate is
  the same investigation loop with a smaller budget, a deadline inside its parent's, and no
  delegate tool of its own — it reports a SUPPORTED / CONTRADICTED / UNPROVEN verdict to the lead,
  never an RCA.
- **Prompt-injection framing.** Every string an MCP tool returns is written by something in the
  cluster — a log line, an event, an annotation — and lands in the conversation beside the
  operator's question. Text shaped like an instruction to the agent
  (`ignore previous instructions`, or an imperative naming one of our own tool names) is logged and gets a
  `[agent guard]` line appended marking the whole result as data. It is never blocked or dropped:
  the injected string stays quotable as evidence. Not the security boundary — that is still the
  write-tool filter, the mandatory dry-run and the human approval click.
- **Identifier masking.** IPs, emails, ARNs, account ids and public hostnames tokenised before any
  LLM backend sees a request, restored in the reply; see [LLM.md](LLM.md#identifier-masking).
- **Confidence threshold.** Low → auto-mention `SLACK_ONCALL_USERS`.

## Reliability

- **Bounded latency.** Per-tool-call, per-investigation, and SQS client request timeouts prevent a
  hung dependency from freezing the agent.
- **MCP reconnect.** Exponential backoff + mutex-protected.
- **SQS dispatcher.** Single per-process dispatcher routes shared-queue responses by `requestId`;
  releases non-owned messages so concurrent investigations don't stall each other.
- **Readiness `/health`.** Returns `503` (not `200`) when a configured dependency (MCP, Postgres,
  Redis) is unreachable, so K8s readiness probes stop routing to a pod that can't investigate.

## Afterwards

- **Investigation trace + replay.** Every run (LLM turns, tool calls, gate decisions) recorded to
  `agent_events`; replayed offline as regression cases under `npm test`. See
  [DEVELOPMENT.md](DEVELOPMENT.md#benchmark--replay).
- **Remediation.** One approval-gated proposal; see [REMEDIATION.md](REMEDIATION.md).
