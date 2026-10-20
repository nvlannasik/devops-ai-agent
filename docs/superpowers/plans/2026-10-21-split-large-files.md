# Split the Large Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user's standing choice — no subagents) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four largest files in `devops-ai-agent` readable and maintainable without changing anything the software does.

**Architecture:** The work moves code and adds no features.
- `runInvestigation` (~600 lines in one method) becomes:
  - a loop state object;
  - an answer finalizer;
  - the answer gates;
  - an `InvestigationRunner` class.
- The incident lifecycle methods leave `DevOpsAgent`.
- `SlackApp` keeps Slack wiring and the four posting helpers every flow shares. Its flows become four classes that all read one live `SlackHost` object: commands, remediation, alerts and mentions.
- The dashboard's `styles.ts` becomes ordered CSS chunks whose concatenation is byte-identical. Its `views.ts` becomes one module per page, with `views.ts` left as a barrel.
- Every moved class follows the existing `Remediator`/`RemediatorHost` pattern (`src/agent/remediation/remediator.ts`): the host is read through getters, never captured.

**Tech Stack:** TypeScript ESM (NodeNext), Node 24, node:test + tsx.

**Spec:** none written. The scope was approved in chat on 2026-10-21 ("buat konsisten agar lebih rapih", then "untuk dashboarding html/css juga masuk ke refactor, tuliskan plannya"). The approved scope is:
1. split `src/agent/index.ts` (`runInvestigation`; incident methods);
2. split `src/app/index.ts` into queue, commands, remediation, alerts and mention flows;
3. split `src/dashboard/styles.ts` and `src/dashboard/views.ts` by page/feature.

The target is about 500 lines per file. Rulings made without a spec are provisional.

## Global Constraints

- **Behaviour-preserving.**
  - No prompt text, log line, Slack message, trace gate, HTML byte, CSS byte, or SQS/MCP shape changes.
  - Comments move with their code, verbatim.
- **The suite stays green after every task.** The baseline at 981e821 is 1597/1597. Each task adds its own tests on top.
- **Import sites stay valid.**
  - Every name exported today from `src/agent/index.ts`, `src/app/index.ts` and `src/dashboard/views.ts` is still exported from that file, via `export … from` re-exports.
  - `bench/run.ts` imports `buildProposalContext` from `app/index.js`. Root `index.ts` imports `SlackApp`.
- **No value import into a barrel.**
  - A new module never imports `../index.js`/`./index.js` (the agent or app barrel) or `./views.js` (the dashboard barrel) as a value.
  - `import type` from a sibling flow is allowed; it is erased.
- Docs and comments are in English; match the surrounding comment density.
- No new dependencies.
- Do not commit `.serena/project.yml` (or anything under `.serena/`).
- Push to `main` is authorized.
  - Deploying needs `kubectl -n devops-tools rollout restart deploy/devops-ai-agent`, after the GH "Build & Push" run for the pushed sha has finished.
  - Find that run with `gh run list --limit 3`, never `--commit` right after the push.
- Never trigger faults or alerts yourself. Never print secrets.

## Review Focus

1. **Loop state read too early.**
   - `done()` used to read `iterations`, `totalToolCalls`, `totalUsage`, `lastResponse` and `sawLogLines` at the moment it was called.
   - `finalizeAnswer` must read them from the `RunState` object at call time, never from a copy made earlier.
   - Task 3's test calls it after mutating the state.
2. **A delegate must go through `host.investigate`, not `this.run`.**
   - `investigate()` is what wraps a run in `withTrace(sub)` and `trace.finish(sub)`.
   - Calling `run` directly gives the delegate the parent's traceId and a run that is never written.
   - Task 5 pins it.
3. **`verifyTimer` is one field.** `armVerificationPoller` sets it (in `RemediationFlow`) and `SlackApp.stop()` clears it. The host must expose a setter onto SlackApp's own field; a copy would leave a timer running past shutdown. Tasks 7 and 9 pin it.
4. **A cross-flow host function that calls itself.** Live 2026-10-20 (8c60b0a), a delegator rewritten into a self-call killed every cluster-model build while every test passed, because every fake stubbed it. The wiring tests drive each host function on a real `SlackApp`/`DevOpsAgent` instance with the targets stubbed.
5. **CSS order is cascade.** A chunk moved out of order changes which rule wins, at the same specificity, with no error. Task 1 pins the exact bytes by sha256.

---

### Task 0: Snapshot every dashboard page before anything moves (controller)

The views and styles must render byte-identical HTML. This snapshot is the BASE side of that comparison. Do not commit the script.

**Files:**
- Create (not committed): `page-snapshot.tmp.ts` at the repo root.

- [ ] **Step 1: Write the script.**

```ts
// Throwaway: boots the dashboard on an empty fake pool and synthetic memory, fetches every page,
// writes normalised HTML to argv[2]. Deleted at the end of the plan.
import { mkdirSync, writeFileSync } from "node:fs";
import { DashboardServer } from "./src/dashboard/server.js";
import { DashboardQueries } from "./src/dashboard/queries.js";
import { config } from "./src/config/index.js";
import { SESSION_COOKIE, mintSession } from "./src/dashboard/auth.js";

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const PASSWORD = "render-check-only";
const pool = { query: async () => ({ rows: [] }), end: async () => {}, on: () => {} } as never;
const memory = {
  recall: async () => ({ incidents: "", remediations: "" }),
  threads: async () => [{ threadId: "1792421141.306329", messages: 3, ttlSeconds: 3600, rcaSent: true, skills: ["cluster-tour"] }],
  thread: async (id: string) => ({ threadId: id, ttlSeconds: 3600, rcaSent: true, skills: [], messages: [{ role: "user", content: "hi" }] }),
};
const skills = () => [{ name: "rca-format", description: "d", when: "mode:alert", chars: 10, body: "# body" }] as never;
config.dashboard.enabled = true; config.dashboard.port = 0; config.dashboard.password = PASSWORD; config.dashboard.cookieSecure = false;
const d = new DashboardServer(new DashboardQueries(pool), () => [], skills, async () => "{}", () => null, memory as never);
await d.start();
const port = (d as unknown as { server: { address(): { port: number } } }).server.address().port;
const cookie = `${SESSION_COOKIE}=${mintSession(PASSWORD)}`;
const pages = ["/", "/login", "/incidents", "/incidents/1", "/harness", "/harness/log-gap", "/topology", "/prompt",
  "/context", "/context/rca-format", "/bench", "/cluster", "/memory", "/memory/alert?name=X&ns=y",
  "/memory/threads", "/memory/threads/1792421141.306329", "/nope"];
for (const p of pages) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie }, redirect: "manual" });
  const html = (await r.text())
    .replace(/nonce="[^"]*"/g, 'nonce="N"').replace(/'nonce-[^']*'/g, "'nonce-N'")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS").replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "HH:MM");
  writeFileSync(`${out}/${p.replace(/[^a-z0-9]+/gi, "_") || "_root"}.html`, `${r.status}\n${html}`);
}
process.exit(0);
```

