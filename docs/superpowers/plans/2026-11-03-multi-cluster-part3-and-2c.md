# Multi-cluster part 3 + 2c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stg findings become fixable (live actions through stg's bridge, GitOps PRs against stg's overlay), and the cluster model (`/cluster`, the tour, "where to change it") exists per cluster.

**Architecture:** Everything rides the existing `withCluster`/`currentCluster` AsyncLocalStorage and `ClusterRouter`. State keyed by `alertname + namespace` gains the cluster with the same `{ cluster, local }` scope `IncidentMemory.openRelatable` already uses (NULL reads as the local cluster). The overlay prefix stays derived by `resolveOverlayPath`, now always under the right cluster; off-local with no prefix refuses.

**Tech Stack:** TypeScript ESM on Node 26, `node:test` + tsx, Postgres (`pg`), Flux/Kustomize/Helm for the gitops task.

**Spec:** `docs/superpowers/specs/2026-11-03-multi-cluster-part3-and-2c-design.md` (read it before any task).

## Global Constraints

- Repos: `devops-ai-agent/` (Tasks 1–3, 5–6) and `gitops-devops-ai-manifest/` (Task 4), both under `/home/nvlannasik/research-devops-ai-agent/`.
- No new dependencies. Tests use `node:test` + tsx; `npm test` must stay fully green (1755 tests at start).
- Single-cluster mode (no registry: `clusters.strict === false`) must behave exactly as today, byte for byte.
- NULL `cluster` in Postgres reads as the local cluster (`storedCluster` in `src/agent/cluster/index.ts`).
- Slack text is wholly one language; new refusal/notice strings follow the existing English refusal style.
- Never fall back to the whole-repo prefix for a non-local cluster.
- Commit to `main` per task; never put a model identifier in a commit message. Don't touch image tags.
- Docs and code comments in English, matching the surrounding comment density.

## Review Focus

- An unlabelled alert in strict mode (stored with `cluster` NULL) must still resolve its own incident → Task 1 test `unlabelled resolve closes the NULL-cluster incident`.
- A pre-017 row (`cluster` NULL) must still be found by a local-cluster resolve and recall → Task 1 tests.
- A stg HelmRelease without Kustomization labels (prefix unresolved) must refuse the PR path, never PR the whole repo → Task 3 test `off-local unresolved prefix refuses`.
- `/cluster?cluster=<unknown or malformed>` → 404 page, no crash; single-cluster `/cluster` unchanged (no switch) → Task 6 tests.
- stg bridge down → `/cluster?cluster=stg` shows the error while `/cluster` (dev) still renders; a failure is not cached → Task 6 test.

---

### Task 1: Identity keyed by cluster — resolve, recall, pending lock

