# LLM Router — workload routing and one-directional failover

**Date:** 2026-07-30
**Status:** Implemented and merged to `main` (§1–§9). Wired into the dev overlay on the GitOps repo's
`feat/llm-router` branch, which is **deliberately unmerged** — that repo's `main` is what Flux
reconciles, so merging it there is the deploy. See the deploy precondition in §9 *Manual verification*.
**Scope:** `devops-ai-agent` only. No changes to `devops-mcp-server`, `llm-worker`, or the GitOps repo beyond
env wiring in the agent's HelmRelease.

## 1. Problem

The agent talks to exactly one LLM backend, chosen at boot by `LLM_PROVIDER`
(`src/config/index.ts:31`). That single choice has to serve every call the agent makes, which forces a bad
trade: a strong model makes routine "show me pods in payment" mentions expensive, and a small private model
is not reliable enough for multi-round alert investigation. There is also no fallback — if the selected
backend is down or exhausted, every investigation fails until someone changes an env var and restarts.

Four goals were confirmed with the user:

1. Route by workload — strong model for investigation, cheap/private model for light conversation.
2. Failover — a backend failure should not become a failed investigation.
3. One place to configure models and credentials.
4. Reusable by future agents (e.g. the planned `finops-agent`).

## 2. The constraint that shaped this design

**No single location can reach every backend.**

The private LLM lives on a private network whose egress is restricted to AWS/SQS only. That is exactly why
`llm-worker` exists — it sits on that network and bridges to the agent over SQS, because the agent cannot
reach the LLM directly. The consequence for this design:

- From the **private network**: the private LLM is reachable; public model APIs are not.
- From the **cluster**: public model APIs are reachable; the private LLM is not (only via SQS).

So a conventional LLM gateway placed in front of all backends — LiteLLM, a self-hosted OpenRouter-style
proxy — **has no valid location in this architecture**. This is not an effort question. It follows that the
routing decision must happen on the **agent side**, the only place where both transports (HTTP to public
models, SQS to the private one) terminate.

## 3. Decision

Implement the router as a fourth `LLMClient` **inside the agent process**, not as a separate service.

Rejected alternatives:

- **Standalone `llm-gateway` service in-cluster.** Would satisfy all four goals and would actually work
  (it would use HTTP for public models and SQS for the private one, exactly as the agent does today). It
  would even shrink the agent, which could then use `OpenAICompatibleClient` alone. Rejected **for now**
  because `finops-agent` is still an idea with no repo and no timeline: this buys operational cost today —
  a HelmRelease, secrets, an extra network hop on the critical investigation path — for a consumer that
  does not exist. Content-block translation would move into the gateway rather than disappear. This is the
  documented upgrade path (§10), not the starting point.
- **LiteLLM proxy in-cluster.** Structurally cannot absorb the private LLM, which speaks SQS rather than
  HTTP. A router above LiteLLM + `SQSLLMClient` would still be required, so LiteLLM adds a deployable
  without removing the component it was meant to replace. Reconsider if the number of *public* providers
  grows well beyond one.

Goal 4 is therefore deferred, not abandoned.

## 4. Architecture

One new file, `src/agent/llm/router.ts`, exporting `RouterLLMClient implements LLMClient`. It holds
instances of the existing clients and contains no LLM logic of its own — it selects and delegates.

`createLLMClient()` (`src/agent/llm/index.ts:7`) gains a fourth branch for `LLM_PROVIDER=router`.
`DevOpsAgent` does not change: it only ever sees `LLMClient.chat(messages, tools, systemPrompt)`
(`src/agent/llm/types.ts:48`).

The constructor accepts an already-built map of backends, with env parsing as the default. This seam is
what makes the tests in §8 free of any mocking framework.

## 5. Backend registry (config surface)

Backends are declared with indexed env vars. The backend name is a **value**, never part of a key, so
adding a backend never requires inventing new key names:

