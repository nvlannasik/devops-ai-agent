# Multi-cluster part 3 + 2c: remediation and the cluster model per cluster — design

Date: 2026-11-03. Follows 2a (`2026-11-02-multi-cluster-routing-design.md`) and 2b (PromQL/LogQL held
to the run's cluster, `agent/cluster/scope.ts`). The user asked for both without a question round
(2026-11-03), so every choice below not stated by the user is marked **(my call)**.

## Intent

After 2a/2b the agent investigates `stg` correctly but can do nothing about what it finds there, and
the dashboard and the cluster tour only know `dev`. Part 3 makes a stg finding fixable through the same
approval card as dev — live actions through stg's bridge, and GitOps pull requests against stg's own
overlay in the same repository. 2c makes the cluster model (the `/cluster` page, the cluster tour, and
"where to change it") exist per cluster.

Before stg may write, the places where 2a still keys state by `alertname + namespace` alone must key it
by cluster too: with writes on, a dev card blocking a stg target, or a stg resolve closing a dev incident,
stops being cosmetic.

## Goals

- A stg alert or mention can produce an approval card; Approve runs it on stg through its bridge.
- A Flux-managed stg workload gets a GitOps PR that edits `apps/stg/...` (or its base), never dev's.
- The change timeline of a stg alert lists that HelmRelease's commits (overlay + base).
- `/cluster` shows any registry cluster (`?cluster=stg`), and says which one it shows.
- A cluster tour in a stg thread is built from stg's inventory and stg's overlay paths.
- Nothing keyed by incident/remediation identity mixes clusters (resolve, pending-card lock, remediation
  recall, alert-state reads, the service-graph cache).

## Non-goals

- Cross-cluster comparison answers ("bandingkan dev dan stg").
- A separate GitOps repository or worker per cluster: one repo, one worker, one queue.
- Tracing for stg (its Jaeger stays local).
- Orphan deletion on stg (`k8s_delete_orphan`) — **(my call)**: it removes objects nothing recreates; dev
  earned it with measured cases, stg has none yet.

## Anti-goals

- A stg PR that edits a dev file. The worker's fallback prefix is the whole repo, and HelmRelease names
  repeat across base, dev and stg (prometheus, loki, fluentbit, …): an unresolved prefix on a non-local
  cluster must refuse, never fall back.
- A change run on the wrong cluster. Every execute/verify path already runs under the card's or the
  check row's cluster (`remediator.ts` `onCluster`); keep it that way.

## Facts this rests on (research 2026-11-03)

- The off-local refusal is one guard, `remediator.ts:211-216`; git history is local-only at
  `agent/index.ts:376-377`; the cluster model is local-only (`onLocal`, `clusterModel()` null off-local).
- `pathPrefix` is derived, not configured: `resolveOverlayPath` reads the HelmRelease's
  `kustomize.toolkit.fluxcd.io/{name,namespace}` labels, that Kustomization's `spec.path`, and
  `fluxPathToPrefix`. On stg the `apps` Kustomization's path is `./apps/stg/applications`, so the same
  code yields `apps/stg/applications/` when it runs under `withCluster("stg")`. On any miss it returns
  undefined and the worker falls back to `GITOPS_PATH_PREFIX` ("" in dev).
- Bug: `collectChanges`' history callback calls `resolveOverlayPath` outside any cluster (`index.ts:382`
  is not wrapped like `:380`), so in strict mode it throws, history goes out with no prefix, and a dev
  HelmRelease that also has a base file reads "ambiguous".
- The worker never reads a cluster; drift's `clusterValue` is the dry-run's `from`, read by whichever
  cluster ran the dry-run. The worker needs no change.
- Live proposals die silently on stg: `remediator.ts:122` returns null when no `[WRITE]` tool is visible,
  and the stg bridge runs with `writeTools.enabled: false`. The chart's `_validate.tpl` requires
  `writeTools.enabled` and `rbac.allowWrite` to agree.