**Files:**
- Modify: `src/agent/incidents/index.ts` (`markResolved`, ~251)
- Modify: `src/agent/remediation/index.ts` (`recallForAlert`, ~188)
- Modify: `src/agent/remediation/evidence-refusals.ts` (`targetKey`, ~224)
- Modify: `src/agent/remediation/remediator.ts` (the `targetKey(...)` call ~179 and wherever the card's `params.target` is written)
- Modify: `src/agent/index.ts` (`resolveIncident` ~654, `recallRemediations` ~341)
- Test: `src/agent/incidents/*.test.ts`, `src/agent/remediation/*.test.ts` next to the existing tests of these functions (follow their fake-pool style)

**Interfaces:**
- Produces: `IncidentMemory.markResolved(labels, by = "alertmanager", scope?: { cluster: string | null; local: string | null })`; `RemediationStore.recallForAlert(alertname, namespace, limit = 3, scope?: { cluster: string | null; local: string | null })`; `targetKey(action: string, namespace: string, name: string, cluster?: string | null): string`.
- SQL for both scopes: `AND COALESCE(<table>.cluster, $local::text) IS NOT DISTINCT FROM $cluster::text`, appended only when `scope` is given (exactly as `openRelatable` does, `incidents/index.ts:456-466`). For recall the column is the incident's (`i.cluster`).
- `targetKey` with a non-empty `cluster` returns `${cluster}:${action}:${namespace}/${name}` lowercased; without one, today's `${action}:${namespace}/${name}` (single-cluster keys unchanged).

- [ ] **Step 1: Write the failing tests**
  - `markResolved scopes to the alert's cluster`: with scope `{cluster:"stg", local:"dev"}` the SQL params end with `"dev","stg"` and the WHERE contains `COALESCE(cluster`; without scope, params are exactly today's `[alertname, namespace, by]`.
  - `unlabelled resolve closes the NULL-cluster incident`: `DevOpsAgent.resolveIncident({alertname, namespace})` in strict mode (registry dev local + stg bridge, no `cluster` label) passes scope `{cluster:"dev", local:"dev"}` — an unlabelled incident is stored NULL, which reads as local.
  - `resolveIncident with cluster=stg scopes to stg`.
  - `recallForAlert scopes by the incident's cluster` (same param/SQL assertions) and `recallRemediations passes the alert's cluster` (strict) / passes no scope (single-cluster).
  - `targetKey keeps single-cluster keys and prefixes the cluster`: `targetKey("restart","Default","Web")` → `"restart:default/web"`; `targetKey("restart","default","web","stg")` → `"stg:restart:default/web"`.
  - `a dev pending card does not block the same target on stg`: the pending lookup key for a stg proposal differs from a dev one (assert on the key passed to `pendingFor`).
- [ ] **Step 2: Run** `npx tsx --test <the test files>` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `DevOpsAgent`, the scope is `this.clusters.strict ? { cluster: alertCluster(labels, this.clusters) ?? this.clusters.local, local: this.clusters.local } : undefined`. In the remediator, the key's cluster is `currentCluster()` when `this.host.clusters?.strict` (proposals run inside the thread's `withCluster`); store the same key in the card's `params.target` so `pendingFor` matches it.
- [ ] **Step 4: Run** the test files, then `npm test` — Expected: PASS, suite green.
- [ ] **Step 5: Commit** `fix(cluster): resolve, remediation recall and the pending-card lock are per cluster`.

### Task 2: Alert-state reads and the service graph per cluster

**Files:**
- Modify: `src/agent/remediation/verify.ts` (`alertState`, ~235)
- Modify: `src/agent/remediation/remediator.ts` (~951, the verification call)
- Modify: `src/agent/incidents/lifecycle.ts` (~83, reconcile) and the query feeding it (it must select `cluster`)
- Modify: `src/agent/correlation/topology.ts` (`serviceGraph` cache, ~50-66)
- Modify: `src/agent/index.ts` (new `serviceGraphFor`), `src/app/alerts.ts` (~66)
- Test: `src/agent/remediation/verify.test.ts` (or the file testing `alertState`), `src/agent/correlation/*.test.ts`

**Interfaces:**
- Produces: `alertState(raw: string, alertname: string | null, namespace: string | null, cluster?: string | null): AlertState` — a record whose `labels.cluster` is a string different from a given `cluster` does not count (same "reject only what we can compare" rule as namespace). Callers pass `storedCluster(row.cluster, registry)` in strict mode, nothing otherwise.
- Produces: `serviceGraph` caches per `currentCluster() ?? ""` (a `Map`); `resetServiceGraphCache()` clears all.
- Produces: `DevOpsAgent.serviceGraphFor(labels: Record<string, string>): Promise<CallGraph | null>` — runs `serviceGraph` under `withCluster(alertCluster(labels, this.clusters))` in strict mode, plain otherwise. `alerts.ts:66` uses it instead of `serviceGraph(...)`.

- [ ] **Step 1: Write the failing tests**
  - `alertState ignores another cluster's alert`: raw holds `KubePodCrashLooping` with `labels.cluster:"dev"`; `alertState(raw,"KubePodCrashLooping","default","stg")` → `"cleared"`; with `"dev"` → `"firing"`; with no cluster arg → `"firing"`; a record with no `cluster` label still counts for `"stg"`.
  - `serviceGraph caches per cluster`: under `withCluster("dev")` then `withCluster("stg")`, the fake `callTool` is called twice (two keys); a second call under `"dev"` within the TTL is served from cache.
  - `serviceGraphFor runs under the alert's cluster`: with the wiring-test router (`src/agent/cluster/wiring.test.ts` setup), the `prometheus_query` that reaches the central fake carries `cluster="stg"` for labels `{cluster:"stg"}`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; the verification call passes the check row's cluster, reconcile passes the incident row's.
