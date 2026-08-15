# Context Assembly and Skills — Design

**Date:** 2026-08-12
**Status:** Approved design. Not implemented.
**Repo:** `devops-ai-agent`

## Why

Three facts about the agent as it stands:

1. **Context management is 58 lines of counting.** `src/agent/context/index.ts` truncates a tool
   result at 8000 characters and keeps the last 40 messages. Both are counts. Neither knows what a
   token is, and neither knows which backend is about to receive the request — so a private LLM with
   a 32k window and Claude with a 200k window are handed exactly the same 40 messages.
2. **The system prompt is sent whole, ten times.** `prompts/system.md` is 31 KB / 347 lines
   (≈7.5k tokens) and `MAX_ITERATIONS = 10`. Twelve failure-mode playbooks ride along on every
   investigation; at most one of them describes the alert at hand. The other eleven are noise
   competing for the model's attention — which matters most on the small models this agent is
   explicitly built to run on.
3. **The RCA format is specified once and re-implemented three times.** `prompts/system.md:302-347`
   prescribes the exact Slack-mrkdwn labels. `src/utils/slack/blocks.ts` re-states them to extract
   sections, `src/dashboard/rca.ts` re-states them to parse a verdict, and `src/app/index.ts:201-206`
   spends a *second LLM call* (`reformatToConversation`) repairing output that missed the format.
   Nothing links these; nothing fails when they drift.

The goal is to make prompt content **selected rather than concatenated**, and to make the context
budget **sized to the window it has to fit**.

## Scope

**In:**
- A skill registry: operator-editable Markdown files with frontmatter, loaded and validated at boot.
- Deterministic skill selection from the alert/message text.
- A context assembly module that owns what goes into a request and in what order.
- A token budget derived from the smallest configured backend window.
- Tool-result compaction that collapses repetition before it truncates.
- A read-only `/context` dashboard page listing the registered skills and the per-backend budget.

**Out (deferred, see the last section):** an evidence ledger, per-investigation telemetry in
Postgres.

**Non-goals:**
- No new npm dependency. The frontmatter parser is hand-written (there is no YAML parser in
  `package.json`, and one flat `key: value` block does not justify adding one).
- No change to the agent ↔ llm-worker SQS contract. This is a hard constraint, and the design in
  §5 exists to satisfy it.
- No change to the `[WRITE]`-tools-never-enter-the-loop invariant (`src/agent/index.ts:189-192`).
- No runtime editing of skills. Skills are files in the image, versioned in Git, deployed by Flux.

## 1. Module map

```
src/agent/skills/
  index.ts        loadSkills() -> SkillRegistry; select(); all()
  frontmatter.ts  parseFrontmatter() — flat key: value, no YAML dep
src/agent/context/
  index.ts        assembleRequest() — the single owner of "what goes in the request"
  budget.ts       estimateTokens(), fitToBudget()
  compact.ts      compactToolResult() — replaces truncateToolResult()
src/dashboard/
  context.ts      buildContextView() — live registry + config -> a plain view object
  views.ts        + contextPage(); NAV gains a fourth entry
  server.ts       + the "context" route
prompts/
  system.md       shrinks from 347 to ~267 lines
  skills/*.md     13 new files
```

Each unit has one job and is testable without the others: `frontmatter.ts` turns text into
key/value + body; `skills/index.ts` turns a directory into a registry and a trigger string into a
list; `budget.ts` turns messages into a number and a number into a smaller list of messages;
`context/index.ts` composes those three into one request.

### Interfaces

