# Replay — production runs as regression cases

Every investigation is recorded into `agent_events` (see `src/agent/trace/`). Replay plays one
recorded run back through the **current** code. Design: `docs/superpowers/specs/2026-10-01-harness-trace-design.md` §7–§9.

## Two modes

| Mode | Model | Tools | Use it for |
|---|---|---|---|
| `gates` (default) | the recorded answers | the recorded results | a change to a gate, a scrubber, the proposal chain — deterministic, free, ~100 ms a case |
| `tools` | live (`LLM_*` env, like the bench) | the recorded results | a change to a prompt, a skill or a model — varies run to run, costs LLM calls |

In `gates` mode a run that asks for an LLM turn or a tool call the recording does not have ends
**`diverged`**, with where. That is the expected result of a deliberate harness change: the new
code decided differently, and the place it says is where to look.

## Commands

```bash
npm test                                             # every case below, gates mode
npm run replay                                       # same, with a summary line per case
npm run replay -- <case> --mode tools --attempts 3   # live model, pass^k

# a production run → a new case (needs the dashboard port-forward on :3101)
DASHBOARD_PASSWORD=… npm run replay:export -- <thread_ts> <case-name> [--run <uuid>]
```

Export reads `/api/trace/<thread_ts>` from the dashboard — never the production database — picks
the latest investigation run on that thread (or `--run`), with its delegates and its proposal,
redacts tokens, keys, JWTs, `password=`-style values and URL credentials, and prints every
redaction. **Read `trace.json` before committing it.** Redaction is pattern matching; the review is
the control.

## A case

```
replay/cases/<name>/trace.json    one run, redacted
replay/cases/<name>/expect.json
```

```json
{
  "answer":   { "must": ["healthy"], "mustNot": ["Root Cause"] },
  "gates":    { "must": ["log-gap:nudge"], "mustNot": ["nudge-lost-rca:kept"] },
  "proposal": { "action": null },
  "allowDiverge": false
}
```

Regexes are case-insensitive. Gate entries are `name:outcome` from `GATE_NAMES`. Export writes the
observed gates as `gates.must` — a snapshot. Edit it to say what this incident **should** produce.

## Known limits

- A run replays from an empty thread. A follow-up mention's earlier turns are not restored, so a
  gate that reads thread history can decide differently than it did live.
- Delegate budgets come from the recorded sub-run; every other config value is local.
- Gates the app records after a run (`rca-structure`, `grounding`, `proposal`) belong to no run and
  are not replayed.
