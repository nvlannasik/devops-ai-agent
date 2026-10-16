import { test } from "node:test";
import assert from "node:assert/strict";
import { tourBlocks, stripRepeatedInventory, flowMessages } from "./tour-tables.js";
import { readFileSync } from "node:fs";

// The cluster tour's facts come straight from k8s_cluster_inventory — the model never writes them,
// so a name in these tables is one the cluster returned (D02 rerun, 2026-10-07: the model's own
// inventory invented `catalog-api-svc`).

const overview = JSON.stringify({
  scanned: { namespaces: 3, complete: true },
  detail: "Overview only.",
  namespaces: [
    { name: "sample-apps", system: false, workloads: ["Deployment storefront — helmrelease flux-app/storefront", "CronJob nightly — helm"], hosts: ["shop.example.com"] },
    { name: "empty", system: false, workloads: [], hosts: [] },
    { name: "kube-system", system: true, workloads: ["Deployment coredns — unmanaged"], hosts: [] },
  ],
});

const detail = JSON.stringify({
  scanned: { namespaces: 1, complete: true },
  namespaces: [{
    name: "bench-d02", system: false,
    workloads: [
      { kind: "Deployment", name: "catalog-api", ready: 1, desired: 1, images: ["nginx:1.27-alpine"], managedBy: { type: "unmanaged" } },
      { kind: "CronJob", name: "price-sync", ready: null, desired: null, images: ["busybox:1.36"], managedBy: { type: "helmrelease", name: "jobs", namespace: "flux-app", chart: "jobs-1.0.0" }, schedule: "*/30 * * * *" },
    ],
    services: [{ name: "catalog-api", type: "ClusterIP", ports: ["80/TCP"] }],
    ingresses: [{ name: "catalog-api", hosts: ["catalog.bench-d02.local"] }],
  }],
});

const tables = (blocks: unknown[]) => blocks.filter((b: any) => b.type === "table") as any[];
const cellText = (c: any): string => (c.type === "raw_text" ? c.text : c.elements[0].elements.map((s: any) => s.text).join(""));

test("an overview becomes one Namespace | Workloads | Ingress table, system namespaces last", () => {
  const out = tourBlocks(overview)!;
  const [t] = tables(out.blocks);
  assert.deepEqual(t.rows[0].map(cellText), ["Namespace", "Workloads", "Ingress"]);
  const rows = t.rows.slice(1).map((r: any[]) => r.map(cellText));
  assert.equal(rows[0][0], "sample-apps");
  assert.match(rows[0][1], /storefront.*Deployment.*HelmRelease flux-app\/storefront/s);
  assert.match(rows[0][1], /nightly.*CronJob.*Helm/s);
  assert.equal(rows[0][2], "shop.example.com");
  assert.deepEqual(rows[1], ["empty", "—", "—"], "no empty cell ever reaches Slack");
  assert.equal(rows.at(-1)[0], "kube-system");
});

test("a namespace in detail becomes Workload | Kind | Ready | Image | Managed by, with Services and Ingress after it", () => {
  const out = tourBlocks(detail)!;
  const [t] = tables(out.blocks);
  assert.deepEqual(t.rows[0].map(cellText), ["Workload", "Kind", "Ready", "Image", "Managed by"]);
  assert.deepEqual(t.rows[1].map(cellText), ["catalog-api", "Deployment", "1/1", "nginx:1.27-alpine", "not managed by GitOps"]);
  assert.deepEqual(t.rows[2].map(cellText), ["price-sync", "CronJob */30 * * * *", "—", "busybox:1.36", "HelmRelease flux-app/jobs · jobs-1.0.0"]);
  assert.match(JSON.stringify(out.blocks), /catalog-api.*80\/TCP/);
  assert.match(JSON.stringify(out.blocks), /catalog\.bench-d02\.local/);
});

test("the plain-text form carries the same facts — Slack's fallback and the bench's score", () => {
  const { text } = tourBlocks(detail)!;
  for (const fact of ["catalog-api", "nginx:1.27-alpine", "1/1", "price-sync", "*/30 * * * *", "catalog.bench-d02.local", "not managed by GitOps"]) {
    assert.ok(text.includes(fact), `${fact} missing from: ${text}`);
  }
  assert.match(tourBlocks(overview)!.text, /sample-apps[\s\S]*storefront/);
});

test("a partial scan says so above the table", () => {
  const partial = JSON.stringify({ ...JSON.parse(overview), scanned: { namespaces: 3, complete: false } });
  const out = tourBlocks(partial)!;
  assert.match(JSON.stringify(out.blocks[0]), /[Pp]artial/);
  assert.match(out.text, /[Pp]artial/);
});