- [ ] **Step 4: Run** the files, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(cluster): alert-state reads and the service graph are per cluster`.

### Task 3: Change timeline and GitOps PRs per cluster

**Files:**
- Modify: `src/agent/index.ts` (`collectChanges`, ~360-390)
- Modify: `src/agent/remediation/remediator.ts` (remove the refusal ~211-216; prefix checks at the dry-run ~542 and the revert path ~609)
- Test: `src/agent/cluster/wiring.test.ts`, the remediator's existing test file(s)

**Interfaces:**
- Consumes: `resolveOverlayPath(hr)` (unchanged; must run under the right cluster).
- Produces: `collectChanges` — the history callback resolves the prefix inside the same `read()` wrapper as `callTool`; git history is available for every cluster whose prefix resolved; when the cluster is non-local (`strict && cluster !== local`) and the prefix is undefined, the callback returns `{ ok: false, reason: "cannot tell which overlay in the repository is <cluster>'s for <name>" }` (an unread line), never a request without `pathPrefix`. Remove the "local cluster only" gitops gate.
- Produces: remediator — no off-local refusal; on a non-local cluster an undefined prefix refuses the GitOps path (dry-run, drift → `flux_reconcile`, revert PR) with `GitOps changes for <cluster> need its overlay path, and <namespace>/<name>'s Flux Kustomization could not be read; a restart or a pod delete is still possible.` Local keeps today's worker fallback.

- [ ] **Step 1: Write the failing tests**
  - `history resolves the overlay under the alert's cluster` (wiring): a fake gitops `request` records the `pathPrefix` it got; with labels `{namespace, cluster:"stg"}` and stg's fake returning a HelmRelease + Kustomization whose `spec.path` is `./apps/stg/applications`, the history request carries `pathPrefix: "apps/stg/applications/"`; the Kustomization read went to `stg:` (not `dev:`). Inject the gitops client through a new optional `AgentDeps.gitops` (tests only), mirroring `deps.mcp`.
  - `off-local unresolved prefix gives no git source`: stg fake has no Kustomization → no gitops request is sent; the timeline's `unread` names stg.
  - `off-local GitOps proposal is no longer refused` and `off-local unresolved prefix refuses` (remediator, using its existing fake host with `clusters` strict and `withCluster("stg")`): with a resolved prefix the dry-run request carries it; without one the result is the refusal above.
  - `local unresolved prefix keeps the fallback`: under `"dev"`, an undefined prefix still sends the dry-run without `pathPrefix`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the files, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): part 3 — GitOps PRs and git history per cluster, from each cluster's own overlay`.

### Task 4: stg bridge write tools (gitops repo)

**Files:**
- Modify: `gitops-devops-ai-manifest/apps/stg/applications/devops-mcp-bridge/release.yaml` (`writeTools`, `rbac`, ~70-86)

**Interfaces:** none (deploy config). Values copied from the spec §4: `writeTools: {enabled: true, allowedNamespaces: [default, flux-system, monitoring, devops-tools]}`; `rbac: {create: true, readOnly: true, allowWrite: true, allowFluxReconcile: true, allowOrphanDelete: false}`. Keep every existing key; comment the why in the file's style (dev's comment at `apps/base/applications/devops-ai-stack/release.yaml:270-285` explains `allowOrphanDelete`).

- [ ] **Step 1: Render check.** Extract the release's `values` and run `helm template x /home/nvlannasik/research-devops-ai-agent/devops-ai-helm-charts/charts/devops-ai-stack -f <values>` — Expected: renders (the chart's `_validate.tpl` passes) and the output has `MCP_ENABLE_WRITE_TOOLS` `"true"` and a Role/ClusterRole rule with `patch` on `deployments` and on `helmreleases`, and no `delete` on `configmaps`.
- [ ] **Step 2: Run** `kubectl kustomize apps/stg/applications` — Expected: builds.
- [ ] **Step 3: Commit** `feat(stg): the SQS bridge serves write tools — live fixes on stg through the approval card` (do not push; the controller pushes and reconciles).

### Task 5: The cluster model per cluster (agent)

**Files:**
- Modify: `src/agent/cluster/index.ts` (`withCluster` type)
- Modify: `src/agent/index.ts` (the `clusterModels` field ~129-142, `clusterModel` ~247, `peekClusterModel`, `clusterInventory` ~268, `onLocal`, `mcpTools`)
- Test: `src/agent/cluster/wiring.test.ts`

