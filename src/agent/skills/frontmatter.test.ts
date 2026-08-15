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
