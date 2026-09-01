# Loop-mode probes — what the agent builder flow must be, and how to prove it

Shape A (one throw) needs a flow that reads evidence and writes an RCA. **Loop mode needs
more**: the flow must be able to *ask for tools*, in a shape we can parse, over and over,
and know when to stop.

This directory specifies the flow and gives you five probes to test it before we write code.

Run the shape-A probes in `../README.md` first — L-probes assume P1 (payload size) and P2
(RCA format) already passed. If P1 failed on size, loop mode is dead on arrival: its payload
grows every round.

---

## Part 1 — What the flow must look like

Our agent keeps the tools and calls them inside the cluster. The agent builder never touches
the MCP server; it only ever sees **tool names** and **the text of their results**. What it
gets in return is the ability to drive the investigation.

### The round trip

```
round N:  llm-worker  ──POST /api/v1/run/<flow>──> flow   input_value = protocol + catalog + transcript
                      <──────────────────────         {"tool_calls":[...]}  or  prose RCA
```

`llm-worker` parses the reply. Valid `tool_calls` JSON → it becomes an Anthropic-shaped
`tool_use` block and goes back to the agent, which runs the tools and starts round N+1.
Prose → that is the final answer.

### Components

| # | Component | Setting | Why it matters |
|---|---|---|---|
| 1 | **Chat Input** | — | Receives `input_value`. Nothing to configure. |
| 2 | **Prompt** | Holds the protocol contract (Part 2). **Template variables must be off or escaped.** | This is the one that breaks silently. Langflow prompt components treat `{word}` as a variable. Our payload is full of `{namespace="payment"}` PromQL and `{"tool_calls":...}` JSON. If the component tries to interpolate those, it either errors or eats them. If you cannot disable templating, the protocol block must live in the flow's prompt and our payload must carry only evidence — **and even then PromQL braces in the evidence are at risk.** L1 tests exactly this. |
| 3 | **Model** | `temperature: 0` – `0.2`. Max output tokens ≥ 2048. | The reply is either strict JSON or a full RCA. High temperature produces creative JSON — trailing commas, renamed keys, a friendly sentence before the brace. |
| 4 | **Chat Output** | Raw passthrough. **No output parser, no JSON parser, no post-processor.** | Anything that reformats the model's text will mangle JSON or strip the mrkdwn `*bold*` our Slack renderer needs. |

### Memory: OFF

Turn the memory / chat-history component **off**, or leave it out of the flow.

Our agent already owns the conversation. It resends the **entire transcript** every round —
that is how the existing loop works, and `assembleRequest()` already budgets and trims it.
If the flow also remembers, every round gets the history twice: once from us, once from the
flow. The model sees duplicated tool results and re-issues calls it already made.

Consequence: `session_id` becomes cosmetic for correctness, not load-bearing. Send a unique
one per investigation anyway (the Slack thread id) so the platform's own logs are greppable
against ours — but nothing depends on it isolating.

> If memory **cannot** be turned off, say so — the design changes: we would send only the
> newest tool results each round and let the flow hold the history. That is a different
> contract, and it makes a dropped round unrecoverable.

### What must NOT be in the flow

- **No tool / agent components.** No HTTP request node, no "Tool Calling Agent", no MCP
  client. The flow reasons; it does not act. Anything that reaches out to infrastructure
  from inside the platform defeats the whole reason we are doing this.
- **No output parser or structured-output enforcement** (see Chat Output above).
- **No greeting/signature append.** It lands in Slack verbatim.

---

## Part 2 — The protocol contract

This block is what `llm-worker` will generate. It appears at the top of `input_value` on
**every** round. In the probe fixtures it is spelled out in full so you can paste it into
the flow's prompt component instead if templating forces that.

```
You are an expert DevOps AI Agent investigating a production incident.

You cannot run tools yourself. The calling agent runs them for you inside the cluster.
Each round you may either ask for tool results, or deliver the final RCA.

TO ASK FOR TOOLS — reply with ONLY this JSON. No prose before or after it, no code fence:
{"tool_calls":[{"id":"c1","name":"<tool>","args":{...}}]}
You may request several tools in one reply; they run in parallel. Ask for everything you
can determine now — a round trip is expensive.

TO FINISH — reply with the RCA as prose, in the format below. Never mix the two: a reply
containing JSON is treated as a tool request and its prose is discarded.

Stop asking and write the RCA as soon as the evidence supports a conclusion. You have a
hard budget of 8 rounds; after that you will be asked for a final answer with whatever you
have.
```

Followed by the tool catalog, then the RCA format (same one as shape A — see
`../p2-full-rca.txt`), then the transcript.

### Why "no code fence"

We *can* strip a fence, and the parser will. But asking for a bare object first tells us
whether the model can follow a strict output contract at all. A model that adds "Sure!
Here's what I need:" in front of the JSON on round 1 will do worse things on round 4.

---

## Part 3 — Running the probes

```bash
export AB_URL='https://<agent-builder-host>/api/v1/run/<flow-id>'
export AB_KEY='<x-api-key>'

cd docs/examples/a2a/loop
./run-loop.sh          # runs L1 → L2 → L3 in order, saves each response
```