```
LLM_BACKEND_1_NAME=opus
LLM_BACKEND_1_KIND=claude
LLM_BACKEND_1_MODEL=claude-opus-5
LLM_BACKEND_1_KEY=<from Secret>

LLM_BACKEND_2_NAME=or
LLM_BACKEND_2_KIND=openai-compatible
LLM_BACKEND_2_BASE_URL=https://openrouter.ai/api/v1
LLM_BACKEND_2_MODEL=qwen/qwen3-235b
LLM_BACKEND_2_KEY=<from Secret>

LLM_BACKEND_3_NAME=qwen
LLM_BACKEND_3_KIND=private-llm

LLM_ROUTE_HEAVY=opus,or
LLM_ROUTE_LIGHT=qwen
```

The field vocabulary is the same for every backend — `NAME`, `KIND`, `MODEL`, `BASE_URL`, `KEY` — but which
of them are required depends on `KIND`:

| `KIND` | required | ignored |
|--------|----------|---------|
| `claude` | `NAME`, `KIND`, `MODEL`, `KEY` | `BASE_URL` |
| `openai-compatible` | `NAME`, `KIND`, `MODEL`, `BASE_URL`, `KEY` | — |
| `private-llm` | `NAME`, `KIND` | `MODEL`, `BASE_URL`, `KEY` (queues and credentials come from the existing SQS/AWS config) |

The parser loops the index from 1 until `_NAME` is absent (~10 lines).

`LLM_ROUTE_HEAVY` is required. `LLM_ROUTE_LIGHT` is optional: when unset, light-marked calls fall through
to the heavy chain, which reduces the router to failover-only and is a valid way to run it.

`KIND` is one of the three clients that already exist — `claude`, `openai-compatible`, `private-llm`. The
router writes no new client; it composes what is there. OpenRouter is not a special case: it is an ordinary
`openai-compatible` entry, which is how "many public models" is satisfied without new code.

Chosen over a single JSON/YAML blob because each field is a separate env var, so `_KEY` can come from a
Secret while the rest come from a ConfigMap via the existing `extraEnvVars` pattern. A blob containing a
key forces the whole blob into a Secret.

**Known cost:** indices are positional, so inserting a backend in the middle renumbers the others. Routing
is unaffected — routes reference `NAME` — but the YAML diff will look noisier than the real change.

**Growth:** linear, not exponential — roughly 4–5 vars per backend. The driver is the number of *routable
backends*, not the number of providers: one aggregator entry exposes many models, and switching model is
editing one existing value. Expected steady state is 3–5 backends.

## 6. Routing signal

`chat()` carries no workload information, and it must not: adding a parameter would touch three
implementations and every call site for a concern none of them own. The repo already resolved this exact
problem for `traceId` using `AsyncLocalStorage` in `src/utils/trace/index.ts`. That module gains
`withRoute(route, fn)` / `currentRoute()`; no new file.

**Default heavy; light must be requested explicitly.** Only two call sites are marked light:

- conversation-mode mentions in `handleMention` (`src/app/index.ts`), reusing the already-computed
  `wantsInvestigation(text)`
- `reformatToConversation` (`src/agent/index.ts:682`)

Everything else stays heavy untouched: alert investigation, remediation proposal parsing
(`src/agent/index.ts:370`), and feedback extraction (`src/agent/index.ts:650`). Both untouched calls parse
strict JSON, which is where small models fail first.

The asymmetry is deliberate. Anyone adding a new LLM call later gets the strong model by default rather
than a silent downgrade — the cheap mistake, not the expensive one.

Reading the `[USER MESSAGE ...]` marker out of `messages` was considered and rejected despite needing zero
plumbing: those markers are prompt text, so renaming one would silently disable routing with no error, and
they do not cover `reformatToConversation`, which uses a minimal system prompt with no marker.

## 7. Failover semantics

### Failure signals

Three, all of them already-known failure modes in this codebase:

1. **Thrown error** — network, 5xx, timeout, SQS not answering within the deadline.
2. **Empty response** — currently surfaces as the "⚠️ the model returned an empty response" message at
   `src/agent/index.ts:219`. This is the token-exhaustion mode of small reasoning models.
3. **Response is raw content-block JSON** — the regex detector at `src/agent/index.ts:224`, currently
   log-only. Reused, not rewritten.

A weak-but-valid answer is **not** a failure signal. Judging quality would require another LLM call and
would not be trustworthy; the router reacts only to deterministically detectable failure.