```ts
// src/agent/skills/index.ts
export interface Skill {
  name: string;           // unique, [a-z0-9-]+
  description: string;    // one line, operator-facing
  when: "always" | RegExp;
  body: string;           // the Markdown below the frontmatter, verbatim
  chars: number;
}
export interface Selection {
  selected: Skill[];
  overflow: string[];     // matched but lost to the cap of 3 — the caller logs them
}
export interface SkillRegistry {
  all(): readonly Skill[];
  select(trigger: string, already: ReadonlySet<string>): Selection;
}
export function loadSkills(dir: string): SkillRegistry;  // throws on any malformation

// src/agent/context/budget.ts
export interface Budget { contextTokens: number; reserveTokens: number }
export function estimateTokens(text: string): number;
export function fitToBudget(input: {
  history: Message[];
  skills: Skill[];
  available: number;        // tokens left after systemPrompt + tools + reserve
}): { history: Message[]; skills: Skill[]; skillsDropped: string[]; messagesDropped: number };

// src/agent/context/index.ts
export interface AssembledRequest {
  messages: Message[];
  systemPrompt: string;   // byte-identical to buildStaticSystemPrompt(), always
  skillsUsed: string[];
  skillsDropped: string[];
  messagesDropped: number;
  estimatedTokens: number;
}
export function assembleRequest(input: {
  history: Message[];
  systemPrompt: string;
  tools: ToolDefinition[];
  skills: readonly Skill[];
  budget: Budget;
}): AssembledRequest;
```

`loadSkills()` returns a registry object rather than populating module-level state, so tests can
load a fixture directory and the real `prompts/skills/` in the same process. The agent holds one
instance, constructed at boot, and the dashboard reads that same instance.

`all()` returns whole `Skill` objects, body included. An earlier draft returned a body-free
projection, which was right when the only consumer was a log line; §11 renders the bodies, and a
second accessor to fetch what the first deliberately withheld is a distinction that no longer pays
for itself.

## 2. Skill file format

```markdown
---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|out of memory|exit code 137|memory limit
---

1. k8s_describe_pod — confirm `lastState` = "Terminated: OOMKilled (exit 137)" …
```

- Frontmatter is delimited by `---` on the first line and a later `---` on its own line.
- Exactly three keys, all required: `name`, `description`, `when`. Any other key is an error —
  silently ignoring a typo'd key would silently disable a skill.
- **`name`** must be unique across the directory and match `^[a-z0-9-]+$`.
- **`description`** is one line, written for a human operator. In this phase it is never sent to the
  model; its consumers are the boot log and `registry.all()`.
- **`when`** is either the literal `always` or a regular expression, compiled case-insensitive.
- The body is everything after the closing `---`, injected **verbatim**. Whatever renders correctly
  in `system.md` renders correctly here.

Parsing is deliberately dumb: split the first line, find the closing `---`, split each line on the
first `:`, trim. No nesting, no lists, no quoting rules, no YAML.

## 3. Loading and validation

`loadSkills(dir)` reads every `*.md` in the directory, sorted by filename, and **throws on the
first problem** — missing directory, a directory holding zero `*.md` files, missing or malformed
frontmatter, missing/unknown key, duplicate `name`, a `when` regex that does not compile, or a file
over `SKILL_MAX_CHARS` (8000).

The empty-directory case earns its own rule. A present-but-empty directory reads as "no skills
configured", which after §8 means an agent with no RCA output format at all — it would investigate
correctly and then answer in a shape that `blocks.ts` cannot parse and the dashboard cannot score.
That is precisely the silent degradation fail-fast exists to prevent, so it is an error, not an
empty list.

Failing at boot means a bad skill file takes down a deployment. That is the right trade — the
alternative is an agent that runs looking healthy while silently missing the playbook for the
alert it was built for — and the blast radius is contained by a test (§12.2) that loads the **real**
`prompts/skills/` directory, so a malformed file fails `npm test` long before it reaches a cluster.

After loading, the agent logs one line per skill (`name`, `description`, `chars`, `when`). The
`/context` page in §11 is the same inventory rendered; the log is what answers "what does this
agent know?" during the window before the dashboard is up, and in any environment where it is not
exposed.

There is no `SKILLS_ENABLED` kill switch. Skills are not an optional layer on top of the prompt —
they *are* prompt content that used to live in `system.md`. A flag that disabled them would
silently ship a degraded agent. If the feature misbehaves, the rollback is `git revert`, which is
also how every other prompt change is rolled back.

