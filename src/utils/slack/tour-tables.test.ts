import { test } from "node:test";
import assert from "node:assert/strict";
import { tourBlocks, stripRepeatedInventory } from "./tour-tables.js";
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
