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
    // That identity is self-consistent and survives the behaviour being deleted: it still holds
    // when the core prompt and the tool schemas are dropped from BOTH sides and reported as 0.
    // Pin them to the real numbers, or the row can claim a window nothing is subtracted from.
    assert.equal(b.core, v.core.tokens);
    assert.ok(b.tools > 0, "the tool schemas are not counted against the window");
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
