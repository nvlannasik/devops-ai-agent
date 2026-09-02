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
- **Namespace scope lock (deterministic, `agent/scope/`):** in conversation mode, the FIRST tool round defines the question's namespaces (the model's initial targeting has always been correct); later rounds calling into other namespaces are refused ("out of scope — answer with what you have / ask before expanding"). Kills the recurring failure where logs full of "upstream timed out" lured the model into `monitoring` on a plain "show me nginx logs" question. Namespace-less calls (prometheus/loki queries) and an empty first-round scope are never blocked. Unit-tested. **The empty-first-round-scope escape is what makes `k8s_cluster_health` usable**: a cluster-wide scan passes no `namespace`, so round 1 sets an empty scope, the lock disables itself, and round 2 may drill into whichever namespace the scan surfaced. Don't "fix" the empty case into a block — that would turn the health scan into a dead end.
- `MENTION_TOOL_ROUNDS` default is **2** (was 3): discover → fetch covers the common flows exactly; a 3rd round only ever fed wandering. Tunable via env without rebuild.

### A group can span more than one subject, and the card used to hide it
One HighErrorRate rule fired 4 alerts across 2 services. The Slack card read
`Summary: ... (service checkout-gateway)` and `Affected pods (4)`. Both were wrong, and the text
is not decoration — `app/index.ts:384` posts it to Slack **and** feeds it to `investigate()`, so
the RCA was built around one of the two services.

