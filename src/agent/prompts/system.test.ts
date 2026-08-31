import { test } from "node:test";
import assert from "node:assert/strict";
import { DELEGATION_SECTION, composeSystemPrompt } from "./system.js";

const core = "# core prompt\n\n## Scope of Work\nstay in the cluster.";

// OFF is what ON gets measured against, so it has to be the file and nothing else. The prompt is
// cached as one ephemeral block (llm/claude.ts) and counted into the context budget at boot, so
// even a trailing newline added here is a difference in both.
test("with the flag off the prompt is the file, byte for byte", () => {
  assert.equal(composeSystemPrompt(core, false), core);
});

test("with the flag on the section is appended and the file is untouched ahead of it", () => {
  const composed = composeSystemPrompt(core, true);
  assert.ok(composed.startsWith(core), "the core prompt must not be rewritten to make room");
  assert.equal(composed, core + DELEGATION_SECTION);
});

// The section and the tool list disagree by design: delegation is offered only where the tool
// budget is unlimited, so on a plain mention this text ships while the tool does not. It has to
// key on what the model actually holds, or it invites a call to a tool that is not there.
test("the section defers to the tool list, not to the flag", () => {
  assert.match(DELEGATION_SECTION, /not in your tool list/);
  assert.match(DELEGATION_SECTION, /investigate everything yourself/);
});

// The two failure modes the deployed build showed: never reaching for it at all, and (the risk
// of over-correcting) reaching for it to fetch one thing.
test("the section says both when to delegate and when not to", () => {
  assert.match(DELEGATION_SECTION, /two or more genuinely different candidate causes/);
  assert.match(DELEGATION_SECTION, /Do NOT delegate to fetch one piece of data/);
  assert.match(DELEGATION_SECTION, /SAME turn/);
});

// Grounding survives the hop: a delegate's prose is not evidence unless it cites the tool.
test("the section carries the citation rule into the RCA", () => {
  assert.match(DELEGATION_SECTION, /names no\s+tool is unverified/);
});