Each response is saved as `<probe>-response.json`. The script prints the extracted answer
text after each round so you can see the shape immediately.

Individual probes: `../run.sh loop/l4-malformed-recovery.txt`

---

## The probes

### L1 — Round 1: does it ask for tools, in our shape?

**Fixture:** `l1-round1.txt` — alert only, zero evidence. The only correct move is to ask.

- [ ] Reply is a bare JSON object, no prose, no fence
- [ ] Top-level key is `tool_calls` (not `tools`, `calls`, `actions`, `function_calls`)
- [ ] Each entry has `id`, `name`, `args` — `args` is an object, not a JSON **string**
- [ ] `name` values are real names from the catalog, spelled exactly
- [ ] `args` keys match the catalog signature (`namespace`/`name`, not `pod`/`ns`)
- [ ] It asks for **several** tools at once, not one — one-at-a-time turns an 8-round budget
      into 8 shallow lookups
- [ ] **PromQL braces survived**: if it emits a `prometheus_query_range`, does the query still
      contain `{namespace="payment"}`? A stripped or mangled brace means the prompt component
      ate it — the templating problem from Part 1, and it will corrupt evidence too

### L2 — Round 2: does it use what it got, and not repeat itself?

**Fixture:** `l2-round2.txt` — round 1's request plus its results, as our agent would send.
The evidence is deliberately *suggestive but incomplete*: the pod OOMKilled, but the logs
that explain why are not there yet.

- [ ] Still valid `tool_calls` JSON (round 1 being clean is not proof round 2 will be)
- [ ] Does **not** re-request a tool whose result is already in the transcript
- [ ] The new request follows from the evidence — asks for the previous container's logs, or
      the memory series, not something unrelated
- [ ] Args are derived from the results, not just the alert labels — this is the whole
      advantage of loop mode over a flat sweep. A model that only ever uses alert labels
      gives us nothing a sweep would not.

### L3 — Round 3: does it stop?

**Fixture:** `l3-round3.txt` — the full picture. Nothing further is needed to conclude.

- [ ] Reply is **prose**, not JSON. This is the failure mode that matters most: a model that
      never stops burns the round budget and returns a forced, half-formed answer every time.
- [ ] The prose is the RCA in our format (same checks as P2: `*single asterisk*`, `•`
      bullets, `*📍 Root Cause*` and `*📈 Confidence:*` present)
- [ ] It cites the evidence it was given, and does not invent tool results it never received

### L4 — Malformed recovery

**Fixture:** `l4-malformed-recovery.txt` — a transcript where the model's previous reply was
invalid, and it is told so.

When JSON comes back broken, `llm-worker` sends **one** correction and no more. This tests
whether that correction works.

- [ ] The reply after the correction is valid JSON
- [ ] It does not apologize in prose *and then* emit JSON — the apology makes it unparseable
      again, and we do not get a third try
- [ ] It does not repeat the same malformed structure

If the model cannot recover, the fallback is: treat any second failure as `end_turn` and use
whatever text it sent as the answer. Ugly, but it never hangs.

### L5 — Stop discipline under a budget

**Fixture:** `l5-stop-discipline.txt` — round 8, a large transcript, and an explicit "this is
your last round, answer now".

- [ ] Returns prose, unconditionally. No JSON.
- [ ] The answer is honest about what it could not determine, rather than fabricating a root
      cause to fill the template. An RCA that invents a cause is worse than one that says
      "inconclusive — here is what I ruled out".

### L6 — Payload growth ceiling

Not a fixture — a measurement, using L3 (the largest).

Real transcripts run larger than these fixtures: 35 tools in the catalog and up to 20 KB of
accumulated tool results by round 5.

- [ ] Record `input_value` bytes and wall-clock seconds for each of L1/L2/L3 (`run-loop.sh`
      prints both)
- [ ] Extrapolate: does round 5–8 stay under whatever ceiling P1 found?
- [ ] Does latency grow with payload, and by how much? Round count × per-round latency is the
      real cost. **8 rounds × 30 s = 4 minutes to first Slack message.** Decide whether that
      is acceptable before we build it, not after.

---

## Verdicts

| Finding | Verdict |
|---|---|
| L1 or L2 returns prose instead of JSON, consistently | **Loop mode is out.** Fall back to shape A (flat sweep, one round). |
| L3 never stops — always more `tool_calls` | **Loop mode is out** unless the flow prompt can be tuned to fix it. Every investigation would hit the budget and return a forced answer. |
| Prompt component eats `{...}` braces and cannot be disabled | **Blocker for both shapes.** PromQL and JSON both die. Needs a platform answer before anything is built. |
| Memory cannot be turned off | Design change — different contract, discuss before building. |
| Key names differ but are stable (`function_calls` not `tool_calls`) | Friction — fix in the flow prompt, or match theirs in the parser. |
| Wraps JSON in a code fence | Friction — the parser strips fences. |
| Asks for one tool at a time | Friction — costs rounds. Tune the flow prompt to push for batching. |
| L4 cannot recover from malformed | Friction — we degrade to "second failure = final answer". |
| 8 rounds × per-round latency is too slow | Judgement call — lower `A2A_MAX_ROUNDS`. At 1 it **is** shape A, same code. |
