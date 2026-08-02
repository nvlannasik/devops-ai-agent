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

test("resolved recognises truthy and falsy values case-insensitively", () => {
  // truthy
  assert.equal(f("resolved=true").resolved, true);
  assert.equal(f("resolved=TRUE").resolved, true);
  assert.equal(f("resolved=True").resolved, true);
  assert.equal(f("resolved=1").resolved, true);
  assert.equal(f("resolved=yes").resolved, true);
  assert.equal(f("resolved=YES").resolved, true);
  // falsy
  assert.equal(f("resolved=false").resolved, false);
  assert.equal(f("resolved=FALSE").resolved, false);
  assert.equal(f("resolved=False").resolved, false);
  assert.equal(f("resolved=0").resolved, false);
  assert.equal(f("resolved=no").resolved, false);
  assert.equal(f("resolved=NO").resolved, false);
});

test("resolved maps unrecognised values to null, not false", () => {
  // an unrecognised value must not silently become a filter that contradicts the intent
  assert.equal(f("resolved=maybe").resolved, null);
  assert.equal(f("resolved=1.0").resolved, null);
  assert.equal(f("resolved=unknown").resolved, null);
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

test("string filters strip control characters that Postgres rejects", () => {
  // NUL byte causes Postgres: "invalid byte sequence for encoding "UTF8": 0x00"
  const params = new URLSearchParams();
  params.set("namespace", "\x00abc");
  const r = parseFilters(params);
  assert.equal(r.namespace, "abc");
  // other control bytes are stripped too
  params.set("alertname", "foo\x01bar\x1Fbaz");
  const r2 = parseFilters(params);
  assert.equal(r2.alertname, "foobarbaz");
});

test("page is bounded by a safe integer ceiling", () => {
  // huge values that overflow Postgres bigint get clamped
  assert.equal(f("page=999999999999999999999").page, 1000000);
  assert.equal(f("page=99999999999999999999999999999999999999").page, 1000000);
  // negative values still clamp to 1
  assert.equal(f("page=-999999999").page, 1);
});