## 4. Selection

**Trigger text** is passed in explicitly, once per incoming user message, as
`investigate(threadId, userMessage, { trigger })`. It defaults to `userMessage`, and the
Alertmanager path in `src/app/index.ts` passes the raw `issueText` — the alertname, labels and
annotations as formatted for the model, and nothing else.

Not `userMessage` itself, because that path prepends recalled prior incidents and prior
remediations to the alert before handing it over. Matching on the combined string would let a
*previous* incident's RCA select this investigation's playbook: one old OOM kill, and every
subsequent alert on that service arrives carrying the `oomkilled` skill.

The trigger is capped at 4000 characters. The cap is not about performance; skill regexes are
operator-authored, and a bounded input bounds the damage a pathological one can do.

**Matching:**
- Every skill with `when: always` is selected, unconditionally.
- Every skill whose regex matches the trigger text is a candidate.
- Candidates are ordered by how many **distinct substrings** the regex matched (descending), then
  by name (ascending), and the first **3** are taken. Concretely: regexes compile with flags `gi`
  and are counted with `new Set([...trigger.matchAll(re)].map((m) => m[0]))` — `matchAll` clones
  the regex internally, so the `g` flag's `lastIndex` is never shared between two selections. The rest are logged by name and dropped. The cap
  exists because five playbooks at once is the same undifferentiated wall of text this design is
  removing.
- `always` skills do not count against the cap.

**Per thread, once.** The agent keeps a `Map<threadId, Set<skillName>>` of skills already selected
for a thread, following the existing `rcaThreads` precedent in `src/agent/memory/index.ts:1-45`
(in-memory, not persisted). `select()` takes that set as `already` and returns only skills not yet
in it. A follow-up question that mentions a new symptom adds its playbook; it never re-adds one.

The set is in-memory, so a pod restart mid-thread loses it and the next message re-selects from its
own trigger text alone. The consequence is bounded: `rca-format` is an `always` skill and is
therefore never the thing that gets lost, and a re-selected playbook is at worst re-sent once.

## 5. Injection — and the cache trap

**Skills must not go into `systemPrompt`.** This is the load-bearing decision of the whole design.

`src/agent/llm/claude.ts:26-32` wraps the *entire* system prompt string in a single
`cache_control: { type: "ephemeral" }` block, and `:40` caches the tools array via its last
element. A system prompt that varies per investigation turns every first call into a full cache
miss plus a cache *write* at 1.25× input price — the change would make the agent slower and more
expensive while appearing to reduce tokens.

So: **skills ride in the request's first user message.** `assembleRequest` prepends one text block
per skill to `messages[0]`, wrapped for greppability:

```
--- skill: oomkilled ---
<body verbatim>
--- end skill: oomkilled ---
```

If `messages[0].role !== "user"` (which should not happen; the thread always opens with the alert),
a new user message carrying the skills is inserted at index 0 instead.

Three consequences, all good:
- **The SQS contract `{ requestId, messages, tools, systemPrompt, traceId? }` is untouched.**
  `llm-worker` needs no change and no coordinated deploy.
- The Anthropic system+tools cache keeps hitting on every iteration.
- Prepending a text block survives `toOpenAIMessages()` in both repos unchanged, because both
  already join multiple text blocks in a user message.

Skills are **not** written to Redis. Memory holds the real conversation only; assembly re-injects
the thread's skill set on every iteration. That keeps stored history clean, keeps skill content out
of the incident record, and — because assembly owns them — makes them droppable under budget
pressure, which §6 relies on.

## 6. Budget

`estimateTokens(text) = Math.ceil(text.length / 3)`.

Three characters per token is deliberately pessimistic — real English is closer to four, but this
context is dominated by JSON tool results, which tokenize far worse than prose. Over-estimating
wastes some window; under-estimating produces a 400 from the backend, or worse, a silent
server-side truncation that removes evidence the model then reasons without.

