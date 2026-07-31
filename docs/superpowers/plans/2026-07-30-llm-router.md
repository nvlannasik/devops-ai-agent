# LLM Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each LLM call to a cheap or strong backend by workload class, with one-directional (up-only) failover across a configurable registry of backends.

**Architecture:** A fourth `LLMClient` implementation (`RouterLLMClient`) lives inside the agent and delegates to the three existing clients. Workload class travels implicitly via `AsyncLocalStorage` (the pattern already used for `traceId`), so `LLMClient.chat()` keeps its signature. Backends are declared with indexed env vars and resolved into client instances at boot.

**Tech Stack:** TypeScript ESM (NodeNext), Node 24, `node:test` + tsx, `node:async_hooks`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-llm-router-design.md`

## Global Constraints

- **Node 24 required.** Default shell node is v14. Put `~/.nvm/versions/node/v24.16.0/bin` on the PATH before any `npm`/`node` command: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH`
- **No new dependencies.** Use stdlib or already-installed packages only.
- **TypeScript ESM (NodeNext):** every relative import ends in `.js`, even when the source file is `.ts`.
- **Tests:** `node:test` + `node:assert/strict`, no mocking framework. Test files are `*.test.ts` beside the code and are excluded from the build.
- Full suite: `npm test` · single file: `node --import tsx --test src/agent/llm/router.test.ts`
- **Docs are written in English.** This includes `CLAUDE.md` and `MEMORY_BANK.md`.
- **This repo has pre-existing uncommitted work** (audit, drift-remediation, and guardrail changes from earlier sessions). Never use `git add -A` or `git add .` — every commit step below names its exact paths.
- **Behaviour must not change when `LLM_PROVIDER` is unset or set to an existing value.** Every constructor change is additive with a fallback to the current global `config`.

---

### Task 1: Route context in `utils/trace`

Carries the workload class down the async call tree, and carries the sticky-escalation flag for the investigation. Extends the existing module rather than adding a new one — it is the same mechanism, already documented there for `traceId`.

**Files:**
- Modify: `src/utils/trace/index.ts` (append; do not touch the existing `withTrace`/`currentTrace`/`traceSuffix`)
- Test: `src/utils/trace/index.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LlmRoute = "heavy" | "light"`
  - `interface RouteContext { route: LlmRoute; escalated: boolean }`
  - `withRoute<T>(route: LlmRoute, fn: () => Promise<T>): Promise<T>`
  - `currentRouteContext(): RouteContext | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/utils/trace/index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRoute, currentRouteContext, withTrace, currentTrace } from "./index.js";

test("no route context outside withRoute", async () => {
  assert.equal(currentRouteContext(), undefined);
});

test("withRoute exposes the route and a fresh escalated flag", async () => {
  await withRoute("light", async () => {
    assert.equal(currentRouteContext()?.route, "light");
    assert.equal(currentRouteContext()?.escalated, false);
  });
});

test("escalated is mutable and visible to later calls in the same context", async () => {
  await withRoute("light", async () => {
    currentRouteContext()!.escalated = true;
    await Promise.resolve();
    assert.equal(currentRouteContext()?.escalated, true);
  });
});

test("each withRoute call gets its own context", async () => {
  await withRoute("light", async () => {
    currentRouteContext()!.escalated = true;
  });
  await withRoute("light", async () => {
    assert.equal(currentRouteContext()?.escalated, false);
  });
});

test("route context nests inside a trace context without clearing it", async () => {
  await withTrace("T-1", async () => {
    await withRoute("light", async () => {
      assert.equal(currentTrace(), "T-1");
      assert.equal(currentRouteContext()?.route, "light");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
node --import tsx --test src/utils/trace/index.test.ts
```

Expected: FAIL — `withRoute` and `currentRouteContext` are not exported from `./index.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/utils/trace/index.ts`:

```ts
// Workload class for the LLM router, carried the same way and for the same reason as the
// trace id above: adding a parameter to LLMClient.chat() would grow 3 implementations and
// every call site for a concern none of them own. `escalated` is mutable on purpose — once
// one call in an investigation falls up to the heavy tier, the rest skip the light tier
// instead of paying a failed attempt per round.
export type LlmRoute = "heavy" | "light";

export interface RouteContext {
  route: LlmRoute;
  escalated: boolean;
}

const routeStore = new AsyncLocalStorage<RouteContext>();

export const withRoute = <T>(route: LlmRoute, fn: () => Promise<T>): Promise<T> =>
  routeStore.run({ route, escalated: false }, fn);

export const currentRouteContext = (): RouteContext | undefined => routeStore.getStore();
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test src/utils/trace/index.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/trace/index.ts src/utils/trace/index.test.ts
git commit -m "feat(llm): add route context to utils/trace for workload-class routing"
```

