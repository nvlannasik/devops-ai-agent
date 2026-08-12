# Context Assembly and Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace count-based context trimming with a token-budgeted assembler, and move the twelve failure-mode playbooks plus the RCA output format out of the always-sent system prompt into selectable skill files, surfaced read-only on a new `/context` dashboard page.

**Architecture:** Three new modules with one job each — `skills/` turns a directory of Markdown files into a registry and a trigger string into a list of skills, `context/budget.ts` turns text into token counts and a too-large request into a smaller one, `context/index.ts` composes them into the message array. Skills ride in the request's **first user message**, never in `systemPrompt`, because the Anthropic client caches the entire system prompt as one block. The dashboard renders the registry through the same structural-type seam `/topology` already uses.

**Tech Stack:** TypeScript ESM (NodeNext), Node 24, `node:test` + tsx, zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-12-context-and-skills-design.md`

## Global Constraints

- **Zero new npm dependencies.** No YAML parser — frontmatter is hand-parsed flat `key: value`.
- **Node 24 required.** The default shell node is v14. Every command in this plan must run with `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH` first, and npm from the repo root: `npm --prefix /Users/annasik/riset/devops-ai-agent <cmd>`.
- **The SQS contract `{ requestId, messages, tools, systemPrompt, traceId? }` must not change.** No edit to `llm-worker` is part of this plan.
- **`systemPrompt` must stay byte-identical to `buildStaticSystemPrompt()`** on every call. `src/agent/llm/claude.ts:26-32` wraps the whole string in one `cache_control: ephemeral` block; a varying system prompt is a full cache miss plus a write at 1.25×. Task 6 carries the regression test that enforces this.
- **`[WRITE]` tools never enter the agentic loop** (`src/agent/index.ts:189-192`). Nothing in this plan touches that filter.
- **The dashboard is read-only.** `/context` is GET-only and must NOT be added to `METHODS` in `src/dashboard/server.ts:49-54`.
- **Nothing rendered is trusted.** Every dashboard interpolation goes through `esc()`. Escape first, insert markup second.
- **Never `git add -A` or `git add .`** — name exact paths in every commit.
- **Do not push.** Commit locally only.
- Tests are `*.test.ts` beside the module, excluded from builds, run with `npm test`.

## Deviations from the spec

Five refinements found while reading the current code. Each is a deliberate change to the spec, not a misreading of it; the spec file is updated to match.

1. **`Tool` → `ToolDefinition`.** The spec's interface block names a type `Tool`; the real type in `src/agent/llm/types.ts:1` is `ToolDefinition`. Name it correctly everywhere.
2. **`select()` returns `{ selected, overflow }`, not `Skill[]`.** §9 requires logging the names dropped by the cap of 3. A pure module must return them rather than log them itself.
3. **The budget is the MINIMUM window across configured backends, resolved once at boot** — not per-backend at request time. The router picks a backend *after* the request is built, so the request must fit the smallest window it might land in. Failover is up-only (light → heavy), so the smallest backend is the usual first attempt anyway; the cost is that a Claude call is sometimes smaller than it needed to be.
4. **Skill keep-order is rank-then-size, with no name special-case.** The spec says "within `always` skills, `rca-format` drops last". Hardcoding that name in `budget.ts` couples the budget to one file. Implemented as: `always` outranks matched, then smaller body kept first. With one `always` skill the behaviour is identical; if a second is ever added the tie-break is size.
5. **The trigger string is passed in explicitly** as `opts.trigger`, defaulting to `userMessage`. `src/app/index.ts:411-413` prepends recalled prior incidents to the alert text, so matching on `userMessage` alone would let a *previous* incident's RCA select this investigation's playbook. The Alertmanager path passes the raw `issueText`.

---

## File Structure

**Create:**
- `src/agent/skills/frontmatter.ts` — text → `{ keys, body }`. Knows nothing about skills.
- `src/agent/skills/frontmatter.test.ts`
- `src/agent/skills/index.ts` — directory → `SkillRegistry`; trigger → selection. Owns validation.
- `src/agent/skills/index.test.ts`
- `src/agent/skills/fixtures/good/*.md`, `src/agent/skills/fixtures/bad-*/*.md` — parser fixtures.
- `src/agent/context/budget.ts` — token estimation, `fitToBudget`, `resolveBudget`.
- `src/agent/context/budget.test.ts`
- `src/agent/context/compact.ts` — `compactToolResult`.
- `src/agent/context/compact.test.ts`
- `src/dashboard/context.ts` — `buildContextView`, dashboard-local structural types.
- `src/dashboard/context.test.ts`
- `prompts/skills/*.md` — 13 skill files.

**Modify:**
- `src/agent/context/index.ts` — `assembleRequest` + `injectSkills`; `trimHistory`/`truncateToolResult` deleted, `trimToWindow` kept.
- `src/agent/context/index.test.ts` — existing tests for the deleted functions removed, new ones added.
- `src/agent/llm/registry.ts` — `BackendSpec.contextTokens`.
- `src/agent/index.ts` — registry + budget on the class, selection per message, `assembleRequest` in the loop, `skillsView()`.
- `prompts/system.md` — playbooks and RCA format removed.
- `src/dashboard/server.ts` — `context` route, handler, constructor param.
- `src/dashboard/views.ts` — `contextPage`, `ICON.context`, `NAV` entry.
- `src/dashboard/styles.ts` — `<pre>` wrapping inside a stacked cell.
- `src/dashboard/views.test.ts`, `src/dashboard/server.test.ts` — page and route tests.
- `index.ts` — pass the skills getter to `DashboardServer`.
- `CLAUDE.md`, `MEMORY_BANK.md`.

---

### Task 1: Frontmatter parser

**Files:**
- Create: `src/agent/skills/frontmatter.ts`
- Test: `src/agent/skills/frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseFrontmatter(text: string, file: string): { keys: Record<string, string>; body: string }`. Throws `Error` whose message starts with `file`.

- [ ] **Step 1: Write the failing test**

Create `src/agent/skills/frontmatter.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.js";

const doc = ["---", "name: oomkilled", "description: A killed container", "when: oomkill", "---", "", "line one", "", "line two"].join("\n");

test("parses a flat key: value block and keeps the body verbatim", () => {
  const { keys, body } = parseFrontmatter(doc, "oomkilled.md");
  assert.deepEqual(keys, { name: "oomkilled", description: "A killed container", when: "oomkill" });
  assert.equal(body, "line one\n\nline two");
});

// A value may contain colons — a regex alternation or a URL routinely does. Splitting on the
// LAST colon, or on every colon, silently truncates the pattern a skill matches on.
test("splits on the first colon only", () => {
  const { keys } = parseFrontmatter(["---", "when: 5xx|http: 500", "---", "b"].join("\n"), "f.md");
  assert.equal(keys.when, "5xx|http: 500");
});

test("CRLF line endings parse the same as LF", () => {
  const { keys, body } = parseFrontmatter(doc.replace(/\n/g, "\r\n"), "f.md");
  assert.equal(keys.name, "oomkilled");
  assert.equal(body, "line one\n\nline two");
});

// Only the FIRST closing --- ends the frontmatter. A playbook body is free to contain its own.
test("a --- inside the body stays in the body", () => {
  const { body } = parseFrontmatter(["---", "name: x", "---", "before", "---", "after"].join("\n"), "f.md");
  assert.equal(body, "before\n---\nafter");
});

test("rejects a file that does not open with ---", () => {
  assert.throws(() => parseFrontmatter("name: x\n", "f.md"), /f\.md: expected "---" on the first line/);
});

test("rejects unclosed frontmatter", () => {
  assert.throws(() => parseFrontmatter("---\nname: x\n", "f.md"), /f\.md: frontmatter is not closed/);
});

test("rejects a line with no colon", () => {
  assert.throws(() => parseFrontmatter(["---", "name x", "---", "b"].join("\n"), "f.md"), /f\.md: line 2 is not "key: value"/);
});

test("rejects a duplicate key", () => {
  assert.throws(() => parseFrontmatter(["---", "name: a", "name: b", "---", "b"].join("\n"), "f.md"), /f\.md: duplicate key "name"/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './frontmatter.js'`.

- [ ] **Step 3: Implement**

Create `src/agent/skills/frontmatter.ts`:

```ts
export interface Frontmatter {
  keys: Record<string, string>;
  body: string;
}

const DELIM = "---";

/**
 * Flat `key: value` frontmatter, hand-parsed because the repo has no YAML parser and one
 * un-nested block does not justify adding one. Deliberately unforgiving: every rejection here
 * is a file that would otherwise load as a silently different skill.
 *
 * `file` is only ever used to name the offender in the message — this parser reads nothing.
 */
export function parseFrontmatter(text: string, file: string): Frontmatter {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== DELIM) {
    throw new Error(`${file}: expected "---" on the first line`);
  }
  const end = lines.indexOf(DELIM, 1);
  if (end === -1) {
    throw new Error(`${file}: frontmatter is not closed by a "---" line`);
  }

  const keys: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // First colon, not last: a `when` pattern may legitimately contain one.
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`${file}: line ${i + 1} is not "key: value" — ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colon).trim();
    if (key in keys) throw new Error(`${file}: duplicate key "${key}"`);
    keys[key] = line.slice(colon + 1).trim();
  }

  // slice(end + 1) — only the first closing delimiter counts, so a body may contain its own.
  return { keys, body: lines.slice(end + 1).join("\n").trim() };
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS, and the pre-existing suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills/frontmatter.ts src/agent/skills/frontmatter.test.ts
git commit -m "feat(skills): flat key: value frontmatter parser"
```

---

### Task 2: Skill registry

**Files:**
- Create: `src/agent/skills/index.ts`, `src/agent/skills/index.test.ts`
- Create: `src/agent/skills/fixtures/good/{rca-format.md,oomkilled.md,crashloop.md,pvc.md}`

**Interfaces:**
- Consumes: `parseFrontmatter(text, file)` from Task 1.
- Produces:
  ```ts
  export const SKILL_MAX_CHARS = 8000;
  export const MAX_MATCHED_SKILLS = 3;
  export const TRIGGER_MAX_CHARS = 4000;
  export interface Skill { name: string; description: string; when: "always" | RegExp; body: string; chars: number }
  export interface Selection { selected: Skill[]; overflow: string[] }
  export interface SkillRegistry { all(): readonly Skill[]; select(trigger: string, already: ReadonlySet<string>): Selection }
  export function loadSkills(dir: string): SkillRegistry;
  export function resolveSkillsDir(): string;
  ```

- [ ] **Step 1: Create the fixture directory**

`src/agent/skills/fixtures/good/rca-format.md`:

```markdown
---
name: rca-format
description: The Slack mrkdwn shape every RCA must take
when: always
---

*Root Cause* one paragraph.
```

`src/agent/skills/fixtures/good/oomkilled.md`:

```markdown
---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|exit code 137|memory limit
---

1. k8s_describe_pod — confirm lastState Terminated OOMKilled.
```

`src/agent/skills/fixtures/good/crashloop.md`:

```markdown
---
name: crashloopbackoff
description: First tool calls for a container restarting in a loop
when: crashloop|restarting
---

1. k8s_describe_pod — read lastState and recentEvents.
```

`src/agent/skills/fixtures/good/pvc.md`:

```markdown
---
name: pvc-pending
description: A claim that never binds
when: pvc|storageclass
---

1. k8s_list_pvcs — confirm the claim is Pending.
```

- [ ] **Step 2: Write the failing test**

