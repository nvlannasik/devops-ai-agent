import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseVisibilitySeconds } from "./sqs.js";

test("releases instantly while a response is still bouncing to its owner", () => {
  assert.equal(releaseVisibilitySeconds(1), 0);
  assert.equal(releaseVisibilitySeconds(20), 0);
});

test("backs off once a message has bounced far past any realistic replica count", () => {
  assert.equal(releaseVisibilitySeconds(21), 60);
  assert.equal(releaseVisibilitySeconds(500), 60);
});
