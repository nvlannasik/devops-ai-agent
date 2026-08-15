import { test } from "node:test";
import assert from "node:assert/strict";

// See topology.provider-claude.test.ts for why this is its own file/process.
process.env.SLACK_BOT_TOKEN = "x";
process.env.SLACK_SIGNING_SECRET = "x";
process.env.ANTHROPIC_API_KEY = "x";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.OPENAI_COMPATIBLE_BASE_URL = "https://user:SENTINEL-openai-pass@gw.internal/v1";
process.env.OPENAI_COMPATIBLE_API_KEY = "SENTINEL-openai-key";
process.env.OPENAI_COMPATIBLE_MODEL = "qwen-max";

const { buildTopology } = await import("./topology.js");

test("provider=openai-compatible populates activeClient with model + redacted base URL", () => {
  const t = buildTopology();
  assert.equal(t.provider, "openai-compatible");
  assert.equal(t.backends.length, 0);
  assert.ok(t.activeClient, "activeClient should be populated for a non-router provider");
  assert.equal(t.activeClient!.detail, "qwen-max @ https://gw.internal/v1");
  assert.match(t.activeClient!.meta, /\bset\b/);
  assert.equal(t.activeClient!.configured, true);

  const serialised = JSON.stringify(t);
  assert.ok(!serialised.includes("SENTINEL-openai-key"), "OPENAI_COMPATIBLE_API_KEY leaked into topology data");
  assert.ok(!serialised.includes("SENTINEL-openai-pass"), "base URL credential leaked into topology data");
});
