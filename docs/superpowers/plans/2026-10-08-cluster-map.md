# Cluster Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/cluster` opens with a React Flow map of the inventory — Ingress host → Service → workload, and each workload's GitOps owner — above the existing tables.

**Architecture:** `k8s_cluster_inventory` (mcp-server) gains server-computed relations: `services[].serves` (selector ↔ pod-template labels) and `ingresses[].backends`. The agent embeds the inventory in the page as a JSON block (as `/topology` embeds its topology); a second client bundle `cluster.js` builds the graph with a pure shared module `cluster-graph.ts` (namespaces collapsed, expandable), lays it out with dagre and renders it with React Flow, reusing `topology.css`.

**Tech Stack:** TypeScript ESM, Node 24, `node:test` + tsx, `@xyflow/react`, `dagre`, esbuild (all already installed). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-cluster-map-design.md`

## Global Constraints

- No new dependencies; React / React Flow / dagre stay devDependencies baked into `dist/public/`.
- A module the client imports never imports server config — the build fails on any `FORBIDDEN` string in a bundle (`scripts/build-client.mjs`); shared types live in a `*-types.ts` with no imports, like `topology-types.ts`.
- Every edge comes from cluster data computed by the mcp-server; nothing inferred from names.
- The whole-cluster overview (`overviewOf`) is unchanged — the agent's tour must stay under the 8000-char tool-result cap.
- The map page follows `/topology`'s rules: nonce CSP, `type="application/json"` data block escaped with `jsonBlock`, a no-JS sentence in the mount cleared on mount, stated frame height, `zoomOnScroll={false}`, `preventScrolling={false}`, `zoomActivationKeyCode={["Meta","Control"]}`.
- Dashboard UI: ui-ux-pro-max skill first; browser check desktop 1280 / phone 390 / dark via `~/.render-check`; LOOK at screenshots.
- Push to `main` authorized; deploy = wait for "Build & Push Docker Images" of the commit, then `kubectl -n devops-tools rollout restart deploy/<name>`.

## Review Focus

1. A Service whose selector matches NO workload (or no selector at all) — no edge, and the Service node still appears so the reader sees an orphan Service. Test in Task 2.
2. A selector that matches workloads in another namespace — never an edge across namespaces. Test in Task 1.
3. Two HelmReleases with the same name in different namespaces own workloads — two owner nodes, not one. Test in Task 2.
4. A namespace expanded then collapsed — node ids stable, no duplicate nodes. Test in Task 2.
5. The bundle missing (`npm run dev`) or the inventory failing — the page still renders the tables (or the note) with no map frame error. Test in Task 4.

---

### Task 1: `serves` and `backends` in `k8s_cluster_inventory` (devops-mcp-server)

**Files:**
- Modify: `devops-mcp-server/src/tools/kubernetes/handlers/inventory.ts`
- Test: `devops-mcp-server/src/tools/kubernetes/handlers/inventory.test.ts`
- Modify: `devops-mcp-server/README.md` (the `k8s_cluster_inventory` row)

**Interfaces:**
- Produces (detail shape only): `services[].serves: string[]` (workload names, same namespace, Deployment/StatefulSet/DaemonSet whose `spec.template.metadata.labels` contain every `spec.selector` pair); `ingresses[].backends: Array<{ host: string; service: string }>` (`"*"` when a rule has no host; `defaultBackend` as `"*"`; deduplicated, first-seen order).

- [ ] **Step 1: Failing tests** — append to `inventory.test.ts`:

```ts
const svc = (ns: string, name: string, selector?: Record<string, string>) => ({ metadata: { namespace: ns, name }, spec: { type: "ClusterIP", ports: [{ port: 80 }], ...(selector ? { selector } : {}) } });
const dep = (ns: string, name: string, labels: Record<string, string>) => ({ metadata: { namespace: ns, name }, spec: { replicas: 1, template: { metadata: { labels }, spec: { containers: [{ image: "x:1" }] } } }, status: { readyReplicas: 1 } });
const rel = {
  namespaces: ["a", "b"],
  deployments: [dep("a", "web", { app: "web", tier: "fe" }), dep("a", "api", { app: "api" }), dep("b", "web", { app: "web", tier: "fe" })],
  statefulsets: [], daemonsets: [],
  cronjobs: [{ metadata: { namespace: "a", name: "job", labels: {} }, spec: { schedule: "* * * * *", jobTemplate: { spec: { template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ image: "j:1" }] } } } } } }],
  services: [svc("a", "web", { app: "web" }), svc("a", "strict", { app: "web", tier: "be" }), svc("a", "external")],
  ingresses: [{ metadata: { namespace: "a", name: "in" }, spec: {
    defaultBackend: { service: { name: "web" } },
    rules: [{ host: "shop.example.com", http: { paths: [{ backend: { service: { name: "web" } } }, { backend: { service: { name: "api" } } }, { backend: { service: { name: "web" } } }] } },
            { http: { paths: [{ backend: { service: { name: "api" } } }] } }] } }],
  kustomizations: [], complete: true,
};