---

### Task 2: Per-backend options on the existing clients

`ClaudeClient` and `OpenAICompatibleClient` currently read model/key/baseUrl from the single global `config` in their constructors, so two instances can never differ. The registry needs per-instance values. Both changes are additive: no argument means today's behaviour exactly.

`SQSLLMClient` needs no change — the spec gives `private-llm` no per-backend fields; its queues and credentials stay in `config.llm.sqs`.

**Files:**
- Modify: `src/agent/llm/claude.ts:5-12`
- Modify: `src/agent/llm/openai-compatible.ts:45-55`
- Test: `src/agent/llm/clients-options.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ClaudeOptions { apiKey?: string; model?: string }`
  - `new ClaudeClient(opts?: ClaudeOptions)` with public `readonly model: string`
  - `interface OpenAICompatibleOptions { baseUrl?: string; apiKey?: string; model?: string }`
  - `new OpenAICompatibleClient(opts?: OpenAICompatibleOptions)` with public `readonly model: string`

- [ ] **Step 1: Write the failing test**

Create `src/agent/llm/clients-options.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";

// Only `model` is asserted. apiKey/baseUrl are handed to the vendor SDKs, which expose no
// stable public accessor for them — reaching into SDK internals would test the SDK, not us.
// Task 3 covers that the registry passes those fields through.

test("ClaudeClient takes a per-instance model", () => {
  const c = new ClaudeClient({ apiKey: "test-key", model: "claude-opus-5" });
  assert.equal(c.model, "claude-opus-5");
});

test("two ClaudeClients can hold different models", () => {
  const a = new ClaudeClient({ apiKey: "test-key", model: "model-a" });
  const b = new ClaudeClient({ apiKey: "test-key", model: "model-b" });
  assert.equal(a.model, "model-a");
  assert.equal(b.model, "model-b");
});

test("OpenAICompatibleClient takes a per-instance model", () => {
  const c = new OpenAICompatibleClient({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "test-key",
    model: "qwen/qwen3-235b",
  });
  assert.equal(c.model, "qwen/qwen3-235b");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test src/agent/llm/clients-options.test.ts
```

Expected: FAIL — the constructors take no arguments and `model` is `private`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/llm/claude.ts`, replace lines 5–12 with:

```ts
// Per-instance overrides so the router can register several Claude backends with different
// models. Omitting them keeps the previous behaviour: read the single global config.
export interface ClaudeOptions {
  apiKey?: string;
  model?: string;
}

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  readonly model: string;

  constructor(opts: ClaudeOptions = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? config.llm.claude.apiKey });
    this.model = opts.model ?? config.llm.claude.model;
  }
```

In `src/agent/llm/openai-compatible.ts`, replace lines 45–55 with:

```ts
// Per-instance overrides — see ClaudeOptions. This is also how an aggregator such as
// OpenRouter is registered: it is an ordinary OpenAI-compatible backend, not a special case.
export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI;
  readonly model: string;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl ?? config.llm.openaiCompatible.baseUrl,
      apiKey: opts.apiKey ?? config.llm.openaiCompatible.apiKey,
    });
    this.model = opts.model ?? config.llm.openaiCompatible.model;
  }
```

- [ ] **Step 4: Run tests and typecheck**

```bash
node --import tsx --test src/agent/llm/clients-options.test.ts
npm run build
npm test
```

Expected: new file PASS (3 tests); `npm run build` clean; `npm test` all green — no existing test may break, because both constructors still default to `config`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm/claude.ts src/agent/llm/openai-compatible.ts src/agent/llm/clients-options.test.ts
git commit -m "feat(llm): allow per-instance model/key/baseUrl on Claude and OpenAI-compatible clients"
```

---

### Task 3: Backend registry

Turns indexed env vars into validated specs, then into client instances. Kept in its own file so `router.ts` stays about routing only.

**Files:**
- Create: `src/agent/llm/registry.ts`
- Test: `src/agent/llm/registry.test.ts` (create)

**Interfaces:**
- Consumes: `ClaudeOptions`/`OpenAICompatibleOptions` constructors from Task 2.
- Produces:
  - `type BackendKind = "claude" | "openai-compatible" | "private-llm"`
  - `interface BackendSpec { name: string; kind: BackendKind; model?: string; baseUrl?: string; apiKey?: string }`
  - `interface Registry { backends: BackendSpec[]; heavy: string[]; light: string[] }`
  - `parseRegistry(env: NodeJS.ProcessEnv): Registry`
  - `buildBackends(specs: BackendSpec[]): Map<string, LLMClient>`