**Interfaces:**
- Produces: `withCluster<T>(cluster: string | null, fn: () => T): T` (sync-capable; existing async callers unchanged).
- Produces: `DevOpsAgent` keeps `Map<string, ClusterModelCache>` keyed by cluster (`""` in single-cluster mode), each cache's builder running `buildClusterModel` under `withCluster(cluster)` (strict) — `onLocal` is no longer used for the model. `clusterModel(namespace?)` reads the entry of `currentCluster()` (strict; null when there is none) or `""`. `peekClusterModel(cluster?: string): ClusterModel | null` and `clusterInventory(cluster?: string): Promise<string>` default to the local cluster in strict mode. `mcpTools()` returns the local cluster's tools in strict mode (for `/topology`).

- [ ] **Step 1: Write the failing tests** (replace the 2a test `the dashboard's /cluster reads the local cluster; another cluster's thread gets no local model`):
  - `each cluster has its own model`: `withCluster("stg", () => agent.clusterModel())` makes the inventory call reach `stg:k8s_cluster_inventory`; `withCluster("dev", …)` reaches `dev:`; a second stg call within the TTL makes no new call.
  - `the dashboard reads the cluster it is asked for`: `agent.clusterInventory()` → `dev:`; `agent.clusterInventory("stg")` → `stg:`.
  - `mcpTools in strict mode lists the local cluster's tools`: includes `k8s_list_pods` outside any `withCluster`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the file, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): 2c — the cluster model and the tour per cluster`.

### Task 6: Dashboard `/cluster?cluster=`

**Files:**
- Modify: `src/dashboard/server.ts` (route ~54, handler ~564-570, `clusterInventory` + `inventoryCache` ~184/370-391, constructor callback types ~203-212)
- Modify: `src/dashboard/cluster-views.ts` (`clusterPage`, ~46-143)
- Modify: `src/index.ts` (~18, the two callbacks now take a cluster)
- Test: `src/dashboard/server.test.ts`, `src/dashboard/cluster-views.test.ts`

**Interfaces:**
- Consumes: Task 5's `clusterInventory(cluster?)`, `peekClusterModel(cluster?)`.
- Produces: server callbacks `inventory?: (cluster?: string) => Promise<string>`, `clusterModel?: (cluster?: string) => unknown`; `inventoryCache: Map<string, entry>` keyed by cluster (failures still not cached). `clusterPage(inv, error, open, nonce, assets, model, view?: { current: string; names: string[] })` — with `view`, the title reads `Cluster · <current>` and a `<nav class="seg" aria-label="Cluster">` of links `/cluster?cluster=<name>` (`aria-current="true"` on the current) sits in `.page-actions`, the incidents page's markup (`incident-views.ts:79-88,112`); without `view`, the page is byte-identical to today.
- `?cluster=` is validated by the registry: absent → local cluster; a name not in `clusters.names` (or malformed) → the existing 404 `errorPage`. Single-cluster mode ignores the param and passes no `view`.
- Follow `src/dashboard/CLAUDE.md` (links only in `.seg`, no new styles, the page's nonce/JSON-block rules).

- [ ] **Step 1: Write the failing tests**
  - `clusterPage names the cluster and links the others` (view given) / `clusterPage without a view is unchanged` (snapshot-equal to the no-view output).
  - server: `/cluster?cluster=stg` calls `inventory("stg")` and `clusterModel("stg")`; `/cluster` calls them with the local name; `/cluster?cluster=prd` → 404; `/cluster?cluster=Bad!` → 404; single-cluster `/cluster?cluster=stg` renders as today.
  - `a stg failure does not touch dev`: `inventory("stg")` throws → the stg page shows `Inventory failed:`; a following `/cluster` renders dev's cached inventory; a following `/cluster?cluster=stg` calls `inventory("stg")` again.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the files, then `npm test` and `npm run build` — Expected: PASS, build ok.
- [ ] **Step 5: Commit** `feat(dashboard): /cluster per cluster — a cluster switch and the cluster in the title`.

### Task 7 (controller): ship, verify live, docs

Done by the controller, not a subagent: push both repos, wait for CI, roll out the agent (`kubectl -n devops-tools rollout restart deploy/devops-ai-agent`), reconcile stg Flux and confirm the bridge restarts with write tools; Playwright check of `/cluster` and `/cluster?cluster=stg` (memory: verify UI in a browser); live success checks 1–4 of the spec as far as the connector account allows (the user clicks Approve); docs: `devops-ai-agent/CLAUDE.md`, workspace `CLAUDE.md`, `confluence-docs` 01/03/04/05/06 + README; final self-review.