test("serves: every selector pair must match, same namespace only, never a CronJob", () => {
  const a = shapeInventory(rel as any).namespaces.find((n) => n.name === "a")!;
  const serves = Object.fromEntries(a.services.map((s) => [s.name, s.serves]));
  assert.deepEqual(serves.web, ["web"], "b/web carries the same labels and must not appear; the CronJob neither");
  assert.deepEqual(serves.strict, [], "tier=be is not satisfied by tier=fe");
  assert.deepEqual(serves.external, [], "no selector, no edge");
});

test("backends: each path with its host, '*' for no host and the default backend, deduplicated", () => {
  const a = shapeInventory(rel as any).namespaces.find((n) => n.name === "a")!;
  assert.deepEqual(a.ingresses[0]!.backends, [
    { host: "*", service: "web" },
    { host: "shop.example.com", service: "web" },
    { host: "shop.example.com", service: "api" },
    { host: "*", service: "api" },
  ]);
});

test("the overview carries no relations — the tour's budget is unchanged", () => {
  assert.doesNotMatch(JSON.stringify(overviewOf(shapeInventory(rel as any))), /serves|backends/);
});
```

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/inventory.test.ts`
Expected: FAIL — `serves` undefined.

- [ ] **Step 2: Implement** in `inventory.ts`:
  - Interfaces: `PodSpecHolder` gains `metadata?: { labels?: Record<string, string> }`; `ServiceObj.spec` gains `selector?: Record<string, string>`; `IngressObj.spec` gains `defaultBackend?: { service?: { name?: string } }` and rules gain `http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> }`.
  - In `shapeInventory`, collect per namespace `podLabels: Array<{ name: string; labels: Record<string, string> }>` from Deployments, StatefulSets, DaemonSets (`o.spec?.template?.metadata?.labels ?? {}`) — never CronJobs.
  - Service row: `serves: sel && Object.keys(sel).length ? (podLabels.get(ns) ?? []).filter((w) => Object.entries(sel).every(([k, v]) => w.labels[k] === v)).map((w) => w.name) : []`.
  - Ingress row: `backends` = the default backend as `{ host: "*", service }` first, then each rule's paths as `{ host: rule.host ?? "*", service }`, skipping entries with no service name, deduplicated on `` `${host}\u0000${service}` `` keeping first-seen order.
  - The `byNs` service/ingress element types gain `serves: string[]` / `backends: Array<{ host: string; service: string }>`.

- [ ] **Step 3: Run, build, commit, push**

Run: `npm test && npm run build`
Expected: all pass, build 0.

README `k8s_cluster_inventory` row: append "Detail entries carry `services[].serves` (workloads the selector matches) and `ingresses[].backends` (host → Service) for the dashboard's map."

```bash
git add src/tools/kubernetes/handlers/inventory.ts src/tools/kubernetes/handlers/inventory.test.ts README.md
git commit -m "feat(k8s): inventory relations — Service serves, Ingress backends"
git push -u origin main
```

