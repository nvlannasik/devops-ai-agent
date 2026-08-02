import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFilters, PAGE_SIZE_MAX } from "./filters.js";

const f = (qs: string) => parseFilters(new URLSearchParams(qs));

test("an empty query string yields the defaults", () => {
  const r = f("");
  assert.deepEqual(
    { from: r.from, to: r.to, alertname: r.alertname, namespace: r.namespace, severity: r.severity, resolved: r.resolved },
    { from: null, to: null, alertname: null, namespace: null, severity: null, resolved: null }
  );
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 50);
});

test("filters are read into typed fields", () => {
  const r = f("alertname=KubePodCrashLooping&namespace=prod&severity=critical&resolved=true");
  assert.equal(r.alertname, "KubePodCrashLooping");
  assert.equal(r.namespace, "prod");
  assert.equal(r.severity, "critical");
  assert.equal(r.resolved, true);
});

test("resolved distinguishes false from absent", () => {
  assert.equal(f("resolved=false").resolved, false);
  assert.equal(f("").resolved, null);
  assert.equal(f("resolved=").resolved, null);
});

// The hard cap is a safety rail, not a preference: without it a crafted URL runs an
// unbounded query on the same event loop that handles alerts.
test("pageSize is clamped to the hard maximum and never below 1", () => {
  assert.equal(f("pageSize=100000").pageSize, PAGE_SIZE_MAX);
  assert.equal(f("pageSize=0").pageSize, 1);
  assert.equal(f("pageSize=-5").pageSize, 1);
  assert.equal(f("pageSize=abc").pageSize, 50);
});

test("page is at least 1", () => {
  assert.equal(f("page=0").page, 1);
  assert.equal(f("page=-3").page, 1);
  assert.equal(f("page=abc").page, 1);
  assert.equal(f("page=7").page, 7);
});

// A malformed date must not become an Invalid Date that Postgres rejects at query time.
test("malformed dates are dropped, not passed through", () => {
  assert.equal(f("from=not-a-date").from, null);
  assert.equal(f("from=2026-07-01")!.from!.toISOString().slice(0, 10), "2026-07-01");
});

test("blank values are treated as absent", () => {
  const r = f("alertname=&namespace=%20%20");
  assert.equal(r.alertname, null);
  assert.equal(r.namespace, null);
});