- [ ] **Step 1: Write the failing test**

Create `src/agent/llm/registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistry, buildBackends } from "./registry.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";

const valid = {
  LLM_BACKEND_1_NAME: "opus",
  LLM_BACKEND_1_KIND: "claude",
  LLM_BACKEND_1_MODEL: "claude-opus-5",
  LLM_BACKEND_1_KEY: "sk-ant-test",
  LLM_BACKEND_2_NAME: "or",
  LLM_BACKEND_2_KIND: "openai-compatible",
  LLM_BACKEND_2_BASE_URL: "https://openrouter.ai/api/v1",
  LLM_BACKEND_2_MODEL: "qwen/qwen3-235b",
  LLM_BACKEND_2_KEY: "sk-or-test",
  LLM_BACKEND_3_NAME: "qwen",
  LLM_BACKEND_3_KIND: "private-llm",
  LLM_ROUTE_HEAVY: "opus,or",
  LLM_ROUTE_LIGHT: "qwen",
} satisfies NodeJS.ProcessEnv;

test("parses indexed backends and routes", () => {
  const r = parseRegistry(valid);
  assert.deepEqual(r.backends.map((b) => b.name), ["opus", "or", "qwen"]);
  assert.deepEqual(r.heavy, ["opus", "or"]);
  assert.deepEqual(r.light, ["qwen"]);
  assert.equal(r.backends[1].baseUrl, "https://openrouter.ai/api/v1");
});

test("stops at the first gap in the index", () => {
  const { LLM_BACKEND_2_NAME, ...gapped } = valid;
  const r = parseRegistry({ ...gapped, LLM_ROUTE_HEAVY: "opus", LLM_ROUTE_LIGHT: "" });
  assert.deepEqual(r.backends.map((b) => b.name), ["opus"]);
});

test("LLM_ROUTE_LIGHT is optional", () => {
  const { LLM_ROUTE_LIGHT, ...noLight } = valid;
  assert.deepEqual(parseRegistry(noLight).light, []);
});

test("private-llm needs only NAME and KIND", () => {
  const r = parseRegistry({
    LLM_BACKEND_1_NAME: "qwen",
    LLM_BACKEND_1_KIND: "private-llm",
    LLM_ROUTE_HEAVY: "qwen",
  });
  assert.equal(r.backends[0].kind, "private-llm");
});

test("rejects an unknown kind", () => {
  assert.throws(
    () => parseRegistry({ ...valid, LLM_BACKEND_1_KIND: "router" }),
    /LLM_BACKEND_1_KIND/
  );
});

test("rejects a duplicate name", () => {
  assert.throws(
    () => parseRegistry({ ...valid, LLM_BACKEND_3_NAME: "opus", LLM_BACKEND_3_KIND: "private-llm" }),
    /duplicate/
  );
});

test("rejects openai-compatible without BASE_URL", () => {
  const { LLM_BACKEND_2_BASE_URL, ...noUrl } = valid;
  assert.throws(() => parseRegistry(noUrl), /LLM_BACKEND_2_BASE_URL/);
});

test("rejects claude without KEY", () => {
  const { LLM_BACKEND_1_KEY, ...noKey } = valid;
  assert.throws(() => parseRegistry(noKey), /LLM_BACKEND_1_KEY/);
});

test("rejects a missing LLM_ROUTE_HEAVY", () => {
  const { LLM_ROUTE_HEAVY, ...noHeavy } = valid;
  assert.throws(() => parseRegistry(noHeavy), /LLM_ROUTE_HEAVY/);
});

test("rejects a route naming an unregistered backend", () => {
  assert.throws(() => parseRegistry({ ...valid, LLM_ROUTE_LIGHT: "ghost" }), /ghost/);
});

test("rejects an empty registry", () => {
  assert.throws(() => parseRegistry({ LLM_ROUTE_HEAVY: "opus" }), /LLM_BACKEND_1_NAME/);
});

test("buildBackends maps names to configured client instances", () => {
  const m = buildBackends(parseRegistry(valid).backends);
  assert.deepEqual([...m.keys()], ["opus", "or", "qwen"]);
  assert.ok(m.get("opus") instanceof ClaudeClient);
  assert.equal((m.get("opus") as ClaudeClient).model, "claude-opus-5");
  assert.ok(m.get("or") instanceof OpenAICompatibleClient);
  assert.equal((m.get("or") as OpenAICompatibleClient).model, "qwen/qwen3-235b");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test src/agent/llm/registry.test.ts
```

Expected: FAIL — `./registry.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/llm/registry.ts`:

