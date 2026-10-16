import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClusterGraph, nsId } from "./cluster-graph.js";
import type { ClusterInventory } from "./cluster-types.js";

const inv: ClusterInventory = { scanned: { namespaces: 3, complete: true }, namespaces: [
  { name: "shop", system: false,
    workloads: [
      { kind: "Deployment", name: "web", ready: 2, desired: 2, images: ["web:1"], managedBy: { type: "helmrelease", name: "app", namespace: "flux-app" } },
      { kind: "Deployment", name: "api", ready: 1, desired: 1, images: ["api:1"], managedBy: { type: "helmrelease", name: "app", namespace: "flux-app" } },
      { kind: "CronJob", name: "sync", ready: null, desired: null, images: ["j:1"], managedBy: { type: "unmanaged" }, schedule: "* * * * *" }],
    services: [{ name: "web", type: "ClusterIP", ports: ["80/TCP"], serves: ["web"] }, { name: "orphan", type: "ClusterIP", ports: ["81/TCP"], serves: [] }],
    ingresses: [{ name: "in", hosts: ["shop.example.com"], backends: [{ host: "shop.example.com", service: "web" }] }] },
  { name: "other", system: false,
    workloads: [{ kind: "Deployment", name: "web", ready: 1, desired: 1, images: ["w:2"], managedBy: { type: "helmrelease", name: "app", namespace: "flux-other" } }],
    services: [], ingresses: [] },
  { name: "kube-system", system: true, workloads: [{ kind: "Deployment", name: "coredns", ready: 1, desired: 1, images: ["c:1"], managedBy: { type: "unmanaged" } }], services: [], ingresses: [] },
] };

const ids = (g: ReturnType<typeof buildClusterGraph>) => g.nodes.map((n) => n.id).sort();

test("collapsed: one card per application namespace, system hidden until asked for", () => {
  const g = buildClusterGraph(inv, new Set(), false);
  assert.deepEqual(ids(g), [nsId("other"), nsId("shop")]);
  const shop = g.nodes.find((n) => n.id === nsId("shop"))!;
  assert.match(shop.data.sub ?? "", /3 workloads · 1 outside GitOps/);
  assert.equal(shop.data.expanded, false);
  assert.equal(g.edges.length, 0);
  assert.ok(buildClusterGraph(inv, new Set(), true).nodes.some((n) => n.id === nsId("kube-system")));
});

test("expanded: host → service → workload routes, owner → workload manages, orphan Service kept", () => {
  const g = buildClusterGraph(inv, new Set([nsId("shop")]), false);
  const e = (k: string) => g.edges.filter((x) => x.kind === k).map((x) => `${x.source}>${x.target}`).sort();
  assert.deepEqual(e("routes"), ["host/shop/shop.example.com>svc/shop/web", "svc/shop/web>wl/shop/web"]);
  assert.deepEqual(e("manages"), [
    "owner/shop/helmrelease/flux-app/app>wl/shop/api",
    "owner/shop/helmrelease/flux-app/app>wl/shop/web",
    "owner/shop/unmanaged>wl/shop/sync",
  ]);
  assert.ok(g.nodes.some((n) => n.id === "svc/shop/orphan"), "a Service that serves nothing is still drawn");
  assert.equal(g.nodes.find((n) => n.id === "owner/shop/unmanaged")!.data.tone, "warning");
  // The card stays in the grid, marked open — it vanishing on click left readers looking for it.
  assert.equal(g.nodes.find((n) => n.id === nsId("shop"))!.data.expanded, true);
});

test("owners with one name in two namespaces stay two nodes", () => {
  const g = buildClusterGraph(inv, new Set([nsId("shop"), nsId("other")]), false);
  assert.ok(g.nodes.some((n) => n.id === "owner/shop/helmrelease/flux-app/app"));
  assert.ok(g.nodes.some((n) => n.id === "owner/other/helmrelease/flux-other/app"));
});

test("expanding and collapsing is stable — same ids, no duplicates", () => {
  const a = buildClusterGraph(inv, new Set([nsId("shop")]), false);
  const b = buildClusterGraph(inv, new Set([nsId("shop")]), false);
  assert.deepEqual(ids(a), ids(b));
  assert.equal(new Set(ids(a)).size, a.nodes.length);
  assert.deepEqual(ids(buildClusterGraph(inv, new Set(), false)), [nsId("other"), nsId("shop")]);
});

// Onboarding v2 (spec 2026-10-16-cluster-onboarding-flow §4): the cluster model's flow on the map.
const MODEL: any = {
  snapshot: { at: "2026-10-16T10:00:00.000Z", appliedRevision: null, repoRevision: null },
  nodes: [
    { id: "wl/shop/web", kind: "workload", namespace: "shop", name: "web", workloadKind: "Deployment" },
    { id: "wl/shop/api", kind: "workload", namespace: "shop", name: "api", workloadKind: "Deployment" },
    { id: "svc/db/postgres", kind: "service", namespace: "db", name: "postgres" },
    { id: "svc/monitoring/jaeger", kind: "service", namespace: "monitoring", name: "jaeger" },
  ],
  edges: [
    { from: "wl/shop/web", to: "wl/shop/api", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q" }] },
    { from: "wl/shop/api", to: "svc/db/postgres", kind: "depends", certainty: "configured", role: "app", evidence: [{ type: "env", workload: "api", via: "DB_HOST" }] },
    { from: "wl/shop/api", to: "svc/monitoring/jaeger", kind: "depends", certainty: "configured", role: "telemetry", evidence: [{ type: "env", workload: "api", via: "OTEL_EXPORTER_OTLP_ENDPOINT" }] },
  ],
  external: [], changeAt: {}, unknowns: [],
};

test("model edges join only an open namespace; telemetry hidden unless asked; a cross-namespace target gets a card in this panel", () => {
  const g = buildClusterGraph(inv, new Set([nsId("shop")]), false, MODEL);
  assert.ok(g.edges.some((e) => e.kind === "calls" && e.source === "wl/shop/web" && e.target === "wl/shop/api"));
  assert.ok(g.edges.some((e) => e.kind === "depends" && e.target === "svc/db/postgres"));
  const pg = g.nodes.find((n) => n.id === "svc/db/postgres");
  assert.equal(pg?.data.namespace, "shop");
  assert.equal(pg?.data.label, "db/postgres");
  assert.equal(pg?.data.sub, "other namespace");
  assert.ok(!g.edges.some((e) => e.target === "svc/monitoring/jaeger"));
  assert.ok(buildClusterGraph(inv, new Set([nsId("shop")]), false, MODEL, true).edges.some((e) => e.target === "svc/monitoring/jaeger"));
  assert.ok(!buildClusterGraph(inv, new Set(), false, MODEL).edges.some((e) => e.kind === "calls"), "a collapsed namespace draws no flow");
});
