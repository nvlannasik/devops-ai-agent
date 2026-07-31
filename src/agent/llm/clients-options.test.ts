import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";

// Only `model` is asserted. apiKey/baseUrl are handed to the vendor SDKs, which expose no
// stable public accessor for them — reaching into SDK internals would test the SDK, not us.
// Task 3 covers that the registry passes those fields through.

test("ClaudeClient takes a per-instance model", () => {
  const c = new ClaudeClient({ apiKey: "test-key", model: "claude-opus-5" });
  assert.equal(c.model, "claude-opus-5");
});

test("two ClaudeClients can hold different models", () => {
  const a = new ClaudeClient({ apiKey: "test-key", model: "model-a" });
  const b = new ClaudeClient({ apiKey: "test-key", model: "model-b" });
  assert.equal(a.model, "model-a");
  assert.equal(b.model, "model-b");
});

test("OpenAICompatibleClient takes a per-instance model", () => {
  const c = new OpenAICompatibleClient({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "test-key",
    model: "qwen/qwen3-235b",
  });
  assert.equal(c.model, "qwen/qwen3-235b");
});
