import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr, bearerToken } from "./index.js";

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
