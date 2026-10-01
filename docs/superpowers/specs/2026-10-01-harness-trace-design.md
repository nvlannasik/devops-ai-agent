# Design — Harness trace: gate metrics and production replay

**Date:** 2026-10-01
**Status:** design agreed section by section in chat. Nothing implemented yet.
**Scope:** `devops-ai-agent` only. One additive migration (`011_agent_events.sql`), one optional
constructor parameter on `DevOpsAgent`, three dashboard routes. No change to `devops-mcp-server`,
`llm-worker`, or any cross-repo contract.

## 1. Problem

The agent is mostly harness now: a dozen gates and scrubbers sit between the model and Slack, and
another dozen between a proposal and an approval card. Two things about that harness cannot be
answered today.

1. **Is a gate helping?** Every gate logs its decision, and nothing aggregates the logs. Nobody can
   say how often `log-gap` nudges in a week, or how often its extra round made the answer worse.
   That question is not hypothetical: on 2026-09-29 (thread `1790690405.435999`) the log-gap round
   replaced a complete RCA with "Here are the last 10 log lines … as requested", and it was found
   by reading `kubectl logs` by hand.
2. **Does a harness change fix a production failure without breaking another?** The benchmark
   answers this for synthetic cases, against a live cluster and a live LLM — slow, noisy, and
   blind to whatever production did that no case reproduces. A production investigation cannot be
   re-run: tool results are compacted at ingest (`context/compact.ts`), held in Redis for 24h, and
   logged only truncated. The raw evidence a failure was built from is gone within a day.

Both need the same thing: a record of each investigation — what the model said, what each tool
returned, and what each gate decided. One recording, two consumers.

## 2. Scope

**In:**
- `agent_events` table and a recorder writing to it from the loop (§3, §4).
- One `gate` event at every point that already logs a decision (§5).
- Dashboard: a Harness page, a per-gate drill-down, a per-incident event timeline, and a read-only
  trace export endpoint (§6).
- Replay runner with two modes, `gates` (offline, deterministic) and `tools` (live LLM, recorded
  tools), covering `investigate()` and the remediation proposal step (§7).
- Regression cases under `replay/cases/`, run in `gates` mode by `npm test` (§8).

**Out, with reasons:**
- **Converting 2026-09-29's incident into a case.** It was never recorded and its logs are
  truncated. It stays protected by the unit tests added with its fix.
- **Recording full LLM requests.** ~40K tokens per call, and neither mode needs them: `gates`
  replays responses, `tools` rebuilds the prompt from the code under test — which is the point.
- **Replaying the Slack layer** (card rendering, posting). It is not harness; `utils/slack` has
  its own tests.
- **Automatic case creation from production.** Export is a deliberate human step, because a trace
  carries cluster data and the redaction pass needs a reviewer (§8.2).

## 3. Architecture

```
investigate(thread)                                  recorder (per investigation, in memory)
  ├─ start  ── issue text, opts, tool defs, sha ──►   start
  ├─ llm.chat()     ── response, usage, skills  ──►   llm
  ├─ mcp.callTool() ── input, RAW result|error  ──►   tool
  ├─ gate/scrubber  ── name, outcome, detail    ──►   gate
  └─ done()         ── final answer             ──►   end ──► one batched INSERT, fire-and-forget
```

`DevOpsAgent` takes optional dependencies: `new DevOpsAgent({ llm?, mcp?, recorder? })`. Production
passes nothing and behaves exactly as today; replay passes fakes. The recorder is the only new
writer. It never throws into the loop: a failed INSERT is logged at `warn` and the investigation is
unaffected, the same contract as `UsageStore.record`.

Delegates record under their own sub-thread id (`<thread>/sub-N`), which `withTrace` already makes
the ambient `traceId`, so parallel delegates interleave safely and replay can route by thread.

The proposal step records under the alert's thread, flagged `phase: "proposal"`, so one thread's
events cover both the RCA and the card decision.

## 4. Storage

### 4.1 Schema (`migrations/011_agent_events.sql`)

```sql
CREATE TABLE IF NOT EXISTS agent_events (
  id          bigserial PRIMARY KEY,
  thread_ts   text        NOT NULL,   -- includes delegate sub-threads: "<thread>/sub-1"
  seq         integer     NOT NULL,   -- order within one investigation run
  kind        text        NOT NULL,   -- start | llm | tool | gate | end
  name        text,                   -- tool name, gate name, or LLM backend
  outcome     text,                   -- gate only: nudge | restore | kept | refused | dropped | capped | …
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_thread ON agent_events (thread_ts, seq);
CREATE INDEX IF NOT EXISTS agent_events_gate   ON agent_events (kind, name, created_at);
```

A thread can hold several runs (an alert, then follow-up mentions). Each `start` carries a
`run` id (uuid); every event of that run carries it in `payload.run`, and `seq` restarts at 0 per
run. Replay selects one run.

