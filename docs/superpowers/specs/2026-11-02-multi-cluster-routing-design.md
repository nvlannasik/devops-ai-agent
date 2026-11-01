# Multi-cluster, part 2a: cluster identity and routing — design

Date: 2026-11-02. Sub-project 2a of multi-cluster (part 1, the SQS bridge, shipped 2026-10-16:
`2026-10-15-multi-cluster-sqs-bridge-design.md`). Order after this: 2c onboarding multi-cluster →
2b PromQL/LogQL guard → part 3 GitOps mapping per cluster.

## Intent

The agent investigates alerts from more than one Kubernetes cluster. Observability is
centralised: one cluster (`dev` today) runs Prometheus, Loki, Alertmanager and the agent stack;
workload clusters (`stg` today) ship their metrics and logs to it and accept no inbound traffic.
The agent reaches a workload cluster's Kubernetes API only through that cluster's SQS bridge
(part 1).

Today the agent talks to exactly one MCP server and has no notion of "which cluster". With a
second cluster shipping data, that is wrong in quiet ways: an alert from stg would be investigated
against dev's pods, and both clusters have a node called `worker1`, so an unfiltered query mixes
them. 2a makes the cluster an explicit property of every thread, card, incident and tool call.

## Goals

- An alert from stg is investigated against stg's Kubernetes (through its bridge) and the
  central Prometheus/Loki filtered to `cluster="stg"`; its RCA card and approval card say stg.
- A mention names its cluster, or the agent asks for it before reading any Kubernetes.
- Everything that runs later without a thread (verification, the GitOps apply watch) acts on
  the cluster the card was made for.
- Memory never presents one cluster's history as another's.
- With no cluster registry configured, the agent behaves exactly as it does today.

## Non-goals

- A code guard that rewrites or rejects PromQL/LogQL lacking the cluster filter (2b). 2a adds a
  prompt rule only.
- `/cluster` map selector, multi-cluster cluster tour, `buildClusterModel` per cluster (2c).
- GitOps PR remediation for a non-local cluster: `pathPrefix` per cluster, `locate` per cluster
  (part 3). See Remediation below for what 2a does instead.
- Tracing for workload clusters: stg's Jaeger stays local, so `tracing_*` finds nothing for an
  stg thread. A known limit, stated in the RCA's unknowns, not fixed here.

## Anti-goals

- Never fall back to the central cluster's Kubernetes when a thread's cluster is unknown or its
  bridge is unreachable. A wrong-cluster answer is worse than no answer.
- No change to any of the 27 existing `mcp.callTool` / `mcp.getTools` call sites.

## Live facts this design rests on (checked 2026-11-02)

- stg ships to dev: Prometheus `remote_write` to `10.10.10.111` with `external_labels:
  {cluster: stg}`; fluentbit to Loki at `10.10.10.112` with `cluster=stg`
  (gitops `2f0fc4c`). 8,751 stg series arrive centrally.
- Dev's own series carry no `cluster` label, only `cluster_name="kubernetes-cluster-dev"` (used by
  Grafana dashboards). Dev's logs carry no cluster label.
- Alert rules evaluate only at the centre. Alertmanager `group_by: [alertname, namespace]`.
- Both clusters have a node named `worker1`, and both have `kube-system` and `monitoring`.
- stg has no bridge. `devops-mcp-bridge-lab2` runs in dev and reads dev (part 1 lab).
- The umbrella chart can disable the agent and the worker (`<subchart>.enabled`). The lab2
  bridge authenticates to SQS with IAM Roles Anywhere.

## Design

### 1. Registry and routing (decided 2026-10-21)

- Registry: `MCP_LOCAL_CLUSTER` (optional; the cluster the agent's HTTP MCP server reads, `dev`)
  plus the existing `MCP_SQS_CLUSTERS` (`stg=devops-mcp-stg-request.fifo`). **Strict mode** —
  everything in this document — applies only when the registry is configured: `MCP_LOCAL_CLUSTER`
  set or `MCP_SQS_CLUSTERS` non-empty. Otherwise nothing changes.
- Routing by tool name: `k8s_*` and `flux_*` go to the thread's cluster (HTTP MCP for the local
  cluster, its `SqsMCPClient` for a bridge cluster). `prometheus_*`, `loki_*`, `alertmanager_*`
  and `tracing_*` go to the central MCP server.
- Write policy is each bridge's own tool list: a bridge started without write tools never yields
  a card for its cluster.
- An unreachable bridge never affects the agent's `/health`. For that thread it is an unknowns line
  in the RCA ("Kubernetes for stg was unreachable").

### 2. Where a thread's cluster comes from

- **Alert:** the group's `cluster` label. Alertmanager `group_by` becomes
  `[alertname, namespace, cluster]`, so one group never mixes clusters.
- **Dev labels its own data `cluster=dev`:** a per-job relabel on dev's Prometheus scrapes
  (keeping `cluster_name` for Grafana) and `cluster=dev` on dev's fluentbit output. Without it every
  dev alert would be "unlabelled" in strict mode and lose its Kubernetes tools.
- **Mention:** a registry cluster name in the message as a whole word ("cek pod di stg") binds the
  thread. A thread already bound keeps its cluster.
- **Switch:** an explicit request ("pindah ke dev") rebinds the thread. Earlier history stays in the
  conversation, marked as about the previous cluster. Existing cards stay bound to theirs.