---

### Task 2: Shared types and the graph model (devops-ai-agent)

**Files:**
- Create: `src/dashboard/cluster-types.ts` (no imports — client-safe)
- Create: `src/dashboard/cluster-graph.ts`, `src/dashboard/cluster-graph.test.ts`
- Modify: `src/dashboard/views.ts` (import the types from `cluster-types.ts`; delete its local copies; re-export `ClusterInventory`)

**Interfaces:**
- Produces `cluster-types.ts`:

```ts
export type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };
export interface ClusterWorkload { kind: string; name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string }
export interface ClusterNamespace {
  name: string;
  system: boolean;
  workloads: ClusterWorkload[];
  services: Array<{ name: string; type: string; ports: string[]; serves?: string[] }>;
  ingresses: Array<{ name: string; hosts: string[]; backends?: Array<{ host: string; service: string }> }>;
}
export interface ClusterInventory { scanned: { namespaces: number; complete: boolean }; namespaces: ClusterNamespace[] }
```

- Produces `cluster-graph.ts`:

```ts
export type ClusterNodeKind = "namespace" | "host" | "service" | "workload" | "owner";
export interface ClusterNodeData { kind: ClusterNodeKind; label: string; sub?: string; namespace: string; tone?: "warning"; expanded?: boolean; [k: string]: unknown }
export interface ClusterNode { id: string; data: ClusterNodeData }
export interface ClusterEdge { id: string; source: string; target: string; kind: "routes" | "manages" }
export interface ClusterGraph { nodes: ClusterNode[]; edges: ClusterEdge[] }
export const nsId = (ns: string): string => `ns/${ns}`;
export function buildClusterGraph(inv: ClusterInventory, expanded: ReadonlySet<string>, showSystem: boolean): ClusterGraph;
```

- [ ] **Step 1: Failing tests** — `cluster-graph.test.ts`:

```ts
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
```

Run: `npx tsx --test src/dashboard/cluster-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement** `cluster-types.ts` (the Interfaces block verbatim) and `cluster-graph.ts`:
  - visible = `inv.namespaces.filter((n) => showSystem || !n.system)`.
  - Collapsed namespace → `{ id: nsId(n.name), data: { kind: "namespace", label: n.name, sub, namespace: n.name, expanded: false } }`, `sub` = `` `${w} workloads` `` plus `` ` · ${u} not managed by GitOps` `` when `u > 0` (`u` = workloads with `managedBy.type === "unmanaged"`).
  - Expanded namespace → workload nodes `wl/<ns>/<name>` (`label` name, `sub` `` `${kind} · ${ready}/${desired}` `` or `` `${kind} · ${schedule}` ``); service nodes `svc/<ns>/<name>` (`sub` ports joined); host nodes `host/<ns>/<host>` from `backends` (label `any host` for `"*"`); owner nodes — `owner/<ns>/helmrelease/<hrNs>/<name>` (label `HelmRelease <hrNs>/<name>`), `owner/<ns>/kustomization/<ksNs>/<name>` (label `Kustomization <ksNs>/<name>`), `owner/<ns>/helm` (label `Helm`), `owner/<ns>/unmanaged` (label `not managed by GitOps`, `tone: "warning"`) — one per distinct id.
  - Edges: `routes` host→svc for each backend whose Service exists in the namespace; `routes` svc→wl for each `serves` name that is a workload of the namespace; `manages` owner→wl. Edge id `` `${kind}:${source}>${target}` ``, deduplicated.
  - Header comment: pure, imports types only; built in the CLIENT from the embedded inventory, as `topology-graph.ts`' `buildGraph` is.

- [ ] **Step 3: Move the types** — `views.ts` imports `type ClusterInventory, type ManagedBy` from `./cluster-types.js`, deletes its local definitions, and adds `export type { ClusterInventory } from "./cluster-types.js";` so `server.ts`'s import keeps working.

- [ ] **Step 4: Run, commit**

Run: `npx tsx --test src/dashboard/cluster-graph.test.ts src/dashboard/views.test.ts && npx tsc --noEmit -p . && npx tsc -p tsconfig.client.json --noEmit`
Expected: all pass.

```bash
git add src/dashboard/cluster-types.ts src/dashboard/cluster-graph.ts src/dashboard/cluster-graph.test.ts src/dashboard/views.ts
git commit -m "feat(dashboard): cluster graph model — namespaces collapsed, routes and manages edges"
```

---

### Task 3: The client bundle `cluster.js`

**Files:**
- Create: `src/dashboard/client/cluster-layout.ts`, `src/dashboard/client/cluster-layout.test.ts`
- Create: `src/dashboard/client/cluster-nodes.tsx`, `src/dashboard/client/cluster.tsx`
- Modify: `scripts/build-client.mjs` (two entries; FORBIDDEN scan over both JS files)
- Modify: `src/dashboard/assets.ts` (serve `cluster.js`; `Assets` gains `clusterJs: Asset`)

**Interfaces:**
- Consumes: `buildClusterGraph`, `nsId`, `ClusterGraph`, `ClusterNodeData` (Task 2).
- Produces: `layoutClusterGraph(g: ClusterGraph): { nodes: Node<ClusterNodeData, "cluster">[]; edges: Edge[] }`; DOM contract: mount `#cluster-root` (with `data-fallback`), data `#cluster-data` (the `ClusterInventory` JSON); `Assets.clusterJs: Asset`.

