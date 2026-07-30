import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseVisibilitySeconds, parseResponseBody } from "./sqs.js";

test("releases instantly while a response is still bouncing to its owner", () => {
  assert.equal(releaseVisibilitySeconds(1), 0);
  assert.equal(releaseVisibilitySeconds(20), 0);
});

test("backs off once a message has bounced far past any realistic replica count", () => {
  assert.equal(releaseVisibilitySeconds(21), 60);
  assert.equal(releaseVisibilitySeconds(500), 60);
});

// An unroutable body used to throw out of routeMessage: the rest of the receive batch was
// skipped and the message was never deleted, so the dispatcher hot-looped on it every 2s
// while every in-flight investigation on this replica timed out.
test("parseResponseBody returns null for anything unroutable instead of throwing", () => {
  assert.equal(parseResponseBody(undefined), null);
  assert.equal(parseResponseBody("not json at all"), null);
  assert.equal(parseResponseBody("null"), null);
  assert.equal(parseResponseBody('"a bare string"'), null);
  assert.equal(parseResponseBody("{}"), null); // no requestId
  assert.equal(parseResponseBody('{"requestId":""}'), null); // empty requestId
  assert.equal(parseResponseBody('{"requestId":42}'), null); // wrong type
});

test("parseResponseBody accepts both the success and the error envelope", () => {
  assert.deepEqual(parseResponseBody('{"requestId":"r1","response":{"stopReason":"end_turn"}}'), {
    requestId: "r1",
    response: { stopReason: "end_turn" },
  });
  assert.deepEqual(parseResponseBody('{"requestId":"r2","error":"boom"}'), { requestId: "r2", error: "boom" });
});
