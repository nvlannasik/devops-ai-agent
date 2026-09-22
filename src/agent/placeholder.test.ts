import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderIn } from "./index.js";

// Verbatim tool inputs from the 2026-09-22 CPU-throttling runs.
test("the placeholder calls that actually ran are caught", () => {
  assert.equal(
    placeholderIn({ query: 'histogram_quantile(0.99, sum by (service,le) (rate(http_server_request_duration_seconds_bucket{namespace="X"}[5m])))' }),
    '="X"'
  );
  assert.equal(placeholderIn({ query: '{namespace="X"} |~ "timeout|connection refused"', limit: 200 }), '="X"');
  assert.equal(placeholderIn({ namespace: "X" }), "X");
  assert.equal(placeholderIn({ service: "Y", minDurationMs: 0, limit: 20 }), "Y");
  assert.equal(placeholderIn({ query: '{namespace="sample-apps"} | json | service = "Y"' }), '= "Y"');
});

test("real values pass", () => {
  assert.equal(placeholderIn({ namespace: "sample-apps" }), null);
  assert.equal(placeholderIn({ query: 'sum by (service) (rate(http_server_requests_total{namespace="sample-apps",status=~"5.."}[5m]))' }), null);
  assert.equal(placeholderIn({ query: '{namespace="payments", app="api"} |= "X-Request-Id"' }), null);
  assert.equal(placeholderIn({ limit: 20, direction: "backward" }), null);
});
