import { test } from "node:test";
import assert from "node:assert/strict";
import { backendPrices, costUsd } from "./pricing.js";

test("prices are read per backend name, in USD per million tokens", () => {
  const p = backendPrices({
    LLM_BACKEND_1_NAME: "chatgpt", LLM_BACKEND_1_PRICE_INPUT: "0.05", LLM_BACKEND_1_PRICE_OUTPUT: "0.40",
    LLM_BACKEND_2_NAME: "private-llm-agus",
    LLM_BACKEND_3_NAME: "haiku", LLM_BACKEND_3_PRICE_INPUT: "1", LLM_BACKEND_3_PRICE_OUTPUT: "5", LLM_BACKEND_3_PRICE_CACHE_READ: "0.1",
  });
  assert.deepEqual(p.get("chatgpt"), { input: 0.05, output: 0.4 });
  assert.equal(p.has("private-llm-agus"), false, "no price is no entry, never a zero price");
  assert.deepEqual(p.get("haiku"), { input: 1, output: 5, cacheRead: 0.1 });
});

test("a malformed or half-set price is ignored rather than inventing a cost", () => {
  const p = backendPrices({ LLM_BACKEND_1_NAME: "a", LLM_BACKEND_1_PRICE_INPUT: "abc", LLM_BACKEND_1_PRICE_OUTPUT: "1",
                            LLM_BACKEND_2_NAME: "b", LLM_BACKEND_2_PRICE_INPUT: "1" });
  assert.equal(p.size, 0);
});

test("cost: tokens times price; cache reads only when they have a price; no price is null", () => {
  assert.equal(costUsd({ input: 1, output: 5, cacheRead: 0.1 }, { input: 1_000_000, output: 200_000, cacheRead: 500_000 }), 1 + 1 + 0.05);
  assert.equal(costUsd({ input: 1, output: 5 }, { input: 1_000_000, output: 0, cacheRead: 9_000_000 }), 1);
  assert.equal(costUsd(undefined, { input: 1, output: 1, cacheRead: 0 }), null);
});
