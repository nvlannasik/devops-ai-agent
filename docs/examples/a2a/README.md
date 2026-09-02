# A2A feasibility probes — agent builder

Six things to verify against the real agent builder **before** any code gets written for
the A2A integration. Each probe is a single `curl` with a payload file in this directory.

The design this validates: our agent stays in the cluster and holds the tools; the agent
builder holds the reasoning. We sweep evidence with MCP, ship it as one string, and get an
RCA string back. The MCP server is never exposed to the agent builder platform.

## Running a probe

```bash
export AB_URL='https://<agent-builder-host>/api/v1/run/<flow-id>'
export AB_KEY='<x-api-key>'

./run.sh p1-smoke.txt
```

`run.sh` prints the HTTP status, the wall-clock seconds, and the **unmodified** response
body. Nothing is parsed — the point is to see the real envelope, including whatever the
platform adds that the sample response omits.

Save each response next to its payload as `<probe>-response.json` so the answers are
reviewable later.

## Status — all six probes have now been run

Every probe below has been run against the real flow, and the code they justified is in
`llm-worker` (`LLM_API_FORMAT=agent-builder`, `src/agent-builder.ts`). **P2, P3, P5 and P6
passed on the first pass; P1 and P4 were finished on 2026-09-02 with `run-gaps.sh` and also
passed.** No blocker from the table at the bottom of this file survives.

| Probe | Result |
|---|---|
| P1 — payload ceiling | **No truncation through 32 KB.** A tail canary came back verbatim at 4, 8, 16, 24 and 32 KB |
| P3 — session isolation | **No memory.** Same `session_id`, token stored then asked for, answered `NONE`; `session_id` echoes what we send |
| P4 — failure shape | **Non-2xx with `{"detail": ...}`.** Bad key and unknown flow id both; no error ever dressed as an answer |
| P4 — concurrency | 3 parallel full-size RCAs: **22 s / 24 s / 76 s**, all 200, format intact, no throttling |

The one number still worth respecting is **latency spread**: a single earlier RCA took 104 s,
and the concurrent runs ranged 22–76 s. Budget for the slow end and multiply by the agent's
tool rounds before promising anyone a fast RCA. That is a product constraint, not a bug.

`run-gaps.sh` stays as a regression harness — re-run it after any flow change, because every
result above is a property of the flow's configuration, not of the platform:

```bash
export AB_URL='https://<agent-builder-host>/api/v1/run/<flow-id>'
export AB_KEY='<x-api-key>'

./run-gaps.sh size      # P1 — payload ceiling; a tail canary per rung
./run-gaps.sh session   # P3 — is the flow's memory still off?
./run-gaps.sh failure   # P4 — is a failure still distinguishable from an answer?
./run-gaps.sh load      # P4 — latency spread and concurrency
./run-gaps.sh           # all four
```

**Why `size` still matters most.** A platform that quietly drops the tail of an oversized
payload returns a confident RCA built on half the evidence, and nothing in the response says
so — response length cannot reveal it. The canary is the only detector, and adding a memory
or prompt component to the flow could reintroduce a ceiling that this run did not find.

Raw bodies and generated payloads land in `gap-responses/` (gitignored). Copy anything
worth keeping out of there, the way the earlier responses were kept.

---

## P1 — Does the envelope hold a large multi-line prompt?

**Payload:** `p1-smoke.txt` (tiny, and a first sanity check that the endpoint answers at all)

The sample request in `agent-builder-agus-request.txt` sends one short sentence. Ours will
send **8–20 KB** of alert text, pod descriptions, log excerpts and metric series, with
newlines, backticks, quotes and `{}` braces throughout.

Confirm:
- [ ] A payload with embedded newlines survives (JSON `\n`, not stripped or collapsed)
- [ ] No length ceiling below ~32 KB — if there is one, what is it, and does it return an
      error or silently truncate? **Silent truncation is the dangerous answer**: we would
      ship half the evidence and get a confident RCA built on it.
- [ ] Backticks, `{`/`}`, and `"` in the payload come back intact in the model's reasoning
      (Langflow flows sometimes run the input through a prompt template — a `{name}` in our
      evidence could be eaten as a template variable)

Run P1 first, then re-run it with `p2-full-rca.txt` to test the real size.

## P2 — Can it produce the exact RCA format?

**Payload:** `p2-full-rca.txt` (realistic OOMKill: alert + 5 tool results, ~2.5 KB)

This is the whole bet. Our Slack renderer (`src/dashboard/rca.ts`, `parseRca()`) needs
**at least two `*Bold*` section headings** or it falls back to plain text, and
`src/app/index.ts` looks specifically for a `Root Cause` section to decide whether to post
the RCA card.

Confirm in the response text:
- [ ] Sections present: `*📍 Root Cause*`, `*📊 Evidence*`, `*🔧 Recommended Actions*`,
      `*📈 Confidence:*`
- [ ] Single-asterisk bold (`*text*`), **not** `**text**` — the flow's own persona may
      have been written for standard Markdown, which our renderer will not parse
- [ ] `•` bullets, not `-` or `*`
- [ ] No `##` headers
- [ ] It uses the evidence given and does **not** claim it will "investigate further" or
      ask to run a command — a flow whose persona says "I am a helpful assistant" tends to
      offer next steps instead of concluding

