import { test } from "node:test";
import assert from "node:assert/strict";

// LLM_PROVIDER=router is what topology.test.ts exercises. The other three providers each need
// their own env — config reads process.env once at module evaluation — hence their own file,
// same reasoning as topology.stdio.test.ts.
process.env.SLACK_BOT_TOKEN = "x";
process.env.SLACK_SIGNING_SECRET = "x";
process.env.LLM_PROVIDER = "claude";
process.env.ANTHROPIC_API_KEY = "SENTINEL-claude-key";
process.env.CLAUDE_MODEL = "claude-opus-9";

const { buildTopology } = await import("./topology.js");

test("provider=claude populates activeClient with the model, key presence, never the key", () => {
  const t = buildTopology();
  assert.equal(t.provider, "claude");
  assert.equal(t.backends.length, 0);
  assert.ok(t.activeClient, "activeClient should be populated for a non-router provider");
  assert.equal(t.activeClient!.detail, "claude-opus-9");
  assert.match(t.activeClient!.meta, /\bset\b/);
  assert.equal(t.activeClient!.configured, true);

  const serialised = JSON.stringify(t);
  assert.ok(!serialised.includes("SENTINEL-claude-key"), "ANTHROPIC_API_KEY leaked into topology data");
});
