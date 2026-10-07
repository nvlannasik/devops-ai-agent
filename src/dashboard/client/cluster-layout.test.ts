import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutClusterGraph } from "./cluster-layout.js";
import { buildClusterGraph, nsId } from "../cluster-graph.js";
import type { ClusterInventory } from "../cluster-types.js";

const inv: ClusterInventory = { scanned: { namespaces: 1, complete: true }, namespaces: [{ name: "shop", system: false,
  workloads: Array.from({ length: 6 }, (_, i) => ({ kind: "Deployment", name: `w${i}`, ready: 1, desired: 1, images: ["x:1"], managedBy: { type: "unmanaged" as const } })),
  services: [{ name: "s", type: "ClusterIP", ports: ["80/TCP"], serves: ["w0", "w1"] }],
  ingresses: [{ name: "i", hosts: ["h"], backends: [{ host: "h", service: "s" }] }] }] };

test("an expanded namespace lays out left to right with no overlapping nodes", () => {
  const { nodes, edges } = layoutClusterGraph(buildClusterGraph(inv, new Set([nsId("shop")]), false));
  const box = (n: (typeof nodes)[number]) => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 });
  const cards = nodes.filter((n) => n.data.kind !== "panel" && n.data.kind !== "panelHead");
  for (const [i, a] of cards.entries())
    for (const b of cards.slice(i + 1)) {
      const p = box(a), q = box(b);
      assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, `${a.id} overlaps ${b.id}`);
    }
  const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
  assert.ok(x("host/shop/h") < x("svc/shop/s") && x("svc/shop/s") < x("wl/shop/w0"), "host → service → workload, left to right");
  assert.ok(x("wl/shop/w0") < x("owner/shop/unmanaged"), "the owner sits after its workloads");
  assert.ok(edges.some((e) => e.id.startsWith("manages:") && (e.style as { strokeDasharray?: string } | undefined)?.strokeDasharray), "manages edges are dashed");
});

// Measured on the live cluster, 2026-10-08: 17 collapsed namespaces have no edges between them, so
// dagre stacked them in ONE column and the opening zoom was 0.47 — below the spec's 0.8. Collapsed
// cards are a grid; each expanded namespace is its own dagre block, below the grid.
const many: ClusterInventory = { scanned: { namespaces: 17, complete: true }, namespaces: Array.from({ length: 17 }, (_, i) => ({
  name: `ns-${String(i).padStart(2, "0")}`, system: false, services: [], ingresses: [],
  workloads: [{ kind: "Deployment", name: "w", ready: 1, desired: 1, images: ["x:1"], managedBy: { type: "unmanaged" as const } }] })) };

test("collapsed namespaces form a grid of at most four per row, in name order", () => {
  const { nodes } = layoutClusterGraph(buildClusterGraph(many, new Set(), false));
  const rows = new Map<number, string[]>();
  for (const n of nodes) rows.set(n.position.y, [...(rows.get(n.position.y) ?? []), n.id]);
  assert.equal(rows.size, 5, "17 cards, 4 per row");
  assert.ok([...rows.values()].every((r) => r.length <= 4));
  const first = [...rows.entries()].sort((a, b) => a[0] - b[0])[0]![1];
  assert.deepEqual(first, [nsId("ns-00"), nsId("ns-01"), nsId("ns-02"), nsId("ns-03")]);
});

test("a narrow frame asks for two columns", () => {
  const { nodes } = layoutClusterGraph(buildClusterGraph(many, new Set(), false), 2);
  assert.equal(new Set(nodes.map((n) => n.position.y)).size, 9, "17 cards, 2 per row");
});

test("an expanded namespace is laid out below the grid, overlapping nothing", () => {
  const { nodes } = layoutClusterGraph(buildClusterGraph({ ...many, namespaces: [...many.namespaces, inv.namespaces[0]!] }, new Set([nsId("shop")]), false));
  const gridBottom = Math.max(...nodes.filter((n) => n.data.kind === "namespace").map((n) => n.position.y + (n.height ?? 0)));
  const shop = nodes.filter((n) => n.data.namespace === "shop" && n.data.kind !== "namespace");
  assert.ok(shop.length > 0 && shop.every((n) => n.position.y > gridBottom), "the block starts under the grid");
  const cards = nodes.filter((n) => n.data.kind !== "panel" && n.data.kind !== "panelHead");
  for (const [i, a] of cards.entries())
    for (const b of cards.slice(i + 1)) {
      const ov = !(a.position.x + (a.width ?? 0) <= b.position.x || b.position.x + (b.width ?? 0) <= a.position.x ||
                   a.position.y + (a.height ?? 0) <= b.position.y || b.position.y + (b.height ?? 0) <= a.position.y);
      assert.ok(!ov, `${a.id} overlaps ${b.id}`);
    }
});

