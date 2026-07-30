import { test } from "node:test";
import assert from "node:assert/strict";
import { withRoute, currentRouteContext, withTrace, currentTrace } from "./index.js";

test("no route context outside withRoute", async () => {
  assert.equal(currentRouteContext(), undefined);
});

test("withRoute exposes the route and a fresh escalated flag", async () => {
  await withRoute("light", async () => {
    assert.equal(currentRouteContext()?.route, "light");
    assert.equal(currentRouteContext()?.escalated, false);
  });
});

test("escalated is mutable and visible to later calls in the same context", async () => {
  await withRoute("light", async () => {
    currentRouteContext()!.escalated = true;
    await Promise.resolve();
    assert.equal(currentRouteContext()?.escalated, true);
  });
});

test("each withRoute call gets its own context", async () => {
  await withRoute("light", async () => {
    currentRouteContext()!.escalated = true;
  });
  await withRoute("light", async () => {
    assert.equal(currentRouteContext()?.escalated, false);
  });
});

test("route context nests inside a trace context without clearing it", async () => {
  await withTrace("T-1", async () => {
    await withRoute("light", async () => {
      assert.equal(currentTrace(), "T-1");
      assert.equal(currentRouteContext()?.route, "light");
    });
  });
});