- [ ] **Step 1: Failing layout test** — `cluster-layout.test.ts`:

```ts
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
```

Run: `npx tsx --test src/dashboard/client/cluster-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `cluster-layout.ts`** — dagre `{ rankdir: "LR", ranksep: 72, nodesep: 16, marginx: 16, marginy: 16 }` (`/topology`'s measured values); sizes per kind: namespace 260×64, workload 220×56, service 200×52, host 220×44, owner 240×52; React Flow nodes `{ id, type: "cluster", position: { x: pos.x - w / 2, y: pos.y - h / 2 }, data, width: w, height: h }`; edges `{ id, source, target, type: "smoothstep", style: kind === "manages" ? { strokeDasharray: "6 4" } : undefined }`. For layout only, each `manages` edge is given to dagre reversed (workload → owner) so owners rank after workloads; the React Flow edge keeps owner → workload.

- [ ] **Step 3: Implement `cluster-nodes.tsx` and `cluster.tsx`**
  - `cluster-nodes.tsx`: `ClusterNodeCard` — label in mono, `sub` muted below, a small kind caption; `tone === "warning"` uses the warning border/ink classes the topology cards use; a namespace card is `role="button"`, `tabIndex={0}`, `aria-expanded={false}`, Enter/Space toggles via the same handler the click uses; React Flow `Handle`s at `Position.Left` (target) and `Position.Right` (source). `export const clusterNodeTypes = { cluster: ClusterNodeCard }`.
  - `cluster.tsx`: `topology.tsx`'s structure — `MOUNT_ID = "cluster-root"`, `DATA_ID = "cluster-data"`; state `expanded: Set<string>`, `showSystem: boolean`; `buildClusterGraph` → `layoutClusterGraph` → `<ReactFlow>` with `/topology`'s props (`fitView`, `fitViewOptions={{ padding: 0.06 }}`, `minZoom={0.2}`, `maxZoom={2.5}`, `colorMode="system"`, `zoomOnScroll={false}`, `panOnScroll={false}`, `zoomActivationKeyCode={["Meta","Control"]}`, `preventScrolling={false}`, `nodesConnectable={false}`, `deleteKeyCode={null}`, `aria-label="Cluster map"`) inside `<div className="topo-view">`; re-fit on change like `topology.tsx` (requestAnimationFrame `fitView({ padding: 0.06, duration: 400, maxZoom: 1 })`, skipped on first render); a namespace card click toggles it into `expanded`; a toolbar above the canvas with a "Show system namespaces" checkbox and one "Collapse <ns>" button per expanded namespace; a legend below: solid = routes, dashed = managed by, warning = not managed by GitOps, "Ctrl/Cmd + scroll to zoom". Do NOT import `@xyflow/react/dist/style.css` — the page links `topology.css`, which contains it.
  - `main()` as in `topology.tsx`: parse `#cluster-data`, clear the fallback sentence and `data-fallback`, mount under `StrictMode` + `ReactFlowProvider`; any failure leaves the server's markup.