// Feedback 2026-10-08: the expanded view "is dizzying". dagre ranked each row on its own, so a
// row with no Ingress host slid left and its Service sat under the host heading. Lanes are fixed
// per kind now, inside a framed panel per namespace with its own column headings.
const lanes: ClusterInventory = { scanned: { namespaces: 1, complete: true }, namespaces: [{ name: "shop", system: false,
  workloads: [
    { kind: "Deployment", name: "front", ready: 1, desired: 1, images: ["x:1"], managedBy: { type: "helmrelease", name: "front", namespace: "flux-app" } },
    { kind: "Deployment", name: "api", ready: 1, desired: 1, images: ["x:1"], managedBy: { type: "helmrelease", name: "api", namespace: "flux-app" } },
    { kind: "CronJob", name: "sync", ready: null, desired: null, images: ["x:1"], managedBy: { type: "unmanaged" }, schedule: "* * * * *" }],
  services: [{ name: "front", type: "ClusterIP", ports: ["80/TCP"], serves: ["front"] }, { name: "api", type: "ClusterIP", ports: ["8080/TCP"], serves: ["api"] }, { name: "orphan", type: "ClusterIP", ports: ["9/TCP"], serves: [] }],
  ingresses: [{ name: "i", hosts: ["shop.example.com"], backends: [{ host: "shop.example.com", service: "front" }] }] }] };

test("each kind has one lane: a row without a host keeps its Service in the Service lane", () => {
  const { nodes } = layoutClusterGraph(buildClusterGraph(lanes, new Set([nsId("shop")]), false));
  const xs = (kind: string) => new Set(nodes.filter((n) => n.data.kind === kind).map((n) => n.position.x));
  for (const kind of ["host", "service", "workload", "owner"]) assert.equal(xs(kind).size, 1, `${kind} cards share one x`);
  const x = (k: string) => [...xs(k)][0]!;
  assert.ok(x("host") < x("service") && x("service") < x("workload") && x("workload") < x("owner"));
  const y = (id: string) => nodes.find((n) => n.id === id)!.position.y;
  assert.equal(y("svc/shop/api"), y("wl/shop/api"), "a Service sits on the row of the workload it serves");
  assert.equal(y("host/shop/shop.example.com"), y("svc/shop/front"));
});

test("an open namespace is a panel with column headings, framing its cards; its grid card stays, marked open", () => {
  const { nodes } = layoutClusterGraph(buildClusterGraph(lanes, new Set([nsId("shop")]), false));
  const panel = nodes.find((n) => n.data.kind === "panel")!;
  assert.ok(panel, "a panel frame");
  assert.equal(panel.zIndex, -1, "the frame is drawn behind the cards and edges");
  // Browser check 2026-10-08: the ✕ inside a zIndex -1 node sat under React Flow's pane and could
  // not be clicked. The header — title, close control, lane headings — is its own node above it.
  const head = nodes.find((n) => n.data.kind === "panelHead")!;
  assert.ok(head && (head.zIndex ?? 0) >= 0, "the header is above the pane, so its ✕ is clickable");
  // …and React Flow gives a node that is neither draggable nor selectable pointer-events: none,
  // so the header has to ask for them back or every click goes through to the pane.
  assert.equal((head.style as { pointerEvents?: string } | undefined)?.pointerEvents, "all");
  assert.deepEqual((head.data.columns as Array<{ label: string }>).map((c) => c.label), ["Ingress host", "Service", "Workload", "Managed by"]);
  assert.ok(head.position.y + (head.height ?? 0) <= Math.min(...nodes.filter((n) => n.data.namespace === "shop" && !["panel", "panelHead", "namespace"].includes(n.data.kind)).map((n) => n.position.y)), "no card under the header");
  for (const n of nodes.filter((m) => m.data.namespace === "shop" && !["panel", "panelHead", "namespace"].includes(m.data.kind))) {
    assert.ok(n.position.x >= panel.position.x && n.position.x + (n.width ?? 0) <= panel.position.x + (panel.width ?? 0), `${n.id} inside the panel`);
    assert.ok(n.position.y >= panel.position.y && n.position.y + (n.height ?? 0) <= panel.position.y + (panel.height ?? 0), `${n.id} inside the panel`);
  }
  assert.equal(nodes.find((n) => n.id === nsId("shop"))!.data.expanded, true);
});
