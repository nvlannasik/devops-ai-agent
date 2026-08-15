import { test } from "node:test";
import assert from "node:assert/strict";

// See topology.provider-claude.test.ts for why this is its own file/process.
process.env.SLACK_BOT_TOKEN = "x";
process.env.SLACK_SIGNING_SECRET = "x";
process.env.ANTHROPIC_API_KEY = "x";
process.env.LLM_PROVIDER = "private-llm";
process.env.SQS_REQUEST_QUEUE_NAME = "llm-request.fifo";

const { buildTopology } = await import("./topology.js");

test("provider=private-llm populates activeClient saying it goes via SQS", () => {
  const t = buildTopology();
  assert.equal(t.provider, "private-llm");
  assert.equal(t.backends.length, 0);
  assert.ok(t.activeClient, "activeClient should be populated for a non-router provider");
  assert.match(t.activeClient!.detail, /SQS/);
  assert.equal(t.activeClient!.configured, true);
});
