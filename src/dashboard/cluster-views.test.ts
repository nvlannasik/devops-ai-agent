import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage } from "./views.js";
import { parseFilters } from "./filters.js";
import type { IncidentDetail, IncidentPage, IncidentRow } from "./queries.js";

// Multi-cluster 2a (spec 2026-11-02 §5): a Cluster column, a cluster filter and the cluster on the
// incident page — and in single-cluster mode none of it, byte for byte.
const row = (id: number, cluster?: string): IncidentRow => ({
  id, created_at: new Date("2026-11-02T00:00:00Z"), resolved_at: null, alertname: "KubePodCrashLooping",
  namespace: "kube-system", severity: "warning", confidence: "medium", root_cause: null, ...(cluster ? { cluster } : {}),
});
const page = (rows: IncidentRow[]): IncidentPage => ({ rows, hasMore: false, total: rows.length, capped: false });
const now = new Date("2026-11-02T01:00:00Z");

test("?cluster= parses into the filter, and only a cluster-shaped value", () => {
  assert.equal(parseFilters(new URLSearchParams("cluster=stg")).cluster, "stg");
  assert.equal(parseFilters(new URLSearchParams("cluster=STG;drop")).cluster, null);
  assert.equal(parseFilters(new URLSearchParams("")).cluster, null);
});

test("with clusters, the list has a Cluster column and a cluster filter", () => {
  const html = listPage(page([row(1, "stg"), row(2, "dev")]), parseFilters(new URLSearchParams("cluster=stg")), now, undefined, ["dev", "stg"]);
  assert.match(html, /<th[^>]*>Cluster<\/th>/);
  assert.match(html, /<td role="cell" class="cluster[^"]*"[^>]*>stg<\/td>/);
  assert.match(html, /<nav class="seg" aria-label="Cluster">/);
  assert.match(html, /<a href="\/incidents\?cluster=stg" aria-current="true">stg<\/a>/);
  assert.match(html, /<a href="\/incidents">All<\/a>/);
});

test("without clusters, the list is exactly what it was", () => {
  const f = parseFilters(new URLSearchParams(""));
  const before = listPage(page([row(1)]), f, now);
  assert.equal(listPage(page([row(1)]), f, now, undefined, []), before);
  assert.doesNotMatch(before, /<th[^>]*>Cluster<\/th>|aria-label="Cluster"/, "no column, no filter (the rail's Cluster page link is another thing)");
});

test("the incident page carries its cluster beside the severity", () => {
  const incident = { ...row(3), rca: "x", channel: "C1", thread_ts: "1.1" } as IncidentDetail;
  assert.match(detailPage({ incident, remediations: [], feedback: [], cluster: "stg" }), /class="title-meta">[\s\S]*☸ stg/);
  assert.doesNotMatch(detailPage({ incident, remediations: [], feedback: [] }), /☸/);
});