**Window per backend.** The LLM registry gains an optional `contextTokens` per backend, defaulted
by kind:

| kind | default `contextTokens` |
|---|---|
| `claude` | 200000 |
| `openai-compatible` | 128000 |
| `private-llm` | 32000 |

**Reserve** = `config.llm.maxTokens` (`src/config/index.ts:53`, default 8096 — the model must have
room to answer) + 1024 safety margin.

**Available** = `contextTokens − reserve − estimate(systemPrompt) − estimate(JSON.stringify(tools))`.

**One budget, resolved once at boot, from the SMALLEST window across the configured backends.**
With `LLM_PROVIDER=router` the backend is chosen *after* the request has been assembled, so the
request has to fit whichever window it might land in — and it might land in the smallest. Failover
is up-only (light → heavy), so the smallest backend is also the usual first attempt; the cost of
this choice is that a call which happens to land on Claude is sometimes smaller than it needed to
be. Sizing per backend instead would mean assembling the request twice, or reassembling it on
every failover, to buy window on the path that is already the least constrained.

Worked through for the tightest real backend, a 32k private LLM at the default `maxTokens`:
`32000 − 9120 − ~8000 (system.md after the split) − ~4000 (tool schemas) ≈ 10.9k tokens` left for
skills and history. Positive, but small enough that the drop order below is not hypothetical — it
is the normal operating condition on that backend, and the reason this feature exists.

At boot, the smallest backend is checked: if `available ≤ 0`, throw and name it. Checking the
smallest is checking all of them, since every other backend has strictly more room. A backend whose
window cannot hold the system prompt and the tool schemas is misconfigured, and that should surface
at deploy time, not during an incident.

**Fill order** (stop when the budget is reached):
1. `messages[0]` — the thread's opening alert, pinned, always.
2. The most recent message — pinned. A request without the thing being answered is useless.
3. Skills.
4. Remaining history, newest first.

Skills are budgeted as their own line item even though §5 injects them *into* `messages[0]`: what
is pinned in step 1 is the user's own alert text, and "dropping" a skill in step 3 means not
injecting its block in the first place. Assembly computes the selection before it builds the
message, so nothing has to be un-done.

**Drop order when it does not fit:** matched playbooks first (largest first), then `always` skills
(largest first), then history from the oldest. History is dropped after skills because *history is
evidence already gathered; a skill is advice*.

`always` outranking matched is what protects `rca-format`: it is the output contract, and losing it
means the RCA does not render in Slack at all. The rule is rank-then-size rather than a name
check — hardcoding `"rca-format"` in `budget.ts` would couple the budget to one file, and with a
single `always` skill the two rules are identical anyway. If a second `always` skill is ever added,
the tie-break between them is size.

History trimming reuses the existing pairing rule from `trimToWindow`: a `tool_use` block and its
`tool_result` are never separated, because the API rejects an orphan of either.

If the two pinned messages alone exceed the budget, log `context_budget_exceeded` with the numbers
and send them anyway. A visible 400 from the backend beats inventing a truncation that hides which
evidence was lost.

`MAX_HISTORY_MESSAGES = 40` and `trimHistory()` are deleted — superseded by the budget.
`trimToWindow()` stays; `MAX_MESSAGES = 50` in `memory/index.ts` stays and is honestly what it has
always been: a **storage** cap on the Redis key, not a context decision.

## 7. Tool-result compaction

`compactToolResult()` replaces `truncateToolResult()` in `sanitizeContentBlocks()`, and runs at
**ingest** — the compacted form is what goes into Redis. Compaction is therefore **permanent**: the
raw tool output is not recoverable from the conversation afterwards. Compacting on send instead
would keep it, at the price of storing full raw results under a 24h TTL for every investigation.
The tradeoff is accepted deliberately, and it is the one decision here worth revisiting if an
investigation ever turns out to need a detail that compaction removed.

