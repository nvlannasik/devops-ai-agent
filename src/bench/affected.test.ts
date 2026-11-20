import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadSkills } from "../agent/skills/index.js";
import { loadCases } from "./case.js";
import { SMOKE, describe, filterOf, selectCases } from "./affected.js";

// The real catalog and the real skills: the selection is only worth something if it is the one
// production's selector makes.
const cases = loadCases(join(process.cwd(), "bench", "cases"));
const registry = loadSkills(join(process.cwd(), "prompts", "skills"));
const ids = (files: string[]) => [...selectCases(files, cases, registry).cases.keys()].sort();

test("a playbook selects the cases whose alert text triggers it, through the agent's own selector", () => {
  const got = ids(["prompts/skills/node-pressure.md"]);
  assert.ok(got.includes("C15-control-plane-memory-outside-pods"), got.join(","));
  assert.ok(!got.some((id) => id.startsWith("A01")), "a crashloop case does not load node-pressure");
});

test("a mode-keyed skill and the system prompt are wide: the smoke set, never the full catalog", () => {
  for (const f of ["prompts/skills/rca-format.md", "prompts/system.md", "src/agent/loop/answer-gates.ts"]) {
    const got = ids([f]);
    assert.equal(got.length, SMOKE.length, f);
    assert.ok(got.length < cases.length);
  }
  // every smoke prefix still names a case — a renamed case must not silently shrink the set
  for (const p of SMOKE) assert.ok(cases.some((c) => c.id.startsWith(`${p}-`)), p);
});

test("a case's own files select that case; tests, docs and the app layer select nothing", () => {
  assert.deepEqual(ids(["bench/cases/C15-control-plane-memory-outside-pods/case.json"]), ["C15-control-plane-memory-outside-pods"]);
  const sel = selectCases(["src/agent/vm/tools.test.ts", "docs/x.md", "src/app/feedback.ts", "src/dashboard/nodes.ts"], cases, registry);
  assert.equal(sel.cases.size, 0);
  assert.deepEqual(sel.unmapped, []);
});

test("node code selects the node cases; a file no rule names is reported, not dropped", () => {
  const sel = selectCases(["src/agent/remediation/unsafe-advice.ts", "src/utils/something-new.ts"], cases, registry);
  const got = [...sel.cases.keys()];
  assert.ok(got.includes("C15-control-plane-memory-outside-pods"));
  assert.ok(got.every((id) => /node|C1[2-6]/i.test(id)), got.join(","));
  assert.deepEqual(sel.unmapped, ["src/utils/something-new.ts"]);
  assert.match(describe(sel.cases.get("C15-control-plane-memory-outside-pods")!), /node code: src\/agent\/remediation\/unsafe-advice\.ts/);
});

test("the filter is anchored catalog numbers", () => {
  const f = filterOf(["C15-control-plane-memory-outside-pods", "A01-crashloop-missing-config-key"]);
  assert.equal(f, "^(A01|C15)-");
  assert.ok(new RegExp(f).test("A01-crashloop-missing-config-key"));
  assert.ok(!new RegExp(f).test("A10-service-no-endpoints"));
});