Read `DashboardServer`'s constructor and the `SkillView` type before you run it.
- If a parameter's shape differs, adjust only the fake.
- A route that answers 404 or a redirect is fine. It is still a deterministic page.

- [ ] **Step 2: Run it at BASE.**
  - Command: `npx tsx page-snapshot.tmp.ts .superpowers/sdd/2026-10-21-split-large-files/pages-base`
  - Expected: 17 files, each starting with a status line.
  - Run it again into `pages-base2` and `diff -r` the two. Expected: no diff. If they differ, extend the normalisation until two BASE runs agree. A snapshot that differs from itself proves nothing.

### Task 1: `styles.ts` → ordered chunks, byte-identical

**Files:**
- Create. Line numbers are as of 981e821:
  - `src/dashboard/styles/chrome.ts` (lines 31–512: tokens, mobile drawer, top bar, rail);
  - `src/dashboard/styles/panels.ts` (513–852: type, panels, delta);
  - `src/dashboard/styles/tables.ts` (853–1242: tables, badges, filters, sign-in, prose);
  - `src/dashboard/styles/content.ts` (1243–1604: RCA, skill, markdown, chips, empty/pager);
  - `src/dashboard/styles/charts.ts` (1605–1991: charts, donut, topology, hover);
  - `src/dashboard/styles/responsive.ts` (1992–2146: responsive & motion, the rail as a drawer);
  - `src/dashboard/styles/bench.ts` (2147–2279: benchmark).
- Modify: `src/dashboard/styles.ts` (keeps its header comment; becomes the concatenation).
- Test: `src/dashboard/styles.test.ts`.

**Interfaces:**
- Produces: `export const STYLES: string`, unchanged in value. Each chunk is `` export const CHROME_CSS = `…`; `` (likewise `PANELS_CSS`, `TABLES_CSS`, `CONTENT_CSS`, `CHARTS_CSS`, `RESPONSIVE_CSS`, `BENCH_CSS`).

- [ ] **Step 1: Pin today's bytes.**
  - Run `npx tsx -e 'import {STYLES} from "./src/dashboard/styles.ts"; import {createHash} from "node:crypto"; console.log(STYLES.length, createHash("sha256").update(STYLES).digest("hex"))'`.
  - Write the test with the printed length and hash in place of `<LENGTH>` and `<HASH>`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { STYLES } from "./styles.js";

// 2026-10-21 split: STYLES is seven ordered chunks. Order is the cascade, so the bytes are pinned —
// a chunk moved or a line lost changes which rule wins with no error anywhere.
test("STYLES is byte-identical to the pre-split stylesheet", () => {
  assert.equal(STYLES.length, <LENGTH>);
  assert.equal(createHash("sha256").update(STYLES).digest("hex"), "<HASH>");
});

test("no stylesheet chunk interpolates", () => {
  for (const f of readdirSync(new URL("./styles/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8"), /\$\{/, f);
  }
});
```

The first test is written against today's file, so it passes now. That is correct for a characterization test.
- [ ] **Step 2: Run it.** `npx tsx --test src/dashboard/styles.test.ts`. Expected: test 1 PASS; test 2 fails with ENOENT, because the `styles/` directory does not exist yet.
- [ ] **Step 3: Split.**
  - Write a throwaway script (`.superpowers/sdd/2026-10-21-split-large-files/split-styles.mjs`). It cuts `styles.ts` at the marker lines listed under Files (`/* ---------- tables ---------- */` and the like). It writes each line range verbatim between `` export const X_CSS = ` `` and `` `; ``.
  - The first chunk starts on the line right after `` export const STYLES = ` `` and the last ends on the line right before the closing `` `; ``. No line is dropped and none is duplicated.
  - Each chunk file gets a one-line header comment naming what it holds and pointing at `styles.ts` for the template-literal rules.
  - `styles.ts` becomes its header comment, the seven imports, and:

```ts
export const STYLES = CHROME_CSS + PANELS_CSS + TABLES_CSS + CONTENT_CSS + CHARTS_CSS + RESPONSIVE_CSS + BENCH_CSS;
```

  - Backslashes (`\\2191`) copy verbatim, because each chunk is again a template literal.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/dashboard/styles.test.ts`. Expected: 2/2 PASS. A hash mismatch means a boundary line was lost or doubled: diff the new `STYLES` value against the old one.
  - `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(dashboard): styles.ts into seven ordered CSS chunks, bytes pinned`

### Task 2: `views.ts` → one module per page

**Files:** all under `src/dashboard/`. Line numbers are as of 981e821.
- Create:
  - `parts.ts`: shared atoms.
    - `fmtUsd`, `costCell` (5–39).
    - `ico`, `ICON` (40–122).
    - `TONE`, `tone`, `toneAttr`, `badge`, `dash`, `stateBadge`, `severityBadge`, `breakable` (344–416).
    - `empty`, `section`, `statList` (417–500).
    - `PAGE_SPAN`, `pageWindow`, `pager` (801–881).
    - `jsonBlock` (1578–1595), which is shared by topology and cluster.
  - `layout.ts`: the page shell.
    - `NAV_GROUPS`, `REFRESH_SECONDS`, `layout`, `RANGE_LABEL`, `WINDOW_LABEL`, `rangeControl` (123–309).
    - `SESSION_HOURS`, `loginPage` (310–343).
    - `errorPage` (1463–1470).
  - `overview-views.ts`: `delta`, `incidentTable` (exported; `listPage` uses it), `tokenUsage`, `overviewPage` (501–800).
  - `incident-views.ts`:
    - `listPage`, `verdictCell`, `detailPage`, `postmortemPage` (882–1274);
    - `usageSection`, `timelineSection` (1284–1338), which only `detailPage` calls.
  - `harness-views.ts`: `NUDGE_FATES`, `isFate` (1275–1283), `harnessPage`, `harnessGatePage` (1339–1462).
  - `agent-views.ts`:
    - `nodeRows`, `backendRows`, `capabilityRows` (1471–1577);
    - `topoFrame`, `topologyPage` (1596–1687);
    - `skillRows`, `skillHref`, `promptPage`, `skillPage`, `budgetRows`, `contextPage` (1688–1862).
  - `bench-views.ts`: 1863–2169, from `// ---- Benchmark` through `benchPage`.
  - `cluster-views.ts`: `managed` (2170–2183), `clusterFrame`, `clusterPage` (2184–2274), and the `ClusterInventory` type re-export that `server.ts` imports from `views.ts` today.
- Modify:
  - `views.ts` becomes a barrel. It keeps a 3-line header comment and has one `export * from "./<module>.js";` per module above.
  - `memory-views.ts` imports `ICON`, `empty`, `pager` and `section` from `./parts.js`, and `layout` from `./layout.js`.
  - `src/dashboard/CLAUDE.md` gets one bullet naming the page-module layout.
- Test: `src/dashboard/views-split.test.ts`.

**Interfaces:**
- Produces: every name `views.ts` exports today, still exported from `views.ts`. `parts.ts` and `layout.ts` are what page modules import. The dependency order is `parts` ← `layout` ← page modules ← `views.ts`, and nothing points back up.

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as views from "./views.js";

// 2026-10-21 split: views.ts is a barrel over one module per page. server.ts and views.test.ts
// import from it, so it must keep exporting every page; and no page module may import it back,
// or ESM evaluates a half-initialised cycle.
const PAGES = ["layout", "loginPage", "errorPage", "overviewPage", "listPage", "detailPage", "postmortemPage",
  "harnessPage", "harnessGatePage", "topologyPage", "promptPage", "skillPage", "contextPage", "benchPage",
  "clusterPage", "pager", "pageWindow", "section", "empty", "ICON", "REFRESH_SECONDS"];

test("the views barrel still exports every page and shared part", () => {
  for (const name of PAGES) assert.ok(name in views, name);
});

test("no dashboard module imports the views barrel back", () => {
  const dir = new URL("./", import.meta.url);
  // server.ts is the barrel's consumer, not a page module — it keeps importing views.js.
  const own = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "views.ts" && f !== "server.ts";
  for (const f of readdirSync(dir).filter(own)) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /from "\.\/views\.js"/, f);
  }
});

