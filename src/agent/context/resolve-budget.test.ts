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

// Why every caller must pass the parsed registry when the provider is "router", never null:
// "router" is not a BackendKind, so windowOf falls through its last `??` to the 32k private-llm
// default and the same config that resolves to 128k with a registry blows up without one. The
// error even names a backend that does not exist. See src/agent/index.ts:134-142.
test("a router provider with no registry collapses to the 32k floor and can throw", () => {
  const overheadTokens = 7_528; // prompts/system.md as it stands
  assert.equal(
    resolveBudget({ registry: null, provider: "router", maxTokens: 8096, overheadTokens }).contextTokens,
    32_000
  );
  assert.throws(
    () => resolveBudget({ registry: null, provider: "router", maxTokens: 23_448, overheadTokens }),
    /backend "router"/
  );
  // The same MAX_TOKENS against the real registry is comfortable — the null was the whole problem.
  assert.equal(
    resolveBudget({
      registry: reg({ name: "sonnet", kind: "claude" }, { name: "chatgpt", kind: "openai-compatible" }),
      provider: "router", maxTokens: 23_448, overheadTokens,
    }).contextTokens,
    128_000
  );
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