- [ ] **Step 4: Build wiring**
  - `scripts/build-client.mjs`: `entryPoints: { topology: <topology.tsx>, cluster: <cluster.tsx> }`, `entryNames: "[name]"`; the FORBIDDEN scan reads both `topology.js` and `cluster.js`; the Tailwind append stays on `topology.css`; if esbuild emits a `cluster.css`, delete it after the build (the page never links it).
  - `src/dashboard/client/tailwind.css`: confirm its `@source` covers the new `.tsx` files (it must scan `client/`); add `@source "./cluster-nodes.tsx"; @source "./cluster.tsx";` if it names files individually.
  - `assets.ts`: `FILES` gains `{ name: "cluster.js", type: "text/javascript; charset=utf-8" }`; `Assets` gains `clusterJs: Asset`; `loadAssets` returns `{ js, css, clusterJs, byPath }` (any missing file → null, unchanged).

- [ ] **Step 5: Run, commit**

Run: `npx tsx --test src/dashboard/client/cluster-layout.test.ts && npm run build && ls dist/public && npm test`
Expected: layout PASS; `dist/public` lists `topology.js`, `topology.css`, `cluster.js`; suite green.

```bash
git add src/dashboard/client/cluster-layout.ts src/dashboard/client/cluster-layout.test.ts src/dashboard/client/cluster-nodes.tsx src/dashboard/client/cluster.tsx src/dashboard/client/tailwind.css scripts/build-client.mjs src/dashboard/assets.ts
git commit -m "feat(dashboard): cluster.js — the inventory map, collapsed namespaces, React Flow"
```

---

### Task 4: The map on `/cluster`

**Files:**
- Modify: `src/dashboard/views.ts` (`clusterPage` gains `nonce`, `assets`; `clusterFrame` beside `topoFrame`)
- Modify: `src/dashboard/server.ts` (`/cluster` sends a nonce and `csp(nonce)`, passes `this.assets`)
- Test: `src/dashboard/views.test.ts`, `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `Assets.clusterJs` (Task 3), DOM contract `#cluster-root` / `#cluster-data` (Task 3).
- Produces: `clusterPage(inv: ClusterInventory | null, error: string | null, openIncidents?: number, nonce?: string, assets?: Assets | null): string`.

- [ ] **Step 1: Failing tests** — `views.test.ts`:

```ts
test("the cluster page mounts the map above the tables, with the inventory as an escaped JSON block", async () => {
  const { clusterPage } = await import("./views.js");
  const inv = { scanned: { namespaces: 1, complete: true }, namespaces: [{ name: "x</script><b>", system: false, workloads: [], services: [], ingresses: [] }] };
  const assets = { js: { path: "/assets/topology.a.js" }, css: { path: "/assets/topology.b.css" }, clusterJs: { path: "/assets/cluster.c.js" } } as any;
  const html = clusterPage(inv as any, null, 0, "n0nce", assets);
  assert.match(html, /<div id="cluster-root" data-fallback>/);
  assert.match(html, /<script type="application\/json" id="cluster-data" nonce="n0nce">/);
  assert.doesNotMatch(html, /x<\/script><b>/, "the data block cannot be closed from inside");
  assert.match(html, /<script src="\/assets\/cluster\.c\.js" nonce="n0nce" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/topology\.b\.css">/);
  assert.ok(html.indexOf("cluster-root") < html.indexOf("Nothing deployed here"), "map above the tables");
});

test("no bundle or no inventory: tables or note, never a broken map frame", async () => {
  const { clusterPage } = await import("./views.js");
  const inv = { scanned: { namespaces: 1, complete: true }, namespaces: [{ name: "a", system: false, workloads: [], services: [], ingresses: [] }] };
  assert.match(clusterPage(inv as any, null, 0, "n", null), /The cluster map is not built/);
  assert.doesNotMatch(clusterPage(null, "MCP server not connected", 0, "n", null), /cluster-root/);
});
```