- The SQS bridge deletes a write tool's message before running it (at-most-once, `sqs-bridge.ts:112-122`).
- Single-cluster keys found: `markResolved` (alertname + namespace), `pendingFor` target key
  (`action:ns/name`), `recallForAlert(alertname, namespace)`, `alertState(...)` in verification and in
  reconcile (ignores the `cluster` label), `serviceGraph`'s one 5-minute cache slot, `/topology`'s
  `mcpTools()` read outside any cluster.

## Design

### 1. Identity keyed by cluster (prerequisite)

- `markResolved` matches the resolved alert's cluster (NULL reads as local, as everywhere since 017).
- The pending-card lock key gains the cluster: `cluster:action:ns/name` (local cluster for single-cluster
  mode, so today's keys keep working there).
- `recallRemediations` / `recallForAlert` take the cluster; a verdict applies only to its own cluster
  (2a spec §4 already said so).
- `alertState` (verification and reconcile) matches the `cluster` label when the check/incident has one.
- `serviceGraph`'s cache is keyed by the current cluster; correlation calls it under the alert's cluster.

### 2. Change timeline per cluster

`collectChanges` resolves the overlay prefix under the alert's cluster (same `read()` wrapper the MCP
call uses). Git history runs for any cluster whose prefix resolved; off-local with no prefix → no git
source (a stated unread line), never the whole-repo fallback.

### 3. GitOps PRs per cluster

- Remove the off-local refusal. `dry_run`, `open_pr` and `revert_pr` carry the prefix resolved under the
  card's cluster, as they already do for dev.
- Off-local and the prefix did not resolve → refuse the PR path with the reason ("cannot tell which
  overlay in the repository is stg's for <hr>"). Local keeps today's fallback.
- `flux_reconcile` on drift and the revert PR follow the same rule; the rollback gate is unchanged.

### 4. Live actions on stg

- gitops repo: the stg bridge release turns on `writeTools` with `allowedNamespaces: [default,
  flux-system, monitoring, devops-tools]` **(my call: the stg namespaces with workloads; the server's own
  guard still blocks kube-system / flux-system workload changes)** and `rbac.allowWrite: true`,
  `allowFluxReconcile: true`, `allowOrphanDelete: false`.
- Agent: nothing new — the router already exposes the bridge's `[WRITE]` tools to a stg run, and
  execution already runs under the card's cluster. At-most-once on the bridge stays.

### 5. The cluster model per cluster (2c)

- `ClusterModelCache` keys `cluster + namespace`; a build runs under `withCluster(cluster)` (locate uses
  that cluster's resolved prefixes). `clusterModel(ns)` reads the current cluster's entry; `peek(cluster)`
  for the dashboard. Single-cluster mode keys on `""` as today.
- Dashboard `/cluster?cluster=<name>`: in strict mode a `.seg` link group of the registry's clusters (the
  incidents page's pattern, `incident-views.ts:79-88`), default the local cluster; the page title names
  the cluster; an unknown name is a 404. The inventory cache is keyed by cluster. **(my call: a data
  filter like the incident list's, not a second rail item — the memory rule "pages, not tabs" is about two
  views of one feature, and this is one view over different data.)**
- `/topology` reads the local cluster's tools (`onLocal`).

## Success (live)

1. A stg mention "restart deployment X in default" → an approval card with "Cluster: stg"; Approve
   restarts X on stg (the user clicks — the connector account cannot approve).
2. A stg Flux workload's image change → the dry-run/PR diff names `apps/stg/...`.
3. `/cluster?cluster=stg` renders stg's namespaces; `/cluster` renders dev's, titled with the cluster.
4. A stg alert's timeline shows commits when its HelmRelease has any.

## Left to the builder

Test layout, exact refusal wording (one language per reply — see the memory on one-language Slack text),
where the cluster parameter threads through `queries.ts`/`verify.ts` signatures.