```ts
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

// Backends are declared with indexed env vars — LLM_BACKEND_<N>_<FIELD>. The backend NAME is
// a value, never part of a key, so adding one never means inventing new key names. Each field
// being its own env var is the point: _KEY comes from a Secret while the rest come from a
// ConfigMap, which a single JSON blob could not do without dragging the whole blob into the
// Secret. Routes reference NAME, so renumbering indices never breaks routing.
export type BackendKind = "claude" | "openai-compatible" | "private-llm";

export interface BackendSpec {
  name: string;
  kind: BackendKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface Registry {
  backends: BackendSpec[];
  heavy: string[];
  light: string[];
}

const KINDS: BackendKind[] = ["claude", "openai-compatible", "private-llm"];

const splitNames = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Which fields each kind needs. private-llm takes none: its queues and credentials stay in
// config.llm.sqs, shared by every replica.
function assertFields(spec: BackendSpec, i: number): void {
  const missing: string[] = [];
  if (spec.kind === "claude" || spec.kind === "openai-compatible") {
    if (!spec.model) missing.push("MODEL");
    if (!spec.apiKey) missing.push("KEY");
  }
  if (spec.kind === "openai-compatible" && !spec.baseUrl) missing.push("BASE_URL");
  if (missing.length > 0) {
    throw new Error(
      `LLM backend ${i} (kind=${spec.kind}) is missing ` +
      missing.map((m) => `LLM_BACKEND_${i}_${m}`).join(", ")
    );
  }
}

// Everything throws here rather than at first request: an env-var typo must show up as a pod
// that refuses to start, not as the first alert of the day failing.
export function parseRegistry(env: NodeJS.ProcessEnv): Registry {
  const backends: BackendSpec[] = [];
  for (let i = 1; ; i++) {
    const name = env[`LLM_BACKEND_${i}_NAME`]?.trim();
    if (!name) break;
    const kind = env[`LLM_BACKEND_${i}_KIND`]?.trim() as BackendKind | undefined;
    if (!kind || !KINDS.includes(kind)) {
      throw new Error(
        `LLM_BACKEND_${i}_KIND must be one of ${KINDS.join(", ")} (got ${kind ?? "unset"})`
      );
    }
    if (backends.some((b) => b.name === name)) {
      throw new Error(`duplicate LLM backend name "${name}" at index ${i}`);
    }
    const spec: BackendSpec = {
      name,
      kind,
      model: env[`LLM_BACKEND_${i}_MODEL`],
      baseUrl: env[`LLM_BACKEND_${i}_BASE_URL`],
      apiKey: env[`LLM_BACKEND_${i}_KEY`],
    };
    assertFields(spec, i);
    backends.push(spec);
  }

  if (backends.length === 0) {
    throw new Error("LLM_PROVIDER=router requires at least LLM_BACKEND_1_NAME");
  }

  const heavy = splitNames(env.LLM_ROUTE_HEAVY);
  const light = splitNames(env.LLM_ROUTE_LIGHT);
  if (heavy.length === 0) {
    throw new Error("LLM_ROUTE_HEAVY is required when LLM_PROVIDER=router");
  }
  for (const n of [...heavy, ...light]) {
    if (!backends.some((b) => b.name === n)) {
      throw new Error(`LLM_ROUTE_* references unknown backend "${n}"`);
    }
  }

  return { backends, heavy, light };
}

export function buildBackends(specs: BackendSpec[]): Map<string, LLMClient> {
  const out = new Map<string, LLMClient>();
  for (const s of specs) {
    if (s.kind === "claude") {
      out.set(s.name, new ClaudeClient({ apiKey: s.apiKey, model: s.model }));
    } else if (s.kind === "openai-compatible") {
      out.set(s.name, new OpenAICompatibleClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }));
    } else {
      out.set(s.name, new SQSLLMClient());
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test src/agent/llm/registry.test.ts
npm run build
```

Expected: PASS, 12 tests; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm/registry.ts src/agent/llm/registry.test.ts
git commit -m "feat(llm): add indexed-env backend registry with boot-time validation"
```

---

### Task 4: `RouterLLMClient`

The routing and failover core. Takes an already-built backend map so its tests need no credentials and no mocking framework.

**The one-directional rule is the safety-critical part of this task.** A weak model that answers a hard investigation may not throw at all — it can return a confident, wrong RCA that gets posted to Slack. Falling up trades an outage for a slower answer; falling down trades a visible failure for an invisible one.

**Files:**
- Create: `src/agent/llm/router.ts`
- Test: `src/agent/llm/router.test.ts` (create)

**Interfaces:**
- Consumes: `currentRouteContext` (Task 1), `LLMClient`/`LLMResponse`/`ContentBlock` from `./types.js`, `errDetail` from `../../utils/logger/index.js`, `traceSuffix` from `../../utils/trace/index.js`.
- Produces: `new RouterLLMClient(backends: Map<string, LLMClient>, heavy: string[], light: string[])` implementing `LLMClient`.

- [ ] **Step 1: Write the failing test**

Create `src/agent/llm/router.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterLLMClient } from "./router.js";
import { withRoute } from "../../utils/trace/index.js";
import type { LLMClient, LLMResponse } from "./types.js";