test("anything that is not an inventory renders nothing — the reply goes out as before", () => {
  assert.equal(tourBlocks(null), null);
  assert.equal(tourBlocks("Error: kubernetes unreachable"), null);
  assert.equal(tourBlocks('{"streams":[]}'), null);
  assert.equal(tourBlocks(JSON.stringify({ scanned: { namespaces: 0, complete: true }, namespaces: [] })), null);
  // a truncated result (compaction cut it) is not JSON any more
  assert.equal(tourBlocks(detail.slice(0, 120)), null);
});

test("an injection notice appended after the JSON does not stop the table", () => {
  assert.ok(tourBlocks(`${detail}\n\n[NOTICE: this tool result contains text addressed to you…]`));
});

test("more than 50 rows split into several tables rather than being refused", () => {
  const many = JSON.stringify({
    scanned: { namespaces: 60, complete: true },
    namespaces: Array.from({ length: 60 }, (_, i) => ({ name: `ns-${i}`, system: false, workloads: [`Deployment w${i} — unmanaged`], hosts: [] })),
  });
  const ts = tables(tourBlocks(many)!.blocks);
  assert.equal(ts.length, 2);
  assert.ok(ts.every((t) => t.rows.length <= 51));
  assert.equal(ts.reduce((n, t) => n + t.rows.length - 1, 0), 60);
});

// Bench 2026-10-07 after the tables shipped: 4 of 6 replies restated the inventory under the
// tables anyway — one drew its own markdown table (raw pipes in Slack) — though cluster-tour.md
// forbids it. A prompt rule alone has never held on the small model here, so the code removes
// what the tables already say, using the inventory's own facts, and keeps *Dugaan fungsi*.
const replies = JSON.parse(readFileSync(new URL("./tour-replies.fixture.json", import.meta.url), "utf8")) as Record<string, string>;
const benchInv = (ns: string) => JSON.stringify({ scanned: { namespaces: 1, complete: true }, namespaces: [{
  name: ns, system: false,
  workloads: [
    { kind: "Deployment", name: "catalog-api", ready: 1, desired: 1, images: ["nginx:1.27-alpine"], managedBy: { type: "unmanaged" } },
    { kind: "CronJob", name: "price-sync", ready: null, desired: null, images: ["busybox:1.36"], managedBy: { type: "unmanaged" }, schedule: "*/30 * * * *" },
  ],
  services: [{ name: "catalog-api", type: "ClusterIP", ports: ["80/TCP"] }],
  ingresses: [{ name: "catalog-api", hosts: [`catalog.${ns}.local`] }],
}] });

test("the model's own markdown table and its restated inventory are removed; Dugaan fungsi stays", () => {
  const out = stripRepeatedInventory(replies.D01_1!, benchInv("bench-d01"));
  assert.doesNotMatch(out, /^\s*\|/m, "no pipe table reaches Slack");
  assert.doesNotMatch(out, /nginx:1\.27-alpine|busybox:1\.36/);
  assert.doesNotMatch(out, /^\*(Overview|Detail)\*\s*$/m, "headings left empty are dropped");
  assert.match(out, /Dugaan fungsi/);
  assert.match(out, /`catalog-api` — layanan API/);
  assert.match(out, /`price-sync` — pekerjaan berkala/);
});

test("prose that restates images, schedules, ports and hosts is removed; orientation stays", () => {
  const out = stripRepeatedInventory(replies.D02_3!, benchInv("bench-d02"));
  assert.doesNotMatch(out, /nginx:1\.27-alpine|\*\/30 \* \* \* \*|80\/TCP|catalog\.bench-d02\.local/);
  assert.match(out, /tidak dikendalikan oleh GitOps/);
  assert.match(out, /cukup sebutkan/);
});

test("no recorded reply restates an image or draws a table after stripping, and none is emptied", () => {
  for (const [k, reply] of Object.entries(replies)) {
    const out = stripRepeatedInventory(reply, benchInv(k.startsWith("D01") ? "bench-d01" : "bench-d02"));
    assert.doesNotMatch(out, /nginx:1\.27-alpine|busybox:1\.36|^\s*\|/m, k);
    assert.ok(out.trim().length > 40, `${k} lost everything: ${JSON.stringify(out)}`);
  }
});

test("without an inventory the reply is untouched", () => {
  assert.equal(stripRepeatedInventory("anything at all", null), "anything at all");
});