**On signal 3 — corrected meaning.** The garbled JSON originally seen in Slack was our own bug
(`JSON.stringify(m.content)` in `toOpenAIMessages`, since fixed in both `llm-worker/src/llm.ts` and
`src/agent/llm/openai-compatible.ts`), not evidence of a weak model. The detector's meaning today is
"**this backend's tool-call channel is not working**" — either our translation regressed, or the backend
runs without a tool-call parser (e.g. vLLM started without `--enable-auto-tool-choice --tool-call-parser`).
The second is a real operational mistake and escalating is the right response. Accepted risk: if the cause
is a regression in our code, failover **masks** it — every request quietly escalates to the expensive
model. Mitigated by logging this case at warn with its own distinct message naming the likely cause, never
folded into the generic failover line.

### Direction

Failover is **one-directional: up only.**

- The effective chain for `light` is the light list followed by the heavy list.
- The effective chain for `heavy` is the heavy list alone.

Light may escalate to heavy; heavy never descends into light. Lateral failover between strong backends
(`opus` → `or`) is preserved because that is not a capability downgrade.

The rationale is asymmetric risk. A failed strong model is a visible outage. A weak model answering a
complex investigation may not throw at all — it may return a confident, wrong RCA that gets posted to
Slack. Falling up trades an outage for a slower answer; falling down trades a visible failure for an
invisible one.

### Attempts and stickiness

Each backend is tried at most once per `chat()`. The same backend is never retried — the underlying
clients already have their own backoff, and stacking retries only slows the failure down.

Once a call escalates, the remaining calls in the same investigation go straight to heavy. The flag lives
on the same `AsyncLocalStorage` context object, so there is no external state and no per-thread map to
clean up. Without it, a five-round investigation against a dead light backend pays five wasted calls.

## 8. Error handling and observability

**Validate at boot, not on first request.** The registry is parsed once at startup and throws on: unknown
`KIND`, duplicate `NAME`, a backend missing a field its `KIND` requires (§5), an empty or absent
`LLM_ROUTE_HEAVY`, or an `LLM_ROUTE_*` entry naming a backend that is not registered. Lazy validation would turn an env-var typo into the first
failed alert of the day instead of a pod that refuses to start. Note that `router` is not a valid `KIND`,
so the router cannot reference itself and no recursion guard is needed.

Implementation added three rules this section did not anticipate, all of the same kind — a config
mistake must be loud:
- indices are scanned over a fixed range (1..20) and a **gap throws**; stopping at the first gap would
  silently drop every backend after it. Indices past 20 are ignored.
- a name may not appear in **both** route lists, nor twice within one list — either would call the same
  backend back-to-back and, across tiers, set a false escalation flag.
- an unknown `LLM_PROVIDER` throws in `createLLMClient()` rather than falling through to `claude`.

**Lifecycle.** Every registered backend is constructed eagerly at boot; registering one is the statement of
intent to use it, and eager construction makes validation happen naturally. `RouterLLMClient` **must**
implement `shutdown()` and call every backend's optional `shutdown()` with `allSettled`, matching the
existing graceful-shutdown drain pattern. `SQSLLMClient.shutdown()` stops its dispatcher and deletes its
queue; missing this leaks an orphaned SQS queue on every restart.

**Logging** uses the existing `errDetail` and `traceSuffix()`, so every line carries the `traceId` that
joins the agent log, the worker log, and the Slack thread. Four lines:

| Level | When | Content |
|-------|------|---------|
| info  | once per attempt | chosen route, backend, attempt N of M |
| warn  | ordinary failover | backend name and the reason it failed |
| warn  | signal 3 | tool-call channel dead, with likely cause (see §7) |
| error | chain exhausted | every backend tried and why each failed |

The backend name is also appended to the existing usage log line, so per-backend cost is available via
`grep` without building any aggregation.

**Total failure** throws a single error listing each backend and its cause, with `cause` set to the last
error (native in Node, no dependency). No new user-facing surface: `handleMention` still catches it as
"❌ Investigation failed", and `reformatToConversation` already has `.catch(() => reply)`, so a router
failure there degrades to the original text.

## 9. Testing