1. Under `MAX_TOOL_RESULT_CHARS` (8000) → return unchanged, byte for byte.
2. **Collapse consecutive repetition.** Normalize each line by masking ISO-8601 timestamps to
   `<ts>` and digit runs of 2+ to `<n>`, then find runs of **3 or more consecutive** lines sharing a
   normalized key. Keep the first line of the run and append `… ×N more like this`.
   Only *consecutive* runs. Global deduplication would merge two separate phases of an incident —
   the same error at 14:02 and again at 14:31 is the signal, not the noise.
3. Still over the cap → head/tail split with the existing `TRUNCATION_NOTICE`, unchanged.

A 200-line log of one repeated stack trace becomes two lines instead of a head/tail slice through
the middle of it.

## 8. What moves out of `system.md`

**Moves to `prompts/skills/` (13 files):**

- `rca-format.md` — `when: always` — the whole of `## RCA Output Format` (L302-347). It stays in
  every request; the win here is not tokens but a single home for a format that three modules
  currently re-state from memory.
- Twelve playbooks from `## Failure Mode Playbooks` (L106-185), one file each:
  `crashloopbackoff`, `oomkilled`, `imagepullbackoff`, `high-error-rate`, `high-latency`,
  `pod-not-ready`, `pod-pending`, `service-unavailable`, `rollout-stuck`, `pvc-pending`,
  `forbidden`, `gitops-drift`.

**Stays in `system.md` (~267 lines):** Scope of Work, Response Mode, Tool Calling, Investigation
Discipline, Blast Radius, Pod State Awareness, **Tool Usage Reference**, Evidence and Reasoning
Rules, Timestamp Correlation, Severity Guidelines, Confidence Scoring, Escalation Triggers, Safety
Guidelines, Execution & Remediation.

The Tool Usage Reference (PromQL/LogQL/Kubernetes/tracing cookbooks, L186-247) stays in core
deliberately. A trigger built from alert text cannot know whether the model is about to write a
PromQL query, and a wrong guess removes the query patterns exactly when they are needed. It is
cross-cutting reference material, not symptom-specific advice.

Net effect: ~80 lines leave the always-sent prompt (≈23%), and an investigation carries one
playbook instead of twelve.

## 9. Error handling

| Condition | When | Behaviour |
|---|---|---|
| Skills directory missing | boot | throw, naming the resolved path |
| Skills directory holds zero `*.md` | boot | throw, naming the resolved path |
| Missing / malformed frontmatter | boot | throw, naming the file |
| Missing, unknown, or duplicate key | boot | throw, naming file + key |
| Duplicate `name` across files | boot | throw, naming both files |
| `when` regex does not compile | boot | throw, naming file + pattern + parse error |
| File over `SKILL_MAX_CHARS` | boot | throw, naming file + size |
| Backend window too small for prompt + tools | boot | throw, naming the backend |
| No skill matches the trigger | request | proceed with `always` skills only; log at debug |
| More than 3 matches | request | take 3, log the dropped names at info |
| Budget forces a skill drop | request | log at warn with the names and the numbers |
| Budget exceeded by pinned messages alone | request | log at error, send anyway |

The skills directory path resolves the same way `resolvePromptPath()` already does in
`src/agent/prompts/system.ts` — dev path, then the container path — so no new configuration is
required for either environment.

## 10. Observability

One structured log line per assembled request:

```
context_assembled { threadId, skillsUsed, skillsDropped, messagesDropped, estimatedTokens }
```

`threadId` is the same value that travels as `traceId` on the SQS contract, so this line joins the
agent log, the worker log, and the Slack thread in one grep — the existing convention, unchanged.

## 11. The `/context` dashboard page

Answers one operator question without opening an editor: **what does this agent know, and how much
room does it have to say it?**

