import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistry, buildBackends } from "./registry.js";
import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";

const valid = {
  LLM_BACKEND_1_NAME: "opus",
  LLM_BACKEND_1_KIND: "claude",
  LLM_BACKEND_1_MODEL: "claude-opus-5",
  LLM_BACKEND_1_KEY: "sk-ant-test",
  LLM_BACKEND_2_NAME: "or",
  LLM_BACKEND_2_KIND: "openai-compatible",
  LLM_BACKEND_2_BASE_URL: "https://openrouter.ai/api/v1",
  LLM_BACKEND_2_MODEL: "qwen/qwen3-235b",
  LLM_BACKEND_2_KEY: "sk-or-test",
  LLM_BACKEND_3_NAME: "qwen",
  LLM_BACKEND_3_KIND: "private-llm",
  LLM_ROUTE_HEAVY: "opus,or",
  LLM_ROUTE_LIGHT: "qwen",
} satisfies NodeJS.ProcessEnv;

test("parses indexed backends and routes", () => {
  const r = parseRegistry(valid);
  assert.deepEqual(r.backends.map((b) => b.name), ["opus", "or", "qwen"]);
  assert.deepEqual(r.heavy, ["opus", "or"]);
  assert.deepEqual(r.light, ["qwen"]);
  assert.equal(r.backends[1].baseUrl, "https://openrouter.ai/api/v1");
});

test("stops at the first gap in the index", () => {
  const { LLM_BACKEND_2_NAME, ...gapped } = valid;
  const r = parseRegistry({ ...gapped, LLM_ROUTE_HEAVY: "opus", LLM_ROUTE_LIGHT: "" });
  assert.deepEqual(r.backends.map((b) => b.name), ["opus"]);
});

test("LLM_ROUTE_LIGHT is optional", () => {
  const { LLM_ROUTE_LIGHT, ...noLight } = valid;
  assert.deepEqual(parseRegistry(noLight).light, []);
});

test("private-llm needs only NAME and KIND", () => {
  const r = parseRegistry({
    LLM_BACKEND_1_NAME: "qwen",
    LLM_BACKEND_1_KIND: "private-llm",
    LLM_ROUTE_HEAVY: "qwen",
  });
  assert.equal(r.backends[0].kind, "private-llm");
});

test("rejects an unknown kind", () => {
  assert.throws(
    () => parseRegistry({ ...valid, LLM_BACKEND_1_KIND: "router" }),
    /LLM_BACKEND_1_KIND/
  );
});

test("rejects a duplicate name", () => {
  assert.throws(
    () => parseRegistry({ ...valid, LLM_BACKEND_3_NAME: "opus", LLM_BACKEND_3_KIND: "private-llm" }),
    /duplicate/
  );
});

test("rejects openai-compatible without BASE_URL", () => {
  const { LLM_BACKEND_2_BASE_URL, ...noUrl } = valid;
  assert.throws(() => parseRegistry(noUrl), /LLM_BACKEND_2_BASE_URL/);
});

test("rejects claude without KEY", () => {
  const { LLM_BACKEND_1_KEY, ...noKey } = valid;
  assert.throws(() => parseRegistry(noKey), /LLM_BACKEND_1_KEY/);
});

test("rejects a missing LLM_ROUTE_HEAVY", () => {
  const { LLM_ROUTE_HEAVY, ...noHeavy } = valid;
  assert.throws(() => parseRegistry(noHeavy), /LLM_ROUTE_HEAVY/);
});

test("rejects a route naming an unregistered backend", () => {
  assert.throws(() => parseRegistry({ ...valid, LLM_ROUTE_LIGHT: "ghost" }), /ghost/);
});

test("rejects an empty registry", () => {
  assert.throws(() => parseRegistry({ LLM_ROUTE_HEAVY: "opus" }), /LLM_BACKEND_1_NAME/);
});

test("buildBackends maps names to configured client instances", () => {
  const m = buildBackends(parseRegistry(valid).backends);
  assert.deepEqual([...m.keys()], ["opus", "or", "qwen"]);
  assert.ok(m.get("opus") instanceof ClaudeClient);
  assert.equal((m.get("opus") as ClaudeClient).model, "claude-opus-5");
  assert.ok(m.get("or") instanceof OpenAICompatibleClient);
  assert.equal((m.get("or") as OpenAICompatibleClient).model, "qwen/qwen3-235b");
});
