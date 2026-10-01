# Harness Trace (iteration 1: recording, gate events, dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every investigation (LLM responses, raw tool results, gate decisions) into Postgres and show per-gate metrics on a new dashboard page, so harness behaviour is measurable in production.

**Architecture:** A `TraceRecorder` buffers events per investigation run in memory and writes them with one batched INSERT when the run ends. LLM and MCP traffic is captured by wrapping the two clients once in the `DevOpsAgent` constructor (every call site covered without touching it); gate decisions are one explicit `trace.gate(...)` call beside each existing log line. The dashboard reads the same table.

**Tech Stack:** TypeScript ESM (Node 24), `pg`, `node:test` + tsx, server-rendered dashboard (`src/dashboard/`).

**Spec:** `docs/superpowers/specs/2026-10-01-harness-trace-design.md` — this plan covers build-order steps 1–3 (§10). Replay (§7, §8) is a separate, later plan.

## Global Constraints

- Node 24, TS ESM; tests `*.test.ts` via `npm test`; no new dependencies.
- Table `agent_events`, columns exactly as spec §4.1; migration `migrations/011_agent_events.sql`.
- Event kinds `start | llm | tool | gate | end`. Tool result cap 512K chars, flagged `truncated: true`.
- Retention: run bodies 30 days, gate rows 180 days, pruned by the existing verification poller.
- `TRACE_ENABLED` (default true); `GIT_SHA` env, `"unknown"` when unset.
- `source` = `prod` by default, `bench` from `src/bench/run.ts`; dashboard shows `prod` only.
- Recording never throws into an investigation (same contract as `UsageStore.record`).
- Dashboard: `esc()` every row value; UI via `ui-ux-pro-max`, verified in a browser (`~/.render-check`).
- Docs in English. Push to `main` authorized; deploy = CI then `kubectl -n devops-tools rollout restart deploy/devops-ai-agent`.

## Review Focus

