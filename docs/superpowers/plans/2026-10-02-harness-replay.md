# Harness Replay (iteration 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay a recorded production investigation against the current code — offline and deterministic (`gates` mode) or with a live LLM over recorded tool results (`tools` mode) — and keep chosen traces as regression cases run by `npm test`.

**Architecture:** A trace is the event list `/api/trace/:thread` returns, narrowed to one investigation run plus its delegates and its proposal run. Replay builds a real `DevOpsAgent` with a `ReplayLLM` and a `ReplayMCP` fed from that list (the `AgentDeps` injection from iteration 1), runs `investigate()` and the proposal step, captures the replay's own gate events with an in-memory recorder, and scores them against `expect.json`.

**Tech Stack:** TypeScript ESM, `node:test` + tsx, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-harness-trace-design.md` §7–§9 (build steps 4–5).

## Global Constraints

- Modes `gates` | `tools`; outcomes `passed | failed | diverged | crashed` (spec §7.3).
- Unrecorded LLM call or tool call in `gates` mode → `diverged`, never a crash; in `tools` mode an unrecorded tool returns `Error: not recorded in this trace`.
- Replay never writes to Postgres: the recorder it uses has an in-memory sink, `source: "replay"`.
- Case layout `replay/cases/<name>/trace.json` + `expect.json`; expect format exactly spec §8.1; regexes case-insensitive; gate entries `name:outcome`.
- Export reads `/api/trace/:thread` over the dashboard (env `DASHBOARD_URL`, default `http://localhost:3101`, and `DASHBOARD_PASSWORD`), never the production DB; redacts before writing; prints every redaction.
- Docs in English; push to main authorized; replay is a dev tool, nothing to deploy.

## Review Focus

1. **A thread holding several runs** (an alert, then follow-up mentions): replay picks ONE investigation run plus only ITS delegates and proposal. (Task 1)
2. **The same tool called twice with the same input** replays in recorded order, not failing on the second. (Task 2)
3. **Local config differing from prod** for delegate budgets: taken from the recorded sub-run starts, not local env. (Task 2)
4. **A proposal that passed every gate** replays as that proposal, not as `null` for want of a DB. (Task 2)
5. **A secret inside a log line** in an exported trace is redacted; a near-miss (`token_count=3`) is not. (Task 4)

## File Structure

| File | Responsibility |
|---|---|
| `src/replay/trace.ts` | Trace types; `selectRun(events, runId?)`; `readCase(dir)`. Pure. |
| `src/replay/fakes.ts` | `Diverged`, `ReplayLLM`, `ReplayMCP`. |
| `src/replay/run.ts` | `replay(trace, { mode, live? })` → result; `score(result, expect)`. |
| `src/replay/redact.ts` | `redact(value)` → `{ value, hits }`. Pure. |
| `src/replay/export.ts` | CLI: fetch, select, redact, write a case. |
| `src/replay/cli.ts` | CLI: run cases in either mode, report pass^k. |
| `src/replay/cases.test.ts` | Every `replay/cases/*` in `gates` mode under `npm test`. |
| `src/agent/index.ts`, `src/agent/trace/index.ts` | `AgentDeps.remediations`; `source: "replay"`. |

## Tasks

### Task 1: Trace selection
- `TraceEvent = { thread_ts, seq, kind, name, outcome, payload }` (the `/api/trace` row; array order = insert order).
- `selectRun(events, runId?)`: parent thread = the one without `/sub-`; the given run, else the LATEST parent `start` with `phase: "investigate"`; plus every sub-thread run whose rows sit between the previous parent run and this one (delegates flush before their parent); plus the first parent `phase: "proposal"` run after it. Unknown run id throws.
- Tests: two investigate runs → latest by default, either by id; the earlier run's delegates excluded; proposal attached.

### Task 2: Fakes, runner (gates mode), round-trip
- `ReplayLLM`: per-thread, per-phase queues of `llm` events; routes by `currentTrace()`; empty → `Diverged` (or the live client in tools mode).
- `ReplayMCP`: `getTools()` = parent `start.tools`; `callTool` by `thread + phase + toolCallKey`, recorded order, last repeats; recorded `error` thrown; unrecorded → `Diverged` / error text.
- `replay()`: in-memory recorder (`source: "replay"`), `new DevOpsAgent({ llm, mcp, recorder, remediations })`, delegate budgets from recorded sub-run starts, `investigate(parent, start.issue, start.opts)`, then the proposal from its run's start. Result: answer, `name:outcome` gates, proposal `{action}|{refused}|null`.
- `score(result, expect)` per spec §8.1 with `allowDiverge`.
- Tests: round-trip (scripted run with a delegate and a log-gap nudge → replay → same answer and gates); divergence; duplicate tool call; passed proposal → action.

### Task 3: Cases under npm test + CLI
- `cases.test.ts` over `replay/cases/*`; `cli.ts` (`npm run replay -- [<case>] [--mode gates|tools] [--attempts N]`), tools mode via `createLLMClient()`, pass^k.

### Task 4: Redaction + export, first real case
- `redact()`: Bearer tokens, AWS key ids / secret keys, JWTs, `password|passwd|secret|token|api_key=value` (value ≥ 6 chars, not numeric), URL credentials → `[REDACTED]`.
- `export.ts`: login → `/api/trace/:thread` → `selectRun` → `redact` → `trace.json` + `expect.json` skeleton (observed gates as `gates.must`) → print hits and size. Export the first production trace as a case.

### Task 5: Docs and final review
- `CLAUDE.md` gotcha, `MEMORY_BANK.md` entry 36, `replay/README.md` usage.