### 4.2 Payloads

| kind | payload |
|---|---|
| `start` | `run`, `source` (`prod` \| `bench` — set by whoever builds the recorder: `bench/run.ts` passes `bench`, the app's default is `prod`), `sha` (`GIT_SHA` env when the image sets it, else `"unknown"`; wiring the CI build arg is part of step 1), `issue` (full text incl. recall block), `opts` (`mode`, `trigger`, `namespace`, `maxToolRounds`, `maxIterations`, `depth`), `tools` (MCP tool definitions at that moment) |
| `llm` | `run`, `phase` (`investigate` \| `proposal`), `content` (response blocks), `stopReason`, `usage`, `backend`, `route`, `skills` (names loaded for that call) |
| `tool` | `run`, `name`, `input`, `result` (RAW, pre-guard, pre-compaction) or `error`, `ms`, `truncated` |
| `gate` | `run`, `detail` (the sentence the log line already writes, ≤ 500 chars), plus gate-specific numbers (e.g. `dropped: 5`) |
| `end` | `run`, `answer` (after every scrubber), `ms`, `llmCalls`, `toolCalls` |

### 4.3 Size and retention

- One tool result is capped at **512 KB**; larger results are cut and flagged `truncated: true`.
  Replay treats a truncated result as recorded: the agent compacts far below 512 KB anyway.
- Measured basis (2026-10-01): 203 incidents in 36 days (~6/day), one Loki result up to 298K
  chars, Postgres volume 8Gi with 7.6G free, database 10 MB. Estimate ~1 MB raw per
  investigation → ~180 MB raw for 30 days, less after TOAST compression.
- **Retention:** `start`/`llm`/`tool`/`end` rows older than **30 days** are deleted; `gate` rows are
  kept **180 days** (small, and they are the trend). Deletion rides the existing poller in
  `app/index.ts` beside `expireStaleRemediations` / `runIncidentReconcile` — one DELETE per kind per
  pass, `LIMIT`ed, so a backlog never takes a long lock.
- `TRACE_ENABLED` (default `true`) turns recording off without a code change.

### 4.4 Redaction

The database holds raw results, at the same trust level as `incidents.root_cause` and the Redis
conversation it already stores. Redaction happens at **export** (§8.2), the only step that moves a
trace out of the cluster.

## 5. Gate events

One `recorder.gate(name, outcome, detail)` call at each point that already logs its decision. No
gate's logic changes.

| Group | Gate names (outcomes) |
|---|---|
| Loop nudges | `no-evidence`, `log-gap`, `image-gap`, `rca-completeness` (`nudge`); their resolution (`accepted` \| `restored` \| `kept-earlier`); `nudge-lost-rca` (`kept`) |
| Loop ceilings | `tool-budget`, `iteration-ceiling`, `deadline` (`forced`); `delegate` (`refused`) |
| Tool input | `placeholder` (`refused`), `injection` (`framed`), `repeat-call` (`memo`), `log-fanout` (`refused`) |
| Output scrubbers | `confidence-cap` (`capped` \| `kept-high`), `template-echo`, `fabricated-note`, `runbook`, `offer` (`dropped`, with count) |
| After the answer | `grounding` (`gap`, with names), `rca-structure` (`card` \| `conversation`) |
| Remediation | each `refusalFor` gate by name — `replacement`, `quarantine`, `orphan`, `offer`, `target`, `resource-fault`, `scale`, `image` (`refused`); `dry-run` (`failed`); `proposal` (`posted` \| `refused-hidden` \| `refused-posted` \| `null`) |

**Nudge resolution is the headline metric.** Every `nudge` is followed, in the same run, by exactly
one resolution event for the same gate: `accepted` (the new answer was used), `restored` (the extra
round fetched nothing, pre-nudge answer kept), or `kept-earlier` (the retry was worse and was
discarded — `nudge-lost-rca`, or the completion gate's "more missing" check). A gate whose nudges
mostly end `kept-earlier` costs more than it buys.

Gate names are a closed union type in `agent/trace/`, so a typo is a compile error and the
dashboard's list of gates is the type's list.

## 6. Dashboard

Three routes, added to `matchRoute` in `src/dashboard/server.ts`:

- **`/harness`** — per-gate table for 7 and 30 days: fires, % of investigations, outcome
  breakdown, daily sparkline; and a nudge-resolution panel (accepted / restored / kept-earlier per
  gate). `source = prod` only; bench runs are recorded but filtered out by default.
- **`/harness/:gate`** — the runs that fired one gate, newest first, each linked to the existing
  incident detail page when the thread has an incident.
- **`/incidents/:id`** gains an **event timeline**: the run's `llm` / `tool` / `gate` events in
  order, with tool results collapsed to their size and first line. "Why did the answer come out
  like this" stops needing `kubectl logs`.
- **`GET /api/trace/:thread_ts`** — the full event list of one thread as JSON, for export. Behind
  the dashboard's existing password, read-only like every other route.

UI work goes through the `ui-ux-pro-max` skill and is verified in a browser (Playwright,
`~/.render-check`), per standing practice.

## 7. Replay

### 7.1 Fakes (`src/replay/`)

- **`ReplayLLM`** — a queue of recorded `llm` responses per thread (parent and each `/sub-N`),
  routed by the ambient `traceId`.
  - `gates` mode: an empty queue throws `Diverged("LLM #N on <thread>")`.
  - `tools` mode: delegates to a real `LLMClient` built from env, like the bench.
- **`ReplayMCP`** — recorded `tool` results looked up by `thread + toolCallKey(name, input)`;
  `getTools()` returns the recorded definitions from `start`.
  - `gates` mode: an unrecorded call throws `Diverged("tool <name> <input> on <thread>")`.
  - `tools` mode: returns `Error: not recorded in this trace` — the model sees a tool failure and
    carries on, which is what a real failure looks like to it.
- The recorder is **off** during replay, so replays never reach the metrics.

### 7.2 What runs

`investigate(thread, issue, opts)` with the recorded issue and opts, then — when the trace holds a
`phase: "proposal"` event — the proposal step as the alert path runs it (`proposeWithRetry` →
`refusalFor` → dry-run served from the recorded tool result). Slack is never touched.

### 7.3 Outcome

`passed` | `failed` (which expectation) | `diverged` (where) | `crashed` (stack). In `gates` mode,
`diverged` is the expected result of a deliberate harness change and the reason to look, not a
failure of the runner; a case opts into accepting it with `allowDiverge`.

## 8. Regression cases

### 8.1 Format

```
replay/cases/<name>/trace.json    — exported, redacted event list of one run
replay/cases/<name>/expect.json
```

```json
{
  "answer":   { "must": ["Root Cause"], "mustNot": ["as requested"] },
  "gates":    { "must": ["log-gap:nudge"], "mustNot": ["nudge-lost-rca:kept"] },
  "proposal": { "action": null },
  "allowDiverge": false
}
```

`must`/`mustNot` are case-insensitive regexes, the same convention as `bench/cases/*/case.json`.
`gates` entries are `name:outcome` strings matched against the replay's own gate events.

### 8.2 Export

`npm run replay:export -- <thread_ts> <name> [--run <uuid>]` fetches `/api/trace/:thread_ts` over
the existing dashboard port-forward (no production DB credentials locally — consistent with the
rule that the bench never points `DB_HOST` at production), picks the run, redacts, writes
`trace.json` and a skeleton `expect.json`, and prints every redaction and the file size for review
before commit.

Redaction patterns: `Authorization: Bearer …`, AWS access key ids and secret keys, JWTs,
`password=` / `passwd=` / `secret=` / `token=` values, and URLs with embedded credentials. Each
match becomes `[REDACTED]`. Secret VALUES never reach a trace in the first place —
`k8s_list_secrets` returns names and types only.

### 8.3 Running

- `npm test` runs every case in `gates` mode (target: under 1s per case).
- `npm run replay -- <case> --mode tools --attempts 3` runs with a live LLM and reports pass^k
  the way the bench does.

## 9. Testing

1. **Round-trip (the proof the recording is complete):** run an investigation against a scripted
   LLM and scripted MCP with the recorder on; replay the captured events in `gates` mode; the final
   answer and the gate events must be identical.
2. **Divergence:** a deliberately altered gate turns the same replay into `diverged`, never a crash
   and never a silent pass.
3. **Recorder:** the 512 KB cap, batching, run/seq numbering, and an INSERT failure that leaves the
   investigation untouched.
4. **Redaction:** a positive and a negative fixture per pattern.
5. **Dashboard:** aggregation queries against fixture rows, the route table, and a browser check.

## 10. Build order

1. Migration + recorder + `start`/`llm`/`tool`/`end` events + retention.
2. Gate events (§5).
3. Dashboard pages and the export endpoint — **metrics are usable from here**, before replay exists.
4. Replay runner, `gates` mode, round-trip test.
5. `tools` mode, export command, first real case from the first recorded production incident.

## 11. Risks

- **Recording cost on the hot path.** Buffered in memory and written once per run; the extra work
  per tool call is one object push. The INSERT is off the critical path.
- **Trace drift from code drift.** A trace recorded by an older agent replays against newer code
  by design. `start.sha` says which code recorded it; a case whose trace predates a tool-schema
  change may need re-exporting rather than a code fix, and the `diverged` message says where.
- **Sensitive data in the repo.** Mitigated by export-time redaction plus human review; exports
  are never automatic.
