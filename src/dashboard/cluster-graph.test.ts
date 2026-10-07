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
  assert.match(shop.data.sub ?? "", /3 workloads · 1 not managed by GitOps/);
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
  assert.equal(g.nodes.find((n) => n.id === nsId("shop")), undefined, "an expanded namespace is its contents, not its card");
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
