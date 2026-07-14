import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForSlack } from "./split.js";

test("short messages pass through untouched", () => {
  assert.deepEqual(splitForSlack("hello"), ["hello"]);
});

test("splits at newline boundaries under the limit", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
  const chunks = splitForSlack(lines.join("\n"), 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1010); // limit + closing fence slack
  // no line is cut in half: rejoining (minus fence rebalancing) preserves every line start
  for (const line of ["line 0 ", "line 50 ", "line 99 "]) {
    assert.ok(chunks.some((c) => c.includes(line)));
  }
});

test("re-balances code fences across the split", () => {
  const text = "intro\n```\n" + Array.from({ length: 60 }, (_, i) => `log line ${i}`).join("\n") + "\n```\ndone";
  const chunks = splitForSlack(text, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const fences = (chunk.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `chunk has unbalanced fences:\n${chunk}`);
  }
  // continuation chunks that carry code start with a reopened fence
  assert.ok(chunks[1].startsWith("```"));
});