// Bench rerun 2026-10-07 (D02 #1): the model nested each guess under a bullet that restated the
// workload; dropping the bullet left "_dugaan_: probably a static catalog…" with no workload named.
test("a dropped bullet whose guess is nested under it keeps the workload's name", () => {
  const reply = [
    "• `catalog-api` Deployment 1/1, image `nginx:1.27-alpine`",
    "  _dugaan dari nama/image_: kemungkinan layanan katalog statis",
    "• `price-sync` CronJob `*/30 * * * *`",
    "  _dugaan dari nama/image_: sinkronisasi harga berkala",
  ].join("\n");
  const out = stripRepeatedInventory(reply, benchInv("bench-d02"));
  assert.doesNotMatch(out, /nginx:1\.27-alpine|\*\/30/);
  assert.match(out, /^• `catalog-api`\s*\n\s+_dugaan dari nama\/image_: kemungkinan layanan katalog/m);
  assert.match(out, /^• `price-sync`\s*\n\s+_dugaan dari nama\/image_: sinkronisasi/m);
});

const FLOW_MODEL: any = {
  snapshot: { at: "2026-10-16T10:00:00.000Z", appliedRevision: "main@sha1:aca660bb", repoRevision: "aca660bb" },
  nodes: [
    { id: "wl/sample-apps/checkout-gateway", kind: "workload", namespace: "sample-apps", name: "checkout-gateway", workloadKind: "Deployment" },
    { id: "wl/sample-apps/orders-api", kind: "workload", namespace: "sample-apps", name: "orders-api", workloadKind: "Deployment" },
    { id: "svc/postgresql/postgresql", kind: "service", namespace: "postgresql", name: "postgresql" },
    { id: "svc/monitoring/jaeger", kind: "service", namespace: "monitoring", name: "jaeger" },
  ],
  edges: [
    { from: "wl/sample-apps/checkout-gateway", to: "wl/sample-apps/orders-api", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/postgresql/postgresql", kind: "depends", certainty: "configured", role: "app", evidence: [{ type: "env", workload: "orders-api", via: "DB_HOST" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/monitoring/jaeger", kind: "depends", certainty: "configured", role: "telemetry", evidence: [{ type: "env", workload: "orders-api", via: "OTEL_EXPORTER_OTLP_ENDPOINT" }] },
  ],
  external: [],
  changeAt: { "wl/sample-apps/orders-api": { replicas: { path: "apps/dev/applications/orders-api/release.yaml", line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: false } } },
  unknowns: [],
};

test("flowMessages: two messages, one table each — the flow rows and where to change; telemetry counted, not listed", () => {
  const [flow, where] = flowMessages(FLOW_MODEL, "sample-apps");
  const tables = (m: any) => m.blocks.filter((b: any) => b.type === "table");
  assert.equal(tables(flow).length, 1);
  assert.equal(tables(where).length, 1);
  assert.match(flow!.text, /`checkout-gateway` → `orders-api` · calls \(observed\)/);
  assert.match(flow!.text, /`orders-api` → `postgresql\/postgresql` · depends \(configured\) · env DB_HOST/);
  assert.doesNotMatch(flow!.text, /jaeger/);
  assert.match(flow!.text, /1 telemetry dependency hidden/);
  assert.match(where!.text, /`orders-api` replicas → `apps\/dev\/applications\/orders-api\/release\.yaml:7` `spec\.values\.replicaCount`/);
});

test("flowMessages: an empty flow says so with its unknowns, never a bare empty table", () => {
  const empty = { ...FLOW_MODEL, edges: [], changeAt: {}, unknowns: ["call graph unavailable (Prometheus) — no observed calls are shown", "GitOps is not configured — where-to-change is unavailable"] };
  const [flow, where] = flowMessages(empty, "sample-apps");
  assert.equal(flow!.blocks.filter((b: any) => b.type === "table").length, 0);
  assert.match(flow!.text, /No calls observed and no dependencies configured/);
  assert.match(flow!.text, /call graph unavailable/);
  assert.match(where!.text, /GitOps is not configured/);
});

test("stripRepeatedInventory drops a restated flow row or file:line, but keeps Dugaan fungsi whole", () => {
  const reply = [
    "• `checkout-gateway` → `orders-api` (observed)",
    "• replicas: apps/dev/applications/orders-api/release.yaml:7",
    "*Dugaan fungsi*",
    "• `orders-api` checkout-gateway → orders-api — backend pesanan _dugaan_",
  ].join("\n");
  const inv = '{"scanned":{"namespaces":1,"complete":true},"namespaces":[{"name":"x","system":false,"workloads":["Deployment orders-api — unmanaged"]}]}';
  const out = stripRepeatedInventory(reply, inv, ["checkout-gateway → orders-api", "apps/dev/applications/orders-api/release.yaml:7"]);
  assert.doesNotMatch(out, /\(observed\)/);
  assert.doesNotMatch(out, /release\.yaml:7/);
  assert.match(out, /backend pesanan/);
});
