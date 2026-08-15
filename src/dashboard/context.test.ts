import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextView, backendSpecs } from "./context.js";

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

// The three above run on whatever single backend the test env configures, so none of them can see
// a second row. These drive the specs in directly.
test("every backend gets its own row, and the smallest window governs", () => {
  const v = buildContextView(skills, 0, "[]", [
    { name: "light", kind: "openai-compatible", model: "qwen3-32b", contextTokens: 32_000 },
    { name: "heavy", kind: "claude", model: "claude-opus-5", contextTokens: 200_000 },
  ]);
  assert.deepEqual(v.backends.map((b) => b.name), ["light", "heavy"]);
  assert.equal(v.backends[0]!.window, 32_000);
  assert.equal(v.backends[1]!.window, 200_000);
  // Hand-computed rather than re-derived with the implementation's own reduce: a test that
  // recomputes the comparison the same way passes even when the comparison is backwards.
  assert.equal(v.effective.backend, "light");
  assert.equal(v.effective.available, 32_000 - v.backends[0]!.reserve - v.core.tokens);
});

test("a router registry contributes one spec per backend", () => {
  const specs = backendSpecs("router", {
    LLM_BACKEND_1_NAME: "light", LLM_BACKEND_1_KIND: "openai-compatible",
    LLM_BACKEND_1_MODEL: "qwen3-32b", LLM_BACKEND_1_KEY: "x",
    LLM_BACKEND_1_BASE_URL: "http://vllm", LLM_BACKEND_1_CONTEXT_TOKENS: "32000",
    LLM_BACKEND_2_NAME: "heavy", LLM_BACKEND_2_KIND: "claude",
    LLM_BACKEND_2_MODEL: "claude-opus-5", LLM_BACKEND_2_KEY: "y",
    LLM_ROUTE_HEAVY: "heavy",
  });
  assert.deepEqual(specs.map((s) => s.name), ["light", "heavy"]);
  assert.equal(specs[0]!.contextTokens, 32_000);
});

// A registry that will not parse is a degraded page, not a 500. parseRegistry throws on an empty
// env ("router requires at least LLM_BACKEND_1_NAME"), which is the cheapest way to reach the catch.
test("a registry that will not parse degrades to one row", () => {
  assert.deepEqual(backendSpecs("router", {}).map((s) => s.name), ["router"]);
});

// Not "router", so the registry is never consulted at all — the env below would throw if it were.
test("a single-provider deployment never parses a registry", () => {
  assert.deepEqual(backendSpecs("claude", { LLM_BACKEND_1_NAME: "nope" }).map((s) => s.name), ["claude"]);
});