- **No cluster:** a mention with none — the agent answers without Kubernetes tools and asks which
  cluster, naming the registry's clusters. An alert without a `cluster` label (or naming a cluster
  not in the registry) is investigated without Kubernetes tools; the RCA says the label is missing,
  and confidence is capped at Low, which pages on-call.

### 3. ClusterRouter

- `ClusterRouter implements McpTools` replaces the single MCP client in `DevOpsAgent`.
- The active cluster travels in `AsyncLocalStorage` — `withCluster(name, fn)` /
  `currentCluster()`, the same pattern as `withTrace` in `src/utils/trace/index.ts`. The router
  reads it on every call; no call site changes.
- `getTools()` returns the central tools plus the `k8s_*`/`flux_*` tools of the current cluster;
  with no current cluster in strict mode, the central tools only.
- `withCluster` is set at the entry points: an investigation or follow-up (the thread's cluster),
  a proposal and its execution (the card's), and the jobs that run without a thread — verification,
  the GitOps apply watch, the incident reconcile — from the database row.
- The investigation prompt gets one line naming the cluster and requiring `cluster="<name>"` in
  every PromQL and LogQL selector. Enforcing it in code is 2b.

### 4. Postgres and memory

- Migration `017` (`016` is taken by the GitOps apply watch) adds a nullable `cluster` column to
  `incidents`, `remediations` and `remediation_checks`. Remediations and checks hold it directly:
  a mention's card has no incident, and the poller must not join to find it.
  `incident_feedback` and `postmortems` take it from their incident.
- The run's `start` payload in `agent_events` records the cluster.
- **NULL means the local cluster** (`MCP_LOCAL_CLUSTER`) when read. No data migration; all of
  dev's history stays valid.
- Recall is keyed `cluster + alertname + namespace`. The three trust tiers stay, same cluster
  first. Another cluster's incidents drop to the "possibly related" tier, labelled with their
  cluster ("seen on dev"); a human-confirmed cause from another cluster is shown as confirmed
  there, not as a strong prior here. A remediation verdict applies only to its own cluster.
- Redis: a mention thread's cluster lives in a per-thread key with the conversation's 24h TTL. An
  alert thread's cluster comes from its incident row. Dedup separates per cluster through the
  Alertmanager group key. Cross-alert correlation ("🔗 Related alert") joins only incidents of the
  same cluster.

### 5. Slack and dashboard (mockup approved 2026-11-02)

- RCA card: a cluster badge beside the severity, and the cluster (and "bridge" when remote) in the
  footer.
- Approval card: a bold "Cluster: stg" line directly above Approve/Reject.
- Mention without a cluster: the agent asks, listing the clusters.
- Switch: "🔀 This thread now uses cluster dev. Earlier answers were about stg."
- Dashboard: a Cluster column and a cluster filter on the incident list; the cluster in the incident
  page's title. Pre-multi-cluster incidents show as the local cluster.
- In single-cluster mode (no registry), none of this appears.

### 6. Remediation on a bridge cluster

- Live actions run through the card's cluster: dry-run and execution via that cluster's bridge.
- GitOps PRs for a non-local cluster are part 3. Until then, when the target of a non-local card is
  Flux-managed, the agent refuses the PR path with the reason ("GitOps changes for stg arrive with
  per-cluster repository mapping") instead of opening a PR against the local cluster's overlay.
  Restarts and pod deletes stay allowed, as they are reconcile-safe today.

### 7. The stg bridge

- stg runs the umbrella chart with only `devops-mcp-server` enabled, `TRANSPORT=sqs`, request
  queue `devops-mcp-stg-request.fifo`, the shared `devops-mcp-response.fifo`, read tools only at
  first (`MCP_ENABLE_WRITE_TOOLS` off). Deployed by Flux from the stg overlay.
- AWS credentials for SQS on stg are the user's to provide as a Secret (IAM Roles Anywhere, as the
  lab2 bridge does). The overlay references the Secret and never creates it.
- The agent's `MCP_SQS_CLUSTERS` gains `stg=devops-mcp-stg-request.fifo`; `MCP_LOCAL_CLUSTER=dev`.
- `devops-mcp-bridge-lab2` (part 1 lab) is removed once the stg bridge answers.

## Success

1. A real stg alert (a test workload crash-looping on stg) posts an RCA with the stg badge; its tool
   calls in Jaeger go `k8s_*` → `SqsMCPClient` → the stg bridge, and its PromQL carries
   `cluster="stg"`.
2. A dev alert behaves as today, with a dev badge.
3. "@agent pod mana yang restart?" with no cluster gets the question back and no Kubernetes call.
4. A verification check for a stg card runs against stg after a pod restart of the agent.
5. With the registry unset, the full test suite passes unchanged.

## Testing

- Unit: the router's routing table, strict vs single-cluster mode, unknown cluster, unreachable
  bridge; thread binding from label, mention, switch; recall keys and tiers; migration NULL rule.
- Replay: existing cases run unchanged in single-cluster mode.
- Live: success items 1–4 on dev + stg. Silence nothing extra: the test workload lives on stg,
  not in `bench-*`.

## What is left to the builder

- The exact mention grammar for binding and switching, within "a registry name as a whole word"
  and "an explicit switch phrase".
- How the chart's env/secretEnv carry the bridge's SQS and AWS settings on stg, if the subchart
  needs a small change for it.
- The test workload for success item 1 (smallest thing that crash-loops on demand).