`server.test.ts` — extend the existing "/cluster renders the inventory…" test: `header(first, "content-security-policy")` contains `'nonce-` and that nonce equals the `nonce="…"` on the page's `<script` tags.

Run: `npx tsx --test src/dashboard/views.test.ts src/dashboard/server.test.ts`
Expected: FAIL — no map frame, no CSP header.

- [ ] **Step 2: Implement**
  - `views.ts`: `clusterFrame(inv, nonce, assets)` mirroring `topoFrame` — no `assets` → `<div class="card topo-frame">` + `empty("The cluster map is not built.", "Run npm run build:client to bundle it. Every fact it draws is in the tables below.", ICON.plug)`; otherwise `<div class="card flush topo-frame"><div id="cluster-root" data-fallback><p class="topo-fallback">The cluster map needs JavaScript. The tables below carry the same facts.</p></div></div>` + `jsonBlock("cluster-data", nonce, inv)` + `` `<script src="${esc(assets.clusterJs.path)}" nonce="${esc(nonce)}" defer></script>` ``. `clusterPage` inserts it after the intro paragraph and before the namespace sections, only when `inv` is non-null; `layout(…, { current: "/cluster", openIncidents, stylesheet: assets?.css.path })`.
  - `server.ts` `/cluster`: `const nonce = newNonce();` then `send(200, clusterPage(inv, error, open, nonce, this.assets), "text/html; charset=utf-8", { "content-security-policy": csp(nonce) })`.

- [ ] **Step 3: Run, build, commit**

Run: `npx tsx --test src/dashboard/views.test.ts src/dashboard/server.test.ts && npm run build && npm test`
Expected: all pass.

```bash
git add src/dashboard/views.ts src/dashboard/views.test.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat(dashboard): the cluster map on /cluster, above the tables"
```

---

### Task 5: Browser check, deploy, docs

- [ ] **Step 1:** Load ui-ux-pro-max. Fetch the LIVE detail inventory once (`k8s_cluster_inventory {detail:true}` through an MCP port-forward, AFTER Task 1 is deployed) into the scratchpad — never committed. Run a local `DashboardServer` on a spare port with an `inventory` stub returning that file, mint a session cookie (`mintSession`), and load `/cluster` in Playwright (`~/.render-check`) at 1280 and 390, light and dark.
- [ ] **Step 2: Measure** — after load read `document.querySelector(".react-flow__viewport").style.transform`; expect scale ≥ 0.8 with every namespace collapsed. Click the largest application namespace's card; expect no overlapping cards and readable labels. No horizontal page overflow. LOOK at every screenshot. If the scale is below 0.8, cut `ranksep` / card width and re-measure (`/topology`'s lesson: width binds, measure rather than reason).
- [ ] **Step 3: Deploy** — agent image of the last commit; roll out; load the live `/cluster` through a dashboard port-forward and screenshot it.
- [ ] **Step 4: Docs** — `src/dashboard/CLAUDE.md`: one bullet — the second bundle (`cluster.js`, no CSS of its own, links `topology.css`), the graph built client-side from the embedded inventory by the pure `cluster-graph.ts`, every edge from mcp-server relations (`serves`, `backends`), namespaces collapsed by default, system namespaces behind a toggle. `devops-mcp-server/CLAUDE.md`: one sentence that `serves`/`backends` are detail-only so the overview stays inside the agent's 8000-char cap.
- [ ] **Step 5:** Commit and push both repos.