// A fake backend is a plain object — that is the whole point of injecting the map.
function fake(res: LLMResponse | (() => never), calls: string[], name: string): LLMClient {
  return {
    async chat() {
      calls.push(name);
      if (typeof res === "function") res();
      return res;
    },
  };
}

const answer = (text: string): LLMResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

const toolRound = (): LLMResponse => ({
  content: [{ type: "tool_use", id: "t1", name: "k8s_list_pods", input: {} }],
  stopReason: "tool_use",
});

const boom = () => {
  throw new Error("backend down");
};

function build(calls: string[], light: LLMClient, heavy: LLMClient, heavy2?: LLMClient) {
  const m = new Map<string, LLMClient>([["light1", light], ["heavy1", heavy]]);
  if (heavy2) m.set("heavy2", heavy2);
  return new RouterLLMClient(m, heavy2 ? ["heavy1", "heavy2"] : ["heavy1"], ["light1"]);
}

test("no route context uses the heavy chain", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await r.chat([], [], "sys");
  assert.deepEqual(calls, ["heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("withRoute('light') uses the light chain", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1"]);
  assert.equal(res.content[0].text, "L");
});

test("a throwing light backend falls up to heavy", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("a throwing heavy backend propagates and NEVER falls down to light", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(answer("L"), calls, "light1"), fake(boom, calls, "heavy1"));
  await assert.rejects(() => r.chat([], [], "sys"), /all LLM backends failed/);
  assert.deepEqual(calls, ["heavy1"]);
  assert.ok(!calls.includes("light1"));
});