Create `src/agent/skills/index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, SKILL_MAX_CHARS, MAX_MATCHED_SKILLS } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD = join(HERE, "fixtures/good");

// Writes one .md into a throwaway directory and returns the directory, so each malformation
// test names exactly the file it is about instead of sharing a fixture tree.
function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

const skill = (name: string, when: string, body = "b") =>
  ["---", `name: ${name}`, "description: d", `when: ${when}`, "---", body].join("\n");

test("loads every .md in the directory, sorted, with sizes", () => {
  const r = loadSkills(GOOD);
  assert.deepEqual(r.all().map((s) => s.name), ["crashloopbackoff", "oomkilled", "pvc-pending", "rca-format"]);
  assert.ok(r.all().every((s) => s.chars > 0));
  assert.equal(r.all().find((s) => s.name === "rca-format")!.when, "always");
});

test("always-skills are selected for any trigger, matched ones only on a hit", () => {
  const r = loadSkills(GOOD);
  const { selected } = r.select("Pod api-7f was OOMKilled (exit code 137)", new Set());
  assert.deepEqual(selected.map((s) => s.name), ["rca-format", "oomkilled"]);
});

test("matching is case-insensitive and ignores skills already loaded for the thread", () => {
  const r = loadSkills(GOOD);
  const { selected } = r.select("OOMKILL", new Set(["rca-format", "oomkilled"]));
  assert.deepEqual(selected, []);
});

test("the cap keeps the best three matches and reports the rest", () => {
  const d = dirWith({
    "a.md": skill("aaa", "boom"), "b.md": skill("bbb", "boom"),
    "c.md": skill("ccc", "boom"), "d.md": skill("ddd", "boom"),
  });
  const { selected, overflow } = loadSkills(d).select("boom", new Set());
  assert.equal(selected.length, MAX_MATCHED_SKILLS);
  assert.equal(overflow.length, 1);
  // equal hit counts, so the tie-break is name-ascending and "ddd" is the one left out
  assert.deepEqual(selected.map((s) => s.name), ["aaa", "bbb", "ccc"]);
  assert.deepEqual(overflow, ["ddd"]);
  rmSync(d, { recursive: true, force: true });
});

test("more distinct matches outranks fewer", () => {
  const d = dirWith({ "one.md": skill("one", "alpha"), "two.md": skill("two", "alpha|beta|gamma") });
  const { selected } = loadSkills(d).select("alpha beta gamma", new Set());
  assert.deepEqual(selected.map((s) => s.name), ["two", "one"]);
  rmSync(d, { recursive: true, force: true });
});

// A `g`-flagged regex carries lastIndex. If the registry reused one across selections the
// second call would start mid-string and miss.
test("selection is repeatable — a regex is never left with a dirty lastIndex", () => {
  const r = loadSkills(GOOD);
  const first = r.select("oomkill", new Set()).selected.map((s) => s.name);
  const second = r.select("oomkill", new Set()).selected.map((s) => s.name);
  assert.deepEqual(first, second);
});

test("the trigger is capped, so text past the cap cannot match", () => {
  const r = loadSkills(GOOD);
  const { selected } = r.select("x".repeat(4000) + " oomkill", new Set());
  assert.deepEqual(selected.map((s) => s.name), ["rca-format"]);
});

for (const [label, files, re] of [
  ["a missing directory", null, /could not be read/],
  ["an empty directory", {}, /holds no \.md files/],
  ["a missing key", { "a.md": ["---", "name: a", "description: d", "---", "b"].join("\n") }, /a\.md: missing required key "when"/],
  ["an unknown key", { "a.md": ["---", "name: a", "description: d", "when: x", "colour: red", "---", "b"].join("\n") }, /a\.md: unknown key "colour"/],
  ["an illegal name", { "a.md": skill("Not_A_Name", "x") }, /must match/],
  ["an uncompilable regex", { "a.md": skill("a", "([unclosed") }, /a\.md: when is not a valid regex/],
  ["an empty body", { "a.md": ["---", "name: a", "description: d", "when: x", "---", "  "].join("\n") }, /a\.md: body is empty/],
  ["a duplicate name", { "a.md": skill("dup", "x"), "b.md": skill("dup", "y") }, /duplicate skill name "dup" in a\.md and b\.md/],
  ["an oversized file", { "a.md": skill("a", "x", "y".repeat(SKILL_MAX_CHARS)) }, /exceeds SKILL_MAX_CHARS/],
] as const) {
  test(`throws on ${label}`, () => {
    const d = files === null ? join(tmpdir(), "skills-does-not-exist-4a91") : dirWith(files);
    assert.throws(() => loadSkills(d), re);
    if (files !== null) rmSync(d, { recursive: true, force: true });
  });
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 4: Implement**

Create `src/agent/skills/index.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKILL_MAX_CHARS = 8000;
export const MAX_MATCHED_SKILLS = 3;
export const TRIGGER_MAX_CHARS = 4000;

const REQUIRED_KEYS = ["name", "description", "when"] as const;
const NAME_RE = /^[a-z0-9-]+$/;

export interface Skill {
  name: string;
  description: string;
  /** "always" or a case-insensitive, global regex over the trigger text. */
  when: "always" | RegExp;
  body: string;
  /** Size of the whole file, frontmatter included — what the dashboard reports. */
  chars: number;
}

export interface Selection {
  selected: Skill[];
  /** Names that matched but lost to MAX_MATCHED_SKILLS. The caller logs them. */
  overflow: string[];
}

export interface SkillRegistry {
  all(): readonly Skill[];
  select(trigger: string, already: ReadonlySet<string>): Selection;
}

// Same two-candidate walk as resolvePromptPath() in ../prompts/system.ts: dev runs from src/,
// the container runs from dist/src/, and prompts/ sits at the project root in both.
export function resolveSkillsDir(): string {
  const candidates = [
    join(__dirname, "../../../prompts/skills"),
    join(__dirname, "../../../../prompts/skills"),
  ];
  for (const p of candidates) {
    try {
      readdirSync(p);
      return p;
    } catch {
      continue;
    }
  }
  throw new Error(`skills directory could not be read — tried ${candidates.join(" and ")}`);
}

function parseSkill(file: string, text: string): Skill {
  if (text.length > SKILL_MAX_CHARS) {
    throw new Error(`${file}: ${text.length} chars exceeds SKILL_MAX_CHARS (${SKILL_MAX_CHARS})`);
  }
  const { keys, body } = parseFrontmatter(text, file);

  for (const k of REQUIRED_KEYS) {
    if (!keys[k]) throw new Error(`${file}: missing required key "${k}"`);
  }
  // Unknown keys are an error, not a shrug: a typo'd key is a skill that silently does something
  // other than what its author wrote.
  for (const k of Object.keys(keys)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(k)) {
      throw new Error(`${file}: unknown key "${k}" (allowed: ${REQUIRED_KEYS.join(", ")})`);
    }
  }

  const name = keys.name!;
  if (!NAME_RE.test(name)) {
    throw new Error(`${file}: name "${name}" must match ${NAME_RE.source}`);
  }
  if (!body) throw new Error(`${file}: body is empty`);

  let when: "always" | RegExp = "always";
  if (keys.when !== "always") {
    try {
      // `g` so distinct matches can be counted; `i` so a skill author never has to think
      // about the case an alert label happens to arrive in.
      when = new RegExp(keys.when!, "gi");
    } catch (err) {
      throw new Error(`${file}: when is not a valid regex — ${(err as Error).message}`);
    }
  }

  return { name, description: keys.description!, when, body, chars: text.length };
}

function selectFrom(skills: readonly Skill[], trigger: string, already: ReadonlySet<string>): Selection {
  const text = trigger.slice(0, TRIGGER_MAX_CHARS);

  const selected: Skill[] = [];
  const scored: { skill: Skill; hits: number }[] = [];

  for (const s of skills) {
    if (already.has(s.name)) continue;
    if (s.when === "always") {
      selected.push(s);
      continue;
    }
    // matchAll clones the regex, so the `g` flag's lastIndex is never shared between calls.
    // Distinct substrings, not raw count: a word repeated 40 times is one signal, not forty.
    const hits = new Set([...text.matchAll(s.when)].map((m) => m[0].toLowerCase())).size;
    if (hits > 0) scored.push({ skill: s, hits });
  }

  scored.sort((a, b) => b.hits - a.hits || a.skill.name.localeCompare(b.skill.name));
  return {
    selected: [...selected, ...scored.slice(0, MAX_MATCHED_SKILLS).map((x) => x.skill)],
    overflow: scored.slice(MAX_MATCHED_SKILLS).map((x) => x.skill.name),
  };
}

/**
 * Reads and validates a whole skills directory. Throws on the first problem — a malformed skill
 * must be a pod that refuses to start, not an agent that investigates correctly and then answers
 * in a shape nothing downstream can parse.
 */
export function loadSkills(dir: string): SkillRegistry {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    throw new Error(`skills directory ${dir} could not be read — ${(err as Error).message}`);
  }
  if (files.length === 0) {
    throw new Error(`skills directory ${dir} holds no .md files — an agent with no skills has no RCA output format`);
  }

  const skills: Skill[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const skill = parseSkill(f, readFileSync(join(dir, f), "utf-8"));
    const prev = seen.get(skill.name);
    if (prev) throw new Error(`duplicate skill name "${skill.name}" in ${prev} and ${f}`);
    seen.set(skill.name, f);
    skills.push(skill);
  }

  return {
    all: () => skills,
    select: (trigger, already) => selectFrom(skills, trigger, already),
  };
}
```

- [ ] **Step 5: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/skills/index.ts src/agent/skills/index.test.ts src/agent/skills/fixtures
git commit -m "feat(skills): registry with boot-time validation and deterministic selection"
```

---

### Task 3: The thirteen skill files

**Files:**
- Create: `prompts/skills/*.md` (13 files)
- Test: `src/agent/skills/real.test.ts`

**Interfaces:**
- Consumes: `loadSkills(dir)`, `resolveSkillsDir()` from Task 2.
- Produces: a populated `prompts/skills/` directory. `prompts/system.md` is NOT edited in this task — the content is copied, so the agent keeps working exactly as before until Task 8 wires injection and Task 9 removes the originals.

- [ ] **Step 1: Create the twelve playbook files**

For each row: create `prompts/skills/<file>`, put the frontmatter shown below at the top, and copy the named line range of `prompts/system.md` **verbatim** as the body, dropping only its own `### <Heading>` line.

| File | Body = `system.md` lines | `name` | `when` |
|---|---|---|---|
| `crashloopbackoff.md` | 111–113 | `crashloopbackoff` | `crashloop\|restarting\|restart count` |
| `oomkilled.md` | 116–118 | `oomkilled` | `oomkill\|out of memory\|exit code 137\|memory limit` |
| `imagepullbackoff.md` | 121 | `imagepullbackoff` | `imagepull\|errimagepull\|pull.?back.?off` |
| `high-error-rate.md` | 124–126 | `high-error-rate` | `5xx\|error rate\|http_?5\|internal server error` |
| `high-latency.md` | 129–132 | `high-latency` | `latency\|slow\|timeout\|p99\|p95` |
| `pod-not-ready.md` | 135–137 | `pod-not-ready` | `not ?ready\|readiness\|probe fail` |
| `pod-pending.md` | 140–141 | `pod-pending` | `pending\|unschedulable\|insufficient (cpu\|memory)\|taint` |
| `service-unavailable.md` | 144–147 | `service-unavailable` | `503\|service unavailable\|no endpoints\|connection refused` |
| `rollout-stuck.md` | 150–152 | `rollout-stuck` | `rollout\|progressdeadline\|replicas ?mismatch\|not progressing` |
| `pvc-pending.md` | 155–157 | `pvc-pending` | `pvc\|persistentvolume\|volume\|storageclass` |
| `forbidden.md` | 160–161 | `forbidden` | `forbidden\|permission denied\|rbac\|unauthorized` |
| `gitops-drift.md` | 164–184 | `gitops-drift` | `drift\|helmrelease\|flux\|unexpected (image\|tag\|replica)` |

Descriptions, one line each, operator-facing:

| `name` | `description` |
|---|---|
| `crashloopbackoff` | First tool calls for a container restarting in a loop |
| `oomkilled` | First tool calls for a container killed at its memory limit |
| `imagepullbackoff` | Why the event message alone is usually the root cause |
| `high-error-rate` | Correlating a 5xx spike with a deploy |
| `high-latency` | Turning "service Y is slow" into "span Z is slow" |
| `pod-not-ready` | A running container that never passes its readiness probe |
| `pod-pending` | Reading the scheduler's own message for an unschedulable pod |
| `service-unavailable` | A Service with no ready backends behind it |
| `rollout-stuck` | A deployment whose new ReplicaSet never becomes ready |
| `pvc-pending` | A claim that never binds |
| `forbidden` | Resolving an RBAC denial to the exact apiGroup/resource/verb |
| `gitops-drift` | A running spec that does not match what the repo declares |