1. **An investigation that throws** must still write its run — `finish()` runs in a `finally`. (Task 3)
2. **`\u0000` or a lone surrogate** in a tool result fails the whole jsonb batch — the recorder strips both. (Task 2)
3. **Parallel delegates** record into their own runs via the ambient `currentTrace()`, never the parent's. (Task 2)
4. **A gate fired with no open run** (app layer, after flush) is written standalone, not dropped. (Task 2)
5. **Route input** — `/harness/:gate` only for names in `GATE_NAMES`, `/api/trace/:ts` only for a Slack ts shape; everything else 404s before any query. (Task 7)

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/011_agent_events.sql` | Table + two indexes. |
| `src/agent/trace/store.ts` | `TraceStore`: chunked batch INSERT, retention DELETEs. SQL only. |
| `src/agent/trace/index.ts` | `TraceRecorder`, `GATE_NAMES`/`GateName`, `refusalGate`, `instrumentLLM`, `instrumentMCP`. No SQL. |
| `src/config/index.ts` | `config.trace = { enabled, sha }`. |
| `src/agent/index.ts` | Constructor deps, wiring, run begin/end/finish, gate calls, `recordGate`, `pruneTraces`. |
| `src/app/index.ts` | Post-run gates (`rca-structure`, `grounding`, `proposal`), retention pass in the poller. |
| `src/bench/run.ts`, `Dockerfile`, CI workflow | `traceSource: "bench"`; `GIT_SHA` build arg. |
| `src/dashboard/{queries,server,views}.ts` | Queries, routes, Harness pages, incident timeline, `/api/trace`. |

## Tasks

### Task 1: Migration and `TraceStore`
- Create `migrations/011_agent_events.sql` (spec §4.1).
- `TraceStore(pool | null)`: `insert(rows: EventRow[])` — 7 params per row, chunks of `INSERT_CHUNK = 500`, `$6::jsonb`, warn on failure; `prune()` — two `DELETE … WHERE id IN (SELECT … LIMIT 5000)` (kind <> 'gate' older than 30 days; kind = 'gate' older than 180 days), returns rows deleted, 0 on failure.
- Tests (`store.test.ts`, stub pool): one INSERT with 14 params for 2 rows; 501 rows → 2 statements; null pool / empty rows / failing DB never throw; prune SQL names both windows.
- Commit: `feat(trace): agent_events table and its store`.

### Task 2: `TraceRecorder` and client wrappers
- `TraceRecorder(sink | null, { source, sha })`: `enabled`, `begin(thread, start)`, `skills(thread, names)`, `llm(thread, response)`, `tool(thread, name, input, {result}|{error}, ms)`, `gate(thread, name, outcome, detail?, extra?)`, `resolveNudge(thread, "accepted"|"restored"|"kept-earlier")`, `end(thread, payload)`, `finish(thread)`.
  - One open run per thread (uuid `run`, `seq` from 0); `start` payload carries `source` and `sha`; every gate payload carries `source`.
  - `gate(..., "nudge")` while another nudge is pending first resolves the pending one as `accepted`; `end()` and `finish()` resolve any pending nudge as `accepted`.
  - Gate with no open run → immediate single-row insert with `run: null`. `llm`/`tool` with no open run → ignored.
  - Strip `\u0000` and lone surrogates (`stripLoneSurrogates`) from every string in a payload; cap tool results at 512K chars.
  - At most 200 open runs (oldest flushed); sink failure is a warn.
- `instrumentLLM(llm, () => recorder)` returns a client whose `chat` records the response under `currentTrace()`; `instrumentMCP(mcp, () => recorder)` patches `callTool` to record the RAW result or the error.
- Tests (`recorder.test.ts`): ordering/seq/run id; nudge resolution (default accepted, explicit kept-earlier, second nudge); standalone gate; ignored tool outside a run; cap + NUL + surrogate; disabled no-op; parallel delegates via `withTrace`; throwing sink.
- Commit: `feat(trace): recorder with per-run buffering, nudge resolution and client wrappers`.

### Task 3: Wire into the agent
- `config.trace`. `export interface AgentDeps { llm?; mcp?; traceSource?; recorder? }`; `constructor(deps = {})` wraps `llm`/`mcp` with getters onto `this.trace`; `initialize()` gives the default recorder a `TraceStore(pool)` (an injected recorder is kept) and sets `this.traceStore`.
- `investigate()` → `runInvestigation(...).finally(() => this.trace.finish(threadId))`; `begin` after "Investigation started" with `{ phase: "investigate", issue, opts, tools }`; `trace.skills()` before each chat; `done()` calls `trace.end(threadId, { answer, ms, llmCalls, toolCalls })` after the scrubbers.
- `proposeRemediation` becomes a wrapper that opens a `phase: "proposal"` run under the thread, runs the original body (`proposeRemediationRun`), ends and finishes it.
- Public `recordGate(...)` and `pruneTraces()`.
- `src/bench/run.ts`: `new DevOpsAgent({ traceSource: "bench" })`. Dockerfile runtime stage: `ARG GIT_SHA=unknown` / `ENV GIT_SHA=$GIT_SHA`; CI `build-args: GIT_SHA=${{ github.sha }}`.
- Tests (`wiring.test.ts`): a scripted conversation run records `start, llm, tool, llm, end`; a run whose LLM throws still records `start` and no `end`.
- Commit: `feat(trace): record every investigation and proposal run`.

### Task 4: Gate events in the loop
- One call beside each existing log line: `no-evidence` nudge; log-gap `restore` → `resolveNudge("restored")`; `log-gap` nudge; `nudge-lost-rca` kept + `resolveNudge("kept-earlier")`; `image-gap` nudge; `rca-completeness` nudge; completion "more missing" → `resolveNudge("kept-earlier")`; `scope-lock`, `log-fanout`, `write-blocked`, `placeholder` refused; `tool-budget` / `iteration-ceiling` forced; `deadline` forced/apology; `iteration-ceiling` exhausted; `delegate` refused; `injection` framed; `repeat-call` memo. In `done()`, before `end`: `confidence-cap` capped/kept-high, `template-echo`, `fabricated-note`, `runbook` dropped, `offer` stripped.
- Tests (`gates.test.ts`, scripted agent): crashloop alert answered without logs → `log-gap:nudge` + `log-gap:accepted`; a retry that loses the RCA → `nudge-lost-rca:kept` + `log-gap:kept-earlier`.
- Commit: `feat(trace): every loop gate and scrubber records its decision`.

### Task 5: Post-run gates and retention
- `refusalGate("image gate") → "remediation-image"` (unknown → `remediation-other`); refusal callback and dry-run failure record gates.
- App: `rca-structure` card/conversation; `grounding` gap; `proposal` posted / refused-hidden / refused-posted / null; a fourth `try` in the poller calling `agent.pruneTraces()`.
- Tests: `refusalGate` mapping; `maybeProposeRemediation` records `proposal:refused-hidden`.
- Commit: `feat(trace): remediation and post-run gates; trace retention in the poller`.

### Task 6: Dashboard queries
- `harness()` → `{ runs7, runs30, stats: {name,outcome,d7,d30}[] }` (prod only; runs = `start` with `phase = 'investigate'`, not `/sub-`).
- `harnessGate(name)` → 30-day daily series (`generate_series`) + latest 100 events joined to `incidents` on the parent thread.
- `timeline(thread)` → events of the thread and its sub-threads, tool results as length + first 200 chars only; `detail()` gains `timeline`.
- `trace(thread)` → full events for export, limit 2000.
- Tests: prod filter + delegate exclusion; timeline never selects full results; null pool returns empties.
- Commit: `feat(dashboard): harness, gate drill-down, timeline and trace queries`.

### Task 7: Routes and pages
- Invoke `ui-ux-pro-max` first.
- Routes `/harness`, `/harness/:gate` (only `GATE_NAMES`), `/api/trace/:ts` (`^\d{1,12}\.\d{1,9}$`, JSON).
- `harnessPage` (gate table: 7d, 30d, per-run %, outcomes; "What each nudge led to" table), `harnessGatePage` (line chart + latest events linked to incidents), timeline section on `detailPage`, "Harness" nav item + icon.
- Tests: route table incl. rejects; harness page links and outcome rendering, no `undefined`/`NaN`; drill-down escapes `detail`.
- Browser check at 390px and 1280px.
- Commit: `feat(dashboard): Harness page, gate drill-down, incident timeline, trace export endpoint`.

### Task 8: Docs, deploy, verify
- `CLAUDE.md` gotcha (clients wrapped once; gates record themselves; `GATE_NAMES` closed; strip NUL/surrogates); `MEMORY_BANK.md` entry 35.
- Push, wait for CI, rollout restart, confirm `[migrate]` applied 011, a live run produces `start/llm/tool/end` rows with the real `sha`, and `/harness` + the incident timeline render.
