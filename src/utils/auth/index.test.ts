import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr, bearerToken, slackUserAllowed } from "./index.js";

test("timingSafeEqualStr matches equal strings and rejects different ones", () => {
  assert.equal(timingSafeEqualStr("s3cret-token", "s3cret-token"), true);
  assert.equal(timingSafeEqualStr("s3cret-token", "wrong"), false);
  // different lengths must not throw (sha256 fixes the width)
  assert.equal(timingSafeEqualStr("short", "a-much-longer-value"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});

test("bearerToken extracts the token or returns null", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123"); // case-insensitive scheme
  assert.equal(bearerToken("Bearer   spaced  "), "spaced");
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken(""), null);
  assert.equal(bearerToken(undefined), null);
});

test("slackUserAllowed: an empty allowlist leaves the agent open to everyone", () => {
  assert.equal(slackUserAllowed("U1", { allowed: [], oncall: [], approvers: [] }), true);
  // on-call/approver lists alone do not close it — they predate the allowlist
  assert.equal(slackUserAllowed("U1", { allowed: [], oncall: ["U2"], approvers: ["U3"] }), true);
});

test("slackUserAllowed: a set allowlist admits it, on-call and approvers, and no one else", () => {
  const lists = { allowed: ["U1"], oncall: ["U2"], approvers: ["U3"] };
  assert.equal(slackUserAllowed("U1", lists), true);
  assert.equal(slackUserAllowed("U2", lists), true);
  assert.equal(slackUserAllowed("U3", lists), true);
  assert.equal(slackUserAllowed("U9", lists), false);
  // a bot post or a payload with no user cannot be admitted by an allowlist
  assert.equal(slackUserAllowed(undefined, lists), false);
});