- **`alerts[0].annotations` is never the group's voice.** Alertmanager's `commonAnnotations` is
  empty the moment a rule templates its subject ("…for service checkout-gateway" vs "…for service
  storefront"), and the old fallback then presented one member's description as everyone's.
  `commonAnnotationsOf()` (the mirror of `commonLabels`) is the intersection; when it is empty the
  first member's text is still shown but labelled **`Summary (1 of 4)`**, so it cannot pass for the
  group. For `n === 1` the intersection IS that alert's annotations, so single alerts are unchanged.
- **`Services (N)` names what the group really spans** when the subjects differ.
  `distinctSubjects()` walks `service → deployment → workload → app`, first key present wins.
  `job` is deliberately not in that list — it is the scrape job, identical across a group.
- **Pods are de-duplicated.** A rule firing per `(pod, status)` yields two alerts per pod, and the
  printed count was the alert count: "4 affected pods" for two.

### Delegation has a deterministic trigger, because the model never pulled it
Given the tool, an unlimited budget and a 342-token prompt section, the model did not delegate
once across three firing incidents — including one carrying 388k characters of Loki output and two
related alerts. Same finding as every other guard here: a rule the model must remember does not
hold, a marker on the message does.

- **The webhook logs its subjects whether or not the hint fires** (`[slack] group subjects: ...`),
  naming the raw label keys when none matched. A hint that returned `""` left no trace, so "the
  model declined to delegate" and "the group never looked multi-subject" read identically — and
  they need opposite fixes (the label vocabulary vs. the model's judgement).
- `delegationHint()` (`subagent/`) is built at the webhook from `distinctSubjects(firing)` and
  prepended to the alert message. It names the services, asks for one delegate each in the FIRST
  turn (capped at `maxFanout`), and — the actual point — demands a verdict: **one cascade, or
  separate incidents**, with the evidence that decided it.
- **The condition is read off the labels, not guessed.** One rule firing for two services IS two
  candidate causes. `correlation/index.ts` used to assume the first reading silently ("every alert
  in the payload shares a root cause"); nothing in a payload settles it, and now nothing pretends to.
- Empty string when the flag is off, when there is one subject, or when there are none — the alert
  message is untouched, the same rule that keeps the tool and the prompt section out of the OFF side.
- It still tells the model what to do if `delegate_investigation` is absent from its tool list, so
  the hint cannot strand a run whose budget was finite.

### Delegation does not fire in a linear-chain topology, and that is expected
Four deploys with `SUBAGENT_ENABLED=true`, zero delegations. Not a broken trigger — the signal it
reads is not produced by this cluster, and the reason is in the alert rule itself:

```
rate(http_server_requests_total{status=~"5.."}[5m]) > 0.05
```

`http_server_requests_total` counts requests a service SERVED. A workload failing its readiness
probe is removed from the Service endpoints, receives nothing, and its 5xx counter stays flat: a
fully broken backend DISAPPEARS from an error-rate metric rather than showing up in it. Down
loadgen → storefront → checkout-gateway → orders-api, only the edge service still serves and still
returns 5xx, so a two-alert group carries one distinct `service` and `delegationHint()` correctly
returns `""`. That same investigation's RCA named three pods failing readiness — the multi-subject
condition existed in the cluster, never in Alertmanager.

Multi-subject needs a fan-out topology: one shared dependency failing while several callers are
still up and still serving errors. **Decided 2026-08-29 to accept this rather than broaden the
trigger.** Parsing first-round tool output for "unhealthy workloads" is format-dependent, and one
observation is not enough to design against. Revisit only if a genuine multi-subject group is
observed and delegation still does not fire.

- **Two independent gates; only the second is missing.** Gate 1 (`offersDelegation()` — is the tool
  registered) opened on every deploy: `tools=50` vs 49, +722 tokens = the 342-token prompt section
  plus the tool definition. Gate 2 (`delegationHint()` — is the model told to use it) never opened.
- **The hint has exactly one call site, the webhook** (`app/index.ts`). A mention that
  `wantsInvestigation()` recognises gets `Infinity` and therefore the tool, but carries no alert
  labels to read — so that path rests entirely on the model's own initiative, which is the thing
  measured at zero across three incidents.
- **`SUBJECT_LABELS` is first-match-wins.** One alert carrying `service` fixes the key for the whole
  group and `deployment`/`workload`/`app` are never consulted, so a mixed group where only some
  alerts carry `service` yields a partial list.

### Sub-agent delegation (`agent/subagent/`, `SUBAGENT_ENABLED`, opt-in)
The lead investigation can hand ONE hypothesis to a delegate that runs the same loop in its own
context and returns findings as a `tool_result`. Built for multi-hypothesis incidents, where the
evidence for one candidate cause was contaminating the reasoning about another inside a window
that is only 32k on the private LLM.

- **OFF must be today's behaviour byte for byte**, because OFF is the baseline ON is measured
  against. So the tool is *not registered* when the flag is off — not registered-and-refused: the
  tools array is cached as one block (`llm/claude.ts` marks the last tool ephemeral) and counts
  against the context budget, so a present-but-unusable tool moves both. `withDelegateTool()` owns
  that decision and `subagent/index.test.ts` pins it.
- **It is the same loop, not a second one.** `runInvestigation()` grew `maxIterations`, `deadline`
  and `depth` options; a delegate is that function with a smaller budget. Every guard worth having
  lives in that loop — the `[WRITE]` filter, the namespace scope lock, the log fan-out cap,
  `forcedFinalAnswer()` — and a copy of the loop is a copy of them that drifts. The write-tool
  exclusion in particular must never be re-derived at a second call site.
- **`SUBAGENT_TOOL_ROUNDS` is finite on purpose.** A delegate with a tool budget gets the
  conversation-mode guards that an alert investigation's `Infinity` switches off, and its budget
  notice already carries "do NOT use the RCA format" — the right shape for findings.
- **Delegates are split out of the round BEFORE the scope lock.** A delegate call carries no
  namespace, so letting it reach `namespacesOf()` on the first round would lock the scope to the
  empty set — the case that disables the lock for the whole run.
- **Only an infinite tool budget is offered delegation** (`offersDelegation()`). A finite budget
  means conversation mode, where `MENTION_TOOL_ROUNDS` is 2: one delegate spends half the rounds
  the whole question gets and takes `CHILD_DEADLINE_RESERVE_MS` off the parent's clock doing it,
  and it cannot pay for itself out of that. Infinite is exactly the set worth delegating from —
  the alert path, and a mention `wantsInvestigation()` reads as an explicit investigation request
  — because those are the runs that weigh several competing causes and end in an RCA. The first
  deployed build offered it on the mention path too, where it was a token cost on every call and
  could never have earned it back.
- **Depth is fixed at 1.** A delegate is never offered the tool. Nesting multiplies LLM calls and
  wall clock geometrically inside a deadline that only shrinks. Stated independently of the budget
  clause even though a delegate's `SUBAGENT_TOOL_ROUNDS` is finite and would fail that one too:
  the two answer different questions, and neither should rest on the other holding.
- **The child's deadline is the parent's minus `CHILD_DEADLINE_RESERVE_MS` (60s)**, and delegation
  is refused outright once less than that remains. The parent still has to read the findings and
  compose an answer; a child running to the parent's own deadline delivers evidence to a run that
  has already given up. Reasoning composes take 60-90s over SQS, so this is the constraint that
  decides whether the feature is usable at all — delegates therefore run in **parallel**, never in
  sequence.
- **The model has to be told delegation exists, in the system prompt.** The first deployed build
  carried the tool and its full description on the alert path with an unlimited budget and never
  once called it — one tool description among fifty is not where a model forms strategy.
  `DELEGATION_SECTION` (`prompts/system.ts`, ~342 tokens) is appended by `composeSystemPrompt()`
  only when the flag is set.
  - **Conditional and still cacheable:** `SUBAGENT_ENABLED` is env, fixed for the process, so the
    string is one constant per process — one ephemeral block, no per-request rewrite. Flag off
    returns the file byte for byte, which is what keeps OFF the baseline. It is also counted into
    the context budget automatically, since `resolveBudget` measures `buildStaticSystemPrompt()`.
  - **It keys on the TOOL LIST, not on the flag**, because the two disagree by design: delegation
    is offered only to an unlimited budget, so on a plain mention the section ships while the tool
    does not. "When it is not in your tool list, investigate everything yourself" is one sentence;
    a second cached prompt to keep the two in step would be a second thing to keep in step.
  - It says when NOT to delegate as loudly as when to — the over-correction to watch for is a
    delegate spawned to fetch one value.
- **A delegate stamps its own response-mode marker** (`DELEGATE_MARKER`), self-describing so
  `prompts/system.md` needs no clause — that file is the one static cached block, shared with the
  OFF side. Same rule as every other entry point (see §Response Mode): without a marker the model
  produces a full RCA, which is the wrong shape for something whose reader is the lead run.
- **Sub-thread ids are `${threadId}/sub-N`.** Prefixed, so grepping the Slack thread id still finds
  every child across the agent and llm-worker logs, and the sub id isolates one. The sub-thread is
  scratch: `memory.clear()` + `threadSkills.delete()` in a `finally`, or every delegate leaks a
  Redis key and an entry in a Map capped at `MAX_TRACKED_THREADS`.
- **`UsageStore.linkToIncident` claims the sub-threads too** (`thread_ts LIKE '<ts>/sub-%'`). A
  delegate logs its tokens under its own sub-thread id — that is the run that spent them — but the
  incident is the parent's, and the original exact-match backfill left every delegated call
  unattributed forever, silently hiding the cost of the feature being evaluated.
- **Delegates take no semaphore slot.** `maxConcurrentInvestigations` is enforced in
  `app/index.ts` around the entry points; a child waiting on a permit its own parent holds is a
  deadlock.
- **Refusals are synthesized `tool_result`s, never dropped calls** (fan-out cap, no time left, blank
  hypothesis, child threw). An unanswered `tool_use` is a 400 from Anthropic, not a smaller request.
- **Known ceiling:** the child returns prose and is *told* to cite the tool behind each claim —
  there is no schema enforcing it. Evidence grounding is what the benchmark scores
  (`docs/BENCHMARK_agent_stack.md`), so if the lead starts repeating uncited claims as fact, the
  upgrade is a structured return (`{claim, tool, args, excerpt}`), not a longer prompt. Likewise
  the delegate inherits the parent's whole tool set: a per-delegate tool subset is the stronger
  scope guard, deferred because it adds a second thing the model can get wrong.

### Thread memory has two halves and they must have the same lifetime
A mention on an alert thread investigated `sample-apps` and ended up querying `default`. The
labels were never missing — `fitToBudget` pins `history[0]` unconditionally, so the alert text was
in every request. Three things around it gave way in the same turn, and the fixes are two:

- **Playbooks were in-process while the conversation was in Redis.** `threadSkills` was a plain
  `Map` on `DevOpsAgent`, keyed by the same threadId as `conv:`. The 01:47 rollout brought a live
  thread back with 11 messages of history and `skills: [rca-format]` where it had been carrying
  `high-latency`, `high-error-rate` and `pod-not-ready` — a latency follow-up answered without the
  latency playbook, silently, with no log line saying a playbook had been lost. Now
  `ConversationMemory.getSkills/setSkills` persist the **names** under `skills:<threadId>` on the
  conversation's own 24h TTL, `clear()` drops all three keys, and `runInvestigation` rehydrates
  once per process per thread. Names, not bodies: `resolveSkillNames()` resolves against the LIVE
  registry, so a skill deleted from `prompts/skills/` since does not come back.
- **The anchor was one pinned sentence at the far end of the window.** `buildMentionMarker()`
  (`prompts/system.ts`) now restates the thread's alertname and namespace on **every** mention —
  the same reasoning that already duplicates the mode and scope rules into the marker. The
  identity comes from Postgres (`IncidentMemory.threadAlertIdentity`), the only durable source;
  null for a thread that was never an alert, and then the clause is absent rather than empty.
  **It anchors, it does not forbid** — leaving the namespace is allowed when a tool result already
  read points there, and the model has to say which one did. The cross-namespace hop that prompted
  this may well have been correct: the Loki output named a Service the workload really calls.
  Blocking is the deterministic lock's job, not this one's.
- **The third thing is still open, deliberately:** the namespace scope lock disabled itself.
  `namespacesOf()` reads only a `namespace` **tool parameter**, and the round-1 calls were all
  `prometheus_query_range` / `loki_query_range`, which carry the namespace inside the query
  string. Empty first-round scope → the lock switches off for the run (the documented
  `k8s_cluster_health` escape, which fires far more often than intended: a Prometheus/Loki opening
  is the standard one for latency and error questions). Parsing `namespace="..."` out of the query
  string would close it — and would also have stopped the agent following a hostname the logs
  named. Don't tighten it until a wrong hop is observed that the marker did not catch.

### Evidence grounding check (`agent/grounding/`, deterministic)
The agent found a Service `default/order-services-svc` with no ready endpoints and then named a
Deployment `order-service` behind it — a name derived from the Service's, returned by no tool.
The remediation dry-run refused the action (`deployments.apps "order-service" not found`, posted
to the thread), but nothing guarded the **claim**: the invented name still reached Slack, then
`incidents.root_cause`, then the next investigation as recall context. The dry-run guards what
the agent does; this guards what it says.

- `groundingGaps(answer, history)` returns the resource names an answer asserts that no
  `tool_result` in the thread ever returned. `SlackApp.warnIfUngrounded()` posts them as their
  own thread message after the answer, on **both** paths (mention and alert), best-effort.
- **Posted as a separate message, never appended to the RCA.** The RCA is parsed by shape
  downstream (`buildRcaBlocks`, `extractSection`, `dashboard/rca.ts`) and a line past the last
  section is a line every one of those parsers would have to learn.
- **Candidates come from the backticks**, which the RCA format already mandates for resource
  names (`prompts/skills/rca-format.md`) — the model's own marking, not a heuristic. They are then
  filtered to a DNS-1123 shape, so PromQL, metric names (underscores), selectors (`app=nginx`),
  quantities (`512Mi`, `98%`), timestamps and reason strings (`CrashLoopBackOff`) each fail on a
  character they contain. A bare word with no `-`/`.`/`/` is skipped: it would flag a wording
  difference, not an invention.
- **The two boundary rules are the whole design, and they pull opposite ways.** A trailing `-`
  counts as grounded, because a Deployment is only ever seen as its pods' prefix
  (`checkout-gateway` → `checkout-gateway-6b747db7c9-zwdcv`) and an exact-token test would flag
  every correctly-named workload in every RCA. A trailing letter or digit does NOT, because
  `order-service` sits inside `order-services-svc` as a plain prefix — a substring test would
  have declared the invented name grounded by the very Service it was invented from. Both
  directions are pinned in `grounding/index.test.ts`.
- **Evidence is every tool RESULT plus every tool ARGUMENT** — not assistant text (one
  hallucination would confirm the next) and not the alert message, whose recall block is a past
  incident's `root_cause` and therefore the exact channel an invented name propagates through.
  Arguments were added after the check's first real firing was a **false positive**:
  `sample-apps` flagged in an RCA whose only calls were `k8s_list_events{namespace:"sample-apps"}`
  and an empty Prometheus query. A tool scoped to a namespace routinely does not repeat that
  namespace in its body, so nearly every RCA naming its own namespace would have been flagged —
  and a check that cries wolf is one nobody reads by the second week. It is weaker, and still
  catches the failure it exists for: `order-service` was derived from a Service name and asserted
  in prose, never passed to any tool. What it can no longer catch is a name the model invents AND
  queries, whose empty result is visible on its own.
- Namespace-qualified names are split: `sample-apps/orders-api` is two claims, and tool output
  names the namespace and the workload separately. **The consequence is a known blind spot** — a
  workload seen in namespace A grounds a claim about namespace B. This cluster has exactly that
  shape: `default/order-services-svc` is an orphaned Service whose selector matches labels that
  only exist on `sample-apps/orders-api`, so a cross-namespace mix-up has both halves individually
  true. Pairing would need the namespace and the name to co-occur inside one tool result, which
  their output formats do not agree on; worth adding only once a wrong pair is actually observed.
- **What it does not catch is the reasoning, only the naming.** The same incident produced a
  correct observation (a Service with zero endpoints), an invented Deployment behind it
  (`order-service`, caught here and by the dry-run), and a wrong inference — a Service selector
  only ever matches pods in its OWN namespace, so an orphan pointing at another namespace's
  labels can never have endpoints and is a cleanup item, not a downstream dependency. No
  name-level check reaches that; it is a benchmark case (Tier C, adversarial).

### Lone surrogates make the request unparseable — guard at the wire (`agent/llm/sanitize.ts`)
A remediation proposal failed on **all three backends at once** with the same 400:

```
The request body is not valid JSON: no low surrogate in string: line 1 column 2973
```

Not a backend problem. Emoji are UTF-16 surrogate pairs and the RCA format is full of them
(🔴 📍 📈); `buildProposalPrompt`'s `rca.slice(0, 2500)` landed between the two halves of one, and
`JSON.stringify` emitted the survivor as a bare `\ud83d` escape, which every strict parser on the
other end rejects. Identical payload on every backend, so the router's up-only failover spent the
whole chain re-sending the same broken bytes and logged three backend failures for one bug of ours.

- **`sanitizeForWire()` is called first in all three `LLMClient.chat()` implementations**
  (claude, openai-compatible, sqs), not at the producers. There are at least five fixed-offset
  slices over model-written text (`remediation/proposal.ts`, `context/compact.ts`,
  `app/index.ts`'s memory slice, the recall snippets in `incidents/`) and the model itself can
  emit a lone surrogate that no producer-side fix would ever see.
- It walks **every** string in the payload, `input` on a `tool_use` included — those arguments are
  the model's too, and they ride back into history next turn. **Tools are deliberately not walked:**
  they come from the MCP server, are static for the process, and are cached as one block.
- Replacement is **U+FFFD, not deletion** — half an emoji carries nothing, and the replacement
  character says a character was lost rather than quietly closing the gap.
- `stripLoneSurrogates` calls `test()` on a `g`-flagged regex, so it must reset `lastIndex` first
  or every other call answers false. `sanitize.test.ts` pins that.
- **llm-worker needs no copy of this** (unlike `toOpenAIMessages`): it forwards what the agent
  already sanitized, and its only `slice`s are log-only. A lone surrogate in the model's *reply*
  comes back through the agent's history and is caught on the next request.

### Reasoning-model token exhaustion (private-llm)
The private LLM is a reasoning model: `completion_tokens` includes hidden thinking, which
once consumed the ENTIRE 8096 budget → `finish_reason=length`, empty content, and the user
got a blank-response fallback. Chain of defenses:
- **llm-worker maps `finish_reason=length` → `max_tokens`** (was disguised as `end_turn`).
- **llm-worker auto-retry safeguard:** empty content + `max_tokens` → one retry with **2× token budget** (`isEmptyTokenExhaustion`, unit-tested). Partial answers are never retried.
- Agent's empty-response fallback names the fix (`LLM_MAX_TOKENS` / `LLM_REASONING_EFFORT`).
- Tuning (worker env): raise `LLM_MAX_TOKENS` (16384 recommended), optionally `LLM_REASONING_EFFORT=low` (only sent when set; remove if the backend rejects it).
- **Timeout coherence:** `SQS_LLM_TIMEOUT_SECONDS` default is **240** (was 120). A reasoning compose can take 60–90s, and the worker's 2× retry doubles that — 120s lost the race by 23s in testing (worker delivered a good answer 10:06:55; agent had timed out 10:06:32). The agent-side timeout must cover attempt + retry.
- **Measured, 2026-08-29 dev:** the retry is not a cheap safety net — it is a second full
  inference. Leaving `LLM_MAX_TOKENS` at the 8096 default, LLM #1 took **63458ms for out=9133**
  (out > the ceiling is the tell: only the 2x retry can produce it). Raised, the same first call
  became **24253ms for out=3435** and the whole investigation went 118792ms → **83294ms**. The
  recommendation above was already written here and simply had not been applied to the cluster.
- **After that, latency is output-token-bound and nothing else.** Same run: LLM #1 3435 tokens in
  24.3s, LLM #2 9386 in 56.5s — both ≈150 tok/s, and total out=12821 ÷ 150 ≈ the 83s measured.
  Prefill, tools (4 in parallel, 2.4s) and network are noise. Two consequences worth writing down
  before someone re-derives them: `cache_read=0 cache_write=0` on every SQS call is real but
  **fixing prompt caching would buy almost nothing**, and the 722 tokens `SUBAGENT_ENABLED` adds
  cannot show up in wall-clock at this ratio. The remaining cost is hidden reasoning — LLM #2 spent
  ~8200 of its 9386 output tokens thinking to emit ~1100 tokens of RCA — so `LLM_REASONING_EFFORT`
  is the lever, not caching, and not trimming context.
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
- `GET /health` calls `agent.healthCheck()` → checks MCP (`mcp.ping()`) + Postgres (`SELECT 1`, only if incidents enabled) + Redis (`PING`, only if backend=redis).
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
- **Recall is tiered, and the tiers are never flattened**: CONFIRMED (human, `incident_feedback`) → agent hypotheses for the exact `(alertname, namespace)` → **possibly related** (similarity, `migrations/005`). Past incidents are framed as **Hypothesis to verify** (system prompt + injected block) to avoid anchoring on a stale root cause.
- **Similarity tier = Postgres built-in full-text search, no new dependency.** No pgvector, no `pg_trgm`, no embeddings API — `incidents.root_cause_tsv` is a `GENERATED ALWAYS AS (to_tsvector('english', coalesce(root_cause,''))) STORED` column with a GIN index; the alert text is the query side. The **two-arg** `to_tsvector(regconfig, text)` is IMMUTABLE and can back a generated column; the one-arg form cannot (it depends on `default_text_search_config`). No `CREATE EXTENSION` on purpose: `runMigrations(pool)` runs inside `DevOpsAgent.initialize()`, so a migration that needs a privilege the app role lacks means **the pod refuses to start**. pgvector would also put an embedding call on the read path.
- **Ranking is distinct-lexeme overlap, not `ts_rank`.** Measured: on an OR tsquery `ts_rank` returns the same score for a one-term and a two-term hit (`0.0608` both) — it does not reward matching more of the query. Counting distinct matched lexemes (`unnest(root_cause_tsv)` vs the query's lexeme array) does, and a human can check it. `@@` on the GIN index filters, the count ranks and thresholds at `MIN_OVERLAP`; rows the exact-match tiers already cover are excluded so nothing appears twice.
- `queryTerms()` splits CamelCase alert names (`KubePodCrashLooping OOMKilled` → `kube/crash/looping/killed`), drops envelope words, digits, and terms under 4 chars, dedups, and caps at 24 terms. Unit-tested in `incidents/index.test.ts`.
- The similarity tier is **skipped entirely without query text** (recall then issues exactly 2 queries, never touching `root_cause_tsv`), rendered **last**, labelled as the weakest evidence, and wrapped so a failure there can never break recall.
- `parseConfidence` reused; `parseSeverity` + `extractRootCause` are local, unit-tested in `incidents/index.test.ts`.

### `severity` was two columns wearing one name (`migrations/008`) — fixed 2026-09-02
Reported as "the alert is `warning` in Slack but `critical` in the DB". Two defects stacked:
- **`prompts/skills/rca-format.md` shipped a value, not a placeholder.** Under the line
  *"Output EXACTLY this structure"* it printed `*🔴 Severity:* \`Critical\`` and
  `*📈 Confidence:* \`High\`` as finished text while every other field was a `[bracketed]`
  placeholder. Models read `Critical` as part of the required structure and copied it through.
  Both are now `[level]`, with the allowed values moved into prose **above** the structure block
  so nothing inside it is copyable. Naming the values inline (`[Critical|High|Medium|Low]`) was
  tried and rejected: `parseConfidence`'s pattern matches `(high|medium|low)` *inside* the
  string, so that placeholder still parsed as `high`.
- **`store()` preferred the RCA text over the alert's label**, and the two use incompatible
  vocabularies — Alertmanager emits `critical`/`warning`/`info`, the agent's Severity Guidelines
  say Critical/High/Medium/Low. One column held both, so it could not be filtered or aggregated;
  the dashboard's filter (`views.ts`, offering exactly critical/warning/info) silently could not
  reach rows written in the agent's vocabulary, and `recall()` fed the wrong level back into the
  next investigation of the same alert.

Now: **`severity` is the fact** (the Alertmanager label, exactly what the Slack card rendered)
and **`assessed_severity` is the judgement** (the RCA's impact call). Disagreement between them
is signal worth keeping — `warning` assessed `critical` is an under-graded alert, `critical`
assessed `low` is a noisy rule — so `recall()` prints both, labelled.

Two things worth not re-deriving:
- **The resolved label is passed to `store()` as an argument, never merged into the label map.**
  Slack resolves it as `groupLabels.severity ?? firing[0].labels.severity`, but
  `AlertDeduplicator.fingerprint()` hashes *every* key in that map — writing the resolution back
  would change the fingerprint and orphan the dedup claim the group was already claimed under.
- **`parseSeverity` now returns null outside `{critical,high,medium,low}`.** An unreplaced
  placeholder or an Alertmanager word is the model failing to fill the template in; null reads
  honestly as "not assessed", where a stray string reads as a judgement.

The regression test is a **prompt contract**: `skills/real.test.ts` runs `parseSeverity` /
`parseConfidence` over the shipped template — scoped to the text after *"Output EXACTLY this
structure"*, because a match in the explanatory prose above it masks the template line and the
test passes while checking nothing (it did, on the first attempt).

### RCA reads top-down for on-call, and Root Cause is a causal chain — 2026-09-02
Two changes to `prompts/skills/rca-format.md`, plus `## Causal Chain` in `prompts/system.md`.

**Depth.** There was no 5-Why anywhere: `Investigation Discipline` is a *breadth* rule (don't
re-query what you know) and `Root Cause` was specified as "One paragraph", so investigations
stopped at the proximate cause — "the gateway can't parse the response" rather than "orders-api
ships v2 while the gateway parses v1". `*📍 Root Cause*` is now a numbered causal chain. **Not
literal 5-Why, deliberately:** a fixed quota makes the model invent links 4 and 5 when evidence
supports 3, which collides head-on with the anti-fabrication rule in `Safety Guidelines`, and an
invented causal chain is the worst thing this agent can emit — it reads as the most authoritative
output it produces. So the chain is bounded by evidence instead: every link cites the tool result
behind it, and the chain **stops explicitly (⛔) at the first unsupported link**, naming what
would extend it. That stopping line doubles as an Escalation Trigger.

**Order.** The card is read by someone who was just paged, so it now goes
`⚡ TL;DR → ⚠️ Impact → 🔧 Recommended Actions → 📍 Root Cause → 📊 Evidence → 🚫 Ruled Out → 📈 Confidence`.
Impact used to sit *below* the actions, which is backwards — impact is what decides whether the
actions are worth waking up for. `⚡ TL;DR` is the only new label; everything else was reordered,
not renamed, because the labels are a contract read by four places: `blocks.ts`
(`extractSection`/`isRcaResponse`), `app/index.ts` (the "is this an RCA" gate), `dashboard/rca.ts`,
and `remediation/proposal.ts` (which looks for "Recommended Actions"). `buildRcaBlocks` extracts by
label rather than position, so **RCAs already in Postgres render in the new order too**, and one
missing its TL;DR just opens on Impact.

**The trap in `extractSection`.** Its lookahead ends a section on a *hardcoded emoji set*. A label
whose emoji is missing there is invisible as a boundary and the section above it silently absorbs
the rest of the RCA — no throw, no empty section, just one giant block. Note the direction: a
section's emoji ends the section **above** it, so the first heading in the template is the one a
naive test never exercises. `skills/real.test.ts` derives the headings from the shipped template
and checks each against a `*🔴 SENTINEL*` section placed in front for exactly that reason (the
first version of that test passed with ⚡ removed from the set).

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
  `csp(nonce?)` and is **per route**: only `/topology` passes a nonce, and it is the only route
  with a `script-src` **or** a `style-src 'self'` at all. Everywhere else there is no exemption,
  which is what keeps a missed `esc()` inert on the pages that render an RCA and gives an
  injected `<link>` nowhere to point.

**Its own pool, `max: 3`, with `statement_timeout = 3s`.** Sharing the agent's pool would let
one slow dashboard query starve `storeIncident` of connections — the investigation finishes and
the result is silently lost. Every query carries a `LIMIT` (page size 50, hard cap 200) and the
overview aggregates are cached for 60s: a held-down refresh key is otherwise unthrottled load on
the same event loop that handles alerts, and a signed-in operator can hold one down as easily as
a stranger could. `queries.test.ts` asserts that mechanically over every emitted statement —
a new query without a `LIMIT` fails the suite rather than the cluster.

**Pagination (`/incidents`).** Ten rows a page, `PAGE_SIZE` in `filters.ts`, and **not
adjustable** — there is no `pageSize` parameter and nothing about paging in the filter form.
Page size is not a filter: a filter narrows *which* incidents you are looking at, paging only
moves through them. The per-page `<select>` that used to sit in the filter bar conflated the
two — it needed **Apply filters** to take effect and sat nowhere near the pager it governed —
and at 50 rows the pager was a summary line under a screen and a half of scrolling, which is
why nobody could find it. A constant also means no URL can widen the `LIMIT`.
`list()` runs two queries concurrently: the page (over-fetched by
one row, which is where `hasMore` comes from) and a **bounded** count —
`SELECT count(*) FROM (SELECT 1 FROM incidents <same WHERE> LIMIT $n) c`, `COUNT_CAP = 5000`.
An unbounded `COUNT(*)` is a full scan of a table that only grows, on a 3-connection pool with a
3s timeout; the cap trades an exact number nobody reads past 5,000 for a bounded cost, and the
page says `5,000+` when it hits the ceiling. Two consequences worth keeping straight:
- The two queries share no snapshot, so a row inserted between them can make the count smaller
  than what was just rendered. `total` is therefore `max(count, offset + rows.length)` — the
  summary can never claim fewer incidents than the reader can see.
- **Next is driven by the over-fetch, not by the count.** Past the ceiling the count is a floor
  and would strand the reader; `hasMore` still knows there is another row.
`Promise.all` order is load-bearing — rows first, count second; the tests read `calls[0]`.
`pageWindow(current, last)` (`views.ts`) prints first, last, and ±2 around the current page,
eliding the rest with `null` → `…`, but a *lone* hidden page is printed rather than elided (an
ellipsis standing in for one number is longer than the number). The pager renders **below the
table**, links carry the active filters forward, and `page=1` is omitted so a shared URL shows
only what is actually on. Submitting the filter form drops `page` and so returns to page 1,
which is what you want — page 6 of the old result set means nothing in the new one.

**Nothing rendered is trusted input.** `rca`/`root_cause` are LLM output and the labels come from
Alertmanager, so every interpolation goes through `esc()` in `html.ts`. That helper's test is the
security-relevant one in this module.

**The rail (`layout()` + `.rail` in `styles.ts`).** Navigation is a left sidebar, not a top bar:
`<body>` is a two-column grid (`var(--rail-w) minmax(0, 1fr)`) and `body.bare` collapses it to
one for sign-in and not-configured — without that class those pages would open 13.5rem short of
the left edge. Everything about it is constrained by **zero client JS outside `/topology`**:
- No hamburger, no toggle, no stored collapse state. The rail is CSS only, so it responds to the
  viewport and nothing else: a full sidebar wide, a horizontal bar under 60rem, icons-only under
  30rem.
- Icons are hand-written inline `<svg>` (`ICON` in `views.ts`). `default-src 'none'` blocks an
  icon font and a sprite `<use href>` alike, and a dependency for twelve paths is not worth it.
  Each is `aria-hidden="true" focusable="false"` beside a real `<span class="lbl">`.
- The icons-only breakpoint **clips the label, it does not delete it**: `clip-path: inset(50%)`,
  so the text stays in the accessible name and a screen reader still reads "Incidents".
- `main` and `footer.bottom` carry `width: 100%; min-width: 0`, and that is not restating a
  default. They are flex items of the rail's `.pane` column with `margin: 0 auto`, and a flex
  item with an auto cross-axis margin does not stretch — it takes fit-content, floored at
  min-content, which on a phone is the width of the widest table. The whole page scrolled
  sideways while `.table-wrap` scrolled nothing. `min-width` alone does not fix it. A test in
  `views.test.ts` pins both declarations.

**Sizing is fluid, and it is measured against the container, not the viewport.** Every panel used
to be laid out from `@media` breakpoints against a fixed `--maxw: 76rem`, and both halves of that
were wrong: on a 1920 display the page sat in a 76rem ribbon with the rest of the screen empty,
and on every width in between the components kept proportions that were chosen for one width.
The rules now:
- **`main` is a container** (`container: page / inline-size`), and the hero and the chart declare
  their own (`hero`, `chart`). A media query cannot size these correctly: the rail is a 13.5rem
  column above 60rem and a top bar below it, so the same viewport width means two different
  content widths. Container queries ask the only question that matters — how wide is *this* box.
  Note `cqi` inside a custom property resolves at the **use** site against the nearest *ancestor*
  container; an element's own `container-type` never applies to itself.
- **Padding, gaps and the stat type scale are `clamp()`, not fixed steps** (`--fs-stat`, `main`'s
  padding, `h2` margins, `.hero` padding). A breakpoint is a cliff between two sizes that are each
  right once; a clamp is right everywhere in between, which is what removes the dead space.
- **The stat shelf steps 4 → 2 → 1** (`@container page` at 54rem and 26rem) and never `auto-fit`.
  `auto-fit` on the token shelf produced a 3+1 band with an orphan tile, and a shelf that is not a
  clean divisor of its row reads as a bug.
- **There is one measure, `--maxw` (88rem), and the reading measure that used to compete with it
  is gone.** `.pane:has(.prose)` dropped the incident page to 58rem so a line of argument would not
  run the width of a large monitor. The rule was removed: it capped the **page**, not the prose, so
  above ~1180px the fact strip, both record tables and the RCA all froze together — `main` measured
  928px at 1440 **and** at 1920, i.e. the page ignored the screen. Buying the sentences a shorter
  line by stopping the figures growing charges the wrong block. A line-length ceiling, if it comes
  back, belongs on the text inside `.doc`, where it costs the tables nothing. `views.test.ts` pins
  the absence of the page-wide rule and, separately, the `--maxw >= step + 3` floor that keeps the
  fact strip in one row.
- **A document page is one wrapper.** `detailPage` and `skillPage` put their whole body in
  `<div class="doc">` (`width: 100%; min-width: 0`, and deliberately **no** measure). Without it
  every block is a loose full-width band sized only by its own content — a measured `p.eyebrow` of
  880×11 — a stack of strips rather than a document. With it, both pages follow the column: 1360 /
  1176 / 760 / 468 at viewports of 1920 / 1440 / 1024 / 390.
- **A shelf's sub-lines are all-or-nothing.** `.stat dd` is bottom-anchored (`margin-top: auto`)
  so values line up across a row without reserving a blank caption line — reserving one
  (`min-height` on `dt`) was itself the whitespace being complained about. But the anchor pulls the
  sub-line with it: give three tiles a sub-line and the fourth's value floats a line higher. Either
  every tile on a shelf has one or none does. `views.test.ts` asserts it over both pages.
- `[data-tone]` (not `tr[data-tone]`) feeds `--spine`, so a stat card wears the same severity bar a
  table row does. Overview's *Open* tile takes `critical` only while something is actually open.
- **The incident page's shelf is a variant, not a second component** — `statList(items, "facts")`
  → `.stats.facts`. Namespace, confidence and two timestamps are an identity card, not figures, and
  at the bottom of the ladder four stacked tiles cost a third of a phone screen *above* the analysis
  the page exists for. In the one-column step only, `.stats.facts .stat` becomes `flex-direction:
  row`: caption left, value right, the shape of a spec sheet. Two abreast there is no room for it,
  and wider the tiles are already short. `views.test.ts`'s shelf assertions match the variants too —
  a variant changes how a tile lays out, never what a shelf may hold.
- **Two faces, not three.** `--font-ui` for the interface and everything written in sentences,
  `--font-data` for what the system *measured* (ids, endpoints, timestamps, counts). There was a
  third — a serif `--font-prose` on the RCA, on the argument that what the agent wrote is a
  different kind of content from what it measured. It is, but `font-src` is blocked outright, so no
  stack here is a font this project ships: the serif resolved to Iowan Old Style or Times, a print
  face at 17px on a graphite console, and the RCA read as pasted in from somewhere else. The
  distinction is still drawn — by the panel, the 68ch measure and `--fs-md` at 1.7 line-height,
  which is what actually makes a paragraph read as prose.

**A five-column table does not become readable by scrolling sideways.** `.table-wrap`'s horizontal
scroll is a last resort: what falls off the right edge is whichever columns the author happened to
put last — Result and Executed on the remediation table, i.e. the outcome of the change — and
nothing on screen points at them. So `table(head, body, narrow)` (`html.ts`) lets a table declare
what it *becomes* when the columns will not fit, and there are three answers:
- **`"cards"` — the incident list, and only it.** Below 46rem each row is a three-row grid placed
  **by cell name**: `when | sev | state` on the header line, the cause across the full width under
  it, the namespace ellipsised right on a third. Placement by name is why this is not general —
  another table's columns would come apart under the same rules. `td.when` gives up its `nowrap`
  here: a nowrap cell does not shrink a `minmax(0, 1fr)` track, it overflows it, and at 320px the
  timestamp printed underneath the CRITICAL badge.
- **`"stack"` — a record whose values are sentences** (Evidence, Remediation, On-call feedback,
  and the topology page's Inbound/Outbound — "Postgres (incident memory)", a queue pair with an
  arrow between the two names, "bot token present, socket mode present").
  Below 40rem each cell becomes a caption/value pair captioned from **its own `data-label`** via
  `td::before`, so the caption travels with the cell and inserting a column cannot leave the
  captions naming the wrong values. `headers()` and `cell()` take the same string, which is what
  stops a header and its caption drifting apart. The cells are `display: block`, never grid or
  flex: they hold inline markup (`inlineMrkdwn()` emits `<code>` and `<strong>` mid-sentence) and
  either layout mode would make each of those its own item and take the sentence apart word by
  word. Caption **above** the value here, because beside it the widest label sets a column
  ("Confirmed root cause" is 20 characters) and the sentence is read through what is left.
- **`"pairs"` — a record whose values are all short** (Token usage, Most recurring, LLM backends —
  a spec sheet: a name, two identifiers, an enum, an endpoint). The same stack with the caption
  *beside* the value. What chooses between the two is what the cells hold,
  not how many there are: six counts and two ids each spending a caption line of their own turn a
  six-field accounting row into twelve lines, five times over, and the caption line says nothing
  the caption does not. Implemented as a **hanging indent** — `padding-left: 6rem` on the cell,
  `text-indent: -6rem`, `width: 6rem` on the `::before` — precisely so the value stays one inline
  flow; a grid or a flex row would split it, which is the same reason the stacked cell is a block.
  The 6rem is the widest caption these tables actually carry (REACHED VIA), not the widest one
  imaginable — a table whose labels are sentences takes the plain stack instead. Three traps: the
  sheet's `*` reset does not match pseudo-elements, so padding on that `::before` lands *outside*
  the 6rem and knocks the first line out of the column; `text-indent` **inherits**, and any
  descendant that lays out its own lines re-applies it, so the Route badge (`display: inline-block`)
  printed its own text 6rem to its left, on top of the caption, leaving an empty pill behind —
  `td * { text-indent: 0 }` undoes it for every such child, present and future, and costs nothing
  on the inline elements that never had a first line of their own; and `pairs` emits
  **`data-stack data-pairs` both** (`NARROW_ATTR` in `html.ts`) — the pairs block only overrides
  two declarations, so `data-pairs` alone is a table that never stacks at all. A test pins it.

Some tables opt out, and that is a decision too: the topology page's MCP tools table is a family
name and a count, two short columns that fit 320px with room to spare. There is nothing to rescue,
and stacking it would put the expanded `<details>` tool list *between* the family and its count —
the pair the row exists to show. A narrow layout is for columns that fall off the edge.

Both layouts cost the table its semantics: a browser derives the table role from the **computed**
display, so `display: grid` on a `<tr>` leaves a screen reader with anonymous groups. The
`role="table"` / `rowgroup` / `row` / `cell` / `columnheader` chain is what survives the display
change, and it only works if *every* level declares one — `table()` marks up the wrapper, and the
caller must use `headers()`/`cell()` (or hand-write the roles, as `incidentTable()` does) to be
allowed to ask for any of them. `views.test.ts` pins the roles, the named cells, and that a
stacked table's captions equal its headers, over both pages and both stack variants.

The three thresholds are staggered on purpose: cards at 46rem, stack/pairs at 40rem. The incident
list carries five columns of which two are prose, so it runs out of room first; a table of counts
survives a narrower box as a table, and a table is still the better reading of it while it fits.

**`breakable()`** (`views.ts`) inserts `<wbr>` at the humps of a CamelCase alert name —
`Kube<wbr>Pod<wbr>Crash<wbr>Looping`, at *every* hump — after escaping, never before. A browser takes an offered break
before inventing one, so a long identifier wraps where it means something instead of mid-word. Its
companion is `overflow-wrap: anywhere` rather than `break-word`: only `anywhere` lowers min-content
width, which is what lets a `minmax(0, 1fr)` track actually shrink instead of being propped open by
its longest word.

**The filter bar declares its tracks** (`form.filters`). `auto-fit` gave a date field that can only
say dd/mm/yyyy the same width as an alert name, and re-cut the row at every width — 6 across here,
an orphaned 4+3 there, **Apply** landing wherever the wrap dropped it. The ladder is now fixed at
7 declared tracks → 3 → 2 (`@container page` 62rem / 34rem); both steps divide six evenly, so
from/to stays one range and severity/state one pair at every width. All three control types share
`height: 2.5rem`, and that is load-bearing: a date input carries a picker, a select a chevron, a
text input neither, so `align-items: end` lined up their *bottoms* and left the captions above them
on three different baselines.

**The chart is a `lineChart()` — an SVG line over an HTML grid (`src/dashboard/chart.ts`).**
`svg.ts` is gone. The SVG holds the **line and nothing else**; every piece of text (per-period
value, axis labels, caption) is HTML at the page's own sizes. That split is the whole point: the
chart was once one plain `<svg viewBox="0 0 720 168">` with its type inside it, and an SVG scales
its *text* with its drawing, so the same caption that read fine in a 900px hero rendered near 4px
in a 320px one while the `viewBox` pinned a 4.3:1 letterbox at every width. A `viewBox` cannot be
changed from CSS. Here it is a **unit square stretched with `preserveAspectRatio="none"`**, so the
plot's height is a `clamp()` and every other proportion is a CSS decision taken against the chart's
own width. Load-bearing details:
- **One `--h` per point, rounded once**, drives both renderers: the HTML dot is placed at
  `bottom: var(--h)`, the polyline vertex at `y = 100 - h`. Rounding separately for each is how a
  dot ends up a hair off its own line.
- **The plot grid has no column gap** (the axis below still does). Vertices are placed at
  `(i + .5) / n` of the plot's width; a gap is a `clamp()` in px, which moves every track centre by
  an amount no server-rendered percentage can know, and the dots drift off the line.
- **`.chart-line` is `height: calc(100% - 1.15rem)`, never `auto`.** An SVG with a `viewBox` has an
  intrinsic aspect ratio, and `auto` hands the sizing back to it — the unit square then draws itself
  *square* and the line detaches from the dots by however far the plot is from square (measured 407px
  adrift at 768). Both bugs here were found by measuring in headless Chrome, not by reading markup.
- **The dot's centring margin is on `bottom`/`left`, not `top`.** An element offset from the bottom
  edge is placed by the bottom of its margin box, so a negative `margin-top` is simply unused — a
  constant 4.5px float above the line at every width. Drift is 0px at 1920/1440/1024/768/390.
- `vector-effect: non-scaling-stroke` on `.chart-stroke`. The stretch is non-uniform, so a plain
  `stroke-width` renders as a wedge — thin where the box is wide, thick where it is tall.
- Heights ride in `style="--h:63.6%"`. That works only because the dashboard CSP is
  `style-src 'unsafe-inline'` with **no** `script-src` — inline style attributes are permitted, and
  the value is re-derived with `Number()` (Postgres hands `int8` back as a string) so a hostile row
  can put neither a script nor a `NaN` in the attribute or in the path data.
- Ticks are pre-marked `data-thin` **counting from the end**, and CSS hides them below 26rem. The
  newest period is the one a reader looks at first; counting forwards would drop exactly that one.
  The surviving ticks get `overflow: visible` so they may use the hidden neighbour's track — clipped
  to their own they render as `05-1`.
- The last point is `data-current` (a hollow ring, not a disc) and the caption says why: unmarked,
  a partial week reads as a collapse in incident volume.
- Point values are hidden below 34rem rather than shrunk. Below that width they are the first thing
  to become unreadable, and the axis plus the hero figure still carry the numbers.
- **A single point draws no line** — a one-vertex polyline renders nothing and a one-vertex area is
  a sliver of noise; the dot alone carries it. An all-zero series still draws its line, flat along
  the baseline, because the absence *is* the reading.

**Section and stat glyphs (`ICON` + `section()` in `views.ts`).** The same inline-`<svg>`
mechanism as the rail, extended to every `<h2>` and to the overview's stat cards, so a page of
identically-styled uppercase mono captions has landmarks to scan by. Three rules hold it
together:
- **A heading's glyph and its label are one flex item** — `section()` wraps them in
  `<span class="sec">`, which is what `h2`'s own `gap` spaces. That gap is the distance out to
  the `::after` hairline (16px); between a picture and the word it labels it reads as two
  separate things. Putting the `<svg>` back as a direct child of `h2` renders wrong and passes
  every test except the one that pins the wrapper.
- **A glyph repeats only where the meaning repeats.** The wrench is remediation on the overview
  stat and on the incident page's section; the speech bubble is on-call in both; the chip is the
  model in Token usage and in LLM backends. Anything else gets its own drawing rather than a
  reused near-match — a reader who learns one should not have to relearn it a page later.
- **No glyph carries colour or an accessible name.** `stroke="currentColor"`, `fill="none"`,
  `aria-hidden`, `focusable="false"` — colour here is reserved for severity, focus, and where you
  are, and an announcing icon would give a heading two names. `Stat.icon` is optional and is
  passed as markup, never through `esc()`; `Stat.label` still is. `views.test.ts` pins all of it
  across all three pages at once, so a glyph added to one page and forgotten on another fails.

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

**Interactive map (React Flow, `src/dashboard/client/`).** Replaced a hand-laid SVG plus a
~175-line inline pan/zoom script (`topology-svg.ts` / `topology-script.ts`, both deleted).
Drag a card to move it, drag the canvas to pan, ctrl/cmd + wheel to zoom, plus React Flow's own
`<Controls>`. **The minimap was removed on 2026-09-02** — the map is bounded and fits its frame,
so an overview of an overview was furniture.

The split across files is the design, and it is about what is a **claim** versus what is a
drawing:
- `topology.ts` — config → `Topology` (the allowlist above).
- `topology-types.ts` — the shape and `rowId()`, with **no config import**. It exists because
  `topology-graph.ts` is compiled into the browser bundle: importing the types from
  `topology.ts` would drag `config/index.js` — dotenv and every env var this agent reads —
  into a file served to a browser. `scripts/build-client.mjs` fails the build if a handful of
  config-only strings appear in the output, because that separation is one edit from untrue.
- `topology-graph.ts` — `Topology` → nodes and edges. A plain `.ts` module with no React
  import, so its rules run under `npm test`: a `private-llm` backend hangs off `llm-worker`
  (edge kind `sqs`), everything else off the agent; tool families hang off the MCP server.
  A `.tsx` in the bundle is typechecked but never executed by `node:test`.
- `client/layout.ts` — dagre, `rankdir: LR`. Replaces the old coordinate table. The old note
  said a layout engine "would solve a problem this page does not have", which was true while
  every position was a constant and stopped being true when cards became draggable.
- `client/nodes.tsx`, `client/topology.tsx` — the drawing and the mount.

Load-bearing, and each cost something to get right:
- **Anchoring is by `Node.id`, never by label.** Matching the display string works until
  someone rewords it and then fails SILENTLY, drawing a plausible arrow from the wrong node.
  A missing anchor falls back to the agent — wrong-but-visible beats a dropped edge.
- **A node's id IS its row's id**, both from `rowId()`, so a card's link is `#${node.id}`.
  Backend chips are mapped over the whole list *before* the `viaWorker` split, or the two
  groups would number independently and half the links would point at the wrong row.
- **The topology reaches the browser as `<script type="application/json">`** — inert by type,
  not gated by `script-src`, so operator-supplied strings cannot become script. `<`/`>`/`&` are
  still escaped to `\uXXXX`: a raw `</script>` would close the element early and drop the rest
  into the document as markup. Both that block and the bundle `<script src>` carry the
  per-response nonce; `style-src` gains `'self'` on this route only, for React Flow's stylesheet.
- **The two assets are content-addressed** (`assets.ts`, hashed at boot) and are the only
  responses on this dashboard that are not `no-store`. The path is a key into a two-entry `Map`,
  never a filesystem lookup.
- **The wheel is not captured** (`zoomOnScroll={false}`, `preventScrolling={false}`) — the map
  sits mid-document and a figure that swallowed the wheel would trap a reader trying to reach
  the tables. `zoomActivationKeyCode` names **both** `Meta` and `Control`; React Flow's default
  is `Meta` alone, which is nothing on Linux, and the legend promises Ctrl.
- **A drag must not follow the card's link.** `client/drag-state.ts` records the drag's end and
  the anchor suppresses a click within 200ms — React Flow's `nodeDragThreshold` decides whether
  a drag happened, not whether the click after it should count.
- **The map is script-only now, and that is the trade.** The SVG drew with no script at all. The
  mount ships one sentence saying it needs JavaScript, cleared on a successful parse; the four
  tables below carry every fact it draws, which is the only reason that degradation is
  acceptable. `assets: null` (a dev server, or a build that never bundled) renders a note.
- **Every edge animates (2026-09-02, by request).** It was the SQS hop alone, so that motion
  meant "this call crosses a queue and another pod". That reading is gone by decision: motion is
  uniform now and says the map is live. The SQS distinction rests on what did not move — the
  accent stroke at 2px against `--mark-line` at 1.5px, the accent border on the backend card,
  and the legend row. Four signals became three; none of the survivors is spare.
- **The map adopted Tailwind + shadcn (2026-09-02), scoped to the client bundle.** shadcn is a
  component collection on Radix + Tailwind and ships no icons; the icons came separately from
  lucide. The dashboard's other seven pages stay server-rendered HTML on `styles.ts` — putting
  them on React would ship script to the pages that render LLM output, which is the one thing
  the CSP posture exists to prevent. Four seam rules, all in `src/dashboard/CLAUDE.md`: no
  preflight (and therefore a local reset for UA button styling), shadcn tokens as ALIASES of the
  dashboard's variables (so dark mode needs no `.dark` class), `styles.ts` must not style a card
  (it is the inline `<style>` and would win), and overrides must go through `cn` plain and last
  (neither important form merges under Tailwind v4 — measured). The legend moved into the bundle
  so its swatches call the same `cardClass()` the cards do.
- **Both SQS cards expand into their queues, and the response queue is one shared node
  (2026-09-02).** The LLM path and the GitOps path use a second *request* queue but the same
  *response* queue, routed by `requestId` — `agent/gitops/sqs.ts` takes `responseQueueName`
  from `config.llm.sqs`. Drawing it twice would state the opposite of the contract, so
  `Store.id` lets both cards name `sqs-response` and get one node with two edges into it.
  Sharing is declared, never inferred from the label. Verified in the browser by counting the
  edges that terminate there, not the nodes: React Flow drops an edge whose endpoints it cannot
  find, so a node count alone proves nothing.
- **Postgres and Redis expand into what they hold (2026-09-02), and both lists are derived**
  (`src/dashboard/stores.ts`). Postgres is parsed out of the shipped `migrations/*.sql`; Redis
  is composed from `REDIS_KEYS` constants owned by `agent/memory` and `agent/dedup`, guarded by
  a test that greps those modules and fails if a literal prefix reaches a redis call without
  being declared. A transcribed list of five tables is correct until migration 008 and then
  quietly wrong, which is the one thing this page must not be. Nothing probes. Both render even
  when the dependency is not configured — the schema is what this agent *would* write. Cards
  also carry a glyph now (`IconName`, a closed union, drawn by `client/icons.tsx`), which cost
  the three structural kinds 24px of width: at 216 "Redis (conversation memory)" truncated the
  moment the icon took its indent.
- **Tool families expand into child nodes (2026-09-02).** Clicking a capability card toggles
  it; the open set is a PARAMETER to `buildGraph`, not client-private state, so the claim
  ("a tool hangs off the family that exposes it") stays testable. Three things had to be got
  right and each was found by looking at the rendered page: dagre stacks a rank in one column
  and `k8s` has 34 tools (~1400px — the map went off screen), so each open family is one
  synthetic node sized to the whole block and the tools are dealt into a roughly-square grid
  inside it; `fitView` runs after every toggle but never on mount, or the tools land off one
  edge and the agent off the other; and the family card needed a second control (`↓`, with
  `stopPropagation`) because the disclosure took its click. Re-layout discards drags — opening
  34 tools has to make room. A tool node carries no `href`: the tables list it inside a
  `<details>` with no id of its own.
- **Not covered by `npm test`:** React Flow's rendering, the drag behaviour, the CSS.
  `topology-graph.test.ts` pins the claims and `client/layout.test.ts` runs dagre headless
  (finite positions, left-to-right order, non-overlap, and that the SQS class marks exactly one
  edge). Everything else needs a browser.

**RCA rendering (`src/dashboard/rca.ts`).** The RCA is **Slack mrkdwn, not CommonMark** —
`prompts/system.md` pins it: bold is a *single* asterisk, italic is `_underscores_`, bullets are
the `•` character, and there are **no `#` headings at all**; a section is announced by a line that
is entirely one bold run (`*📍 Root Cause*`). That is why the parser is hand-written rather than a
dependency: a Markdown parser reads almost none of it correctly. `parseRca()` keys off whole-line
bold runs (heading), `*Label:*` + content (field — the colon must sit immediately before the
closing asterisk, or `*Impact: what breaks*` becomes a field), `•`/`-`/`N.` markers, and ` — ` as
the claim/source split. Arguments (Root Cause, Impact) stay prose; Evidence, Ruled Out and
Recommended Actions become two-column tables.
- **Escape-then-markup is the invariant.** `esc()` runs on every fragment *before* a single tag is
  added, so an escaped string provably holds no `<` or `>` and the tags that follow are this
  module's own. There is no ordering in which model output can close a tag we opened. No attribute
  value is ever built from parsed text. `rca.test.ts` mutation-checks each esc() call site.
- **It degrades, never guesses.** Fewer than two titled sections → `parseRca` returns `null` and
  the page renders the plain escaped block it used before. A model that ignores the format loses
  its formatting, never its content. Same for a code fence: a section holding one is left as prose
  rather than tabulated around a stack trace, and the fence is not scanned for bullets or headings.
- **The italic rule is bounded on both sides, and its span must allow inner underscores.** Half the
  identifiers on this page are snake_case, so an unbounded `/_(.+?)_/` mangles `k8s_list_pods`;
  requiring whitespace/bracket before the opener is what prevents that. But excluding `_` from the
  span only looks safer — it means `_k8s_list_pods_`, the exact form the template asks for, never
  matches and the markers render as literal underscores.
- **A verdict is not a section.** The two sections the template ends on — Severity, Confidence —
  are a word, or a word and the one line that justifies it. Rendered like every other section they
  each spent a heading and a full-width panel on eight characters, a third of a phone screen below
  the evidence saying "critical". `renderRca()` promotes them into a trailing `.rca-fields.verdicts`
  strip: matched by name (`VERDICTS`, lowercased — the same convention `COLUMNS` uses) and **only if
  `oneLine()` agrees**, i.e. a single prose block with no newline and no code fence. A model that
  argues its confidence across three bullets has written an argument, and an argument does not fit
  on a strip — it keeps its panel. The model's own inline fields lead the RCA because it wrote them
  as a preamble; the promoted verdicts trail it because the evidence they rest on is above them.
- Evidence's two-column table is `"stack"`-narrow like the rest. Two columns still do not fit a
  phone when the left one is a whole finding: "OOMKilled, exit code 137" against a 5rem Source
  column pushed the tool name off the edge — exactly the half a reader needs to check the claim.

**`llm_usage`** (migration 004) records one row per LLM call, with the router's backend and route.
`incident_id` is NULL at insert — the usage rows are written during the investigation, the
incident row only exists after — and is backfilled by `IncidentMemory.store()` via the
`onStored` callback. Rows for conversation-mode replies stay NULL forever, which is correct.
The overview's **Token usage** section reads it: totals over the 30-day window, then a breakdown
by **backend AND model** (collapsing to backend hides a re-point mid-window, which is the change
someone reading the page is looking for). `sum()` over INTEGER widens to BIGINT and node-postgres
returns BIGINT as a *string*, so every sum goes through `num()` — without it 12 + 7 renders 127.

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
`get`+`delete` on pods. Its verification target strips the pod's random suffix so the check
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
- **`worthProposing` gates the mention path** (`remediation/proposal.ts`, pure + unit-tested). Every mention used to spend a proposal LLM call, so a read-only "status check" on a healthy cluster burned a **heavy** call to be told `{"action": null}` — and on the day the heavy chain was down to one working backend it produced a page of stack traces instead. Propose when **any** of: the reply is an RCA (the template means a fault was diagnosed), the user asked for a change, or the answer carries fault evidence. Skip otherwise, logging the reason.
  - **Deliberately asymmetric**: a false positive costs exactly what today costs (one call answering null), a false negative silently drops a legitimate fix. So every rule is a reason to SPEND the call and skipping is only what's left over. When in doubt, extend the vocabulary rather than tighten it.
  - **The alert path is not gated** — an alert firing IS the evidence.
  - **A clean bill of health uses the same words a broken one does** ("no alerts firing", "0 restarts in the last hour"), so negated forms are stripped before matching or the gate would never skip anything. The keyword group repeats (`+`) because one negation covers a list ("No alerts are firing and nothing is pending" must lose `firing` too), and the window stops at a contrastive conjunction so "no logs, **but** it is in CrashLoopBackOff" keeps its evidence.
  - **Indonesian action verbs are matched as stems with up to 4 leading chars** — the affix carries the request: `perbaiki` arrives as `diperbaiki`, `ganti` as `mengganti`. A `\b`-anchored stem missed all of them.
  - Text-only on purpose: no extra MCP call (`alertmanager_get_alerts`) to check for active alerts — the agent has just looked, so the answer is already in the reply, and a second call adds latency plus a failure mode to a path whose whole point is spending less.
- **Proposal observability:** every null path in `proposeRemediation` logs why (raw model output on parse failure, unregistered action, dry-run refusal, duplicate/store failure) — silent no-card failures cost a full debugging round during live testing.
- **Remediations are recalled as agent memory** (`recallRemediations` → `RemediationStore.recallForAlert`): on the alert path, past executed remediations for the same `(alertname, namespace)` — joined via `remediations.incident_id = incidents.id` — are injected alongside `recallIncidents` into BOTH the investigation and the proposal context ("Previously remediated — same alert: 2026-07-23 set image → repo:v2 — succeeded (PR: ...)"). So a recurrence recalls what was actually DONE (+ the PR/outcome), not just the diagnosis, and the proposal model avoids re-proposing an already-applied fix. Everything's already stored in `remediations` (`params.changes` from→to, `path`, `valuesKey`, `result`=PR URL, `status`) — no schema change; rollback data lives there too (revert the PR = natural GitOps rollback). Keyed by alert → mention-driven flows (no labels) don't recall.
- **Dry-run refusals are posted to the thread** (`{ refused }` return → "🚫 Remediation not proposed — <server reason>"): the model wanted to act but the MCP server refused (GitOps guard / blocked namespace / bad target) — the human deserves the reason, especially "managed by Flux/Helm, change it in the GitOps repo".
- **`parseProposal` normalizes `kind` case** — a correct proposal was dropped over `"kind":"Deployment"` (K8s convention capitalizes; our zod enums are lowercase).
- **Partial RCA leaks are reformatted too** (`leaksRcaStructure`, unit-tested): a change-request reply once shipped as a wall of text — "Proposed plan Immediate/Short-term", "Impact if Unresolved", "Confidence: High", closing "proceed?" question — WITHOUT the Severity label `isRcaResponse` keys on. ≥2 distinct section markers now trigger `reformatToConversation` (which also strips proceed-questions, command instructions, and caps length). system.md caps direct change-request replies at 5 lines. **Mutating kubectl/helm command dumps** (`kubectl rollout/scale/set/patch/...`, `helm upgrade/rollback`) are a leak class of their own — one hit triggers the reformat alone; read-only commands in passing don't.
- **Remediation lifecycle events are appended to thread memory** (`noteInThread` → `[system note] ...` assistant message): card posted / refused / executed / rejected happen OUTSIDE the LLM conversation, and the model once answered "yes" (to its own question) with "I'll open an approval card" right after the server refused one — it had never seen the refusal. system.md tells the model `[system note]` semantics and forbids "do you want me to proceed?" / "I'll open a card".
- **`container` is optional** in `k8s_set_image`/`k8s_set_resources`, both in the proposal schema and the MCP tool: the proposal model CANNOT know container names (not in its context) and guessed one from the workload name (`dev-auth-svc-be` vs actual `auth`). The MCP server auto-resolves single-container workloads and refuses multi-container ones with the name list. Proposal prompt rules: NEVER guess a container name; workload = Deployment/StatefulSet/DaemonSet name, NOT a pod name; an explicit user request ("ganti tag ke latest") is sufficient evidence for any whitelisted action — user-given tag + current repo from context.
- **Approval card mentions the approvers** (`<@Uxx>` in the section block → real Slack notification): `SLACK_APPROVER_USERS` fallback `SLACK_ONCALL_USERS`; both empty = no mention line.
- **GitOps overlay path is auto-detected from Flux** (`resolveOverlayPath`, `gitops/overlay.ts`): a Flux HelmRelease workload's HR CR carries `kustomize.toolkit.fluxcd.io/{name,namespace}` labels (the HR CR is applied by kustomize-controller, so it — unlike the Helm-rendered workload — has them). The agent reads the HR CR → the Kustomization CR → `spec.path` (e.g. `apps/dev/applications`) via the read-only `k8s_get_custom_resources` tool, and sends it as `pathPrefix` in the gitops request so the worker scopes the file search to the right per-env overlay (dev/stg/prd, applications vs systems — all automatic, zero config). Best-effort → falls back to the worker's `GITOPS_PATH_PREFIX`. This also resolves the base+overlay ambiguity (both define the HR; the prefix picks the overlay). **Detection itself needs no manifest change** — Flux auto-adds `helm.toolkit.fluxcd.io/name` to Flux-managed workloads (plain `helm install` like a standalone ingress-nginx lacks it → correctly refused).
- **GitOps PR flow (v2, `DESIGN_gitops_pr_remediation.md`, opt-in `GITOPS_REMEDIATION_ENABLED`):** for a Flux HelmRelease-managed workload the MCP dry-run returns a structured PR preview (not a plain refusal). `parseGitOpsPreview` detects it → `proposeGitOpsPr` asks the **llm-worker** over a second SQS queue (`SqsGitOpsClient`) to prepare the PR (`dry_run` → diff), stores a PR-flavored remediation (`params.gitops=true` + helmRelease/action/changes/path/valuesKey), and posts a GitOps card variant (diff block + file/key). Approve → `executeRemediation` branches on `params.gitops` → `executeGitOpsPr` (`open_pr` → PR URL in `result`; **no verification check** — it returns no `target`, because nothing is live until merge+Flux sync). `SqsGitOpsClient` is a **standalone mirror** of `SQSLLMClient` (NOT a shared base — the LLM client is the battle-tested critical path; two dispatchers cooperate via the shared response queue's release-non-owned mechanism). The agent holds **no GitHub credentials** — those live in the worker. GitOps action names in the preview/request are the SHORT forms (`set_image`/`scale`/`set_resources`), distinct from the DB `action` column's tool name (`k8s_set_image`).
- **Cluster/GitOps drift → `flux_reconcile`, not a PR.** Someone changes the cluster directly (`kubectl set image` on a Flux-managed workload); an alert fires; the RCA is fine; then the remediation died with *"the value is not set in the overlay and can't be auto-added for this action — set it in the overlay values first"*. That message was wrong: the incident context's `from` is the **drifted cluster value**, which naturally isn't in Git, and the worker's line search (key AND value) couldn't tell that apart from "the key isn't there". The worker now returns `drift:{path, valuesKey, gitValue, clusterValue}` (see llm-worker `detectDrift`), and `proposeGitOpsPr` branches to `proposeFluxReconcile` **before** treating it as a refusal:
  - proposes the MCP `flux_reconcile` write tool on the workload (parsed out of the preview's `kind/ns/name` by `workloadOf`), after the same mandatory dry-run;
  - card reads *"Flux reconcile `ns/name` — restore `image.tag` to `v1.4.0` (cluster drifted to `v9.9.9`)"*;
  - **still approval-gated** — the drifted value is occasionally the intended one, in which case the human wants a PR declaring it, not a reconcile discarding it;
  - if the MCP server is older and lacks the tool, the refusal text spells out the `flux reconcile helmrelease <ns>/<name> --force` command instead.
  Direction is fixed on purpose: the GitOps repo is the source of truth, so a reconcile RESTORES what Git declares rather than writing the drifted value into Git.
- **Post-remediation verification** (`agent/remediation/verify.ts`, `migrations/006`) — replaces the old in-process `setTimeout` status check, which was lost on a pod restart and answered the wrong question (it dumped the namespace's pod list into the thread instead of saying whether the problem went away). See "Post-remediation verification" below.
- **Proposal context = head+tail of the RCA** (`buildProposalPrompt`), never head-only: long RCAs put the concrete fix in Recommended Actions at the END — a head-only `slice(0,4000)` cut it off and the model proposed nothing. The alert path also prepends the CONFIRMED prior (first 1200 chars) — a recurrence's proven fix is exactly what the proposal model needs. A user request without a concrete value (e.g. "ganti image tag" with no tag) correctly yields `{"action": null}` — never-invent beats a guessed card.

### Post-remediation verification (`agent/remediation/verify.ts`, `migrations/006`)
Answers "did that actually fix it?" and records the answer, so a later investigation can read
a failed fix as a **negative prior**. Replaced a `setTimeout(…, 90_000)` in whichever pod
handled the approval click.

- **Durable schedule, not a timer.** One row in `remediation_checks` per remediation
  (`one_check_per_remediation` unique index), claimed by whichever replica polls next — a
  restart between the click and the check costs nothing. The poller (`startVerificationPoller`
  in `app/index.ts`) re-arms **after** the work, not on a fixed interval, so a slow tick can't
  overlap the next, and `unref()`s its timer so auxiliary work never keeps the process alive.
- **`due_at` doubles as the lease** (the SQS visibility-timeout idea, in Postgres): claiming
  sets `status='running'` AND pushes `due_at = now() + LEASE_SECONDS`, so a pod that dies
  mid-check releases the row by itself instead of stranding it in `running`. Claim predicate is
  `status IN ('pending','running') AND due_at <= now()` with `FOR UPDATE SKIP LOCKED`.
  A failed check is deliberately **left claimed** — the lease expires and the next pass retries
  it, which makes a transient MCP outage a delay rather than a lost verdict. `MAX_ATTEMPTS`
  then abandons it as `inconclusive`.
- **The alert is the primary signal, pods corroborate.** `alertmanager_get_alerts` → `alertState`,
  `k8s_list_pods` → `summarizePods`. Both degrade independently (`Promise.all` with per-call
  `.catch`).
- **Asked of Alertmanager, not Prometheus.** Alertmanager is where every evaluator's alerts land,
  so a future log-based alert (Loki Ruler, Kibana) is visible to the re-check; `/api/v1/alerts`
  would have scored a still-paging incident as recovered. **Every status Alertmanager returns
  means still firing** — `silenced` most of all, because a human muted the notification, not the
  problem, and reading it as recovery would let someone close an incident by muting it.
  Alertmanager drops resolved alerts, so *presence* is the signal and absence is the recovery.
  The trade: an alert re-firing inside its `for:` window is still `pending` in the evaluator and
  has not reached Alertmanager, so it reads as cleared — deliberate (Alertmanager is the source of
  truth), and `decideVerdict` still refuses "recovered" while any pod is unready.
- **`k8s_list_pods` returns the pod *phase*, not container reasons.** A CrashLoopBackOff pod
  reports `status: "Running"` with `ready: false` — counting phases alone scores a crash loop
  as healthy. Readiness must come from the `ready` boolean.
- **`summarizePods` returns `null` for unreadable output, and `null` is never a healthy zero.**
  Same rule for `alertState`: `"unknown"` (Alertmanager unreadable) and `"none"` (mention-driven,
  no alert behind the remediation) are separate states — collapsing them would let a broken tool
  call read as "there is no alert", i.e. as success.
- **`worse` is a readiness regression and only that.** A rollout replaces the pod set, so a
  restart delta compares *different* pods: the old crashing pod's counter sits in the baseline
  while the new pods start at zero, which scored a half-finished rollout as a regression during
  live testing. Restart counts stay in the detail as evidence, never as a trigger.
- **Alert cleared + pods still down = `inconclusive`, not `recovered`** — the rule usually
  stopped matching because the series went away (pods deleted), not because anything healed.
- **The verdict is recorded before its message is posted.** At-most-once beats a crash between
  two posts telling on-call twice that their fix failed.
- **Slack I/O stays in the app layer**: `runDueRemediationChecks()` *returns* messages;
  `DevOpsAgent` owns Postgres + MCP, `SlackApp` owns chat. The verdict is also appended to
  thread memory (`noteInThread`) so the model knows its own fix didn't hold before the next
  follow-up question.
- **The message quotes the REAL wait**, computed from the row's `created_at`, not from
  `verifyDelayMs` — a retried check waited longer than the setting says, and a verdict with no
  elapsed time invites "maybe it just needed longer", which is the whole argument this check
  exists to settle.
- **`verdict` ≠ `status` in recall.** `status='succeeded'` only means the MCP call returned
  cleanly. `recallForAlert` LEFT JOINs `remediation_checks` (1:1, so it can't fan the row set
  out) and `recallRemediations` renders `→ verified <verdict>` or `→ never verified`; a
  `succeeded` + `unchanged` pair triggers an extra paragraph telling the model not to re-propose
  that action, because if the same fix keeps not holding the root cause is upstream of it.
- **Verdicts are NOT written to `incident_feedback`** — that table is the human-confirmed tier
  and agent-produced verdicts must not be laundered into it. Trust tiering stays intact.
- No check is scheduled for GitOps PR remediations: `executeGitOpsPr` returns no `target`, and
  nothing is live until the PR merges and Flux syncs (the `if (target)` guard covers this).
- Tunables: `REMEDIATION_VERIFY_DELAY_SECONDS` (default 300 — 90s answered while the rolling
  update was still converging) and `REMEDIATION_VERIFY_POLL_SECONDS` (default 30).

### Incident status has three writers, not one (`agent/incidents/reconcile.ts`, `migrations/007`)
`resolved_at` used to be written only by the Alertmanager resolved webhook. That is a single
delivery of a notification that is **never repeated** — `repeat_interval` covers firing only,
and a group whose alerts all resolved is dropped once its resolved notification goes out — and
`/alert` acks `200` **before** processing the payload, so anything failing after the ack (Slack
down, Postgres down, pod killed mid-handler) loses the event for good.

- **The visible symptom is the smaller half.** The incident reads as firing forever in the
  dashboard; worse, `handleResolvedAlert` is also the only caller of `dedup.clear`, so the
  group's claim is held for its full TTL and the alert's **next real firing is suppressed and
  never investigated**. That is the reason this exists.
- **The sweeper** (`runIncidentReconcile`, on the existing verification poller — no second
  timer) asks Alertmanager what it currently holds and closes what it does not. It reuses
  `alertState` from `remediation/verify.ts` rather than deriving "still firing" a second way.
- **Two passes, never one.** An alert re-firing inside its rule's `for:` window is still
  `pending` in the evaluator and invisible to Alertmanager, so one cleared reading is also what
  a flap looks like mid-flap. `cleared_seen_at` records the first sighting (in Postgres, so it
  survives restarts and works across replicas); only a second cleared reading `confirmSeconds`
  later closes anything.
- **No evidence is never recovery.** A failed tool call, an unparseable response, or a
  **truncated** one (`omitted > 0` — absence is the whole signal, and a capped response can hide
  the alert that paged) ends the pass with nothing closed.
- **`group_labels` is why the claim can be released at all.** The dedup fingerprint is hashed
  from Alertmanager's `commonLabels`, which is richer than `group_by`; `alertname`+`namespace`
  hashes to something else entirely. `store()` now persists the exact label set the claim was
  taken under. Rows predating 007 fall back to alertname+namespace, best-effort.
- **`@agent resolved` / `@agent reopen`** — on-call's word, and it beats both other writers.
  Deterministic prefix command like `learn`, **not** an LLM call: a state correction is the one
  message that must not be re-interpreted. Indonesian and English; negations (`belum selesai`,
  `unresolved`) are matched first so they can never read as a close, and ordinary thread talk
  (`ok`, `done`, `thanks`) matches nothing. Outside an incident thread it falls through to the
  normal agent flow rather than answering "I can't do that".
- **`resolved_by`** records which of the three closed it: `alertmanager`, `reconciler`, or a
  Slack user id.
- Tunables: `INCIDENT_RECONCILE_ENABLED`, `_MIN_AGE_SECONDS` (600 = `resolve_timeout` 5m +
  `group_interval` 5m), `_CONFIRM_SECONDS` (120), `_BATCH` (50).

### Context Assembly & Skills
Bounds what actually reaches the LLM call, on both axes that used to be unbounded: which prompt
content ships (all of it, always) and how large a single tool result can grow (as large as the
tool made it).

- **Three modules, three failure modes.** `src/agent/skills/` owns *what content exists and when
  it applies*, `context/budget.ts` owns *how much fits*, `context/compact.ts` owns *how much a
  single tool result is allowed to cost*. Kept apart because each fails a different way: a
  malformed skill is a **boot error** (fail before an incident ever runs), an oversized request is
  a **runtime trim** (fail gracefully mid-investigation, drop something, keep going), and a noisy
  tool result is **neither** — nothing is wrong with it, it's just a log line repeating, so it gets
  collapsed rather than rejected or trimmed.
- **`prompts/skills/` holds thirteen files: twelve failure-mode playbooks plus `rca-format.md`.**
  `rca-format` is `when: always` — every investigation carries the output template regardless of
  what fired. The twelve playbooks are regex-gated on the alert text, so an OOMKilled alert isn't
  also paying tokens for the ImagePullBackOff runbook.
- **`## Tool Usage Reference` stayed in `prompts/system.md` instead of becoming a skill.** A
  skill's `when` matches against the alert text, and the alert text has no way to say whether the
  investigation is about to reach for a PromQL query — that decision happens mid-loop, after the
  model is already several tool calls in. Gating the query cookbook on the alert text would remove
  it at exactly the moment it's needed. Availability beats budget for that one section; everywhere
  else in this design the budget wins.
- **The `/context` page's two tables follow the same rule the rest of the dashboard's tables use:
  what the cells hold, not how many there are.** Skills render `"stack"` — `description` is a
  sentence, so the caption sits above the value. Backend budgets (`window`/`reserve`/`core`/
  `tools`/`available`) render `"pairs"` — every value there is a short number, so the caption sits
  beside it. A future column doesn't get to pick the layout by counting how many rows or columns
  there are; it picks by asking what kind of value fills the cell.
- **`loadSkills` throws when `prompts/skills/` holds no `.md` files**
  (`src/agent/skills/index.ts:129`), and the message says why: an agent with no skills has no RCA
  output format, so it would investigate correctly and then answer in a shape neither the Slack
  renderer nor `src/dashboard/rca.ts` can parse. Failing at boot, loudly, beats failing per-incident,
  silently.

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

### Token-limit parameter is auto-detected (`openai-compatible.ts`)
OpenAI's newer models (o-series, gpt-5) answer `max_tokens` with a hard
`400 Unsupported parameter … Use 'max_completion_tokens' instead`, while vLLM, DeepSeek and
OpenRouter only understand `max_tokens`. Both register as ordinary `openai-compatible`
backends in the same router, so any single static choice breaks half the fleet — and this is
not hypothetical: it took out the whole heavy chain in production (the `chatgpt` backend 400'd,
failover went to `haiku`, which was over its usage limit, and the remediation proposal died).
- The client sends `max_tokens`, and **only** on a 400 whose message names
  `max_completion_tokens` flips the instance and retries once. `wantsMaxCompletionTokens`
  matches the parameter name rather than the sentence (the wording has already changed once)
  and requires status 400, so a 429 or a bad-tool-schema 400 propagates instead of being sent
  twice.
- The choice is cached on the instance, and `buildBackends` runs once at boot → one wasted
  request per backend per pod, not per call.
- **Not** switched on the model name: that breaks the day a provider renames a model.
- Deliberately different from llm-worker's `LLM_USE_MAX_COMPLETION_TOKENS` env flag — the
  worker points at exactly one model, so a flag is fine there; the router holds several and
  the operator shouldn't have to know each one's dialect.

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

The full table — every variable, its default, and whether it is required — lives in
[`README.md`](README.md#configuration) and in `.env.example`, both checked against
`src/config/index.ts`. The digest that used to sit here had fallen ~12 variables behind
(dashboard, GitOps queues, `MENTION_TOOL_ROUNDS`, `INVESTIGATION_TIMEOUT_SECONDS`,
`ALERT_WEBHOOK_TOKEN`, ...). Read the README; do not re-copy it here.

## File Structure

The authoritative tree lives in [`README.md`](README.md#project-structure) and is kept in
sync with the code — it covers every module, including the ones this section predates
(`context/`, `skills/`, `dashboard/`, `gitops/`, `feedback/`, `intent/`, `scope/`,
`usage/`, `utils/trace/`). Keeping a second copy here is what let it drift; do not
reintroduce one.

## AWS Authentication

Controlled by `AWS_AUTH_MODE` env var (read by `entrypoint.sh`):

| Mode | Setup | Use case |
|------|-------|----------|
| `iam-anywhere` | Writes `$AWS_CONFIG_FILE` (default `/tmp/aws/config`) with `credential_process` pointing to `aws_signing_helper` | On-premise / private network with X.509 cert |
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
- [x] **Remediation UX & coherence round** — containers/images in workload listings, head+tail proposal context + CONFIRMED prior included, kind case normalization, dry-run refusals posted to the thread, lifecycle `[system note]`s in thread memory, post-execution 90s status check (**superseded** by the durable verification below), `leaksRcaStructure` + command-dump reformat backstop, `toMrkdwn`, backticked/clean server refusal messages
- [x] **GitOps guard** (`assertNotGitOpsManaged`) + **D. resolved-alert loop** + **E step 5 reaction-learn** — see their sections
- [x] **Agent capability round** (three improvements, zero new deps): (1) **similarity recall** — a third "possibly related" tier over Postgres full-text search (`migrations/005`), so a NodeMemoryPressure can learn from the OOMKilled it caused; (2) **post-remediation verification** (`migrations/006`) — a durable, DB-scheduled check that asks whether the *alert* went away and records the verdict as a negative prior, replacing the in-process 90s pod dump; (3) **evidence-based impact** — `prompts/system.md` now requires blast radius to be derived from `k8s_list_services` / `k8s_get_endpoints` / `k8s_list_ingresses` rather than asserted (RCA section labels unchanged, so `dashboard/rca.ts` still parses)
- [x] **Mention-path proposal gate** (`worthProposing`) — a read-only question against a healthy cluster no longer spends a **heavy** LLM call to be told `{"action": null}`. Verified on-cluster 2026-08-08: the same `status check` cost a 9.1s proposal round-trip before the gate (which proposed a rolling restart of a Deployment that **does not exist** — caught only by the mandatory dry-run) and 0.4s after, with the skip reason logged. The alert path is deliberately not gated.
- [x] **Token-limit parameter auto-detection** (`openai-compatible.ts`) — a live `chatgpt` backend 400'd on `max_tokens` and took the whole heavy chain down with it (failover landed on a `haiku` that was over its usage limit). The client now sends `max_tokens`, flips to `max_completion_tokens` on that one specific 400, retries once, and caches the answer per backend instance.

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
1. ~~**LogQL label schema**~~ ✅ **resolved 2026-09-01, on both sides** — the risk was real and the
   prompt was wrong. fluentbit shipped `job=fluentbit, namespace, pod, container, stream` and nothing
   else (`Auto_kubernetes_labels off`), so the prompt's `{namespace="X", app="Y"}` matched **nothing**
   — exactly the "returns empty → the agent concludes 'no logs' while logs exist" failure predicted
   here. Fixed in two places rather than one:
   - **Shipper** (`gitops-devops-ai-manifest/apps/base/systems/fluentbit/`): an `identity.lua` filter
     now derives one `app` per line from `app.kubernetes.io/name` → `app` → `k8s-app` →
     `app.kubernetes.io/instance` → `container_name`, so every stream carries a workload identity
     whatever convention its author used, and `job` became `<namespace>/<app>` instead of the
     constant `fluentbit`. `Annotations Off` on the kubernetes filter: they were fetched, carried and
     then dropped whole by `Remove_keys`. `test/run.sh` unit-tests the Lua against the shipped
     release.yaml (docker + a Lua image; 11 cases incl. the priority order and the non-k8s passthrough).
   - **Prompt**: patterns rewritten to `{namespace, app}` as the default shape, `pod` demoted to
     "isolating one instance", `service` documented as a JSON field. `skills/real.test.ts` holds the
     cross-repo contract as an allowlist.
   Two caveats on the tick: the schema was resolved from the shipper **config**, not from a live
   query — the patterns still have not been run against real Loki data; and Loki streams are
   immutable, so lines written before the fluentbit rollout keep the old label set and are not
   reachable by `{app=...}` until they age out at `retention_period: 168h`.
1b. **PromQL metric names** ✅ **resolved 2026-09-01** — the sibling of the LogQL bug above, found
   in a live investigation log rather than by reading config. `prompts/system.md` and the
   high-error-rate / high-latency skills named `http_requests_total` and
   `http_request_duration_seconds_bucket`; the apps expose `http_server_requests_total` and
   `http_server_request_duration_seconds_bucket` (`devops-sample-app/packages/platform/src/metrics.ts`).
   PromQL returns empty for an unknown metric, so on 2026-08-31 a `HighErrorRate` investigation got
   `prometheus_query ok (1004ms, 35 chars)` and produced its RCA from Loki alone — it could not read
   the metric that fired its own alert. The latency pattern was doubly broken: `histogram_quantile(
   rate(...)) by (service)` is not valid PromQL, `le` must be inside the sum. Fixed in the prompt and
   both skills, plus `http_client_requests_total{service,peer,status}` added — `status` carries
   `timeout`/`error` literally, which is the downstream-blame signal the RCA needed. `real.test.ts`
   pins the metric allowlist and the prose contract list together.

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