One file, `src/agent/llm/router.test.ts`, following the repo pattern: `node:test` + tsx, no new
dependencies, no mocking framework. A fake backend is a plain object `{ chat: async () => … }`, which is
only possible because of the injected-backends seam in §4.

- default route with no context → heavy; inside `withRoute("light", …)` → light
- light throws → heavy is called and its response returned
- **heavy throws → the error propagates and light is never called**
- empty response from light → escalates to heavy
- content-block-JSON response from light → escalates to heavy
- sticky: after one escalation, the next `chat()` in the same context goes straight to heavy
- lateral failover: `heavy[0]` fails → `heavy[1]` is called
- chain exhausted: the error names every backend and sets `cause`
- config parsing: unknown `KIND`, duplicate `NAME`, and a route naming a missing backend each throw
- `shutdown()` reaches every backend, and one throwing does not stop the others
- **`withRoute("heavy", …)` never touches a light backend** (the clause above has to be able to fail)
- **two concurrent `withRoute` flows do not share escalation state** — one escalates, the other must
  still start at its light backend. Every other case here is sequential, so without this one a
  module-level `{route, escalated}` object passes the entire file while breaking in production, where
  up to `MAX_CONCURRENT_INVESTIGATIONS` flows share one `RouterLLMClient`.

The emphasised cases are the only place the one-directional rule and the isolation it depends on exist as
something that can *fail*. Without them the rules live only in this document, and the next person who finds
bidirectional failover "more robust" will change it with nothing objecting.

### Manual verification (cannot be unit-tested)

Running more than one backend leaves `tool_use.id` values in history that were generated by a different
backend. History is provider-neutral `Message[]` / `ContentBlock[]`, so this is structurally sound, but
whether the Anthropic API accepts arbitrary `tool_use.id` strings on input must be verified once against
the real API. The repo's smoke driver is stubbed and offline and will not catch it. **Do not treat this as
a safe assumption.**

Two paths reach it, not one — the second was missed in the original framing:
1. escalation mid-investigation, where light-generated ids land in the same `chat()` chain; and
2. **any later investigation-mode mention in a thread a light call already touched.** Conversation
   memory is a 24h Redis cache keyed by thread and shared across modes, so a `qwen`-generated id sits
   in history and reaches Claude on the next investigation in that thread with no escalation involved.
   This is the likelier path of the two and needs no failure to trigger it.

**Deploy precondition.** `ANTHROPIC_API_KEY` must exist in Secret `devops-agent-secret` before the dev
overlay is pushed. Flux tracks `main` with a 1-minute poll and no PR gate, so a push **is** a deploy; a
`secretKeyRef` to a missing key yields `CreateContainerConfigError` — the container never starts and there
are no application logs to read.

## 10. Upgrade path

If a second LLM consumer becomes real, promote the router to the standalone in-cluster `llm-gateway`
described in §3. The routing policy, registry shape, and failover semantics transfer unchanged; what
changes is the transport in front of them and which repo owns the credentials. Keeping `RouterLLMClient`
free of agent-specific logic is what keeps that move cheap.

## 11. Files touched

| File | Change |
|------|--------|
| `src/agent/llm/router.ts` | new — `RouterLLMClient`, registry parsing, chain execution |
| `src/agent/llm/router.test.ts` | new — §9 |
| `src/agent/llm/index.ts` | fourth branch in `createLLMClient()` |
| `src/utils/trace/index.ts` | add `withRoute` / `currentRoute` |
| `src/config/index.ts` | `router` added to the `LLM_PROVIDER` union |
| `src/app/index.ts` | wrap conversation-mode mentions in `withRoute("light", …)` |
| `src/agent/index.ts` | wrap `reformatToConversation` in `withRoute("light", …)` |
| `gitops-devops-ai-manifest/apps/dev/applications/devops-ai-agent/release.yaml` | backend + route env vars |
| `MEMORY_BANK.md`, `CLAUDE.md` | document the router and the one-directional rule |

## 12. Open questions

- Anthropic's acceptance of foreign `tool_use.id` values (§9) — verify during implementation.
- Whether `LLM_ROUTE_HEAVY` should also be settable per environment (dev could route everything to the
  private LLM to save cost). Not designed; the registry supports it without change, so this is a config
  decision, not a code one.
