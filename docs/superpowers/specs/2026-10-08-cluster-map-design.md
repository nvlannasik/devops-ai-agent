# Cluster map — the inventory as a React Flow graph on `/cluster`

**Status:** approved direction (2026-10-07), spec under review
**Repos:** `devops-mcp-server` (relations on the inventory), `devops-ai-agent` (graph model, second client bundle, page)
**Builds on:** `2026-10-07-cluster-tour-design.md` (the inventory and the `/cluster` tables)

## 1. Purpose

`/cluster` lists what runs and who manages it, as tables. A newcomer also wants the shape: which
host reaches which Service, which workload a Service fronts, and which GitOps source owns it. A
graph answers that at a glance where tables need a cross-reference by name. The tables stay —
they are the detail, and the page's no-JavaScript fallback.

## 2. Success criteria

1. `/cluster` opens with a map: one collapsed card per application namespace (system namespaces
   hidden behind a toggle), each saying how many workloads it holds and how many are not managed
   by GitOps.
2. Expanding a namespace shows, left to right: Ingress host → Service → workload, and the
   workload's owner (HelmRelease / Kustomization / Helm / unmanaged) joined to it with a
   differently styled edge.
3. Every edge comes from cluster data computed server-side — nothing is inferred from names.
4. Readable at the opening zoom on a 1280px screen; usable on a phone (pan, Ctrl/Cmd+scroll zoom
   like `/topology`, the wheel not captured).
5. Still no LLM, still the 60 s cache, tables below the map unchanged.

## 3. Design

### 3.1 Relations in `k8s_cluster_inventory` (devops-mcp-server)

Detail entries gain two fields; the whole-cluster overview (`overviewOf`) is unchanged, so the
agent's tour and its 8000-char budget are unaffected.

```jsonc
"services":  [{ "name": "storefront", "type": "ClusterIP", "ports": ["80/TCP→3000"], "serves": ["storefront"] }],
"ingresses": [{ "name": "storefront", "hosts": ["shop.example.com"],
                "backends": [{ "host": "shop.example.com", "service": "storefront" }] }]
```

- `serves`: the workloads in the same namespace whose pod-template labels satisfy the Service's
  `spec.selector` (every selector key equal). A Service with no selector (ExternalName,
  manually-managed Endpoints) serves `[]` — an absent edge, not a guessed one. Workload kinds:
  Deployment, StatefulSet, DaemonSet (a CronJob is not a Service backend).
- `backends`: every `rules[].http.paths[].backend.service.name` with its rule's host
  (`"*"` for a rule with no host), plus `defaultBackend` as host `"*"`. Deduplicated.
- Requires the workloads' `spec.template.metadata.labels` and the Services' `spec.selector`,
  both already in the objects the tool lists — no new API calls, no new RBAC.

### 3.2 Graph model (devops-ai-agent, `src/dashboard/cluster-graph.ts`, pure)

`buildClusterGraph(inv: ClusterInventory): ClusterGraph` — server-side, like `buildTopology`.

- Node kinds: `namespace` (the collapsed card), `host`, `service`, `workload`, `owner`.
  An owner node is one per distinct HelmRelease/Kustomization, one `Helm` and one
  `not managed by GitOps` node per namespace.
- Edge kinds: `routes` (host → service, service → workload) and `manages` (owner → workload).
- Every node carries its namespace; the client groups by it.
- Ids are deterministic (`ns/<ns>`, `wl/<ns>/<name>`, `svc/<ns>/<name>`, `host/<ns>/<host>`,
  `owner/<ns>/<type>/<name>`) so expanding and collapsing never reshuffles the rest.

### 3.3 Client (`src/dashboard/client/cluster.tsx`)

- A second esbuild entry → `cluster.js`; `assets.ts` serves it beside `topology.js`. The page
  links the existing `topology.css` (React Flow's stylesheet + the shared Tailwind subset) —
  one stylesheet, not two.
- Graph JSON embedded in the page exactly as `/topology` does; nonce-based CSP unchanged.
- Collapsed namespace = one card. Click (or Enter/Space) expands it into its subgraph; dagre lays
  out only the visible nodes (`rankdir: LR`). System namespaces behind a "Show system
  namespaces" toggle.
- `manages` edges dashed, `routes` solid; the unmanaged owner node uses the warning tone so it
  reads as the thing not to copy. A legend states both, and the zoom keys.
- Reuses `/topology`'s rules: frame height stated, `zoomOnScroll={false}`,
  `preventScrolling={false}`, `zoomActivationKeyCode` naming both Ctrl and Meta, a one-sentence
  no-JS note cleared on mount, `fitView` with small padding.

### 3.4 Page

`clusterPage` renders the map frame above the existing tables; `assets: null` (dev, no bundle)
renders a note, as `topologyPage` does. Map and tables come from the same cached inventory.

## 4. Testing

- **mcp-server:** `serves` (match, partial-label mismatch, selector-less Service, other namespace
  never matched, CronJob never a backend); `backends` (multiple paths, no-host rule, default
  backend, dedupe).
- **agent:** `buildClusterGraph` — ids, edge kinds, owner dedupe, a namespace with no Services
  still has its workloads and owners; layout of an expanded namespace has no overlapping nodes.
- **browser:** desktop, phone, dark; measure the opening zoom (expect ≥ 0.8 with every namespace
  collapsed on the live cluster) and an expanded namespace's readability; screenshot.

## 5. Out of scope

Pods, ReplicaSets, ConfigMaps/Secrets as nodes; traffic between Services (needs metrics or
tracing); live updates; any LLM; editing anything.