test("views.ts holds no page bodies any more", () => {
  const src = readFileSync(new URL("./views.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /export function /);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/dashboard/views-split.test.ts`. Expected: test 1 PASS, test 2 FAIL (`memory-views.ts` imports `./views.js`), test 3 FAIL.
- [ ] **Step 3: Move.**
  - Move the ranges above verbatim. Each module gets only the imports it uses.
  - A helper that was file-private and is now needed by another module gets `export` added, and nothing else changes.
  - `npx tsc --noEmit` must be clean. A "Cannot find name" error is a helper whose module you mis-assigned: import it from the module that owns it. Do not duplicate it.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/dashboard/views-split.test.ts`. Expected: 3/3 PASS.
  - `npm test`. Expected: all pass, including `views.test.ts`, `memory-views.test.ts` and `server.test.ts`.
  - `npx tsx page-snapshot.tmp.ts .superpowers/sdd/2026-10-21-split-large-files/pages-after`, then `diff -r` it against `pages-base`. Expected: **no diff**. Any diff is a finding, not noise: two BASE runs agreed in Task 0.
  - `wc -l src/dashboard/{parts,layout,*-views}.ts`. Expected: every file ≤ ~500.
- [ ] **Step 5: Commit.** `refactor(dashboard): views.ts into one module per page, views.ts kept as the barrel`

### Task 3: Loop state and the answer finalizer out of `runInvestigation`

**Files:**
- Create:
  - `src/agent/loop/run-state.ts`:
    - `InvestigateOptions` and `RunMeta` move here verbatim (today in `agent/index.ts` 85–133), with their doc comments;
    - `zeroUsage`, `addUsage` (135–147);
    - the new `RunState`, `RunCtx` and `newRunState`.
  - `src/agent/loop/finalize.ts`: `finalizeAnswer`, which is the body of today's `done` closure (`agent/index.ts` 602–678).
- Modify: `src/agent/index.ts`.
  - Add `export * from "./loop/run-state.js";`.
  - Delete the moved declarations.
  - Inside `runInvestigation`, replace the `let` loop variables with one `const s = newRunState(…)`, then rewrite every read and write to `s.<name>` (see Step 3).
- Test: `src/agent/loop/finalize.test.ts`.

**Interfaces:**
- Produces:

```ts
export interface RunState {
  iterations: number;
  toolRounds: number;
  totalToolCalls: number;
  toolsDisabled: boolean;
  scopeNamespaces: Set<string> | null;
  sawLogLines: boolean;
  logGapNudged: boolean;
  imageGapNudged: boolean;
  noEvidenceNudged: boolean;
  rcaGapNudged: boolean;
  heldBy: "tools" | "rca" | null;
  preNudgeSummary: string;
  toolRoundsAtNudge: number;
  totalUsage: TokenUsage;
  lastResponse: LLMResponse | undefined;
  skills: ReturnType<typeof selectForThread>;
}
export interface RunCtx {
  threadId: string;
  mode: RunMode;
  depth: number;
  maxToolRounds: number;
  maxIterations: number;
  deadline: number;
  startedAt: number;
  tools: ToolDefinition[];
  systemPrompt: string;
  opts: InvestigateOptions;
}
/** Every counter 0, every flag false, heldBy null, preNudgeSummary "", toolRoundsAtNudge -1, totalUsage zeroUsage(), lastResponse undefined. */
export function newRunState(skills: RunState["skills"]): RunState;
export function finalizeAnswer(ctx: RunCtx, s: RunState, trace: TraceRecorder, text: string): string;
```

  - The comment on each `RunState` field is the comment its `let` carried today. Move them with the fields.
  - `RunMode` comes from `./control.js`.

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { newRunState, type RunCtx } from "./run-state.js";
import { finalizeAnswer } from "./finalize.js";
import { TraceRecorder } from "../trace/index.js";

const ctx = (onComplete: RunCtx["opts"]["onComplete"]): RunCtx => ({
  threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 1000, startedAt: Date.now() - 5, tools: [], systemPrompt: "", opts: { onComplete },
});
const recorder = () => new TraceRecorder(null, { source: "prod", sha: "t" });

// done() read the loop's counters when it was CALLED. The state object must keep that: a copy
// taken before the last round would report the footer one round short.
test("finalizeAnswer reports the state as it is when called, not when the run began", () => {
  const s = newRunState([]);
  let meta: { rounds: number; toolCalls: number } | undefined;
  const c = ctx((m) => (meta = m));
  s.iterations = 3;
  s.totalToolCalls = 7;
  finalizeAnswer(c, s, recorder(), "plain answer");
  assert.deepEqual({ rounds: meta!.rounds, toolCalls: meta!.toolCalls }, { rounds: 3, toolCalls: 7 });
});

test("finalizeAnswer strips the [OFFER] line, as done() did", () => {
  const out = finalizeAnswer(ctx(undefined), newRunState([]), recorder(),
    "Restart it.\n[OFFER] restart `sample-apps/Deployment/api`");
  assert.doesNotMatch(out, /\[OFFER\]/);
});
```

  - Check `TraceRecorder`'s constructor arguments against `agent/index.ts:193`, and copy that call's shape.
  - Read `stripOffer`'s tests (`remediation/proposal.test.ts`) for an `[OFFER]` line it strips, and use that exact form.

- [ ] **Step 2: Run it.** `npx tsx --test src/agent/loop/finalize.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move and rewrite.**
  - Move the declarations listed under Files.
  - In `runInvestigation`, delete the `let` declarations for every `RunState` field (lines 520–535, 587–591, 679, and `let skills` at 575). Build `const s = newRunState(selectForThread(…))` where `skills` was first assigned. Build `const ctx: RunCtx = {…}` right after `deadline` is computed.
  - Then let `npx tsc --noEmit` list every bare use that is now undeclared, and rewrite each one to `s.<name>`.
  - Shorthand properties need the long form (`{ toolRounds }` → `{ toolRounds: s.toolRounds }`), for example in `forcedFinalAnswer({…})` and `logGapAction({…})`.
  - Replace the `done` closure with `const done = (text: string): string => finalizeAnswer(ctx, s, this.trace, text);`.
  - Imports that only `done` used (`capConfidence`, `admitsLogGap`, `parseConfidence`, `stripTemplateEcho`, `stripFabricatedNote`, `stripMutatingCommands`, `stripOffer`) move to `finalize.ts`. Remove them from `index.ts` only if nothing else there uses them.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/loop/finalize.test.ts`. Expected: 2/2 PASS.
  - `npm test`. Expected: all pass, in particular `final-answer.test.ts`, `trace/gates.test.ts`, `trace/wiring.test.ts` and `replay/run.test.ts`. Replay plays recorded runs through this loop, so a moved gate shows up there as `diverged`.
- [ ] **Step 5: Commit.** `refactor(agent): loop state object and the answer finalizer out of runInvestigation`

### Task 4: The answer gates → `loop/answer-gates.ts`

**Files:**
- Create: `src/agent/loop/answer-gates.ts`.
- Modify: `src/agent/index.ts`. The body of `if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") { … }` (today 794–929) becomes one call.
- Test: `src/agent/loop/answer-gates.test.ts`.

**Interfaces:**
- Consumes: `RunState`, `RunCtx` (Task 3).
- Produces:

```ts
export interface GateHost { readonly memory: ConversationMemory; trace(): TraceRecorder; }
/** The answer to finalise, or null when a gate appended its notice and the loop must take another round. */
export async function settleAnswer(h: GateHost, ctx: RunCtx, s: RunState, response: LLMResponse): Promise<string | null>;
```

The call site in the loop:

```ts
if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
  const answer = await settleAnswer({ memory: this.memory, trace: () => this.trace }, ctx, s, response);
  if (answer === null) continue;
  return done(answer);
}
```

  - Inside the moved body, `return done(x)` becomes `return x`, and `continue` becomes `return null`.
  - `this.memory` becomes `h.memory`, and `this.trace` becomes `h.trace()`.
  - `toolsDisabled ? [] : tools` reads `s.toolsDisabled ? [] : ctx.tools`.

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { settleAnswer } from "./answer-gates.js";
import { newRunState, type RunCtx } from "./run-state.js";
import { NO_EVIDENCE_NOTICE } from "./control.js";
import { TraceRecorder } from "../trace/index.js";

const ctx: RunCtx = { threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 60_000, startedAt: Date.now(), tools: [], systemPrompt: "", opts: {} };
const host = (appended: unknown[]) => ({
  memory: { append: async (_t: string, m: unknown) => void appended.push(m), get: async () => [] } as never,
  trace: () => new TraceRecorder(null, { source: "prod", sha: "t" }),
});
const reply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" }) as never;

test("an alert answered with zero tool calls is nudged once: null, and the notice is appended", async () => {
  const appended: unknown[] = [];
  const s = newRunState([]);
  s.iterations = 1;
  assert.equal(await settleAnswer(host(appended), ctx, s, reply("All fine.")), null);
  assert.equal(s.noEvidenceNudged, true);
  assert.deepEqual(appended, [{ role: "user", content: NO_EVIDENCE_NOTICE }]);
});

test("an empty final response is never returned empty", async () => {
  const s = newRunState([]);
  s.toolRounds = 1;
  const out = await settleAnswer(host([]), ctx, s, reply(""));
  assert.match(out!, /empty response/);
});
```

Before running, check `needsEvidence`'s rule in `control.ts`. If an alert with `iterations: 1` and `toolRounds: 0` does not nudge, change the state to match its rule, not the assertion.
- [ ] **Step 2: Run it.** `npx tsx --test src/agent/loop/answer-gates.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move** the body as described. Imports that only the gates used move with it, as in Task 3.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/loop/answer-gates.test.ts`. Expected: 2/2 PASS.
  - `npm test`. Expected: all pass, including the log-gap, image-gap, rca-completeness, nudge-lost-rca and replay tests.
- [ ] **Step 5: Commit.** `refactor(agent): the answer gates out of runInvestigation into loop/answer-gates.ts`

### Task 5: `InvestigationRunner` — the rest of the loop leaves `DevOpsAgent`

**Files:**
- Create: `src/agent/loop/runner.ts`.
- Modify: `src/agent/index.ts`. Delete `runInvestigation`, `runDelegates`, `executeToolCalls`, `rehydrateThreadSkills`, `persistThreadSkills` and the `toolMemo` field. `investigate()` calls the runner.
- Test: `src/agent/loop/runner.test.ts`.

**What moves, verbatim:**
- `runInvestigation` becomes `run`.
- The `tool_use` branch of its loop (today 932–1062) becomes `private async toolRound(ctx: RunCtx, s: RunState, response: LLMResponse): Promise<void>`. Its `continue` becomes `return`.
- `runDelegates`, `executeToolCalls`, `rehydrateThreadSkills`, `persistThreadSkills`, and the `toolMemo` field with its comment.

**What changes inside them:**
- `this.mcp`, `this.llm`, `this.memory`, `this.skills` and `this.threadSkills` become `this.host.<x>`.
- `this.trace` becomes `this.host.trace()`, and `this.budget` becomes `this.host.budget()`.
- `this.recordUsage(…)` becomes `this.host.recordUsage(…)`.
- `this.investigate(sub, …)` in `runDelegates` becomes `this.host.investigate(sub, …)`. **Never `this.run`** (Review Focus 2).

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces:

```ts
export interface RunnerHost {
  readonly mcp: McpTools;
  readonly llm: LLMClient;
  readonly memory: ConversationMemory;
  readonly skills: SkillRegistry;
  readonly threadSkills: ThreadSkills;
  trace(): TraceRecorder;
  budget(): Budget;
  investigate(threadId: string, userMessage: string, opts?: InvestigateOptions): Promise<string>;
  recordUsage(threadTs: string | null, response: LLMResponse): void;
}
export class InvestigationRunner {
  constructor(private readonly host: RunnerHost) {}
  run(threadId: string, userMessage: string, opts?: InvestigateOptions): Promise<string>;
}
```

`DevOpsAgent` gains `private readonly runner: InvestigationRunner`. It is built in the constructor next to the `Remediator`, with getters (`get memory() { return self.memory; }`, `trace: () => self.trace`, `budget: () => self.budget`, `investigate: (t, m, o) => self.investigate(t, m, o)`, `recordUsage: (t, r) => self.recordUsage(t, r)`). `investigate()` becomes:

```ts
return withTrace(threadId, () =>
  this.runner.run(threadId, userMessage, opts).finally(() => this.trace.finish(threadId))
);
```

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InvestigationRunner } from "./runner.js";
import { DevOpsAgent } from "../index.js";

const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

test("investigate() reaches the runner", async () => {
  const agent = new DevOpsAgent({ mcp });
  const runner = (agent as any).runner;
  assert.ok(runner instanceof InvestigationRunner);
  let seen: string | null = null;
  runner.run = async (t: string) => { seen = t; return "ok"; };
  assert.equal(await agent.investigate("1.1", "q"), "ok");
  assert.equal(seen, "1.1");
});

// A delegate run that skipped investigate() would carry the parent's traceId and never be written.
test("a delegate goes through the host's investigate(), not the runner's own run()", async () => {
  const calls: string[] = [];
  const host = { investigate: async (t: string) => { calls.push(t); return "CONFIRMED — x"; },
    memory: { clear: async () => {} }, threadSkills: new Map(), trace: () => ({ gate: () => {} }) } as any;
  const r = new InvestigationRunner(host) as any;
  r.run = async () => { throw new Error("delegate must not call run() directly"); };
  const out = await r.runDelegates("1.1", [{ type: "tool_use", id: "d1", name: "delegate_investigation", input: { hypothesis: "h" } }], Date.now() + 600_000);
  assert.equal(calls.length, 1);
  assert.match(String(out.results[0].content), /CONFIRMED/);
});

test("agent/index.ts no longer holds the loop", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /private async (runInvestigation|runDelegates|executeToolCalls)\(/);
});
```

Check `hypothesisOf` (`subagent/index.ts`) for the input field name, and `childDeadline` for how much time the deadline must leave. Set the test's deadline so the delegate is not refused for time.
- [ ] **Step 2: Run it.** `npx tsx --test src/agent/loop/runner.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move** as listed. `npx tsc --noEmit` must be clean. A leftover `this.<x>` is a host member you missed: add it to `RunnerHost`, never cast it away.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/loop/runner.test.ts`. Expected: 3/3 PASS.
  - `npm test`. Expected: all pass, in particular `final-answer.test.ts`, the subagent tests, `trace/*.test.ts`, `replay/run.test.ts` and `skills/*`.
  - `wc -l src/agent/loop/runner.ts`. Expected: ≤ ~550.
- [ ] **Step 5: Commit.** `refactor(agent): the investigation loop into loop/runner.ts (InvestigationRunner)`

### Task 6: Incident lifecycle → `incidents/lifecycle.ts`

**Files:**
- Create: `src/agent/incidents/lifecycle.ts`.
- Modify:
  - `src/agent/index.ts`: `export * from "./incidents/lifecycle.js";`, plus delegators.
  - `src/agent/feedback/learn-flow.test.ts`: migrate it, see Step 3.
- Test: `src/agent/incidents/lifecycle.test.ts`.

**What moves, verbatim:**
- `ReconciledIncident` (62–70) and `fallbackLabels` (72–78), with their comments.
- `runIncidentReconcile`, `setIncidentStatus` and `learnFromThread`, with their doc comments.
- Inside them, `this.incidents`, `this.mcp` and `this.llm` become `this.host.<x>`, and `this.recordUsage` becomes `this.host.recordUsage`.

**Interfaces:**
- Produces:

```ts
export interface LifecycleHost {
  readonly incidents: IncidentMemory;
  readonly mcp: McpTools;
  readonly llm: LLMClient;
  recordUsage(threadTs: string | null, response: LLMResponse): void;
}
export class IncidentLifecycle { constructor(private readonly host: LifecycleHost) {} /* the three methods */ }
```

  - `DevOpsAgent` builds `private readonly lifecycle` with getters, like the `Remediator`.
  - It keeps one-line delegators with today's signatures, such as `runIncidentReconcile(...a: Parameters<IncidentLifecycle["runIncidentReconcile"]>): ReturnType<IncidentLifecycle["runIncidentReconcile"]> { return this.lifecycle.runIncidentReconcile(...a); }`, and the same for the other two.

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { IncidentLifecycle } from "./lifecycle.js";
import { DevOpsAgent } from "../index.js";

const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

// Same guard as remediator.test.ts (8c60b0a): a real agent, every target stubbed, so a delegator
// that calls itself overflows here instead of in production.
test("every DevOpsAgent delegator reaches the IncidentLifecycle, not itself", async () => {
  const agent = new DevOpsAgent({ mcp });
  const l = (agent as any).lifecycle;
  assert.ok(l instanceof IncidentLifecycle);
  const reached: string[] = [];
  for (const name of Object.getOwnPropertyNames(IncidentLifecycle.prototype)) {
    if (name === "constructor") continue;
    l[name] = async () => { reached.push(name); return null; };
    await (agent as any)[name]();
  }
  assert.deepEqual(reached.sort(), ["learnFromThread", "runIncidentReconcile", "setIncidentStatus"]);
});

test("the host is read live: an incident store swapped after construction is the one used", async () => {
  const agent = new DevOpsAgent({ mcp });
  (agent as any).incidents = { findIncidentByThread: async () => null };
  assert.match(await agent.learnFromThread("C", "1.1", "U", "2.2", "t", "h"), /isn't linked/);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/agent/incidents/lifecycle.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move**, then migrate `learn-flow.test.ts`:
  - `(DevOpsAgent.prototype as any).learnFromThread.call(self, …)` becomes `IncidentLifecycle.prototype.learnFromThread.call(viaHost(self), …)`.
  - Define `viaHost` at the top of that file, like in `remediation/rollback-gate.test.ts`: `(f: object) => Object.assign(Object.create(IncidentLifecycle.prototype), f, { host: f })`.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/agent/incidents/lifecycle.test.ts src/agent/feedback/learn-flow.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
  - `wc -l src/agent/index.ts`. Expected: ≤ ~600, down from 1640. It still holds the constructor, `initialize`, the postmortem, timeline and recall methods, and the delegators.
- [ ] **Step 5: Commit.** `refactor(agent): incident lifecycle (reconcile, status, learn) into incidents/lifecycle.ts`

### Task 7: `app/queue.ts`, `app/host.ts`, and the wiring guard

**Files:**
- Create:
  - `src/app/queue.ts`:
    - `Semaphore` (98–120), now exported;
    - `ThreadQueue` (122–159), `InFlightWork` (161–188), with their doc comments;
    - `Accepted` (190), exported;
    - `RESTART_NOTICE` (192–197), exported.
  - `src/app/host.ts`: the `SlackHost` interface every flow reads, and `UnstoredAlert`, the value type of `unstored`, moved from its inline Map type at 217–220.
- Modify: `src/app/index.ts`.
  - `export { ThreadQueue, InFlightWork } from "./queue.js";`; delete the moved code.
  - Add `private wire(): void`, called in the constructor right after `this.agent = agent`.
- Test: `src/app/wiring.test.ts` (grows in Tasks 8–11).

**Interfaces:**
- Produces, in `host.ts`. The two commented members are added by the task named, not now.

```ts
export type UnstoredAlert = { key: string; resolved?: AlertItem[]; channel?: string; namespace?: string; subjects?: string[]; startedAt?: number; alertname?: string };
/** The one object SlackApp hands every flow. Every member is read LIVE (getters), like RemediatorHost. */
export interface SlackHost {
  readonly agent: DevOpsAgent;
  readonly app: App;
  readonly dedup: AlertDeduplicator;
  readonly semaphore: Semaphore;
  readonly threadQueue: ThreadQueue;
  readonly inFlight: InFlightWork<Accepted>;
  readonly unstored: Map<string, UnstoredAlert>;
  readonly tourThreads: Set<string>;
  readonly stopping: boolean;
  verifyTimer: NodeJS.Timeout | null;
  mayUseAgent(user: string | undefined): boolean;
  postRca(channel: string, threadId: string, rca: string, blocks: Block[]): Promise<void>;
  conversationReply(reply: string, threadId: string, reformat: boolean): Promise<string>;
  warnIfUngrounded(channel: string, threadId: string, answer: string, trigger?: string): Promise<void>;
  notifyIfLowConfidence(channel: string, threadId: string, rca: string): Promise<void>;
  // Task 8 adds: handleLearn, handlePostmortem, handleStatusCommand (typed ThreadCommands[…])
  // Task 9 adds: maybeProposeRemediation (typed RemediationFlow["maybeProposeRemediation"])
}
```

`wire()` builds **one** object literal: getters for every state member, a get/set pair for `verifyTimer` onto `self.verifyTimer`, and arrow functions for every method (`postRca: (...a) => self.postRca(...a)`). Store it as `private host!: SlackHost`. **Never spread it**: a spread evaluates the getters once and freezes the values.

- [ ] **Step 1: Write the failing test.**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";

// 2026-10-21: every flow reads SlackApp through one host object. A host function that calls itself
// (8c60b0a was exactly that, in DevOpsAgent) overflows here, on a real SlackApp prototype with
// the targets stubbed, rather than on the first Slack event.
const wired = () => {
  const s = Object.assign(Object.create(SlackApp.prototype), {
    agent: { a: 1 }, app: { b: 1 }, verifyTimer: null, stopping: false,
    unstored: new Map(), tourThreads: new Set(),
  });
  (s as any).wire();
  return s as any;
};

test("the host reads SlackApp live, and verifyTimer writes through", () => {
  const s = wired();
  const other = { a: 2 };
  s.agent = other;
  assert.equal(s.host.agent, other);
  const t = setTimeout(() => {}, 0);
  clearTimeout(t);
  s.host.verifyTimer = t;
  assert.equal(s.verifyTimer, t);
});

test("each shared host method reaches SlackApp's own method", async () => {
  const s = wired();
  const reached: string[] = [];
  for (const m of ["postRca", "conversationReply", "warnIfUngrounded", "notifyIfLowConfidence", "mayUseAgent"]) {
    s[m] = async () => { reached.push(m); return ""; };
    await s.host[m]();
  }
  assert.equal(reached.length, 5);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/app/wiring.test.ts`. Expected: FAIL, `wire` is not a function.
- [ ] **Step 3: Implement** `queue.ts` (a verbatim move), `host.ts`, and `wire()`. The four shared methods and `mayUseAgent` stay `private` on `SlackApp`. The arrow functions inside `wire()` sit in the class body, so they may call them.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/wiring.test.ts src/app/thread-queue.test.ts src/app/in-flight.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(app): queue primitives into app/queue.ts; one live SlackHost for the flows`

### Task 8: `ThreadCommands` → `app/commands.ts`

**Files:**
- Create: `src/app/commands.ts`.
- Modify:
  - `src/app/index.ts`;
  - `src/app/host.ts`: add the three command members;
  - `src/app/allowlist.test.ts` and `src/app/postmortem.test.ts`: migrate, see Step 3.
- Test: extend `src/app/wiring.test.ts`.

**What moves, verbatim:**
- `handleLearn`, `handlePostmortem`, `handleStatusCommand`, `handleLearnByReaction` (today 696–901). They become public methods: drop `private`.
- `POSTMORTEM_REPLY_PAGES` and `fetchThreadReplies` (65–85). `index.ts` re-exports `fetchThreadReplies`.
- Inside, `this.agent`, `this.app`, `this.dedup`, `this.inFlight` and `this.threadQueue` become `this.host.<x>`, and `this.mayUseAgent` becomes `this.host.mayUseAgent`. Calls between these four methods stay `this.<method>`.

**Interfaces:**
- Produces:
  - `export class ThreadCommands { constructor(private readonly host: SlackHost) {} … }`.
  - `SlackHost` gains `handleLearn: ThreadCommands["handleLearn"]; handlePostmortem: ThreadCommands["handlePostmortem"]; handleStatusCommand: ThreadCommands["handleStatusCommand"];`, via `import type`.
  - `SlackApp` gains `private commands!: ThreadCommands`, built in `wire()` after the host.
  - In what is left of `index.ts`, `this.handleLearn(` becomes `this.commands.handleLearn(`, and likewise for the other three. That covers `handleMention` and the `reaction_added` handler. The host arrows are `handleLearn: (...a) => self.commands.handleLearn(...a)`.

- [ ] **Step 1: Extend the wiring test.**

```ts
import { ThreadCommands } from "./commands.js";

test("the command host functions reach ThreadCommands, not themselves", async () => {
  const s = wired();
  assert.ok(s.commands instanceof ThreadCommands);
  const reached: string[] = [];
  for (const m of ["handleLearn", "handlePostmortem", "handleStatusCommand"]) {
    s.commands[m] = async () => void reached.push(m);
    await s.host[m]();
  }
  assert.deepEqual(reached, ["handleLearn", "handlePostmortem", "handleStatusCommand"]);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/app/wiring.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move**, then migrate the two tests.
  - `(SlackApp.prototype as any).handlePostmortem.call(self, …)` and `proto.handleLearnByReaction.call(self, …)` become `ThreadCommands.prototype.<m>.call(viaHost(self), …)`.
  - `viaHost` is `(f: object) => Object.assign(Object.create(ThreadCommands.prototype), f, { host: f })`.
  - `allowlist.test.ts` also drives `handleMention`. Leave that call on `SlackApp.prototype` until Task 11.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/wiring.test.ts src/app/allowlist.test.ts src/app/postmortem.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(app): learn/postmortem/status commands into app/commands.ts (ThreadCommands)`

### Task 9: `RemediationFlow` → `app/remediation.ts`

**Files:**
- Create: `src/app/remediation.ts`.
- Modify:
  - `src/app/index.ts`;
  - `src/app/host.ts`: add `maybeProposeRemediation`;
  - `src/app/remediation-post.test.ts`: migrate it.
- Test: extend `src/app/wiring.test.ts`.

**What moves, verbatim:**
- `maybeProposeRemediation`, `handleRemediationAction`, `startVerificationPoller`, `armVerificationPoller` (1355–1596). They become public.
- Inside, `this.agent`, `this.app`, `this.dedup`, `this.stopping` and `this.verifyTimer` become `this.host.<x>`. The `verifyTimer` assignment goes through the host setter. Calls between these methods stay `this.<method>`.

**Interfaces:**
- Produces:
  - `export class RemediationFlow { constructor(private readonly host: SlackHost) {} … }`.
  - `SlackHost` gains `maybeProposeRemediation: RemediationFlow["maybeProposeRemediation"]`.
  - `SlackApp` gains `private remediation!: RemediationFlow`. Rewrite the remaining callers:
    - the two `app.action` handlers call `this.remediation.handleRemediationAction`;
    - `start()` calls `this.remediation.startVerificationPoller()`;
    - `proposeAfterMention` and `investigateAlertInBackground` call `this.host.maybeProposeRemediation`. They are still in `index.ts` until Tasks 10–11.

- [ ] **Step 1: Extend the wiring test.**

```ts
import { RemediationFlow } from "./remediation.js";

test("maybeProposeRemediation on the host reaches RemediationFlow", async () => {
  const s = wired();
  assert.ok(s.remediation instanceof RemediationFlow);
  let reached = 0;
  s.remediation.maybeProposeRemediation = async () => void reached++;
  await s.host.maybeProposeRemediation();
  assert.equal(reached, 1);
});

test("the poller's timer is SlackApp's own field, so stop() can clear it", () => {
  const s = wired();
  const t = setTimeout(() => {}, 0);
  clearTimeout(t);
  (s.remediation as any).host.verifyTimer = t;
  assert.equal(s.verifyTimer, t);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/app/wiring.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move**, then migrate `remediation-post.test.ts`: `(SlackApp.prototype as any).maybeProposeRemediation.call(self, …)` becomes `RemediationFlow.prototype.maybeProposeRemediation.call(viaHost(self), …)`, with `viaHost` as in Task 8 but over `RemediationFlow.prototype`.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/wiring.test.ts src/app/remediation-post.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(app): approval buttons, proposals and the verification poller into app/remediation.ts`

### Task 10: `AlertFlow` → `app/alerts.ts`

**Files:**
- Create: `src/app/alerts.ts`.
- Modify:
  - `src/app/index.ts`;
  - `src/app/correlation.test.ts` and `src/app/resolved-early.test.ts`: migrate.
- Test: extend `src/app/wiring.test.ts`.

**What moves, verbatim:**
- `correlate`, `handleAlert`, `handleResolvedAlert`, `postResolved`, `closeIfResolvedEarly`, `investigateAlertInBackground` (929–1354). They become public.
- `incidentKey` (199–200) and `frameChangeTimeline` (46–63). `index.ts` re-exports `frameChangeTimeline`; `change-timeline-guard.test.ts` imports it from there.
- `interface AlertmanagerPayload` (1693–end), now exported. `index.ts` imports it as a type for `_mountAlertRoute`.
- Inside:
  - `this.agent`, `this.app`, `this.dedup`, `this.semaphore`, `this.inFlight`, `this.threadQueue` and `this.unstored` become `this.host.<x>`.
  - `this.conversationReply`, `this.postRca`, `this.warnIfUngrounded`, `this.notifyIfLowConfidence` and `this.maybeProposeRemediation` become `this.host.<x>`.
  - Calls among the six moved methods stay `this.<method>`.

**Interfaces:**
- Produces:
  - `export class AlertFlow { constructor(private readonly host: SlackHost) {} … }`.
  - `SlackApp` gains `private alerts!: AlertFlow`.
  - `_mountAlertRoute` calls `this.alerts.handleAlert(payload)`.

- [ ] **Step 1: Extend the wiring test.**

```ts
import { readFileSync } from "node:fs";
import { AlertFlow } from "./alerts.js";

const FLOW_FILES = ["queue", "host", "commands", "remediation", "alerts"];

test("SlackApp builds an AlertFlow and no flow imports the app barrel as a value", () => {
  assert.ok(wired().alerts instanceof AlertFlow);
  for (const f of FLOW_FILES) {
    const src = readFileSync(new URL(`./${f}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /^import (?!type)[^\n]*from "\.\/index\.js"/m, f);
  }
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/app/wiring.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move**, then migrate the two tests.
  - `(SlackApp.prototype as any).<m>.call(self, …)` and `proto.<m>.call(self, …)` become `AlertFlow.prototype.<m>.call(viaHost(self), …)`, for `correlate`, `handleAlert`, `handleResolvedAlert` and `closeIfResolvedEarly`.
  - Lines that copy a method onto the fake, such as `self.postResolved = (SlackApp.prototype as any).postResolved`, take it from `AlertFlow.prototype` now.
  - `self.conversationReply = (SlackApp.prototype as any).conversationReply` stays: that method did not move.
  - `viaHost` is over `AlertFlow.prototype`.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/wiring.test.ts src/app/correlation.test.ts src/app/resolved-early.test.ts src/app/change-timeline-guard.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
  - `wc -l src/app/alerts.ts`. Expected: ≤ ~470.
- [ ] **Step 5: Commit.** `refactor(app): the alert path (dedup, correlation, background investigation, resolve) into app/alerts.ts`

### Task 11: `MentionFlow` → `app/mention.ts`

**Files:**
- Create: `src/app/mention.ts`.
- Modify:
  - `src/app/index.ts`;
  - `src/app/tour-post.test.ts` and `src/app/allowlist.test.ts`: migrate.
- Test: extend `src/app/wiring.test.ts`.

**What moves, verbatim:**
- `postTourTables`, `tourContext`, `postFlowTables`, `handleMention`, `progressNotifier`, `postConversation`, `proposeAfterMention` (341–658, minus `postRca` at 659, which stays). They become public.
- `PREVIOUS_TURN_CHARS` and `buildProposalContext` (31–44, 87–92). `index.ts` re-exports `buildProposalContext` for `bench/run.ts`.
- Inside:
  - `this.agent`, `this.semaphore`, `this.inFlight`, `this.threadQueue`, `this.tourThreads` and `this.mayUseAgent` become `this.host.<x>`.
  - The shared four become `this.host.<x>`.
  - `this.commands.<m>` (left by Task 8) becomes `this.host.<m>`, and `this.host.maybeProposeRemediation` stays.
  - Calls among the seven moved methods stay `this.<method>`.

**Interfaces:**
- Produces:
  - `export class MentionFlow { constructor(private readonly host: SlackHost) {} … }`.
  - `SlackApp` gains `private mentions!: MentionFlow`.
  - The `app_mention` handler calls `this.mentions.handleMention(…)`.
  - What remains in `index.ts`:
    - imports and re-exports;
    - `UNGROUNDED_SHOWN`;
    - the class with its fields, constructor, `wire`, `_mountAlertRoute`, `_authorizeAlert` and `mayUseAgent`;
    - the four shared posting methods;
    - `start`, `drain`, `stop`.

- [ ] **Step 1: Extend the wiring test.** Add `"mention"` to `FLOW_FILES`, and:

```ts
import { MentionFlow } from "./mention.js";

test("the mention flow is built, and the barrel holds only wiring and the shared posts", () => {
  assert.ok(wired().mentions instanceof MentionFlow);
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /private async (handleMention|handleAlert|correlate|handleLearn|maybeProposeRemediation)\(/);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test src/app/wiring.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move**, then migrate the two tests.
  - Every `(SlackApp.prototype as any).<m>.call(…)` for the seven moved methods becomes `MentionFlow.prototype.<m>.call(viaHost(self), …)`. That includes `allowlist.test.ts`'s `handleMention`.
  - `postFlowTables.call({}, …)` becomes `.call(viaHost({}), …)`.
  - `tour-post.test.ts:127` builds `Object.assign(Object.create(SlackApp.prototype), {…})` for `postConversation`. Build it with `viaHost({...the same fields})` over `MentionFlow.prototype` instead.
- [ ] **Step 4: Run.**
  - `npx tsx --test src/app/*.test.ts`. Expected: all pass.
  - `npm test`. Expected: all pass.
  - `wc -l src/app/*.ts | grep -v test`. Expected: `index.ts` ≤ ~420, and every flow ≤ ~470.
- [ ] **Step 5: Commit.** `refactor(app): the mention path (tour, conversation, proposal) into app/mention.ts`

### Task 12: Docs, deploy, and prove nothing changed (controller)

**Files:**
- Modify: `docs/DEVELOPMENT.md` (the source tree), `CLAUDE.md`, `MEMORY_BANK.md` and `src/dashboard/CLAUDE.md`, wherever they name a moved function's file.

- [ ] **Step 1: Docs.**
  - Run `grep -n "app/index.ts\|agent/index.ts\|views.ts\|styles.ts" CLAUDE.md MEMORY_BANK.md docs/*.md src/dashboard/CLAUDE.md`.
  - Where a line names a function that moved, point it at the new file. For example: `forcedFinalAnswer()` is in `loop/control.ts`; `closeIfResolvedEarly` is in `app/alerts.ts`; the line-numbered `app/index.ts:384` reference becomes `app/alerts.ts` (`investigateAlertInBackground`).
  - In `DEVELOPMENT.md`'s tree, add the new files, one line each with their role, in the tree's style.
  - Commit: `docs: point at the split files`.
- [ ] **Step 2: Whole suite and build.**
  - `npm run build` and `npm test`. Expected: build clean; the test count is 1597 plus this plan's new tests, all passing.
  - `wc -l src/agent/index.ts src/agent/loop/*.ts src/app/*.ts src/dashboard/{views,parts,layout,*-views}.ts src/dashboard/styles.ts src/dashboard/styles/*.ts | grep -v test`. Paste the table in the final message.
- [ ] **Step 3: Page equivalence.** Run `page-snapshot.tmp.ts` into `pages-final` and `diff -r` it against `pages-base`. Expected: no diff.
- [ ] **Step 4: Push and deploy.**
  - `git push origin main`.
  - Wait for the Build & Push run of the new sha, then `kubectl -n devops-tools rollout restart deploy/devops-ai-agent`.
  - Check `kubectl -n devops-tools exec deploy/devops-ai-agent -- printenv GIT_SHA`. Expected: the pushed sha.
  - The boot log shows `Discovered 63 MCP tools` and `Redis connected`. `/health` returns 200.
- [ ] **Step 5: Live check.**
  - Run `~/.render-check` Playwright against the live dashboard: every rail page returns 200, there are no console errors, and there is no horizontal overflow at 1280, 900 and 390 px.
  - Ask the user to send one mention in Slack, and read the agent log for that thread: `Investigation started` … `Investigation complete`, and a reply posted.
  - Do not trigger an alert. The next real one proves the alert path; say so in the final message.
- [ ] **Step 6: Clean up.** Delete `page-snapshot.tmp.ts` and the plan's `.superpowers/sdd/2026-10-21-split-large-files/` workspace.