**Route.** `/context`, added to the `Route["kind"]` union and `matchRoute()` in
`src/dashboard/server.ts:22-47`. It is deliberately **not** added to `METHODS` (`:49-54`), so it is
GET-only by construction — the read-only invariant holds without a new exception, and the comment
above `METHODS` stays true as written. The page runs no JavaScript, so it takes the default CSP
with no `script-src` at all; `/topology` remains the only nonce'd response.

**Nav.** A fourth entry in `NAV` (`src/dashboard/views.ts:75-79`), after Topology, labelled
**Context** — not "Skills", because the page answers two questions and the budget half is not a
skill. It needs one 24×24 stroke icon in `ICON`, in the same style as the existing three.

**Data.** Two in-process sources, no DB query and no MCP call: `registry.all()` and the budget
arithmetic from §6. This is the same kind of page as `/topology` — config rendered, not data
queried — so it follows the same split: `src/dashboard/context.ts` turns the live registry and
config into a plain object, and `views.ts` only renders it. The page is then testable from a
fixture, with no boot and no network.

```ts
// src/dashboard/context.ts
export interface SkillView {
  name: string; description: string; when: string; chars: number; body: string;
}
export interface ContextView {
  core: { lines: number; chars: number; tokens: number };
  skills: SkillView[];
  backends: { name: string; model: string; window: number; reserve: number;
              core: number; tools: number; available: number }[];
  effective: { backend: string; available: number };   // the smallest — what §6 budgets to
}
export function buildContextView(
  skills: readonly SkillView[], toolCount: number, toolsJson: string
): ContextView;
```

`SkillView` is the dashboard's own structural type, like `McpTool` in `topology.ts`: strings and
numbers only, so neither side imports the other's types and no `RegExp` ever reaches a template.
The agent exposes `skillsView()` beside the existing `mcpTools()`, and `index.ts` passes it to the
`DashboardServer` constructor as a third getter.

`when` is a display string: `"always"`, or the regex source. Rendering `RegExp.source` rather than
`String(re)` keeps the `/…/gi` wrapper out of the cell, where it would read as part of the pattern.

**Three blocks.**

1. **Core prompt** — one stat line for `system.md` as actually sent: lines, characters, ≈tokens.
   It is the constant every backend pays before anything else, and after §8 it is the number an
   operator most wants to watch.
2. **Skills** — `table(head, body, "stack")`. Columns: Skill, When, Size, Description. `stack` and
   not `pairs`: a description is a sentence and a regex can be long, and the established rule is
   that what the cells hold decides the layout, not how many columns there are.
   The body lives inside the Description cell as `<details><summary>{description}</summary>
   <pre>{body}</pre></details>` — native disclosure, zero JavaScript, and the summary is already
   the line the operator wanted to read. That `<pre>` needs `white-space: pre-wrap` and
   `overflow-x: auto` in `STYLES`, or an unwrapped playbook line pushes the page sideways at 390px.
3. **Budget per backend** — `table(head, body, "pairs")`. Columns: Backend, Model, Window, Reserve,
   Core, Tools, Available. Seven short identifiers and numbers is exactly the spec-sheet shape
   `pairs` was built for — the same call the topology backends table makes.
   Above the table, one sentence naming `effective`: which backend every request is actually built
   to fit, and how many tokens that leaves. Per §6 the budget is the smallest window, so a reader
   scanning the rows would otherwise take the largest number as the operative one.

**Escaping.** Every interpolation goes through `esc()`, including the skill body and the regex
source: escape first, insert markup second. Skill files are operator-authored and in-repo, so this
is not today's threat — it is the rule surviving whoever later makes skills loadable from somewhere
that isn't the image.

**No error state, and that is a decision.** Both data sources are validated at boot (§3 throws on a
bad or empty skills directory, §6 throws on an unusable budget) and the dashboard listens in the
agent's own process. If the page can be reached at all, its data is valid and non-empty. Unlike
`/topology`, which carries a `registryError` because the LLM registry can be *partly* configured,
there is nothing here to degrade into — so no empty state, no error banner, no "not configured"
notice. Adding one later would mean §3 stopped throwing.