If the format is wrong but the reasoning is good: that is fixable in the flow's own prompt,
which is where the fix belongs. If the flow **cannot** be told to obey the format (locked
persona, no prompt access), we need a decision — reformat pass on our side, or drop the RCA
card and post plainly.

## P3 — Does `session_id` isolate, and is it accepted at all?

**Payloads:** `p3-session-a.txt` then `p3-session-b.txt`

The sample response returns `session_id` equal to the flow id in the URL. If every call
shares one session and the flow has a memory component, **incident A's evidence leaks into
incident B's RCA**.

Run three ways:

1. Send A, then B, with the **same** `session_id`:
   ```bash
   ./run.sh p3-session-a.txt shared-session
   ./run.sh p3-session-b.txt shared-session
   ```
   - [ ] Does B answer `ALPHA-7741`? Then the flow has memory and sessions are real.
   - [ ] Does B answer `NONE`? Then either no memory, or `session_id` is ignored.

2. Send A, then B, with **different** `session_id`s:
   ```bash
   ./run.sh p3-session-a.txt session-one
   ./run.sh p3-session-b.txt session-two
   ```
   - [ ] B must answer `NONE`. If it answers `ALPHA-7741`, **`session_id` in the request
         body is ignored** and every caller shares one conversation. That is a blocker for
         concurrent incidents — we would need one flow per stream, or the platform's own
         session mechanism (a header? a query param? ask the platform owners).

3. Send A and B **at the same time**, different sessions, to see whether the flow
   serializes concurrent calls or handles them in parallel.

Also record: does the response's `session_id` echo what we sent, or always the flow id?

## P4 — Timeout, failure shape, and concurrency

**Payload:** `p2-full-rca.txt` (the big one — slowest realistic case)

Our SQS consumer already extends message visibility during long calls, and the Anthropic
path uses a 600 s request timeout. We need the agent builder's real numbers.

Confirm:
- [ ] Wall-clock time for a full-size RCA (`run.sh` prints it). Three runs, note the spread.
- [ ] Is there a platform-side timeout shorter than ours? Ask the owners; a 60 s gateway
      timeout in front of a 90 s flow is an invisible failure mode.
- [ ] Rate limit: how many concurrent runs per flow / per API key? A noisy alert storm fires
      several investigations at once.
- [ ] **What does a failure look like?** Try a bad `x-api-key` and a nonexistent flow id:
  ```bash
  AB_KEY=wrong ./run.sh p1-smoke.txt
  ```
  - [ ] Non-2xx HTTP status, or 200 with an error inside the body? The sample response has
        `"error": false` inside `outputs[0].outputs[0].results.message` — if failures come
        back as HTTP 200 with `error: true`, our parser must check that field, or a failure
        string gets posted to Slack as an RCA.
  - [ ] Is `outputs` ever empty, or `results.message.text` ever absent/null?

## P5 — Can it ask us for more evidence? (shape B seam)

**Payload:** `p5-ask-for-more.txt` (deliberately incomplete: latency alert, no traces)

Shape A ships one round. Shape B lets the agent builder reply "give me traces over 800 ms"
and we run a second sweep. This probe only checks whether that is **possible** — we are not
building it yet.

Confirm:
- [ ] Does it return the JSON `{"need":[...],"why":"..."}` when told to, cleanly, with no
      prose wrapped around it?
- [ ] Or does it wrap the JSON in a code fence / prose ("Sure! Here's what I need: ...")?
      Fenced JSON is fine, we can strip it. Prose *instead of* JSON means shape B needs a
      different signal.
- [ ] Are the tool names and args it asks for plausible (real tool names from the list,
      well-formed args)?

A "no" here does not block shape A. It tells us shape B costs more than a parser.

## P6 — Whose prompt wins?

**Payload:** `p2-full-rca.txt`, sent to a flow that already has its own persona configured

We send a full system prompt inside `input_value` because the Langflow envelope has no
system-prompt field. The flow's own prompt component also injects one.

Confirm:
- [ ] Does our in-payload instruction actually steer the output, or does the flow's persona
      override it? (P2 passing is evidence it steers.)
- [ ] Can the flow owner edit the flow's prompt? If yes, the RCA format belongs there and our
      payload carries only evidence — shorter payload, less to go wrong.
- [ ] Does the flow prepend/append anything to the answer (a greeting, a signature, a
      disclaimer)? Any of that lands in Slack verbatim.

---

## Blockers vs. friction

This table was written before the probes ran. **None of the three blockers occurred** — see the
status section at the top. It is kept as the criteria to re-judge against whenever the flow is
reconfigured, since every one of them is a property of the flow, not of the platform.

| Finding | Verdict |
|---|---|
| `session_id` ignored → shared conversation across incidents | **Blocker** — concurrent alerts corrupt each other |
| Payload silently truncated below ~16 KB | **Blocker** — RCA built on partial evidence, no error to catch |
| Errors returned as HTTP 200 with no distinguishable marker | **Blocker** — failures post to Slack as RCAs |
| Wrong bold/bullet syntax | Friction — fix in the flow prompt, or accept plain-text posts |
| Flow persona adds a greeting | Friction — strip it, or fix the flow prompt |
| No JSON for P5 | Friction — shape B gets harder, shape A unaffected |
| Slow (60–120 s) | Friction — visibility extender already handles it; confirm no gateway timeout |