Example — `prompts/skills/oomkilled.md` in full:

```markdown
---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|out of memory|exit code 137|memory limit
---

1. k8s_describe_pod — confirm `lastState` = "Terminated: OOMKilled (exit 137)" and read the container's configured memory **limit** (the `resources` field) — the kill happens at that limit
2. prometheus_query_range — memory trend: `container_memory_working_set_bytes{namespace="X",pod=~"service.*"}` (look for steady climb toward the limit)
3. k8s_get_pod_logs with `previous: true` — check for memory leak indicators in the killed instance before the kill
```

- [ ] **Step 2: Create the RCA format skill**

Create `prompts/skills/rca-format.md`: the frontmatter below, then `prompts/system.md` lines 304–348 verbatim as the body (everything under `## RCA Output Format`, excluding that heading).

`prompts/system.md` has **no trailing newline**, so `wc -l` reports 347 while the file actually holds 348 lines. Line 348 is the last line of the RCA template — `*📈 Confidence:* ...` — and it is part of the body. Count with `awk 'END{print NR}'`, not `wc -l`, and verify with `grep -c Confidence prompts/skills/rca-format.md` (must be ≥ 1) before committing: `rca-format` is the only `always` skill, so a section missing here is missing from every RCA the agent writes.

```markdown
---
name: rca-format
description: The exact Slack mrkdwn shape every RCA must take
when: always
---
```

- [ ] **Step 3: Write the test that loads the real directory**

Create `src/agent/skills/real.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, resolveSkillsDir, SKILL_MAX_CHARS } from "./index.js";

// The shipped directory, not a fixture. loadSkills throws at boot on any malformation, so this
// test is what turns "the pod refuses to start" into "npm test fails" — the whole reason
// fail-fast is safe to choose.
test("every shipped skill file loads", () => {
  const skills = loadSkills(resolveSkillsDir()).all();
  assert.ok(skills.length >= 13, `expected at least 13 skills, got ${skills.length}`);
  for (const s of skills) {
    assert.ok(s.chars <= SKILL_MAX_CHARS, `${s.name} is ${s.chars} chars`);
    assert.ok(s.description.length > 0 && !s.description.includes("\n"), `${s.name} needs a one-line description`);
    assert.ok(s.body.length > 0, `${s.name} has an empty body`);
  }
});

test("exactly one skill is always-on, and it is the RCA format", () => {
  const always = loadSkills(resolveSkillsDir()).all().filter((s) => s.when === "always");
  assert.deepEqual(always.map((s) => s.name), ["rca-format"]);
});

// One representative alert per playbook. A trigger that selects nothing is a playbook that
// will never fire in production, which no amount of unit testing of the matcher would catch.
test("each playbook is reachable from a realistic alert line", () => {
  const r = loadSkills(resolveSkillsDir());
  const cases: [string, string][] = [
    ["crashloopbackoff", "KubePodCrashLooping: pod api-7f is restarting 12 times"],
    ["oomkilled", "container api exceeded its memory limit and was OOMKilled"],
    ["imagepullbackoff", "Failed to pull image: ImagePullBackOff"],
    ["high-error-rate", "HighErrorRate: 5xx rate is 12% for checkout"],
    ["high-latency", "HighLatency: p99 latency is 2.3s"],
    ["pod-not-ready", "Readiness probe failed: pod is not ready"],
    ["pod-pending", "Pod is Pending: 0/6 nodes available, insufficient cpu"],
    ["service-unavailable", "503 Service Unavailable from the ingress"],
    ["rollout-stuck", "KubeDeploymentReplicasMismatch: rollout has not progressed"],
    ["pvc-pending", "PersistentVolumeClaim data-0 is Pending"],
    ["forbidden", "Error: pods is forbidden — RBAC denied"],
    ["gitops-drift", "the running image does not match what the HelmRelease declares"],
  ];
  for (const [name, alert] of cases) {
    const { selected } = r.select(alert, new Set());
    assert.ok(selected.some((s) => s.name === name), `"${alert}" did not select ${name}`);
  }
});
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -30
```

Expected: PASS. If a playbook is unreachable, widen that skill's `when` — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add prompts/skills src/agent/skills/real.test.ts
git commit -m "feat(skills): 12 failure-mode playbooks + the RCA format as skill files"
```

---

### Task 4: Token estimation and the budget

**Files:**
- Create: `src/agent/context/budget.ts`, `src/agent/context/budget.test.ts`

**Interfaces:**
- Consumes: `Skill` from `../skills/index.js`; `Message`, `ContentBlock` from `../llm/types.js`.
- Produces:
  ```ts
  export const CHARS_PER_TOKEN = 3;
  export const BUDGET_SAFETY_MARGIN = 1024;
  export const DEFAULT_CONTEXT_TOKENS: Record<"claude" | "openai-compatible" | "private-llm", number>;
  export interface Budget { contextTokens: number; reserveTokens: number }
  export function estimateTokens(text: string): number;
  export function estimateMessage(m: Message): number;
  export interface FitResult { history: Message[]; skills: Skill[]; skillsDropped: string[]; messagesDropped: number }
  export function fitToBudget(input: { history: Message[]; skills: readonly Skill[]; available: number }): FitResult;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/agent/context/budget.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessage, fitToBudget, CHARS_PER_TOKEN } from "./budget.js";
import type { Message } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

const user = (text: string): Message => ({ role: "user", content: text });
const asst = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const skill = (name: string, size: number, when: Skill["when"] = /x/gi): Skill =>
  ({ name, description: "d", when, body: "b".repeat(size), chars: size });

test("estimation is pessimistic on purpose — 3 chars per token, never 4", () => {
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(CHARS_PER_TOKEN, 3);
  // Under-estimating produces a 400 or a silent server-side truncation; over-estimating
  // only wastes window.
  assert.ok(estimateTokens("x".repeat(1200)) >= 1200 / 4);
});

test("estimation is monotonic in length", () => {
  assert.ok(estimateTokens("x".repeat(100)) < estimateTokens("x".repeat(200)));
});

test("a block message counts its text, its tool input and its tool result", () => {
  const m: Message = { role: "user", content: [
    { type: "text", text: "abc" },
    { type: "tool_result", tool_use_id: "1", content: "defghi" },
  ] };
  assert.equal(estimateMessage(m), estimateTokens("abc") + estimateTokens("defghi"));
});

test("everything fits — nothing is dropped", () => {
  const history = [user("a"), asst("b"), user("c")];
  const r = fitToBudget({ history, skills: [skill("s", 30)], available: 10_000 });
  assert.equal(r.history.length, 3);
  assert.equal(r.skills.length, 1);
  assert.deepEqual(r.skillsDropped, []);
  assert.equal(r.messagesDropped, 0);
});

// History is evidence already gathered; a skill is advice. Advice goes first.
test("under pressure the skills go before the history", () => {
  const history = [user("a".repeat(300)), asst("b".repeat(300)), user("c".repeat(300))];
  const r = fitToBudget({ history, skills: [skill("big", 3000)], available: 300 });
  assert.deepEqual(r.skillsDropped, ["big"]);
  assert.equal(r.history.length, 3, "no message dropped while a skill was still droppable");
});

// The test above passes under either fill order — its skill is too large to fit in any case.
// This one separates them: the skill WOULD fit if it were offered the window first, and taking
// it would cost the middle message. 105 leaves exactly one of the two affordable after the
// 4 pinned tokens, so whichever is filled first is the one that survives.
test("a skill never takes budget a history message could have used", () => {
  const history = [user("first"), asst("m".repeat(300)), user("last")];
  const r = fitToBudget({ history, skills: [skill("advice", 300)], available: 105 });
  assert.equal(r.history.length, 3, "the middle message was traded away for a skill");
  assert.equal(r.messagesDropped, 0);
  assert.deepEqual(r.skillsDropped, ["advice"]);
});

// 160 is the window where the tie-break decides the outcome rather than merely the order:
// after `core` (50) there is room for `matched-small` (50) OR `matched-big` (100), not both.
// Sorted largest-first the big one is taken and the small one is dropped — a different result,
// which is what makes this assertion mean something.
test("an always-skill outranks a matched one, and among matched the largest drops first", () => {
  const skills = [skill("matched-big", 300), skill("matched-small", 150), skill("core", 150, "always")];
  const r = fitToBudget({ history: [user("a")], skills, available: 160 });
  assert.deepEqual(r.skills.map((s) => s.name), ["core", "matched-small"]);
  assert.deepEqual(r.skillsDropped, ["matched-big"]);
});

// The early return for an empty history used to hand back every skill unmeasured.
test("with no history at all the skills are still measured against the budget", () => {
  const r = fitToBudget({ history: [], skills: [skill("big", 3000)], available: 10 });
  assert.deepEqual(r.skills, []);
  assert.deepEqual(r.skillsDropped, ["big"]);
  assert.equal(r.messagesDropped, 0);
});

test("the first and the most recent message are never dropped", () => {
  const history = [user("first"), asst("mid"), user("last")];
  const r = fitToBudget({ history, skills: [], available: 1 });
  assert.deepEqual(r.history.map((m) => m.content), ["first", "last"]);
  assert.equal(r.messagesDropped, 1);
});

// The API rejects a tool_result whose tool_use is gone, with a 400 that kills exactly the long
// investigations this budget exists to keep alive.
test("a trimmed window never opens on an orphaned tool_result", () => {
  const history: Message[] = [
    user("first"),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "k8s", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(900) }] },
    asst("summary"),
    user("last"),
  ];
  // 308 is chosen so the tool_result (300 tokens) fits and its tool_use (2) does not — the exact
  // window where the orphan actually appears. A budget too small to reach the tool_result would
  // pass this assertion without ever running the code it is about.
  const r = fitToBudget({ history, skills: [], available: 308 });
  const second = r.history[1]!;
  const orphan = Array.isArray(second.content) && second.content.some((b) => b.type === "tool_result");
  assert.equal(orphan, false, "the window starts on an orphaned tool_result");
});