## 12. Testing

Written test-first, `node:test` + tsx, no new dependencies.

1. **The cache-trap regression, first and most important.** Assemble two requests with different
   skill sets and assert `systemPrompt` is byte-identical to `buildStaticSystemPrompt()` in both.
   This single assertion is what keeps §5's decision from being quietly undone later.
2. **The real directory loads.** Load the shipped `prompts/skills/` and assert every file parses,
   names are unique, regexes compile, and sizes are under the cap. This is what makes fail-fast at
   boot safe.
3. **Frontmatter parser:** missing key, unknown key, duplicate key, no closing `---`, CRLF line
   endings, and a body preserved verbatim including blank lines and its own `---` lines.
4. **Selection:** an OOMKilled alert selects `oomkilled` and not `pvc-pending`; `always` skills are
   always present; the cap takes 3 and logs the rest; a second call for the same thread returns
   nothing already selected.
5. **Injection:** skill blocks land in the first user message; message count and role order are
   otherwise unchanged; the guard inserts a message when `messages[0]` is not a user message.
6. **Budget:** a 32k backend drops skills while a 200k backend keeps them from the same history;
   drop order puts `rca-format` last; a `tool_use`/`tool_result` pair is never split; the
   pinned-messages-exceed-budget floor logs and still sends.
7. **Compaction:** 200 identical log lines collapse to one line plus a count; the same line
   appearing in two separated runs stays as two entries (the anti-global-dedupe test); a result
   under the cap is returned byte-identical.
8. **Estimation:** monotonic in input length, and never below `length / 4`.
9. **The page renders from a fixture:** the skills table carries `data-stack`, the budget table
   carries `data-stack data-pairs`, every `data-label` names a real column of its own table (the
   assertion loop `views.test.ts` already runs over the topology tables), and the response contains
   no `<script>` — the claim the CSP makes for this route.
10. **Escaping, asserted on the output:** a skill whose body contains `<script>alert(1)</script>`
    and a `when` regex containing `"` and `<` render as escaped entities. Assert the escaped string
    is present, not merely that the raw one is absent — the second passes on an empty page.
11. **Route and method:** `matchRoute("/context")` and `matchRoute("/context/")` both give
    `{ kind: "context" }`, and `"context"` is absent from `METHODS`, so a POST is rejected. The
    read-only invariant asserted rather than assumed.

## 13. Rollout

One PR in `devops-ai-agent`. No coordinated deploy: the SQS contract, `llm-worker`, and
`devops-mcp-server` are all untouched. No new configuration is required — backend windows default
by kind, and the skills directory resolves like the prompt directory already does. The observable
changes in production are a shorter system prompt, one new log line per request, the boot-time
skill inventory in the log, and a fourth item in the dashboard nav.

The dashboard page is the last task, not the first. It reads the registry and the budget, so it can
only be built once both exist — and building it last means it is written against the real
`ContextView`, not a guess at one.

## Deferred

Not in this spec, and each is additive rather than a rework:

- **Live numbers on `/context`.** The page in §11 shows what is *registered* and what the budget
  *allows* — both static. Which skills actually fired, and how often the budget had to drop one,
  are runtime facts that belong to the telemetry item below; the page gains a column once there is
  something to put in it. Until then `context_assembled` (§10) carries them.
- **An evidence ledger** — a running structured summary of confirmed facts. It is the only piece
  discussed that would add an LLM call to the loop, so it earns its own design.
- **Per-investigation telemetry in Postgres** (tokens saved, skills used per alertname), which
  would let skill triggers be tuned from evidence instead of judgement.
- **Tool-availability triggers** (`requires_tool: loki_query`), so a cookbook disappears when its
  MCP tool family is absent. Only pays off in a deployment missing a tool family.
- **Splitting the Tool Usage Reference**, if per-investigation telemetry ever shows which cookbooks
  actually get used.
