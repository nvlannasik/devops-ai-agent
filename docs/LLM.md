# LLM backends

`LLM_PROVIDER` picks Claude, an OpenAI-compatible API, a private LLM via SQS — or a router holding
several, with light/heavy routes and up-only failover. Settings:
[CONFIGURATION.md](CONFIGURATION.md#llm).

## Private LLM via SQS

For LLMs in a strict private network, set `LLM_PROVIDER=private-llm`. The agent publishes requests
to SQS and polls for responses — private network only needs outbound access to AWS SQS.

See [llm-worker](../../devops-ai-agent-worker) for the worker service deployed in the private network.

## LLM Router

`LLM_PROVIDER=router` holds several backends at once and picks one per call, so a cheap model
can answer "is anything crashlooping?" while a real investigation gets the strong one.

Backends are declared with indexed env vars — the name is a *value*, so adding one never means
inventing new key names, and `_KEY` can come from a Secret while the rest come from a ConfigMap:

```
LLM_BACKEND_1_NAME=local           LLM_BACKEND_2_NAME=opus
LLM_BACKEND_1_KIND=private-llm     LLM_BACKEND_2_KIND=claude
                                   LLM_BACKEND_2_MODEL=claude-opus-5-5
                                   LLM_BACKEND_2_KEY=sk-ant-...

LLM_ROUTE_LIGHT=local              # optional
LLM_ROUTE_HEAVY=opus               # required; comma-separated = ordered failover chain
```

Two per-backend numbers are worth setting rather than leaving to the global defaults:

- `LLM_BACKEND_<N>_CONTEXT_TOKENS` — the window. The budget takes the **smallest** across all
  backends, because the router picks one *after* the request is built.
- `LLM_BACKEND_<N>_MAX_TOKENS` — the output ceiling. The budget reserves the **largest**,
  because whichever backend answers, its answer has to fit in what is left. Conservative in
  opposite directions, on purpose: an over-reserve shortens the history, an under-reserve
  truncates the answer.

  For `claude` and `openai-compatible` this is sent on the wire, and one global value cannot
  serve both a reasoning model and a fast one — a ceiling that suits the fast model makes the
  reasoning model spend its whole budget thinking and return `stop=max_tokens` with empty
  content. For `private-llm` nothing is sent: llm-worker holds its own `LLM_MAX_TOKENS`, so
  the value here is a **declaration** of that worker's setting, read only to size the reserve.
  Declare it wrong and the backend still behaves the same — the agent just keeps the wrong
  amount of window clear for the reply.

`_KIND` is `claude` / `openai-compatible` / `private-llm`; **only `private-llm` takes the SQS
path**, the others call out directly. Indices must be contiguous from 1, routes may not overlap,
and every route name must exist — all of it validated at boot, so an env typo is a pod that
refuses to start rather than the first alert of the day failing.

**More than one private LLM** is allowed, and then each one names the SQS request queue its own
worker polls:

```
LLM_BACKEND_1_NAME=qwen            LLM_BACKEND_2_NAME=deepseek
LLM_BACKEND_1_KIND=private-llm     LLM_BACKEND_2_KIND=private-llm
LLM_BACKEND_1_REQUEST_QUEUE=llm-request-qwen.fifo
                                   LLM_BACKEND_2_REQUEST_QUEUE=llm-request-deepseek.fifo
```

One queue per **model**, not per replica: replicas of one model share a queue and SQS spreads the
work across them (every request is its own `MessageGroupId`, so FIFO never serialises them). The
*response* queue stays global and shared — replies are routed by `requestId`, never by which model
produced them. With a single `private-llm` the global `SQS_REQUEST_QUEUE_NAME` is enough and
`_REQUEST_QUEUE` can be omitted; with two or more it is required on each, because two backends
quietly sharing one queue makes the route a coin flip and the symptom is an answer from the wrong
model — which reads as a bad answer, not a misconfiguration. Each worker deployment sets its own
`SQS_REQUEST_QUEUE_NAME` to match.

**Light** is used for plain Slack mentions and the RCA-format backstop. Everything else — alerts,
explicit investigation requests, remediation proposals — runs **heavy**. Failover is
**up-only**: a light backend that fails escalates into the heavy chain and stays there for the
rest of that investigation; heavy never falls back to light, because a weak model fails by
answering confidently, not by throwing. Only deterministic failures count (empty response, or
content blocks echoed back as prose — the sign of a dead tool-call channel); judging answer
*quality* would take another LLM call and wouldn't be trustworthy.

Per-call token usage is recorded per backend and route in `llm_usage`. A backend failing
`LLM_ROUTER_FAILURE_THRESHOLD` times in a row is skipped for `LLM_ROUTER_COOLOFF_SECONDS`.

## Cost per investigation

Give each backend its price (USD per million tokens) and the dashboard turns `llm_usage` into
money — per backend on the overview, per investigation on the incident page:

```
LLM_BACKEND_1_PRICE_INPUT=0.05
LLM_BACKEND_1_PRICE_OUTPUT=0.4
LLM_BACKEND_1_PRICE_CACHE_READ=0.005   # optional
```

The prices are the operator's, never a table in code. For `openai-compatible` and `private-llm`
the reported input already contains the cached tokens, so those are billed once at the cache
rate, not twice. A backend with no price reads `not priced`, one that reports no token counts
`not reported` — never `$0`.

## Identifier masking

Before any request leaves the agent — to an external API or the private LLM alike — IPs, emails,
AWS ARNs, AWS account ids (only where the text says it is one) and public hostnames are replaced
with stable tokens (`ip-3f9a1c`, `host-9bfc49`, …). Every token is restored in the reply, text and
tool-call arguments both, so tools, memory, Slack and the dashboard only ever see real values. A
token is a hash of its value, so the same IP is the same token on every call.

Deliberately **not** masked: workload, pod, Service and namespace names (the model reasons with
them), Kubernetes label domains, public image registries, in-cluster DNS, file names and field
paths. The system prompt is never touched (it stays one cached block). Pattern-based: it reduces
what leaves, it is not a guarantee. `LLM_MASK_IDENTIFIERS=false` turns it off.