// The pinned last message is usually the tool_result the assistant is waiting on. Pinning it
// without its tool_use produces the same 400 from the other end of the array.
test("a final tool_result keeps the tool_use that produced it", () => {
  const history: Message[] = [
    user("first"),
    asst("filler ".repeat(200)),
    { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "k8s", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "r" }] },
  ];
  // 4 is below the 5 tokens the pinned trio costs. Pinning is unconditional; the middle-fill is
  // not. So with the pairing removed the tool_use has only the budgeted path to arrive by, and
  // cannot afford it — the window comes back as first + orphaned tool_result. A budget large
  // enough for the middle-fill would pick the cheap tool_use up either way and assert nothing.
  const r = fitToBudget({ history, skills: [], available: 4 });
  const kinds = r.history.map((m) => (Array.isArray(m.content) ? m.content[0]!.type : "text"));
  assert.deepEqual(kinds, ["text", "tool_use", "tool_result"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './budget.js'`.

- [ ] **Step 3: Implement**

Create `src/agent/context/budget.ts`:

```ts
import type { Message, ContentBlock } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

// Three characters per token, not the usual four. This context is dominated by JSON tool
// results, which tokenize far worse than prose. Over-estimating wastes window; under-estimating
// produces a 400, or worse a silent server-side truncation that removes evidence the model then
// reasons without.
export const CHARS_PER_TOKEN = 3;
export const BUDGET_SAFETY_MARGIN = 1024;

export const DEFAULT_CONTEXT_TOKENS = {
  claude: 200_000,
  "openai-compatible": 128_000,
  "private-llm": 32_000,
} as const;

export interface Budget {
  contextTokens: number;
  reserveTokens: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const blockText = (b: ContentBlock): string =>
  (b.text ?? "") + (b.content ?? "") + (b.name ?? "") + (b.input ? JSON.stringify(b.input) : "");

export const estimateMessage = (m: Message): number =>
  typeof m.content === "string"
    ? estimateTokens(m.content)
    : m.content.reduce((n, b) => n + estimateTokens(blockText(b)), 0);

const carriesToolResult = (m: Message): boolean =>
  m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");

const carriesToolUse = (m: Message): boolean =>
  m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");

export interface FitResult {
  history: Message[];
  skills: Skill[];
  skillsDropped: string[];
  messagesDropped: number;
}

// Keep-order, i.e. the reverse of drop-order: an always-skill outranks a matched one, and within
// a rank the smaller body is kept first — so the largest matched playbook is the first thing to
// go. No name is special-cased here; with one always-skill this is exactly "rca-format drops
// last", and if a second is ever added the tie-break is size rather than identity.
const keepRank = (s: Skill): number => (s.when === "always" ? 0 : 1);

// Greedy fill in keep-order over whatever `used` leaves. Both callers go through here: an empty
// history is still a budget, and handing back an unmeasured skill list would overflow the window
// on the one path that looks too trivial to check.
const fitSkills = (
  skills: readonly Skill[],
  used: number,
  available: number,
): { kept: Skill[]; dropped: string[] } => {
  const kept: Skill[] = [];
  const dropped: string[] = [];
  for (const s of [...skills].sort((a, b) => keepRank(a) - keepRank(b) || a.body.length - b.body.length)) {
    const t = estimateTokens(s.body);
    if (used + t <= available) {
      used += t;
      kept.push(s);
    } else {
      dropped.push(s.name);
    }
  }
  return { kept, dropped };
};

/**
 * Fits skills and history into `available` tokens.
 *
 * Pinned, in this order: the thread's opening message, the most recent message, and — when that
 * most recent message carries tool_result blocks — the assistant message holding the matching
 * tool_use. Pinned messages are kept whatever the budget says.
 *
 * What the pins leave goes to the history's middle first, newest-first, and only what survives
 * that goes to the skills: history is evidence already gathered, a skill is only advice. The
 * middle is dropped from the oldest end, and the window is advanced past any leading orphaned
 * tool_result.
 */
export function fitToBudget(input: {
  history: Message[];
  skills: readonly Skill[];
  available: number;
}): FitResult {
  const { history, available } = input;
  if (history.length === 0) {
    const { kept, dropped } = fitSkills(input.skills, 0, available);
    return { history: [], skills: kept, skillsDropped: dropped, messagesDropped: 0 };
  }

  const cost = history.map(estimateMessage);
  const first = 0;
  const last = history.length - 1;
  // A trailing tool_result is meaningless without the tool_use it answers.
  const pinFrom = last > first && carriesToolResult(history[last]!) && carriesToolUse(history[last - 1]!)
    ? last - 1
    : last;

  const pinned: number[] = [first];
  for (let i = pinFrom; i <= last; i++) if (i > first) pinned.push(i);
  let used = pinned.reduce((n, i) => n + cost[i]!, 0);

  // History before skills, against the same counter. Reversing these two blocks lets a skill
  // that happens to fit consume budget a message needed, which is the trade this whole function
  // exists to refuse.
  const middle: Message[] = [];
  for (let i = pinFrom - 1; i > first; i--) {
    const t = cost[i]!;
    if (used + t > available) break;
    used += t;
    middle.unshift(history[i]!);
  }

  const { kept, dropped: skillsDropped } = fitSkills(input.skills, used, available);

  const tail = history.slice(pinFrom).filter((_, k) => pinFrom + k > first);
  let out = [history[first]!, ...middle, ...tail];

  // The window must open on a clean turn boundary — see carriesToolResult above.
  let start = 1;
  while (start < out.length - 1 && carriesToolResult(out[start]!)) start++;
  if (start > 1) out = [out[0]!, ...out.slice(start)];

  return { history: out, skills: kept, skillsDropped, messagesDropped: history.length - out.length };
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/context/budget.ts src/agent/context/budget.test.ts
git commit -m "feat(context): token estimation and a budget that drops advice before evidence"
```

---

### Task 5: Tool-result compaction

**Files:**
- Create: `src/agent/context/compact.ts`, `src/agent/context/compact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const MAX_TOOL_RESULT_CHARS = 8000; export function compactToolResult(content: string): string;`

- [ ] **Step 1: Write the failing test**

Create `src/agent/context/compact.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactToolResult, MAX_TOOL_RESULT_CHARS } from "./compact.js";

test("a result under the cap comes back byte-identical", () => {
  const json = JSON.stringify({ pods: [{ name: "api-7f", restarts: 12 }] });
  assert.equal(compactToolResult(json), json);
});

test("a long run of near-identical lines collapses to one line and a count", () => {
  const line = (i: number) => `2026-08-12T14:0${i % 10}:11Z ERROR connection refused to db:5432`;
  const log = Array.from({ length: 400 }, (_, i) => line(i)).join("\n");
  assert.ok(log.length > MAX_TOOL_RESULT_CHARS);

  const out = compactToolResult(log);
  assert.ok(out.length < MAX_TOOL_RESULT_CHARS, `still ${out.length} chars`);
  assert.match(out, /connection refused to db:5432/);
  assert.match(out, /\.\.\. ×399 more like this/);
});

// Global dedupe would merge two phases of an incident. The same error at 14:02 and again at
// 14:31 with recovery in between is the signal, not the noise.
test("two separated runs of the same line stay separate", () => {
  const err = "ERROR connection refused";
  const log = [
    ...Array(5).fill(err),
    "INFO recovered, serving traffic",
    ...Array(5).fill(err),
  ].join("\n");

  const out = compactToolResult(log.padEnd(MAX_TOOL_RESULT_CHARS + 1, "\nINFO tail line"));
  assert.equal([...out.matchAll(/ERROR connection refused/g)].length, 2);
});

test("a run shorter than three lines is left alone", () => {
  const log = ["a", "a", "b"].join("\n").padEnd(MAX_TOOL_RESULT_CHARS + 1, "\nc");
  const out = compactToolResult(log);
  assert.match(out, /^a\na\nb/);
});

// The differentiator has to survive normalize(), so it is spelled in letters. A line numbered
// `line 0`…`line 2999` does NOT work: DIGIT_RUN masks every run of two or more digits, so from
// `line 10` on every line normalizes to the same key, 2990 of them collapse into one, and the
// result lands far under the cap — this test would then pass through the collapse path and never
// reach the truncation it is named after. The doesNotMatch below is what pins that shut.
const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const word = (i: number): string =>
  ALPHA[i % 26]! + ALPHA[Math.floor(i / 26) % 26]! + ALPHA[Math.floor(i / 676) % 26]!;

test("head and tail survive when collapsing is not enough", () => {
  const log = Array.from({ length: 3000 }, (_, i) => `line ${word(i)} unique content ${"x".repeat(20)}`).join("\n");
  const out = compactToolResult(log);
  assert.doesNotMatch(out, /more like this/, "nothing should have collapsed — every line is distinct");
  assert.ok(out.startsWith("line aaa "), "head lost");
  assert.match(out, /\.\.\.\[truncated \d+ chars\]\.\.\./);
  assert.ok(out.trimEnd().endsWith("x".repeat(20)), "tail lost");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './compact.js'`.

- [ ] **Step 3: Implement**

Create `src/agent/context/compact.ts`:

```ts
export const MAX_TOOL_RESULT_CHARS = 8000; // ~2.7k tokens per tool result

const MIN_RUN = 3;
const TRUNCATION_NOTICE = (remaining: number) => `\n...[truncated ${remaining} chars]...\n`;

// What makes two log lines "the same line": everything but the clock and the counters.
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const DIGIT_RUN = /\d{2,}/g;

const normalize = (line: string): string => line.replace(TIMESTAMP, "<ts>").replace(DIGIT_RUN, "<n>");

// Only CONSECUTIVE runs. A global dedupe would merge two phases of an incident: the same error
// at 14:02 and again at 14:31, with a recovery in between, is the signal.
function collapseRuns(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = normalize(lines[i]!);
    let j = i + 1;
    while (j < lines.length && normalize(lines[j]!) === key) j++;
    out.push(lines[i]!);
    const run = j - i;
    if (run >= MIN_RUN) {
      out.push(`... ×${run - 1} more like this`);
    } else {
      for (let k = i + 1; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Compacts one tool result. Runs at INGEST, so the compacted form is what reaches Redis and the
 * raw output is not recoverable afterwards — the deliberate trade is not storing full raw
 * results under a 24h TTL for every investigation.
 */
export function compactToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  const collapsed = collapseRuns(content);
  if (collapsed.length <= MAX_TOOL_RESULT_CHARS) return collapsed;

  // Head AND tail: logs are chronological, so the most recent lines live at the END and
  // head-only truncation drops exactly what "show me the logs" was asking for.
  const half = MAX_TOOL_RESULT_CHARS / 2;
  const remaining = collapsed.length - MAX_TOOL_RESULT_CHARS;
  return collapsed.slice(0, half) + TRUNCATION_NOTICE(remaining) + collapsed.slice(-half);
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/context/compact.ts src/agent/context/compact.test.ts
git commit -m "feat(context): collapse repeated log lines before truncating a tool result"
```

---

### Task 6: `assembleRequest` and the cache-trap regression test

**Files:**
- Modify: `src/agent/context/index.ts` (full rewrite of the module's exports)
- Modify: `src/agent/context/index.test.ts`

**Interfaces:**
- Consumes: `fitToBudget`, `estimateTokens`, `estimateMessage`, `Budget` (Task 4); `compactToolResult` (Task 5); `Skill` (Task 2).
- Produces:
  ```ts
  export function assembleRequest(input: {
    history: Message[]; systemPrompt: string; tools: ToolDefinition[];
    skills: readonly Skill[]; budget: Budget;
  }): AssembledRequest;
  export interface AssembledRequest {
    messages: Message[]; systemPrompt: string; skillsUsed: string[];
    skillsDropped: string[]; messagesDropped: number; estimatedTokens: number;
  }
  export function injectSkills(messages: Message[], skills: readonly Skill[]): Message[];
  export function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[];  // unchanged name
  export function trimToWindow(messages: Message[], maxMessages: number): Message[];  // unchanged
  ```
  `truncateToolResult` and `trimHistory` are **removed**.

- [ ] **Step 1: Write the failing test**

Replace the body of `src/agent/context/index.test.ts` with this (keep any existing `trimToWindow` tests — that function is unchanged and its coverage is still wanted):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRequest, injectSkills, sanitizeContentBlocks, trimToWindow } from "./index.js";
import type { Message } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

const BUDGET = { contextTokens: 200_000, reserveTokens: 9_120 };
const SYSTEM = "You are a DevOps agent.\nRules follow.";
const skill = (name: string, body: string, when: Skill["when"] = /x/gi): Skill =>
  ({ name, description: "d", when, body, chars: body.length + 60 });

// THE regression test. src/agent/llm/claude.ts:26-32 wraps the entire system prompt in one
// cache_control: ephemeral block. A system prompt that varies per investigation is a full cache
// miss plus a cache WRITE at 1.25x — slower and more expensive while looking like a saving.
test("the system prompt is byte-identical no matter which skills are selected", () => {
  const history: Message[] = [{ role: "user", content: "pod is crashlooping" }];
  const a = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills: [], budget: BUDGET });
  const b = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [],
    skills: [skill("rca-format", "use this shape"), skill("oomkilled", "check the limit")],
    budget: BUDGET,
  });
  assert.equal(a.systemPrompt, SYSTEM);
  assert.equal(b.systemPrompt, SYSTEM);
  assert.equal(a.systemPrompt, b.systemPrompt);
});

test("skills ride in the first user message, and the message count is unchanged", () => {
  const history: Message[] = [
    { role: "user", content: "the alert text" },
    { role: "assistant", content: "working on it" },
  ];
  const out = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [], skills: [skill("oomkilled", "check the limit")], budget: BUDGET,
  });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0]!.role, "user");
  assert.match(String(out.messages[0]!.content), /--- skill: oomkilled ---\ncheck the limit\n--- end skill: oomkilled ---/);
  assert.match(String(out.messages[0]!.content), /the alert text/);
  assert.deepEqual(out.messages[1], history[1]);
  assert.deepEqual(out.skillsUsed, ["oomkilled"]);
});

test("a block-content first message gets a text block prepended, not a stringified one", () => {
  const history: Message[] = [{ role: "user", content: [{ type: "text", text: "the alert text" }] }];
  const [m] = injectSkills(history, [skill("s", "advice")]);
  assert.ok(Array.isArray(m!.content));
  const blocks = m!.content as { type: string; text?: string }[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "text");
  assert.match(blocks[0]!.text!, /--- skill: s ---/);
  assert.equal(blocks[1]!.text, "the alert text");
});

// Should not happen — a thread opens with the alert — but a skill block silently dropped is
// worse than an extra message.
test("a non-user first message gets its own skill message rather than losing the skills", () => {
  const history: Message[] = [{ role: "assistant", content: "orphan" }];
  const out = injectSkills(history, [skill("s", "advice")]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, "user");
  assert.match(String(out[0]!.content), /--- skill: s ---/);
});

test("no skills means the history is returned untouched", () => {
  const history: Message[] = [{ role: "user", content: "a" }];
  assert.deepEqual(injectSkills(history, []), history);
});

// The realistic squeeze is a huge PINNED tool result, not a huge skill: skills are capped at
// 8000 chars, so three of them never fill a 32k window on their own. The pins are unconditional,
// and one 66k-char log dump in the most recent message is what leaves no room for the advice.
test("a small window drops skills that a large window keeps", () => {
  const history: Message[] = [
    { role: "user", content: "alert" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(66_000) }] },
  ];
  const skills = [skill("rca-format", "f".repeat(6_000), "always")];
  const big = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills, budget: BUDGET });
  const small = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [], skills, budget: { contextTokens: 32_000, reserveTokens: 9_120 },
  });
  assert.deepEqual(big.skillsUsed, ["rca-format"]);
  assert.deepEqual(small.skillsUsed, []);
  assert.deepEqual(small.skillsDropped, ["rca-format"]);
});

test("the tool schemas are charged to the budget", () => {
  const history: Message[] = [{ role: "user", content: "alert" }];
  const bare = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills: [], budget: BUDGET });
  const withTools = assembleRequest({
    history, systemPrompt: SYSTEM, skills: [], budget: BUDGET,
    tools: [{ name: "k8s_list_pods", description: "list pods", inputSchema: { type: "object" } }],
  });
  assert.ok(withTools.estimatedTokens > bare.estimatedTokens);
});

test("sanitizeContentBlocks compacts a tool_result and leaves other blocks alone", () => {
  const long = Array.from({ length: 400 }, () => "ERROR connection refused").join("\n");
  const out = sanitizeContentBlocks([
    { type: "text", text: "hello" },
    { type: "tool_result", tool_use_id: "1", content: long },
  ]);
  assert.deepEqual(out[0], { type: "text", text: "hello" });
  assert.ok((out[1]!.content as string).length < long.length);
  assert.match(out[1]!.content as string, /more like this/);
});

test("trimToWindow still pins the first message", () => {
  const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const out = trimToWindow(msgs, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0]!.content, "m0");
  assert.equal(out[3]!.content, "m9");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `assembleRequest is not exported`.

- [ ] **Step 3: Implement**

Replace `src/agent/context/index.ts` with:

```ts
import type { Message, ContentBlock, ToolDefinition } from "../llm/types.js";
import type { Skill } from "../skills/index.js";
import { compactToolResult } from "./compact.js";
import { estimateMessage, estimateTokens, fitToBudget, type Budget } from "./budget.js";

export { estimateTokens, estimateMessage, fitToBudget } from "./budget.js";
export type { Budget } from "./budget.js";
export { compactToolResult, MAX_TOOL_RESULT_CHARS } from "./compact.js";

const SKILL_OPEN = (name: string): string => `--- skill: ${name} ---`;
const SKILL_CLOSE = (name: string): string => `--- end skill: ${name} ---`;

// A user message carrying tool_result blocks is only valid when the assistant message holding
// the matching tool_use is still present earlier in the array. See budget.ts for the trimming
// rules this constraint produces.
function carriesToolResult(message: Message): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Keep the first message (the original issue) plus the most recent messages, up to
 * `maxMessages` total, without splitting a tool_use / tool_result pair across the trim
 * boundary. Still used as the STORAGE cap in ConversationMemory — the send-side decision now
 * belongs to fitToBudget.
 */
export function trimToWindow(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages) return messages;
  const first = messages[0];
  let start = messages.length - (maxMessages - 1);
  while (start < messages.length && carriesToolResult(messages[start])) {
    start++;
  }
  return [first, ...messages.slice(start)];
}

export function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "tool_result" && typeof block.content === "string") {
      return { ...block, content: compactToolResult(block.content) };
    }
    return block;
  });
}

/**
 * Prepends one delimited block per skill to the request's first user message.
 *
 * NOT the system prompt. src/agent/llm/claude.ts:26-32 caches the entire system prompt as one
 * ephemeral block, so a system prompt that varies per investigation is a guaranteed cache miss
 * plus a rewrite at 1.25x. Riding in the messages also leaves the SQS contract untouched, and
 * survives toOpenAIMessages() in both repos because each already joins a user message's text
 * blocks.
 */
export function injectSkills(messages: Message[], skills: readonly Skill[]): Message[] {
  if (skills.length === 0 || messages.length === 0) return messages;

  const block = skills
    .map((s) => `${SKILL_OPEN(s.name)}\n${s.body}\n${SKILL_CLOSE(s.name)}`)
    .join("\n\n");

  const first = messages[0]!;
  if (first.role !== "user") {
    return [{ role: "user", content: block }, ...messages];
  }

  const content: Message["content"] =
    typeof first.content === "string"
      ? `${block}\n\n${first.content}`
      : [{ type: "text", text: block } as ContentBlock, ...first.content];

  return [{ ...first, content }, ...messages.slice(1)];
}

export interface AssembledRequest {
  messages: Message[];
  /** Returned untouched, byte for byte — see injectSkills. */
  systemPrompt: string;
  skillsUsed: string[];
  skillsDropped: string[];
  messagesDropped: number;
  estimatedTokens: number;
}

/**
 * The single owner of what goes into an LLM request and in what order.
 */
export function assembleRequest(input: {
  history: Message[];
  systemPrompt: string;
  tools: ToolDefinition[];
  skills: readonly Skill[];
  budget: Budget;
}): AssembledRequest {
  const overhead =
    estimateTokens(input.systemPrompt) +
    (input.tools.length > 0 ? estimateTokens(JSON.stringify(input.tools)) : 0);
  const available = input.budget.contextTokens - input.budget.reserveTokens - overhead;

  const fit = fitToBudget({ history: input.history, skills: input.skills, available });
  const messages = injectSkills(fit.history, fit.skills);

  return {
    messages,
    systemPrompt: input.systemPrompt,
    skillsUsed: fit.skills.map((s) => s.name),
    skillsDropped: fit.skillsDropped,
    messagesDropped: fit.messagesDropped,
    estimatedTokens: overhead + messages.reduce((n, m) => n + estimateMessage(m), 0),
  };
}
```

- [ ] **Step 4: Run the tests and the build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
npm --prefix /Users/annasik/riset/devops-ai-agent run build 2>&1 | tail -20
```

Expected: tests PASS. The build FAILS on `src/agent/index.ts` importing the now-deleted `trimHistory` — that is Task 8's job. If any other file imports `truncateToolResult`, note it for Task 8 and do not patch it here.

- [ ] **Step 5: Commit**

```bash
git add src/agent/context/index.ts src/agent/context/index.test.ts
git commit -m "feat(context): assembleRequest owns the request, skills ride in messages"
```

---

### Task 7: Per-backend context window

**Files:**
- Modify: `src/agent/llm/registry.ts`
- Create: `src/agent/context/resolve-budget.ts`, `src/agent/context/resolve-budget.test.ts`
- Modify: `src/agent/llm/registry.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CONTEXT_TOKENS`, `BUDGET_SAFETY_MARGIN`, `Budget` (Task 4); `Registry`, `BackendSpec`, `BackendKind` from `../llm/registry.js`.
- Produces:
  ```ts
  // registry.ts
  export interface BackendSpec { name: string; kind: BackendKind; model?: string; baseUrl?: string; apiKey?: string; contextTokens?: number }
  // resolve-budget.ts
  export function resolveBudget(input: { registry: Registry | null; provider: string; maxTokens: number; overheadTokens: number }): Budget;
  export function windowOf(spec: BackendSpec): number;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/agent/context/resolve-budget.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBudget, windowOf } from "./resolve-budget.js";
import type { Registry } from "../llm/registry.js";

const reg = (...b: Registry["backends"]): Registry => ({ backends: b, heavy: [], light: [] });

test("a backend's window defaults by kind and an explicit value wins", () => {
  assert.equal(windowOf({ name: "a", kind: "claude" }), 200_000);
  assert.equal(windowOf({ name: "b", kind: "openai-compatible" }), 128_000);
  assert.equal(windowOf({ name: "c", kind: "private-llm" }), 32_000);
  assert.equal(windowOf({ name: "d", kind: "private-llm", contextTokens: 65_536 }), 65_536);
});

// The router picks a backend AFTER the request is built, so the request has to fit the smallest
// window it might land in. Failover is up-only (light -> heavy), so the smallest is also the
// usual first attempt.
test("the budget is the smallest window across configured backends", () => {
  const b = resolveBudget({
    registry: reg({ name: "heavy", kind: "claude" }, { name: "light", kind: "private-llm" }),
    provider: "router", maxTokens: 8096, overheadTokens: 12_000,
  });
  assert.equal(b.contextTokens, 32_000);
  assert.equal(b.reserveTokens, 8096 + 1024);
});

test("without a registry the single provider's kind decides", () => {
  const b = resolveBudget({ registry: null, provider: "claude", maxTokens: 8096, overheadTokens: 100 });
  assert.equal(b.contextTokens, 200_000);
});

// A window that cannot hold the system prompt and the tool schemas is a misconfiguration, and it
// should surface at deploy time rather than during an incident.
test("throws when the smallest window cannot fit the prompt, the tools and the reserve", () => {
  assert.throws(
    () => resolveBudget({
      registry: reg({ name: "tiny", kind: "private-llm", contextTokens: 9_000 }),
      provider: "router", maxTokens: 8096, overheadTokens: 12_000,
    }),
    /backend "tiny".*9000.*leaves no room/s
  );
});
```

Append to `src/agent/llm/registry.test.ts`:

```ts
test("CONTEXT_TOKENS is parsed per backend and left undefined when unset", () => {
  const r = parseRegistry({
    LLM_BACKEND_1_NAME: "light", LLM_BACKEND_1_KIND: "private-llm",
    LLM_BACKEND_1_CONTEXT_TOKENS: "65536",
    LLM_BACKEND_2_NAME: "heavy", LLM_BACKEND_2_KIND: "claude",
    LLM_BACKEND_2_MODEL: "claude-opus-5", LLM_BACKEND_2_KEY: "k",
    LLM_ROUTE_LIGHT: "light", LLM_ROUTE_HEAVY: "heavy",
  } as NodeJS.ProcessEnv);
  assert.equal(r.backends[0]!.contextTokens, 65_536);
  assert.equal(r.backends[1]!.contextTokens, undefined);
});

test("a non-numeric CONTEXT_TOKENS is rejected at boot", () => {
  assert.throws(
    () => parseRegistry({
      LLM_BACKEND_1_NAME: "light", LLM_BACKEND_1_KIND: "private-llm",
      LLM_BACKEND_1_CONTEXT_TOKENS: "lots",
      LLM_ROUTE_LIGHT: "light", LLM_ROUTE_HEAVY: "light",
    } as NodeJS.ProcessEnv),
    /LLM_BACKEND_1_CONTEXT_TOKENS/
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './resolve-budget.js'`.

- [ ] **Step 3: Add the field to `BackendSpec`**

In `src/agent/llm/registry.ts`, extend the interface (line 13):

```ts
export interface BackendSpec {
  name: string;
  kind: BackendKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  // Context window in tokens. Optional — defaults by kind in resolve-budget.ts. Set it when a
  // self-hosted model's window is not the kind's default (a 128k private LLM, say).
  contextTokens?: number;
}
```

And in `parseRegistry`, inside the loop that builds each spec, after the existing fields are read:

```ts
    const rawWindow = env[`LLM_BACKEND_${i}_CONTEXT_TOKENS`]?.trim();
    if (rawWindow) {
      const n = Number(rawWindow);
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`LLM_BACKEND_${i}_CONTEXT_TOKENS must be a positive integer, got ${JSON.stringify(rawWindow)}`);
      }
      spec.contextTokens = n;
    }
```

(Name the local variable holding the spec under construction to match what is already there; if the file builds the object literal in one expression, read `rawWindow` above it and add `...(rawWindow ? { contextTokens: n } : {})`.)

- [ ] **Step 4: Implement `resolve-budget.ts`**

Create `src/agent/context/resolve-budget.ts`:

```ts
import type { Registry, BackendSpec, BackendKind } from "../llm/registry.js";
import { BUDGET_SAFETY_MARGIN, DEFAULT_CONTEXT_TOKENS, type Budget } from "./budget.js";

export const windowOf = (spec: BackendSpec): number =>
  spec.contextTokens ?? DEFAULT_CONTEXT_TOKENS[spec.kind];

/**
 * One budget for the whole process, resolved at boot.
 *
 * The router picks a backend AFTER the request has been built, so a request must fit the
 * SMALLEST window it might land in. Failover is up-only (light -> heavy), so the smallest
 * backend is also the usual first attempt; the cost is that a call which happens to land on
 * Claude is sometimes smaller than it needed to be.
 *
 * `overheadTokens` is the system prompt plus the tool schemas — measured by the caller, because
 * only the caller knows which tools the MCP server actually returned.
 */
export function resolveBudget(input: {
  registry: Registry | null;
  provider: string;
  maxTokens: number;
  overheadTokens: number;
}): Budget {
  const reserveTokens = input.maxTokens + BUDGET_SAFETY_MARGIN;

  const specs: BackendSpec[] =
    input.registry && input.registry.backends.length > 0
      ? input.registry.backends
      : [{ name: input.provider, kind: input.provider as BackendKind }];

  let smallest = specs[0]!;
  for (const s of specs) if (windowOf(s) < windowOf(smallest)) smallest = s;
  const contextTokens = windowOf(smallest);

  const available = contextTokens - reserveTokens - input.overheadTokens;
  if (available <= 0) {
    throw new Error(
      `LLM backend "${smallest.name}" has a ${contextTokens}-token window, which leaves no room ` +
      `for conversation: reserve ${reserveTokens} + system prompt and tools ${input.overheadTokens} ` +
      `already exceed it. Raise LLM_BACKEND_*_CONTEXT_TOKENS, lower MAX_TOKENS, or shorten prompts/system.md.`
    );
  }
  return { contextTokens, reserveTokens };
}
```

Note: `DEFAULT_CONTEXT_TOKENS[spec.kind]` is total over `BackendKind`, so an unknown provider string reaching the fallback branch yields `undefined`. Guard it:

```ts
export const windowOf = (spec: BackendSpec): number =>
  spec.contextTokens ?? DEFAULT_CONTEXT_TOKENS[spec.kind] ?? DEFAULT_CONTEXT_TOKENS["private-llm"];
```

The fallback is the smallest default on purpose: an unrecognised provider gets the conservative window rather than a 200k assumption that fails at request time.

- [ ] **Step 5: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/llm/registry.ts src/agent/llm/registry.test.ts src/agent/context/resolve-budget.ts src/agent/context/resolve-budget.test.ts
git commit -m "feat(context): per-backend context window, budgeted to the smallest"
```

---

### Task 8: Wire the registry and the assembler into the agent loop

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/app/index.ts:415` (pass the raw alert text as the trigger)
- Test: `src/agent/skills-wiring.test.ts`

**Interfaces:**
- Consumes: `loadSkills`, `resolveSkillsDir`, `Skill` (Tasks 2–3); `assembleRequest` (Task 6); `resolveBudget` (Task 7).
- Produces: `DevOpsAgent.skillsView(): readonly SkillView[]` for Task 10, where
  ```ts
  export interface SkillView { name: string; description: string; when: string; chars: number; body: string }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/agent/skills-wiring.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForThread, MAX_TRACKED_THREADS, type ThreadSkills } from "./index.js";
import { loadSkills, resolveSkillsDir } from "./skills/index.js";

const registry = loadSkills(resolveSkillsDir());

test("a thread accumulates skills and never re-adds one", () => {
  const tracked: ThreadSkills = new Map();
  const first = selectForThread(registry, tracked, "T1", "pod api-7f is OOMKilled");
  assert.ok(first.map((s) => s.name).includes("oomkilled"));
  assert.ok(first.map((s) => s.name).includes("rca-format"));

  const second = selectForThread(registry, tracked, "T1", "still OOMKilled, and now CrashLoopBackOff");
  const names = second.map((s) => s.name);
  assert.equal(names.filter((n) => n === "oomkilled").length, 1, "a skill was added twice");
  assert.ok(names.includes("crashloopbackoff"), "a follow-up symptom did not add its playbook");
});

test("threads are tracked independently", () => {
  const tracked: ThreadSkills = new Map();
  selectForThread(registry, tracked, "T1", "OOMKilled");
  const other = selectForThread(registry, tracked, "T2", "PersistentVolumeClaim is Pending");
  assert.ok(other.map((s) => s.name).includes("pvc-pending"));
  assert.ok(!other.map((s) => s.name).includes("oomkilled"));
});

// A Map keyed by threadId grows for the lifetime of the pod otherwise.
test("the thread map is bounded and evicts the oldest", () => {
  const tracked: ThreadSkills = new Map();
  for (let i = 0; i < MAX_TRACKED_THREADS + 5; i++) selectForThread(registry, tracked, `T${i}`, "OOMKilled");
  assert.equal(tracked.size, MAX_TRACKED_THREADS);
  assert.equal(tracked.has("T0"), false);
  assert.equal(tracked.has(`T${MAX_TRACKED_THREADS + 4}`), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `selectForThread is not exported`.

- [ ] **Step 3: Add the exported helper and the class wiring**

In `src/agent/index.ts`, replace the `trimHistory` import (line 10 area) with:

```ts
import { assembleRequest, sanitizeContentBlocks } from "./context/index.js";
import { resolveBudget } from "./context/resolve-budget.js";
import { estimateTokens, type Budget } from "./context/budget.js";
import { loadSkills, resolveSkillsDir, type Skill, type SkillRegistry } from "./skills/index.js";
```

Add near `MAX_ITERATIONS` (line 38):

```ts
// Per-thread skill sets live in memory, like ConversationMemory's rcaThreads. Bounded so a
// long-running pod cannot accumulate one entry per thread it has ever seen; eviction is
// insertion-order, and a thread that outlives its entry simply re-selects from its next message.
export const MAX_TRACKED_THREADS = 500;

export type ThreadSkills = Map<string, Skill[]>;

/** What the dashboard renders. Strings only — no RegExp crosses this boundary. */
export interface SkillView {
  name: string;
  description: string;
  when: string;
  chars: number;
  body: string;
}

/**
 * Selects the skills for one incoming message and folds them into the thread's running set.
 * Exported for the wiring test — the class method is a thin caller.
 */
export function selectForThread(
  registry: SkillRegistry,
  tracked: ThreadSkills,
  threadId: string,
  trigger: string
): Skill[] {
  const known = tracked.get(threadId) ?? [];
  const { selected, overflow } = registry.select(trigger, new Set(known.map((s) => s.name)));
  if (overflow.length > 0) {
    logger.info(`[${threadId}] skills over the cap, not loaded: ${overflow.join(", ")}`);
  }
  const merged = selected.length > 0 ? [...known, ...selected] : known;

  tracked.delete(threadId); // re-insert so this thread becomes the most recent
  tracked.set(threadId, merged);
  while (tracked.size > MAX_TRACKED_THREADS) {
    const oldest = tracked.keys().next().value;
    if (oldest === undefined) break;
    tracked.delete(oldest);
  }
  return merged;
}
```

Add the fields to `DevOpsAgent` (after `private gitops` at line 65):

```ts
  private readonly skills: SkillRegistry;
  private readonly threadSkills: ThreadSkills = new Map();
  private budget: Budget;
```

In the constructor (after line 75):

```ts
    // Throws here rather than at first request: a malformed skill file must be a pod that
    // refuses to start. src/agent/skills/real.test.ts loads this same directory, so a bad file
    // fails npm test long before it reaches a cluster.
    this.skills = loadSkills(resolveSkillsDir());
    for (const s of this.skills.all()) {
      logger.info(`[skills] ${s.name} (${s.chars} chars, when=${s.when === "always" ? "always" : s.when.source}) — ${s.description}`);
    }
    // Provisional: tools are unknown until MCP connects, so initialize() recomputes it.
    this.budget = resolveBudget({
      registry: null, provider: config.llm.provider,
      maxTokens: config.llm.maxTokens, overheadTokens: estimateTokens(buildStaticSystemPrompt()),
    });
```

At the end of `initialize()` (after line 99), once the tool list is known:

```ts
    const tools = this.mcp.getTools();
    this.budget = resolveBudget({
      registry: config.llm.provider === "router" ? parseRegistry(process.env) : null,
      provider: config.llm.provider,
      maxTokens: config.llm.maxTokens,
      overheadTokens: estimateTokens(buildStaticSystemPrompt()) + estimateTokens(JSON.stringify(tools)),
    });
    logger.info(`[context] budget: ${this.budget.contextTokens} token window, ${this.budget.reserveTokens} reserved for output`);
```

Add `import { parseRegistry } from "./llm/registry.js";` to the imports if it is not already there.

Add the dashboard accessor beside `mcpTools()` (line 105):

```ts
  // The registered skills, for the dashboard's /context page. Read-only and already in memory —
  // this makes no call. Strings only: the dashboard never sees a RegExp.
  skillsView(): readonly SkillView[] {
    return this.skills.all().map((s) => ({
      name: s.name,
      description: s.description,
      when: s.when === "always" ? "always" : s.when.source,
      chars: s.chars,
      body: s.body,
    }));
  }
```

- [ ] **Step 4: Use it in the investigation loop**

In `runInvestigation`, change the signature's `opts` (line 166) and `investigate` (line 162) to carry the trigger:

```ts
  investigate(threadId: string, userMessage: string, opts: { maxToolRounds?: number; trigger?: string } = {}): Promise<string> {
    return withTrace(threadId, () => this.runInvestigation(threadId, userMessage, opts));
  }

  private async runInvestigation(threadId: string, userMessage: string, opts: { maxToolRounds?: number; trigger?: string } = {}): Promise<string> {
```

After `await this.memory.append(...)` (line 187), add:

```ts
    // Matched on the alert text alone, not on userMessage: src/app/index.ts prepends recalled
    // prior incidents, and a previous incident's RCA must not select this one's playbook.
    const skills = selectForThread(this.skills, this.threadSkills, threadId, opts.trigger ?? userMessage);
```

Replace lines 206-212 with:

```ts
      const assembled = assembleRequest({
        history: await this.memory.get(threadId),
        systemPrompt,
        tools: toolsDisabled ? [] : tools,
        skills,
        budget: this.budget,
      });
      logger.debug(
        `[${threadId}] LLM call #${iterations} (history: ${assembled.messages.length} messages, ` +
        `-${assembled.messagesDropped} over budget, ~${assembled.estimatedTokens} tokens, ` +
        `skills: [${assembled.skillsUsed.join(", ") || "none"}]` +
        (assembled.skillsDropped.length > 0 ? `, dropped: [${assembled.skillsDropped.join(", ")}]` : "") + ")"
      );
      if (assembled.skillsDropped.length > 0) {
        logger.warn(`[${threadId}] context budget dropped skills: ${assembled.skillsDropped.join(", ")}`);
      }
      // The floor: the first and the most recent message are pinned unconditionally, so a single
      // enormous tool result can put the request over the window with nothing left to drop. Say so
      // and send it anyway — a visible 400 from the backend beats inventing a truncation that
      // hides which evidence went missing.
      const available = this.budget.contextTokens - this.budget.reserveTokens;
      if (assembled.estimatedTokens > available) {
        logger.warn(
          `[${threadId}] context over budget: ~${assembled.estimatedTokens} tokens vs ${available} ` +
          `available — pinned messages alone exceed the window, sending anyway`
        );
      }

      const llmStart = Date.now();
      let response;
      try {
        response = await this.llm.chat(assembled.messages, toolsDisabled ? [] : tools, assembled.systemPrompt);
```

- [ ] **Step 5: Pass the raw alert text from the webhook path**

In `src/app/index.ts:415`, change:

```ts
      const rca = toMrkdwn(await this.agent.investigate(threadId, fullIssue, { trigger: issueText }));
```

- [ ] **Step 6: Run the tests and the build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -30
npm --prefix /Users/annasik/riset/devops-ai-agent run build 2>&1 | tail -20
```

Expected: both PASS. Fix any remaining import of the deleted `trimHistory` / `truncateToolResult`.

- [ ] **Step 7: Commit**

```bash
git add src/agent/index.ts src/agent/skills-wiring.test.ts src/app/index.ts
git commit -m "feat(agent): select skills per thread and assemble every request to a budget"
```

---

### Task 9: Remove the moved sections from `prompts/system.md`

**Files:**
- Modify: `prompts/system.md`
- Test: `src/agent/skills/real.test.ts` (append)

**Interfaces:**
- Consumes: `prompts/skills/*.md` from Task 3, now injected by Task 8.
- Produces: a system prompt with no failure-mode playbooks and no RCA output format.

- [ ] **Step 1: Write the failing test**

Append to `src/agent/skills/real.test.ts`:

```ts
import { buildStaticSystemPrompt } from "../prompts/system.js";

// The content moved; it must not also stay. A section present in both places is sent twice and
// drifts the moment one copy is edited.
test("the moved sections are gone from the system prompt and live only in skills", () => {
  const prompt = buildStaticSystemPrompt();
  assert.doesNotMatch(prompt, /## Failure Mode Playbooks/);
  assert.doesNotMatch(prompt, /## RCA Output Format/);
  assert.doesNotMatch(prompt, /### CrashLoopBackOff/);

  const bodies = loadSkills(resolveSkillsDir()).all().map((s) => s.body).join("\n");
  assert.match(bodies, /Terminated: OOMKilled \(exit 137\)/);
  assert.match(bodies, /\*🔧 Recommended Actions\*/);
});

// The cookbook stays: a trigger built from alert text cannot know whether a PromQL query is
// coming, and a wrong guess removes the query patterns exactly when they are needed.
test("the tool usage reference stays in the core prompt", () => {
  assert.match(buildStaticSystemPrompt(), /## Tool Usage Reference/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — the prompt still contains `## Failure Mode Playbooks`.

- [ ] **Step 3: Delete the two sections**

From `prompts/system.md`, delete:
- Lines 106–185 inclusive — the `## Failure Mode Playbooks` heading, its one-line intro, and all twelve `### …` playbooks, up to but NOT including `## Tool Usage Reference`.
- Lines 302–348 inclusive — the `## RCA Output Format` heading and everything under it to end of file.

  `prompts/system.md` has **no trailing newline**, so `wc -l` reports 347 while the file actually holds 348 lines. Line 348 is `*📈 Confidence:* ...`, the last line of the RCA template. Count with `awk 'END{print NR}'`, not `wc -l`; a delete that stops at 347 orphans that line in the middle of the prompt. It is the same range Task 3 copied into `prompts/skills/rca-format.md`, so verify `grep -c Confidence prompts/system.md` returns 0 after the delete.

Then append this pointer where the RCA section used to be, so the core prompt still names the contract it no longer carries:

```markdown
## RCA Output Format

The exact section labels, the Slack mrkdwn rules and the worked template arrive as a skill in the
first user message. Follow them verbatim — they are what the Slack renderer and the dashboard
parse. If no such skill is present, still answer with `*📍 Root Cause*`, `*📊 Evidence*` and
`*🔧 Recommended Actions*` sections.
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
wc -l /Users/annasik/riset/devops-ai-agent/prompts/system.md
```

Expected: PASS, and `system.md` is roughly 270 lines.

- [ ] **Step 5: Commit**

```bash
git add prompts/system.md src/agent/skills/real.test.ts
git commit -m "refactor(prompts): playbooks and RCA format now live only in prompts/skills"
```

---

### Task 10: The dashboard view builder

**Files:**
- Create: `src/dashboard/context.ts`, `src/dashboard/context.test.ts`

**Interfaces:**
- Consumes: the `SkillView` shape from Task 8 — **redeclared here, deliberately not imported**, the same seam `McpTool` uses in `topology.ts` so neither side owns the other's types; `estimateTokens`, `BUDGET_SAFETY_MARGIN`, `DEFAULT_CONTEXT_TOKENS` (Task 4); `parseRegistry` (Task 7); `buildStaticSystemPrompt()`; `config`.
- Produces:
  ```ts
  export interface SkillView { name: string; description: string; when: string; chars: number; body: string }
  export interface BackendBudget { name: string; model: string; window: number; reserve: number; core: number; tools: number; available: number }
  export interface ContextView {
    core: { lines: number; chars: number; tokens: number };
    skills: SkillView[];
    backends: BackendBudget[];
    effective: { backend: string; available: number };
  }
  export function buildContextView(skills: readonly SkillView[], toolCount: number, toolsJson: string): ContextView;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/context.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextView } from "./context.js";

const skills = [
  { name: "rca-format", description: "The RCA shape", when: "always", chars: 1800, body: "*Root Cause*" },
  { name: "oomkilled", description: "Killed at its limit", when: "oomkill|exit code 137", chars: 900, body: "1. describe" },
];

test("reports the core prompt as it is actually sent", () => {
  const v = buildContextView(skills, 0, "[]");
  assert.ok(v.core.lines > 100, "system.md should be a few hundred lines");
  assert.ok(v.core.tokens > 0);
  assert.equal(v.core.tokens, Math.ceil(v.core.chars / 3));
});

test("passes the skills through unchanged", () => {
  assert.deepEqual(buildContextView(skills, 0, "[]").skills, skills);
});

test("every backend gets a row, and available is what is left for conversation", () => {
  const v = buildContextView(skills, 4, JSON.stringify([{ name: "k8s_list_pods" }]));
  assert.ok(v.backends.length >= 1);
  for (const b of v.backends) {
    assert.equal(b.available, b.window - b.reserve - b.core - b.tools);
  }
});

// The number that actually governs: the router picks after the request is built, so the request
// has to fit the smallest window.
test("the effective budget names the smallest backend", () => {
  const v = buildContextView(skills, 0, "[]");
  const smallest = v.backends.reduce((a, b) => (b.available < a.available ? b : a));
  assert.equal(v.effective.backend, smallest.name);
  assert.equal(v.effective.available, smallest.available);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './context.js'`.

- [ ] **Step 3: Implement**

Create `src/dashboard/context.ts`:

```ts
import { buildStaticSystemPrompt } from "../agent/prompts/system.js";
import { estimateTokens, BUDGET_SAFETY_MARGIN, DEFAULT_CONTEXT_TOKENS } from "../agent/context/budget.js";
import { parseRegistry } from "../agent/llm/registry.js";
import { config } from "../config/index.js";

// The dashboard's own shape, like McpTool in topology.ts: strings and numbers only, so neither
// side imports the other's types and no RegExp ever reaches a template.
export interface SkillView {
  name: string;
  description: string;
  when: string;
  chars: number;
  body: string;
}

export interface BackendBudget {
  name: string;
  model: string;
  window: number;
  reserve: number;
  core: number;
  tools: number;
  available: number;
}

export interface ContextView {
  core: { lines: number; chars: number; tokens: number };
  skills: SkillView[];
  backends: BackendBudget[];
  /** The smallest window — the one every request is actually built to fit. */
  effective: { backend: string; available: number };
}

/**
 * Everything on /context, computed from config and the in-memory registry. Reads no database and
 * makes no call, which is what lets the page render while Postgres is down.
 */
export function buildContextView(
  skills: readonly SkillView[],
  toolCount: number,
  toolsJson: string
): ContextView {
  const prompt = buildStaticSystemPrompt();
  const core = {
    lines: prompt.split("\n").length,
    chars: prompt.length,
    tokens: estimateTokens(prompt),
  };
  const toolTokens = toolCount > 0 ? estimateTokens(toolsJson) : 0;
  const reserve = config.llm.maxTokens + BUDGET_SAFETY_MARGIN;

  const single = [{
    name: config.llm.provider,
    kind: config.llm.provider as keyof typeof DEFAULT_CONTEXT_TOKENS,
    model: undefined as string | undefined,
    contextTokens: undefined as number | undefined,
  }];
  // Same fallback topology.ts makes for its registryError: a registry that will not parse is
  // worth a degraded page, not a 500 — and this page is where an operator would go to see why.
  let specs;
  try {
    specs = config.llm.provider === "router" ? parseRegistry(process.env).backends : single;
  } catch {
    specs = single;
  }

  const backends: BackendBudget[] = specs.map((s) => {
    const window = s.contextTokens ?? DEFAULT_CONTEXT_TOKENS[s.kind] ?? DEFAULT_CONTEXT_TOKENS["private-llm"];
    return {
      name: s.name,
      model: s.model ?? "—",
      window,
      reserve,
      core: core.tokens,
      tools: toolTokens,
      available: window - reserve - core.tokens - toolTokens,
    };
  });

  const smallest = backends.reduce((a, b) => (b.available < a.available ? b : a));
  return { core, skills: [...skills], backends, effective: { backend: smallest.name, available: smallest.available } };
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/context.ts src/dashboard/context.test.ts
git commit -m "feat(dashboard): build the /context view from the registry and the budget"
```

---

### Task 11: The `/context` page, route and nav

**Files:**
- Modify: `src/dashboard/views.ts`, `src/dashboard/server.ts`, `src/dashboard/styles.ts`, `index.ts`
- Test: `src/dashboard/views.test.ts`, `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `ContextView`, `buildContextView` (Task 10); `agent.skillsView()` (Task 8); `table`, `headers`, `cell`, `esc`, `layout`, `section` from the existing dashboard helpers.
- Produces: `export function contextPage(v: ContextView): string;` and `Route["kind"]` gains `"context"`.

- [ ] **Step 1: Write the failing test**

Append to `src/dashboard/views.test.ts`:

```ts
import { contextPage } from "./views.js";
import type { ContextView } from "./context.js";

const CTX: ContextView = {
  core: { lines: 267, chars: 24_100, tokens: 8_034 },
  skills: [
    { name: "rca-format", description: "The exact Slack mrkdwn shape every RCA must take", when: "always", chars: 1_820, body: "*📍 Root Cause*\none paragraph" },
    { name: "oomkilled", description: "First tool calls for a container killed at its memory limit", when: "oomkill|exit code 137", chars: 940, body: "1. k8s_describe_pod" },
  ],
  backends: [
    { name: "heavy", model: "claude-opus-5", window: 200_000, reserve: 9_120, core: 8_034, tools: 4_100, available: 178_746 },
    { name: "light", model: "qwen2.5-32b-instruct", window: 32_000, reserve: 9_120, core: 8_034, tools: 4_100, available: 10_746 },
  ],
  effective: { backend: "light", available: 10_746 },
};

// The skills table holds sentences; the budget table holds seven short numbers. Which narrow
// layout each takes is decided by what the cells hold, and it only shows at 390px.
test("each context table takes the narrow layout its own cells call for", () => {
  const html = contextPage(CTX);
  assert.equal([...html.matchAll(/<table role="table" data-stack>/g)].length, 1, "the skills table");
  assert.equal([...html.matchAll(/<table role="table" data-stack data-pairs>/g)].length, 1, "the budget table");

  for (const t of html.matchAll(/<table role="table" data-stack(?: data-pairs)?>([\s\S]*?)<\/table>/g)) {
    const heads = [...t[1].matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
    const labels = [...t[1].matchAll(/<td role="cell"[^>]*data-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(labels.length % heads.length, 0, "a row is missing a captioned cell");
    for (const l of labels) assert.ok(heads.includes(l), `caption ${l} names no column of this table`);
  }
});

test("the page runs no JavaScript — the claim its CSP makes", () => {
  assert.doesNotMatch(contextPage(CTX), /<script/i);
});

test("a skill body is readable without leaving the page", () => {
  const html = contextPage(CTX);
  assert.match(html, /<details><summary>First tool calls for a container killed at its memory limit<\/summary>/);
  assert.match(html, /<pre>1\. k8s_describe_pod<\/pre>/);
});

test("the effective budget is stated, not left to be inferred from the table", () => {
  assert.match(contextPage(CTX), /light/);
  assert.match(contextPage(CTX), /10,?746/);
});

// Assert the escaped form is PRESENT — asserting the raw form is absent passes on a blank page.
test("a skill body and a regex are escaped, not rendered", () => {
  const html = contextPage({
    ...CTX,
    skills: [{ name: "x", description: 'a "quoted" one', when: '5xx|<b>|"q"', chars: 10, body: "<script>alert(1)</script>" }],
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /5xx\|&lt;b&gt;\|&quot;q&quot;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("the nav offers Context and marks it current on its own page", () => {
  assert.match(contextPage(CTX), /<a href="\/context" aria-current="page">/);
});
```

Append to `src/dashboard/server.test.ts`:

```ts
test("/context is a route, and a trailing slash is the same route", () => {
  assert.deepEqual(matchRoute("/context"), { kind: "context" });
  assert.deepEqual(matchRoute("/context/"), { kind: "context" });
});

// The read-only invariant, asserted rather than assumed. A route absent from METHODS answers 405
// to every method but GET, so the assertion is the absence: only login and logout accept anything
// else, and both act on the session rather than on data. Asserted against the table instead of
// over a live socket — the table IS the rule, and this cannot flake on a port.
test("only the session routes accept a non-GET method", () => {
  assert.deepEqual(Object.keys(METHODS).sort(), ["login", "logout"]);
  assert.equal("context" in METHODS, false);
});
```

Add `METHODS` to that file's existing `./server.js` import. `matchRoute` is already exported (`server.ts:26`); `METHODS` is not — Step 6 exports it.

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -20
```

Expected: FAIL — `contextPage is not exported`.

- [ ] **Step 3: Add the icon and the nav entry**

In `src/dashboard/views.ts`, add to `ICON` beside `topology` (around line 35):

```ts
  context: ico(
    `<path d="M4 5.4A1.8 1.8 0 0 1 5.8 3.6H19v13.6H5.8A1.8 1.8 0 0 0 4 19v-13.6Z"/>` +
      `<path d="M4 19a1.8 1.8 0 0 0 1.8 1.8H19"/><path d="M8.4 8h6.4"/><path d="M8.4 11.6h4.2"/>`
  ),
```

And a fourth `NAV` entry (line 75):

```ts
const NAV = [
  { href: "/", label: "Overview", icon: ICON.overview },
  { href: "/incidents", label: "Incidents", icon: ICON.incidents },
  { href: "/topology", label: "Topology", icon: ICON.topology },
  { href: "/context", label: "Context", icon: ICON.context },
];
```

- [ ] **Step 4: Add `contextPage`**

Append to `src/dashboard/views.ts`:

```ts
const num = (n: number): string => n.toLocaleString("en-US");

// A skill row is a name, a pattern, a size and a sentence — the sentence is what makes this a
// stack rather than pairs. The body hangs off the description in a <details>: native disclosure,
// no JavaScript, and the summary is already the line the reader wanted.
function skillRows(skills: ContextView["skills"]): string {
  // No empty state on purpose: loadSkills throws at boot on a directory with no .md files, so a
  // running agent always has skills. An "empty" table here would be a state the process cannot
  // reach — do not add one later.
  return table(
    headers("Skill", "When", "Size", "Description"),
    skills
      .map((s) =>
        `<tr role="row">` +
        cell("Skill", `<code translate="no">${esc(s.name)}</code>`) +
        cell("When", s.when === "always"
          ? `<span class="badge">ALWAYS</span>`
          : `<code translate="no">${esc(s.when)}</code>`) +
        cell("Size", `${num(s.chars)} chars`) +
        cell("Description",
          `<details><summary>${esc(s.description)}</summary><pre>${esc(s.body)}</pre></details>`) +
        `</tr>`
      )
      .join(""),
    "stack"
  );
}

// Seven short numbers and two identifiers: the spec-sheet shape pairs was built for.
function budgetRows(backends: ContextView["backends"]): string {
  return table(
    headers("Backend", "Model", "Window", "Reserve", "Core", "Tools", "Available"),
    backends
      .map((b) =>
        `<tr role="row">` +
        cell("Backend", `<code translate="no">${esc(b.name)}</code>`) +
        cell("Model", `<code translate="no">${esc(b.model)}</code>`) +
        cell("Window", num(b.window)) +
        cell("Reserve", num(b.reserve)) +
        cell("Core", num(b.core)) +
        cell("Tools", num(b.tools)) +
        cell("Available", num(b.available)) +
        `</tr>`
      )
      .join(""),
    "pairs"
  );
}

export function contextPage(v: ContextView): string {
  return layout(
    "Context",
    `<h1>Context and skills</h1>
     <p class="meta">What this agent knows before it reads a single metric, and how much room it
       has to say it. Read from the running process — no database, no call leaves it.</p>

     ${section(ICON.layers, "Core prompt")}
     <p class="meta"><code translate="no">prompts/system.md</code> — ${num(v.core.lines)} lines,
       ${num(v.core.chars)} chars, about ${num(v.core.tokens)} tokens. Sent on every iteration of
       every investigation.</p>

     ${section(ICON.context, "Skills")}
     <p class="meta">Selected from the alert text and carried in the first user message, never in
       the system prompt — a system prompt that varied per investigation would miss the model's
       prompt cache on every call. Expand a description to read the skill itself.</p>
     ${skillRows(v.skills)}

     ${section(ICON.chip, "Budget per backend")}
     <p class="meta">Every request is built to fit <code translate="no">${esc(v.effective.backend)}</code>,
       the smallest window — about ${num(v.effective.available)} tokens for skills and conversation.
       The router picks a backend after the request is assembled, so the request has to fit the
       smallest one it might land in.</p>
     ${budgetRows(v.backends)}`,
    "/context"
  );
}
```

Add `import type { ContextView } from "./context.js";` to the imports at the top of `views.ts`.

- [ ] **Step 5: Style the disclosure**

In `src/dashboard/styles.ts`, add near the other table rules (outside any container query — this applies at every width):

```css
/* A playbook is preformatted text in a table cell. Without these two, one long PromQL line
   pushes the whole page sideways at 390px — and `pre` does not wrap by default. */
td details > pre {
  white-space: pre-wrap;
  overflow-x: auto;
  margin: .5rem 0 0;
  font-size: .82rem;
  line-height: 1.5;
}
td details > summary { cursor: pointer; }
```

Remember `STYLES` is a template literal — do not introduce a backtick.

- [ ] **Step 6: Add the route and the handler**

In `src/dashboard/server.ts`, extend the union (line 23):

```ts
export type Route =
  | { kind: "overview" | "list" | "health" | "notfound" | "topology" | "context" | "login" | "logout" }
  | { kind: "detail"; id: number };
```

Add to `matchRoute` beside the topology line (line 33):

```ts
  if (p === "/context") return { kind: "context" };
```

Export `METHODS` so the invariant can be asserted directly (`server.ts:51`):

```ts
export const METHODS: Partial<Record<Route["kind"], readonly string[]>> = {
```

Do **not** add `context` to it — the absence of `context` there is what makes the page GET-only.

Add the constructor parameter (line 90) and field (line 82):

```ts
  private readonly skills: () => readonly SkillView[];

  constructor(
    queries?: DashboardQueries,
    mcpTools?: () => readonly McpTool[],
    skills?: () => readonly SkillView[]
  ) {
    this.queries = queries ?? new DashboardQueries();
    this.mcpTools = mcpTools ?? (() => []);
    this.skills = skills ?? (() => []);
  }
```

Add the handler beside the topology one (after line 322), before the database gate — this page reads no database either:

```ts
    if (route.kind === "context") {
      const tools = this.mcpTools();
      return send(
        200,
        contextPage(buildContextView(this.skills(), tools.length, JSON.stringify(tools))),
        "text/html; charset=utf-8"
      );
    }
```

Add the imports: `contextPage` to the `./views.js` import (line 7), and `import { buildContextView, type SkillView } from "./context.js";`.

- [ ] **Step 7: Wire the agent's registry in**

In `index.ts` at the repo root, line 15:

```ts
    const dashboard = new DashboardServer(undefined, () => agent.mcpTools(), () => agent.skillsView());
```

- [ ] **Step 8: Run the tests and the build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -30
npm --prefix /Users/annasik/riset/devops-ai-agent run build 2>&1 | tail -20
```

Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/views.ts src/dashboard/views.test.ts src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/styles.ts index.ts
git commit -m "feat(dashboard): read-only /context page for the skill registry and the budget"
```

---

### Task 12: Documentation

**Files:**
- Modify: `CLAUDE.md`, `MEMORY_BANK.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update `CLAUDE.md`**

Add to the architecture section, after the existing context/prompt notes:

```markdown
- **Skills** (`prompts/skills/*.md`, loaded by `src/agent/skills/`) are prompt content selected
  per investigation: flat `name`/`description`/`when` frontmatter, hand-parsed (no YAML dep), body
  injected verbatim. `when` is `always` or a case-insensitive regex over the alert text. Boot
  throws on any malformation — `src/agent/skills/real.test.ts` loads the shipped directory, so a
  bad file fails `npm test` rather than a deploy.
- **Skills ride in the first user message, never in `systemPrompt`.** `llm/claude.ts:26-32` caches
  the whole system prompt as one ephemeral block; a system prompt that varied per investigation
  would be a full cache miss plus a rewrite at 1.25×. This also leaves the SQS contract untouched.
  `context/index.test.ts` asserts the prompt is byte-identical across different skill sets — that
  test is the guard, do not weaken it.
- **The context budget is the SMALLEST backend window**, resolved once at boot
  (`context/resolve-budget.ts`). The router picks a backend after the request is built, so the
  request has to fit the smallest one it might land in. Under pressure skills drop before history:
  history is evidence already gathered, a skill is advice.
- **Tool results are compacted at ingest** (`context/compact.ts`), so Redis holds the compacted
  form and the raw output is not recoverable. Only *consecutive* runs collapse — a global dedupe
  would merge two phases of an incident.
```

- [ ] **Step 2: Update `MEMORY_BANK.md`**

Add a section describing: the three-module split (`skills/`, `context/budget.ts`, `context/compact.ts`); the twelve playbooks + `rca-format` file list; why the Tool Usage Reference stayed in the core prompt; the `/context` page's two tables and which narrow layout each takes and why; and the empty-skills-directory boot error and the reasoning behind it. Match the file's existing voice — reasons, not restated code.

- [ ] **Step 3: Verify the whole suite and the build one last time**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm --prefix /Users/annasik/riset/devops-ai-agent test 2>&1 | tail -10
npm --prefix /Users/annasik/riset/devops-ai-agent run build 2>&1 | tail -10
```

Expected: all tests pass, build clean.

- [ ] **Step 4: Refresh the knowledge graph**

```bash
cd /Users/annasik/riset && graphify update .
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md MEMORY_BANK.md
git commit -m "docs: context assembly, skills and the /context page"
```
