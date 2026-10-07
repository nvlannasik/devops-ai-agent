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
