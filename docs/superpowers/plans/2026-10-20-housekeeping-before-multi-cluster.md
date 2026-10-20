# Housekeeping Before Multi-Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user's standing choice — no subagents) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `devops-ai-agent` easier to change before multi-cluster part 1 lands, without changing what it does.

**Architecture:** The work moves code and adds no features. MCP access sits behind one small interface, so the multi-cluster `SqsMCPClient` can be a second implementation. The pure helpers and the remediation half of `DevOpsAgent` leave `src/agent/index.ts`. The router-registry read happens in one place. `handleMention` is split into three named steps. Every public name stays where callers import it today, via re-exports and thin delegators.

**Tech Stack:** TypeScript ESM (NodeNext), Node 24, node:test + tsx.

**Spec:** none written. The scope was approved in chat on 2026-10-20 (the housekeeping audit, "Saya setuju semuanya"). The approved scope is:
1. split `agent/index.ts`, with MCP access behind an interface;
2. one router-registry read;
3. SIGTERM in the worker and mcp-server — **dropped**, because both already drain on SIGTERM (`devops-ai-agent-worker/index.ts`, `devops-mcp-server/index.ts`; worker grace period 120 s);
4. split `handleMention`.

Rulings made without a spec are provisional.

## Global Constraints

- **Behaviour-preserving.**
  - No prompt text, log line, Slack message, or SQS/MCP shape changes.
  - The full suite must stay at 1557/1557 after every task (plus each task's new tests).
- **Import sites stay valid.** Every name exported from `src/agent/index.ts` today is still exported from it, through `export … from` re-exports. About 20 test files import from `src/agent/index.js`.
- **No circular imports into the barrel.** A new module never imports `../index.js` or `./index.js` (the agent barrel).
- Docs and comments are in English; match the surrounding comment density.
- No new dependencies.
- Do not commit `.serena/project.yml`.
- Push to `main` is authorized. Deploying needs `kubectl -n devops-tools rollout restart deploy/devops-ai-agent` after the GH "Build & Push" job.

## Review Focus

1. **A moved helper that read module state.** A top-level `const` that the class also uses (`MAX_ITERATIONS`, `LOG_TOOLS`, `TOOL_BUDGET_NOTICE`) must be imported back into `index.ts`, not duplicated. Two copies drift.
2. **`this` inside moved remediation methods.** A method that still calls `this.<agentMethod>` (`timelineFor`, `recordUsage`) must reach it through the `RemediatorHost` deps. Leaving it in silently binds `undefined` at runtime, and tsc only catches it if the type says so.
3. **The trace getter.** `DevOpsAgent.trace` is reassigned in `initialize()`. The remediator must read it through a getter (`() => this.trace`), never capture the value at construction.
4. **`handleMention` ordering.** The tour tables, flow tables, the strip, the reply parts and the footer on the last part must stay in exactly today's order. No test covers that order end to end, so the live check in Task 6 is the only net.
5. **Registry read in tests.** `routerRegistry()` must not memoize. Tests set `process.env.LLM_BACKEND_*` between cases.

---

### Task 1: `McpTools` — the interface every MCP transport implements

**Files:**
- Create: `src/agent/mcp/types.ts`
- Modify:
  - `src/agent/mcp/client.ts` (`export class MCPClient implements McpTools`);
  - `src/agent/index.ts` (`AgentDeps.mcp?: McpTools`, field `private mcp: McpTools`).
- Test: `src/agent/mcp/types.test.ts`

**Interfaces:**
- Produces: `export interface McpTools { connect(): Promise<void>; disconnect(): Promise<void>; getTools(): ToolDefinition[]; callTool(name: string, input: Record<string, unknown>): Promise<string>; ping(): Promise<boolean>; }`. Copy the exact return types from `MCPClient`; if `ping` or `disconnect` returns something else there, the interface copies it.

- [ ] **Step 1: Write the failing test.** `src/agent/mcp/types.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { McpTools } from "./types.js";
import { DevOpsAgent, type AgentDeps } from "../index.js";

// The multi-cluster SqsMCPClient is a second McpTools; the agent must accept any of them, not only
// the HTTP class (whose private fields make it nominal to TypeScript).
test("AgentDeps.mcp accepts any McpTools, not only the HTTP MCPClient", () => {
  const fake: McpTools = {
    connect: async () => {}, disconnect: async () => {}, getTools: () => [],
    callTool: async () => "ok", ping: async () => true,
  };
  const deps: AgentDeps = { mcp: fake };
  assert.ok(new DevOpsAgent(deps));
});
```

- [ ] **Step 2: Run it.**
  - Run `npx tsc --noEmit`. Expected: FAIL, because `./types.js` does not exist yet, and `fake` is not assignable to `MCPClient` (it lacks private members).

- [ ] **Step 3: Implement.**
  - Create `types.ts` with the interface.
  - Add `implements McpTools` to `MCPClient`.
  - Change the `AgentDeps.mcp` type and the `mcp` field type to `McpTools`.
  - `instrumentMCP` is already generic over `{ callTool }`, so leave it.

- [ ] **Step 4: Run.**
  - `npx tsc --noEmit && npx tsx --test src/agent/mcp/types.test.ts`. Expected: PASS.
  - `npm test`. Expected: all pass.

- [ ] **Step 5: Commit.** `refactor(mcp): McpTools interface — the agent takes any MCP transport`

### Task 2: Pure helpers out of `agent/index.ts`

The top-level functions and constants before `export class DevOpsAgent` (today lines ~92–1290) move into four modules by concern. Move each by **symbol name**: cut it verbatim and keep its comment. Then add an `export { … } from` line in `index.ts` for every exported name, and an `import` for every name the class body still uses.

| New module | Symbols |
|---|---|
| `src/agent/loop/log-gap.ts` | `LOG_TOOLS`, `LOG_RESULT_MIN_CHARS`, `NO_LOG_LINES`, `TOOL_ERROR`, `REPEAT_PREFIX`, `returnedLogLines`, `memoSawLogLines`, `nudgeLostRca`, `LOG_GAP_NOTICE`, `demandsLogs`, `isShapeSkill`, `LogGapState`, `logGapAction` |
| `src/agent/remediation/evidence-refusals.ts` | `quarantineRefusal`, `orphanDeleteRefusal`, `TEMPLATE_HASH`, `replicaSetAsDeployment`, `lastToolResultIn`, `ungroundedTargetRefusal`, `RESOURCE_FAULT`, `resourceFaultRefusal`, `offerMismatchRefusal`, `targetKey`, `SATURATION`, `scaleOutRefusal`, `unseenImageRefusal`, `backupFrom`, `PULL_FAILURE`, `IMAGE_REF`, `repoOf`, `imageGapRepo`, `IMAGE_GAP_NOTICE` |
| `src/agent/loop/control.ts` | `MAX_ITERATIONS`, `MAX_LOG_FANOUT`, `TOOL_BUDGET_NOTICE`, `FINAL_TURN_INSTRUCTION`, `ITERATION_CEILING_NOTICE`, `TIME_BUDGET_NOTICE`, `NO_EVIDENCE_NOTICE`, `FABRICATED_EVIDENCE_NOTICE`, `FABRICATED_EVIDENCE`, `fabricatesEvidence`, `needsEvidence`, `DELEGATE_BUDGET_NOTICE`, `forcedFinalAnswer`, `noToolRoundLeft`, `MAX_TRACKED_THREADS`, `WINDOW_PARAMS`, `windowOf`, `memoCovers`, `toolCallKey`, `placeholderIn`, `PLACEHOLDER_REFUSAL`, `REPEAT_NOTICE`, `reportProgress`, `RUN_MODES`, `RunMode`, `modeTag`, `keysOnMode`, `EVIDENCE_STAMP_PREFIX`, `evidenceStamp`, `STALE_EVIDENCE_MINUTES`, `STAMP_RE`, `staleEvidenceNotice`, `evidenceTexts` |
| `src/agent/skills/thread.ts` | `MAX_THREAD_SKILLS`, `CARRIED_SKILLS`, `ThreadSkills`, `SkillView`, `selectForThread`, `decayThreadSkills`, `resolveSkillNames` |

What stays in `index.ts`: `ReconciledIncident`, `fallbackLabels`, `TIMELINE_MAX_*`, `InvestigateOptions`, `RunMeta`, `zeroUsage`, `addUsage`, `AgentDeps`, the class.

**Interfaces:**
- Consumes: `McpTools` (Task 1).
- Produces: the four modules above. Every name keeps its exact signature. `index.ts` re-exports all of them.

- [ ] **Step 1: Write the failing test.** `src/agent/loop/modules.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as barrel from "../index.js";
import * as logGap from "./log-gap.js";
import * as control from "./control.js";
import * as refusals from "../remediation/evidence-refusals.js";
import * as thread from "../skills/thread.js";

const MODULES = { "loop/log-gap.ts": logGap, "loop/control.ts": control, "remediation/evidence-refusals.ts": refusals, "skills/thread.ts": thread };

test("every moved helper is still exported from the agent barrel, as the same value", () => {
  for (const [file, mod] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(mod)) {
      assert.equal((barrel as Record<string, unknown>)[name], value, `${file}: ${name} not re-exported from agent/index.ts`);
    }
  }
});

test("no moved module imports the agent barrel (no cycle back into index.ts)", () => {
  for (const file of Object.keys(MODULES)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from "(\.\.?\/)+index\.js"/, `${file} imports the barrel`);
  }
});

test("agent/index.ts lost its top-level helpers", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^export function (logGapAction|unseenImageRefusal|toolCallKey|selectForThread)\b/m);
});
```

- [ ] **Step 2: Run it.**
  - `npx tsx --test src/agent/loop/modules.test.ts`. Expected: FAIL with module not found.

- [ ] **Step 3: Move the symbols.**
  - Move them table row by table row. Each module imports what its symbols need from their own modules, never from the barrel.
  - After each row, run `npx tsc --noEmit`. Expected: clean before you start the next row.

- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/loop/modules.test.ts`. Expected: 3/3 PASS.
  - `npm test`. Expected: all pass.
  - `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 5: Commit.** `refactor(agent): pure helpers out of agent/index.ts into loop/, remediation/, skills/`

### Task 3: The remediation half of `DevOpsAgent` → `Remediator`

**What moves:** the methods from `proposeRemediation` through `runDueRemediationChecks`, `verifyRemediation`, `podHealth` and `rejectRemediation` (today lines ~2474–3272). They go into `src/agent/remediation/remediator.ts`, `export class Remediator`, verbatim:
- the public ones: `proposeRemediation`, `refusalFor`, the `*RefusalFor` methods, `executeRemediation`, `scheduleRemediationCheck`, `runDueRemediationChecks`, `rejectRemediation`;
- the private ones: `proposeRemediationRun`, `quarantineRefusalFor`, `orphanRefusalFor`, `threadEvidence`, `resolveOverlayPath`, `proposeGitOpsPr`, `proposeRevertPr`, `proposeFluxReconcile`, `workloadOf`, `executeGitOpsPr`, `verifyRemediation`, `podHealth`.

**What changes inside them:**
- `this.<field>` becomes `this.host.<field>` for these fields: `mcp`, `llm`, `remediations`, `checks`, `gitops`, `memory`, `incidents`.
- `this.trace` and `this.traceStore` become `this.host.trace()` and `this.host.traceStore()`.
- `this.timelineFor(…)` and `this.recordUsage(…)` become `this.host.timelineFor(…)` and `this.host.recordUsage(…)`.
- `this.extractText` becomes a module function `extractText` (it is pure). Move it to `remediator.ts` and import it back into `index.ts` if the class still uses it.

**What stays on `DevOpsAgent`:** a one-line delegator per public method, with the same signature, e.g.

```ts
refusalFor(...a: Parameters<Remediator["refusalFor"]>) { return this.remediator.refusalFor(...a); }
```

`app/`, `bench/` and `replay/` keep calling `agent.proposeRemediation(…)` and the rest unchanged.

**Interfaces:**
- Consumes: `McpTools` (Task 1); `lastToolResultIn`, `targetKey` and the refusal helpers (Task 2).
- Produces:
  - `export interface RemediatorHost { mcp: McpTools; llm: LLMClient; remediations: RemediationStore; checks: RemediationCheckStore; gitops: SqsGitOpsClient | null; memory: ConversationMemory; incidents: IncidentMemory; trace(): TraceRecorder; traceStore(): TraceStore | null; timelineFor(threadId?: string): Promise<ChangeTimeline | null>; recordUsage(threadTs: string | null, response: LLMResponse): void; }`. Copy the field types from the class declarations; `traceStore`'s type is whatever the field is today.
  - `export class Remediator { constructor(private readonly host: RemediatorHost) {} … }`.
  - `DevOpsAgent` gains `private readonly remediator: Remediator`. It is built in the constructor with getters that read the CURRENT fields, so a store swapped in `initialize()` is seen: `get remediations() { return self.remediations; }`, and so on.

- [ ] **Step 1: Write the failing test.** `src/agent/remediation/remediator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Remediator } from "./remediator.js";
import { DevOpsAgent } from "../index.js";

test("Remediator is its own class and DevOpsAgent delegates to it", () => {
  assert.equal(typeof Remediator, "function");
  const agent = new DevOpsAgent({ mcp: { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true } });
  assert.ok((agent as any).remediator instanceof Remediator);
});

test("the host is read live: a store swapped after construction is the one the remediator uses", async () => {
  const agent = new DevOpsAgent({ mcp: { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true } });
  let rejected: number | null = null;
  (agent as any).remediations = { reject: async (id: number) => { rejected = id; return null; } };
  await agent.rejectRemediation(7, "U1").catch(() => {});
  assert.equal(rejected, 7);
});

test("agent/index.ts no longer holds the remediation bodies", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /private async (proposeGitOpsPr|executeGitOpsPr|resolveOverlayPath)\(/);
});
```

Read `rejectRemediation`'s body before running. If it calls a store method other than `reject`, name that method in the fake. The test pins live host reads, not a method name.

- [ ] **Step 2: Run it.**
  - `npx tsx --test src/agent/remediation/remediator.test.ts`. Expected: FAIL with module not found.

- [ ] **Step 3: Move the methods.**
  - Move them as listed above, then add the delegators.
  - `npx tsc --noEmit` must be clean. A leftover `this.<x>` that tsc flags is a host member you missed: add it to `RemediatorHost`. Do not cast it away.

- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/remediation/remediator.test.ts`. Expected: 3/3 PASS.
  - `npm test`. Expected: all pass, including `replay/run.test.ts`, `trace/gates.test.ts` and `trace/wiring.test.ts`.

- [ ] **Step 5: Commit.** `refactor(agent): remediation half of DevOpsAgent into remediation/remediator.ts`

### Task 4: One router-registry read

**Files:**
- Modify:
  - `src/agent/llm/registry.ts` (add `routerRegistry`);
  - `src/agent/llm/index.ts`, `src/agent/index.ts` (2 sites), `src/dashboard/topology.ts` (use it).
- Test: `src/agent/llm/registry.test.ts` (append).

**Interfaces:**
- Produces: `export function routerRegistry(env: NodeJS.ProcessEnv = process.env, provider: string = config.llm.provider): Registry | null`. It returns `null` unless `provider === "router"`, otherwise `parseRegistry(env)`. **Not memoized** (Review Focus 5). It throws exactly what `parseRegistry` throws.
- Not changed: `dashboard/context.ts` `backendSpecs(provider, env)` and `llm/pricing.ts` `backendPrices(env = process.env)`. They already take `env` as a parameter for their tests.

- [ ] **Step 1: Write the failing test.** Append to `src/agent/llm/registry.test.ts`:

```ts
test("routerRegistry: null unless the provider is router; parses the given env otherwise", async () => {
  const { routerRegistry } = await import("./registry.js");
  assert.equal(routerRegistry({}, "claude"), null);
  const env = { LLM_BACKEND_1_NAME: "a", LLM_BACKEND_1_KIND: "claude", LLM_BACKEND_1_ROUTE: "heavy" } as NodeJS.ProcessEnv;
  assert.deepEqual(routerRegistry(env, "router"), (await import("./registry.js")).parseRegistry(env));
});
```

Before running it, read the existing cases in `registry.test.ts` for the exact env keys a valid one-backend registry needs, and use those.

- [ ] **Step 2: Run it.**
  - `npx tsx --test src/agent/llm/registry.test.ts`. Expected: FAIL, because `routerRegistry` is not a function.

- [ ] **Step 3: Implement.**
  - Add `routerRegistry`.
  - Replace these reads with `routerRegistry()`:
    - `config.llm.provider === "router" ? parseRegistry(process.env) : null` (both sites in `agent/index.ts`);
    - `parseRegistry(process.env)` in `llm/index.ts`'s `router` case. Use `routerRegistry()!`: the case is already `router`, so it cannot be null there. Keep the existing comment.
    - `topology.ts` `routerBackends()`. Keep its early return and its try/catch.
  - Afterwards, `grep -rn "parseRegistry(process.env)" src --include=*.ts | grep -v test` must print nothing.

- [ ] **Step 4: Run.**
  - `npm test`. Expected: all pass.
  - `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 5: Commit.** `refactor(llm): one router-registry read (routerRegistry)`

### Task 5: `handleMention` in three named steps

**Files:**
- Modify: `src/app/index.ts`
- Test: `src/app/tour-post.test.ts` (append)

Three private methods are cut out of `handleMention` verbatim. Its body then calls them in the same order as today.

**Interfaces:**
- Produces, all on `SlackApp`:
  - `private progressNotifier(client: AllMiddlewareArgs["client"], channel: string, threadId: string): { onProgress: (round: number, tools: string[]) => void; clear: () => Promise<void> }`.
    - `onProgress` is today's `onProgress` closure (the `noticeTs`/`noticePending` state lives inside the notifier).
    - `clear` is today's "delete the notice" block.
  - `private async postConversation(channel: string, threadId: string, client: AllMiddlewareArgs["client"], reply: string, footer: string | undefined, tour: { isTour: boolean; ns: string | null; model: ClusterModel | null }): Promise<void>`. It holds today's `else` branch: tour tables, flow tables, the strip, `splitForSlack`, and posting with the footer on the last part.
  - `private async proposeAfterMention(channel: string, threadId: string, text: string, reply: string, isRca: boolean, previousReply: string, offer: ReturnType<typeof parseOffer>): Promise<void>`. It holds today's `worthProposing` gate, the log line, and the `withTrace(… maybeProposeRemediation …)` call.

- [ ] **Step 1: Write the failing test.** Append to `src/app/tour-post.test.ts`:

```ts
// handleMention split (housekeeping 2026-10-20): the conversation post keeps today's order —
// inventory table, flow tables, then the reply parts, the footer on the last part only.
test("postConversation: tour tables, flow tables, then the reply with its footer last", async () => {
  const posted: any[] = [];
  const client = { chat: { postMessage: async (m: any) => { posted.push(m); return { ts: String(posted.length) }; } } };
  const self = Object.assign(Object.create(SlackApp.prototype), {
    postTourTables: async () => { posted.push({ marker: "inventory" }); return null; },
    postFlowTables: async () => { posted.push({ marker: "flow" }); },
  });
  await (SlackApp.prototype as any).postConversation.call(self, "C1", "1.1", client, "the reply", "footer", { isTour: true, ns: "sample-apps", model: FLOW_MODEL });
  assert.deepEqual(posted.map((p) => p.marker ?? "reply"), ["inventory", "flow", "reply"]);
  assert.match(posted[2].text, /the reply\n\n_footer_$/);
});
```

- [ ] **Step 2: Run it.**
  - `npx tsx --test src/app/tour-post.test.ts`. Expected: FAIL, because `postConversation` is not a function.

- [ ] **Step 3: Cut the three methods out verbatim** and call them from `handleMention`. Variables a cut block used from the enclosing scope become parameters, exactly as the Interfaces block lists.

- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/tour-post.test.ts`. Expected: PASS.
  - `npm test`. Expected: all pass.
  - `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 5: Commit.** `refactor(app): handleMention in three named steps`

### Task 6: Deploy and prove nothing changed (controller)

- [ ] **Step 1: Build.** `npm run build`. Expected: clean, including the dashboard client bundle.
- [ ] **Step 2: Push and deploy.**
  - `git push origin main`, then wait for the "Build & Push" run on the HEAD sha.
  - Run `kubectl -n devops-tools rollout restart deploy/devops-ai-agent` and `rollout status`.
  - `printenv GIT_SHA` must equal HEAD.
- [ ] **Step 3: Live smoke.**
  - Agent log after boot shows MCP connected with the same tool count as before (55) and no error lines.
  - `/cluster` renders with the model edges.
  - Ask the user for two Slack mentions in a new thread:
    1. `jelasin namespace sample-apps`. Expected: inventory table, Request flow, Where to change it, then the reply.
    2. In the same thread: `berapa pod yang running di sample-apps?` Expected: a plain answer, plus the `[remediation] no proposal call` log line.
  - Never trigger a fault for this check.
- [ ] **Step 4: Final self-review** (executing-plans, no subagent). Then delete this plan's workspace.
