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
  for (const [i, a] of nodes.entries())
    for (const b of nodes.slice(i + 1)) {
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
  const shop = nodes.filter((n) => n.data.namespace === "shop");
  assert.ok(shop.length > 0 && shop.every((n) => n.position.y > gridBottom), "the block starts under the grid");
  for (const [i, a] of nodes.entries())
    for (const b of nodes.slice(i + 1)) {
      const ov = !(a.position.x + (a.width ?? 0) <= b.position.x || b.position.x + (b.width ?? 0) <= a.position.x ||
                   a.position.y + (a.height ?? 0) <= b.position.y || b.position.y + (b.height ?? 0) <= a.position.y);
      assert.ok(!ov, `${a.id} overlaps ${b.id}`);
    }
});
