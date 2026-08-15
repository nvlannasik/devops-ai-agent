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