test("an empty response falls up", async () => {
  const calls: string[] = [];
  const empty: LLMResponse = { content: [], stopReason: "end_turn" };
  const r = build(calls, fake(empty, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("a tool_use round with no text is NOT a failure", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(toolRound(), calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1"]);
  assert.equal(res.stopReason, "tool_use");
});

test("a serialized-content-block answer falls up", async () => {
  const calls: string[] = [];
  const junk = answer('[{"type":"tool_use","name":"k8s_list_pods"}]');
  const r = build(calls, fake(junk, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  const res = await withRoute("light", () => r.chat([], [], "sys"));
  assert.deepEqual(calls, ["light1", "heavy1"]);
  assert.equal(res.content[0].text, "H");
});

test("escalation is sticky for the rest of the investigation", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(answer("H"), calls, "heavy1"));
  await withRoute("light", async () => {
    await r.chat([], [], "sys");
    await r.chat([], [], "sys");
  });
  assert.deepEqual(calls, ["light1", "heavy1", "heavy1"]);
});

test("lateral failover inside the heavy tier", async () => {
  const calls: string[] = [];
  const r = build(
    calls,
    fake(answer("L"), calls, "light1"),
    fake(boom, calls, "heavy1"),
    fake(answer("H2"), calls, "heavy2")
  );
  const res = await r.chat([], [], "sys");
  assert.deepEqual(calls, ["heavy1", "heavy2"]);
  assert.equal(res.content[0].text, "H2");
});

test("an exhausted chain names every backend and sets cause", async () => {
  const calls: string[] = [];
  const r = build(calls, fake(boom, calls, "light1"), fake(boom, calls, "heavy1"));
  await assert.rejects(
    () => withRoute("light", () => r.chat([], [], "sys")),
    (err: Error) => {
      assert.match(err.message, /light1/);
      assert.match(err.message, /heavy1/);
      assert.ok(err.cause instanceof Error);
      return true;
    }
  );
});

test("the constructor rejects a route naming an unknown backend", () => {
  assert.throws(
    () => new RouterLLMClient(new Map(), ["ghost"], []),
    /ghost/
  );
});

test("the constructor rejects an empty heavy chain", () => {
  const m = new Map<string, LLMClient>([["a", fake(answer("A"), [], "a")]]);
  assert.throws(() => new RouterLLMClient(m, [], ["a"]), /heavy/);
});

test("shutdown reaches every backend even when one throws", async () => {
  const stopped: string[] = [];
  const mk = (name: string, fail = false): LLMClient => ({
    async chat() {
      return answer(name);
    },
    async shutdown() {
      stopped.push(name);
      if (fail) throw new Error("shutdown failed");
    },
  });
  const m = new Map<string, LLMClient>([["a", mk("a", true)], ["b", mk("b")]]);
  await new RouterLLMClient(m, ["a", "b"], []).shutdown();
  assert.deepEqual(stopped.sort(), ["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test src/agent/llm/router.test.ts
```

Expected: FAIL — `./router.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/llm/router.ts`:

```ts
import logger, { errDetail } from "../../utils/logger/index.js";
import { currentRouteContext, traceSuffix } from "../../utils/trace/index.js";
import type { ContentBlock, LLMClient, LLMResponse, Message, ToolDefinition } from "./types.js";

// Same detector as the one in agent/index.ts. Its meaning is NOT "the model is weak" — the
// garbled JSON once seen in Slack was our own bug (JSON.stringify over content blocks in
// toOpenAIMessages, since fixed). Today it means this backend's tool-call channel is dead:
// either our translation regressed, or the backend runs without a tool-call parser
// (e.g. vLLM without --enable-auto-tool-choice --tool-call-parser).
const SERIALIZED_BLOCKS = /^\s*\[\s*\{\s*"type"\s*:\s*"(text|tool_use)"/;

const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();

interface Failure {
  reason: string;
  toolChannelDead: boolean;
}

// Only deterministically detectable failures count. A weak-but-valid answer is not one:
// judging quality needs another LLM call and would not be trustworthy.
function failureOf(res: LLMResponse): Failure | null {
  // a tool round legitimately carries no text — treating it as empty would escalate every
  // single round of every investigation
  if (res.stopReason === "tool_use") return null;
  const text = textOf(res.content);
  if (!text) return { reason: `empty response (stop=${res.stopReason})`, toolChannelDead: false };
  if (SERIALIZED_BLOCKS.test(text)) return { reason: "serialized content blocks", toolChannelDead: true };
  return null;
}

export class RouterLLMClient implements LLMClient {
  constructor(
    private readonly backends: Map<string, LLMClient>,
    private readonly heavy: string[],
    private readonly light: string[]
  ) {
    if (heavy.length === 0) throw new Error("router needs a non-empty heavy chain");
    for (const n of [...heavy, ...light]) {
      if (!backends.has(n)) throw new Error(`router route references unknown backend "${n}"`);
    }
  }

  // Failover is one-directional: light may escalate into heavy, heavy never descends into
  // light. Lateral failover between strong backends is preserved because that is not a
  // capability downgrade. See DESIGN doc §7 before making this bidirectional.
  private chain(): { names: string[]; route: "heavy" | "light" } {
    const ctx = currentRouteContext();
    if (!ctx || ctx.route === "heavy" || ctx.escalated) return { names: this.heavy, route: "heavy" };
    return { names: [...this.light, ...this.heavy], route: "light" };
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    const { names, route } = this.chain();
    const ctx = currentRouteContext();
    const failures: string[] = [];
    let last: unknown;

    for (const [i, name] of names.entries()) {
      const backend = this.backends.get(name)!;
      logger.info(`[llm-router] route=${route} backend=${name} attempt=${i + 1}/${names.length}${traceSuffix()}`);
      try {
        const res = await backend.chat(messages, tools, systemPrompt);
        const failure = failureOf(res);
        if (!failure) {
          // sticky only when we actually crossed into the heavy tier, not on a lateral hop
          if (route === "light" && i >= this.light.length && ctx) ctx.escalated = true;
          return res;
        }
        if (failure.toolChannelDead) {
          logger.warn(
            `[llm-router] backend=${name} returned serialized content blocks — its tool-call ` +
            `channel is not working. Check the backend's tool-call parser (vLLM: ` +
            `--enable-auto-tool-choice --tool-call-parser) and toOpenAIMessages${traceSuffix()}`
          );
        } else {
          logger.warn(`[llm-router] backend=${name} failed: ${failure.reason}${traceSuffix()}`);
        }
        failures.push(`${name}: ${failure.reason}`);
        last = new Error(`${name}: ${failure.reason}`);
      } catch (err) {
        logger.warn(`[llm-router] backend=${name} threw: ${errDetail(err)}${traceSuffix()}`);
        failures.push(`${name}: ${errDetail(err)}`);
        last = err;
      }
    }

    logger.error(`[llm-router] all backends failed on the ${route} chain${traceSuffix()}`);
    throw new Error(`all LLM backends failed — ${failures.join("; ")}`, { cause: last });
  }

  // SQSLLMClient.shutdown() stops its dispatcher and deletes its queue. allSettled so one
  // failing backend cannot leak the others' queues on every restart.
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.backends.values()].map((b) => b.shutdown?.())
    );
    for (const r of results) {
      if (r.status === "rejected") logger.warn(`[llm-router] backend shutdown failed: ${errDetail(r.reason)}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test src/agent/llm/router.test.ts
npm run build
```

Expected: PASS, 13 tests; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm/router.ts src/agent/llm/router.test.ts
git commit -m "feat(llm): add RouterLLMClient with workload routing and up-only failover"
```

---

### Task 5: Activation

Makes the router reachable and marks the two light call sites. After this task the feature works end to end.

**Files:**
- Modify: `src/config/index.ts:32`
- Modify: `src/agent/llm/index.ts:1-11`
- Modify: `src/app/index.ts` (the `investigate` call in `handleMention`, currently line 191)
- Modify: `src/agent/index.ts:682-701` (`reformatToConversation`)

**Interfaces:**
- Consumes: `RouterLLMClient` (Task 4), `parseRegistry`/`buildBackends` (Task 3), `withRoute` (Task 1).
- Produces: `LLM_PROVIDER=router` as a working provider.

- [ ] **Step 1: Widen the provider union**

In `src/config/index.ts`, replace line 32:

```ts
    provider: (process.env.LLM_PROVIDER ?? "claude") as
      "claude" | "openai-compatible" | "private-llm" | "router",
```

- [ ] **Step 2: Add the factory branch**

Replace the whole of `src/agent/llm/index.ts` with:

```ts
import { config } from "../../config/index.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { buildBackends, parseRegistry } from "./registry.js";
import { RouterLLMClient } from "./router.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

export function createLLMClient(): LLMClient {
  if (config.llm.provider === "router") {
    // parseRegistry throws on a bad registry, and this runs at boot — an env-var typo must
    // stop the pod, not the first alert of the day.
    const { backends, heavy, light } = parseRegistry(process.env);
    return new RouterLLMClient(buildBackends(backends), heavy, light);
  }
  if (config.llm.provider === "openai-compatible") return new OpenAICompatibleClient();
  if (config.llm.provider === "private-llm") return new SQSLLMClient();
  return new ClaudeClient();
}

export type { LLMClient, Message, ToolDefinition, ToolCall, ToolResult, LLMResponse, ContentBlock } from "./types.js";
```

- [ ] **Step 3: Mark conversation-mode mentions as light**

In `src/app/index.ts`, add to the existing imports:

```ts
import { withRoute } from "../utils/trace/index.js";
```

Then replace the `let reply = …` statement (currently line 191):

```ts
      // Conversation-mode mentions are the cheap tier. Investigation requests and the alert
      // path stay heavy by omission — default heavy is deliberate, so a new LLM call added
      // later gets the strong model rather than a silent downgrade.
      let reply = toMrkdwn(
        investigation
          ? await this.agent.investigate(threadId, message, budget)
          : await withRoute("light", () => this.agent.investigate(threadId, message, budget))
      );
```

- [ ] **Step 4: Mark the format backstop as light**

In `src/agent/index.ts`, `withRoute` is imported alongside the existing `withTrace` on line 22:

```ts
import { withRoute, withTrace } from "../utils/trace/index.js";
```

Replace the body of `reformatToConversation` (lines 682–701):

```ts
  async reformatToConversation(text: string): Promise<string> {
    return withRoute("light", async () => {
      const response = await this.llm.chat(
        [
          {
            role: "user",
            content:
              "Rewrite this as a short conversational Slack answer (mrkdwn), at most ~10 short lines. Keep the facts and any log excerpts. " +
              "Remove the incident/RCA structure entirely (severity, root cause, evidence, ruled out, recommended actions/plans, risks, impact, confidence). " +
              "Remove kubectl/helm command instructions entirely — execution happens via the approval card, never via the user's terminal. " +
              'Remove any "do you want me to proceed" style closing question — if a change was requested, an approval card or a refusal follows this message automatically. ' +
              "End with at most one short offer to investigate if something looked genuinely wrong.\n\n---\n\n" +
              text,
          },
        ],
        [],
        "You reformat DevOps chatbot replies for Slack. Output only the rewritten reply in Slack mrkdwn."
      );
      const out = this.extractText(response.content);
      return out || text;
    });
  }
```

- [ ] **Step 5: Verify the whole suite and the build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm run build
npm test
```

Expected: build clean; every test green. No existing test may break — `LLM_PROVIDER` is unset in tests, so `createLLMClient()` still returns `ClaudeClient`.

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/agent/llm/index.ts src/app/index.ts src/agent/index.ts
git commit -m "feat(llm): activate router provider and mark conversation-mode calls light"
```

---

### Task 6: Deploy wiring, docs, and manual verification

**Files:**
- Modify: `../gitops-devops-ai-manifest/apps/dev/applications/devops-ai-agent/release.yaml`
- Modify: `MEMORY_BANK.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a deployable, documented feature.

- [ ] **Step 1: Add the env wiring to the dev overlay**

In the GitOps repo, add to the agent HelmRelease's `extraEnvVars` (keep `LLM_BACKEND_*_KEY` sourced from the existing Secret, not inline):

```yaml
  - name: LLM_PROVIDER
    value: router
  - name: LLM_BACKEND_1_NAME
    value: opus
  - name: LLM_BACKEND_1_KIND
    value: claude
  - name: LLM_BACKEND_1_MODEL
    value: claude-opus-5
  - name: LLM_BACKEND_1_KEY
    valueFrom:
      secretKeyRef:
        name: devops-ai-agent-secret
        key: ANTHROPIC_API_KEY
  - name: LLM_BACKEND_2_NAME
    value: qwen
  - name: LLM_BACKEND_2_KIND
    value: private-llm
  - name: LLM_ROUTE_HEAVY
    value: opus
  - name: LLM_ROUTE_LIGHT
    value: qwen
```

Confirm the Secret name and key against the existing `ANTHROPIC_API_KEY` entry in that release before applying — do not invent names.

- [ ] **Step 2: Document in `MEMORY_BANK.md`**

Add a `### LLM Router (workload routing + up-only failover)` subsection under **LLM Providers**, covering: the four-branch `createLLMClient`; the indexed-env registry and why each field is its own var; `withRoute` reusing the `traceId` AsyncLocalStorage pattern; default-heavy with only two light call sites; the three failure signals; **the one-directional rule and why bidirectional failover is wrong**; stickiness; and boot-time validation. Link the spec.

- [ ] **Step 3: Document in `CLAUDE.md`**

Add one line to **Gotchas**:

```markdown
- **LLM router:** failover is **up-only** (light → heavy, never the reverse) — a weak model fails by answering confidently, not by throwing. `router.test.ts` is what enforces it. Backends come from indexed `LLM_BACKEND_<N>_*` env vars validated at boot.
```

- [ ] **Step 4: Manual verification against the real API**

This is the item the spec flags as unverifiable by unit test. Do not skip it and do not assume it passes.

With `LLM_PROVIDER=router`, `LLM_ROUTE_LIGHT` pointing at the private LLM and `LLM_ROUTE_HEAVY` at Claude, run an investigation that makes at least one tool call on the light backend, then force an escalation (stop the worker, or point the light backend at a dead URL). Confirm in the logs that:

1. the escalation happened (`[llm-router] backend=… failed`, then a heavy attempt),
2. **Anthropic accepted the request whose history contains `tool_use.id` values generated by the other backend** — no 400 about tool ids or block pairing,
3. the subsequent rounds went straight to heavy (stickiness).

If (2) fails, stop and report: the fix is to renumber foreign tool ids during escalation, which is a design change, not a bug fix.

- [ ] **Step 5: Run the full suite one last time and commit**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm run build && npm test
git add MEMORY_BANK.md CLAUDE.md
git commit -m "docs: document the LLM router, its registry, and the up-only failover rule"
```

Commit the GitOps change separately, in that repo.

---

## Self-Review

**Spec coverage.** §3 decision → Tasks 4–5. §4 architecture and injected-backends seam → Task 4. §5 registry, per-kind required fields, optional `LLM_ROUTE_LIGHT` → Task 3. §6 routing signal, default-heavy, both light call sites → Tasks 1 and 5. §7 three failure signals, corrected meaning of signal 3, direction, attempts, stickiness → Task 4. §8 boot validation, lifecycle/`shutdown`, four log lines, error `cause` → Tasks 3 and 4. §9 tests and manual verification → Tasks 4 and 6. §10 upgrade path → documentation only, Task 6. §11 file table → covered, with one addition below.

**Deviation from the spec, deliberate:** §11 lists only `router.ts`. This plan splits registry parsing into `src/agent/llm/registry.ts` so `router.ts` stays about routing alone. It also adds Task 2, which the spec implied but did not spell out: all three clients currently read model/key/baseUrl from the single global `config` in their constructors, so without per-instance options a registry could never hold two differently-configured backends of the same kind.

**Placeholder scan:** none. Every code step carries the code; every doc step names its exact content.

**Type consistency:** `RouteContext.escalated` (Task 1) is the field Task 4 mutates. `BackendSpec`/`Registry` (Task 3) are what Task 5 destructures as `{ backends, heavy, light }`. `RouterLLMClient(map, heavy, light)` has the same argument order in Tasks 4 and 5. `readonly model` (Task 2) is what Task 3's test asserts.
