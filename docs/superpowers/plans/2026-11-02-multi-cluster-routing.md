# Multi-cluster 2a — cluster identity and routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every thread, card, incident and tool call carries a cluster; `k8s_*`/`flux_*` calls go to that cluster (local HTTP MCP or its SQS bridge), everything else to the central MCP.

**Architecture:** A `ClusterRouter` implements `McpTools` and replaces the single MCP client only when a registry is configured (`MCP_LOCAL_CLUSTER` / `MCP_SQS_CLUSTERS`). The active cluster rides in `AsyncLocalStorage` (`withCluster`), set at entry points from the alert label, the thread binding, or a database row, so none of the 27 existing call sites change. GitOps gives dev's own data `cluster=dev`, groups alerts by cluster, and deploys a read-only bridge on stg.

**Tech Stack:** TypeScript/Node 26 ESM, `node:test` + tsx, Postgres (pg), Redis (ioredis), Slack Bolt, Flux/Kustomize/Helm.

**Spec:** `devops-ai-agent/docs/superpowers/specs/2026-11-02-multi-cluster-routing-design.md`

## Global Constraints

- Strict mode applies only when the registry is configured: `MCP_LOCAL_CLUSTER` set or `MCP_SQS_CLUSTERS` non-empty. Otherwise nothing changes — the full suite passes unchanged.
- Never fall back to the central cluster's Kubernetes when a thread's cluster is unknown or its bridge is unreachable.
- No change to any existing `mcp.callTool` / `mcp.getTools` call site.
- `k8s_*` and `flux_*` → the thread's cluster; `prometheus_*`, `loki_*`, `alertmanager_*`, `tracing_*` → central.
- Migration number `017`. A NULL `cluster` reads as `MCP_LOCAL_CLUSTER`.
- Cluster names follow `MCP_SQS_CLUSTERS`' rule: `/^[a-z0-9][a-z0-9-]*$/`.
- Slack copy (exact): switch — `🔀 This thread now uses cluster <new>. Earlier answers were about <old>.`; approval card line — `*Cluster: <name>*`; GitOps refusal — `GitOps changes for <name> arrive with per-cluster repository mapping (multi-cluster part 3); a restart or a pod delete is still possible.`
- Unlabelled alert in strict mode: no Kubernetes tools, confidence capped to Low.
- Push to `main` after each task's suite passes; images build on push and roll only on `kubectl rollout restart`.

## Review Focus

1. A mention naming two registry clusters ("bandingkan dev dan stg") must not bind to either — the thread stays unbound and the agent asks. Pinned in Task 3.
2. A registry name inside a longer word (`devops-ai-agent`, `stg-backup`) must not bind. Pinned in Task 3.
3. A bridge that also lists `prometheus_*` tools must not shadow the central ones. Pinned in Task 2.
4. A delegated sub-investigation runs with its lead's cluster (AsyncLocalStorage across `Promise.all`). Pinned in Task 2.
5. A card approved after an agent restart executes against the cluster stored on its row, not the default. Pinned in Task 5.

---

### Task 1: Cluster registry and context

**Files:**
- Create: `src/agent/cluster/index.ts`, `src/agent/cluster/index.test.ts`
- Modify: `src/config/index.ts` (`config.mcp.localCluster` from `MCP_LOCAL_CLUSTER`)

**Interfaces:**
- Produces:
  - `interface ClusterRegistry { local: string | null; bridges: Array<{ name: string; requestQueueName: string }>; strict: boolean; names: string[] }`
  - `clusterRegistry(mcp?: { localCluster: string | null; sqs: { clusters: Array<{ name: string; requestQueueName: string }> } }): ClusterRegistry` — defaults to `config.mcp`. `names` = local first, then bridges.
  - `withCluster<T>(cluster: string | null, fn: () => Promise<T>): Promise<T>`
  - `currentCluster(): string | null | undefined` — `undefined` = no context set.
  - `storedCluster(stored: string | null, registry?: ClusterRegistry): string | null` — `stored ?? registry.local`.

- [ ] **Step 1: Write the failing tests** in `src/agent/cluster/index.test.ts`:
  - `strict only when a registry is configured` — `{local:null, sqs:{clusters:[]}}` → `strict:false`; `{local:"dev"}` → true; bridges only → true; `names` is `["dev","stg"]` for local dev + bridge stg.
  - `MCP_LOCAL_CLUSTER is validated like a bridge name` — `"Dev"` and a local equal to a bridge name both throw.
  - `withCluster sets and nests` — `currentCluster()` is `undefined` outside, `"stg"` inside, `null` inside `withCluster(null, …)`, and the inner value inside a nested call.
  - `a NULL row reads as the local cluster` — `storedCluster(null, reg)` → `"dev"`, `storedCluster("stg", reg)` → `"stg"`.
- [ ] **Step 2: Run** `npx tsx --test src/agent/cluster/index.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** in `src/agent/cluster/index.ts` (AsyncLocalStorage, like `src/utils/trace/index.ts`) and `config.mcp.localCluster` (`process.env.MCP_LOCAL_CLUSTER || null`, validated in `clusterRegistry`).
- [ ] **Step 4: Run** the test file, then `npm test` — Expected: PASS, full suite green.
- [ ] **Step 5: Commit** `feat(cluster): registry and withCluster context`.

### Task 2: ClusterRouter, wired into DevOpsAgent

**Files:**
- Create: `src/agent/cluster/router.ts`, `src/agent/cluster/router.test.ts`
- Modify: `src/agent/index.ts:102` (construction), `src/agent/mcp/types.ts` (export `BridgeTools`)

**Interfaces:**
- Consumes: Task 1 `ClusterRegistry`, `currentCluster`.
- Produces:
  - `type BridgeTools = Omit<McpTools, "ping">` (what `SqsMCPClient` already is).
  - `class ClusterRouter implements McpTools { constructor(central: McpTools, bridges: Map<string, BridgeTools>, registry: ClusterRegistry) }`
  - `isClusterTool(name: string): boolean` — `/^(k8s|flux)_/`.
  - `createMcp(registry: ClusterRegistry, central: McpTools, bridgeFor: (b: { name: string; requestQueueName: string }) => BridgeTools): McpTools` — returns `central` itself when `!registry.strict`.

- [ ] **Step 1: Write the failing tests** with fake `McpTools` objects (tool lists as plain arrays, `callTool` recording `(name, input)`):
  - `cluster tools go to the thread's cluster, the rest to central` — inside `withCluster("stg")`, `k8s_list_pods` hits the stg fake, `prometheus_query` hits central; inside `withCluster("dev")` (local) `k8s_list_pods` hits central.
  - `no cluster, no Kubernetes` — inside `withCluster(null)` and with no context, `getTools()` has no `k8s_*`/`flux_*`, and `callTool("k8s_list_pods")` rejects with a message containing `no cluster` and the registry names; nothing reached any fake.
  - `an unknown cluster is refused, never sent to central` — `withCluster("prd")` → rejects, central fake untouched.
  - `a bridge's own prometheus tools do not shadow central` (Review Focus 3) — the stg fake lists `prometheus_query`; inside `withCluster("stg")` `getTools()` has exactly one `prometheus_query` and calling it hits central.
  - `an unreachable bridge says so` — the stg fake rejects; the error message starts `Kubernetes for stg was unreachable through its bridge:`.
  - `a delegate keeps its lead's cluster` (Review Focus 4) — two calls inside `withCluster("stg", () => Promise.all([...]))` both hit stg.
  - `single-cluster mode returns the central client unchanged` — `createMcp(nonStrict, central, …)` is `central` (`assert.equal` identity).
  - `ping and connect` — `ping()` is central's; `connect()` connects central then every bridge, and resolves even if a bridge's connect rejects.
- [ ] **Step 2: Run** `npx tsx --test src/agent/cluster/router.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `router.ts`. `getTools()` = central tools without cluster tools, plus the current cluster's cluster tools (local → central's; bridge → that bridge's). In `src/agent/index.ts`, build `createMcp(clusterRegistry(), new MCPClient(), b => new SqsMCPClient(b.name, b.requestQueueName, dispatcher))` with one lazily-constructed `SqsMcpDispatcher(config.mcp.sqs.responseQueueName)` shared by all bridges; `deps.mcp` still wins.
- [ ] **Step 4: Run** the test file, then `npm test` — Expected: PASS, full suite green (replay/bench untouched: no registry).
- [ ] **Step 5: Commit** `feat(cluster): ClusterRouter — k8s/flux to the thread's cluster, the rest central`.

### Task 3: Thread binding and the cluster note

**Files:**
- Create: `src/agent/cluster/binding.ts`, `src/agent/cluster/binding.test.ts`
- Modify: `src/agent/memory/index.ts` (key prefix `cluster`, `getCluster`/`setCluster`), `src/agent/loop/run-state.ts` (`InvestigateOptions.cluster?: string | null`), `src/agent/index.ts` (`investigate` resolves and wraps), `src/agent/incidents/index.ts` (`threadAlertIdentity` also returns `cluster`), `src/app/mention.ts`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - `parseClusterMention(text: string, names: string[]): { cluster: string; switch: boolean } | null`
  - `clusterNote(state: { cluster: string | null; reason: "bound" | "unbound" | "unlabelled" }, registry: ClusterRegistry): string` — the one line prepended to the user message.
  - `ConversationMemory.getCluster(threadId: string): Promise<string | null>`, `setCluster(threadId: string, cluster: string): Promise<void>` — same 24h TTL as `conv`.
  - `DevOpsAgent.investigate` resolves, in order: `opts.cluster` (when not `undefined`) → `memory.getCluster` → the thread's incident row (`storedCluster`) → `null`; wraps the run in `withCluster` only in strict mode.

- [ ] **Step 1: Write the failing tests** in `binding.test.ts`:
  - `a registry name as a whole word binds` — `"cek pod di stg"` → `{cluster:"stg", switch:false}`; `"STG pods?"` → stg.
  - `inside a longer word it does not` (Review Focus 2) — `"restart devops-ai-agent"`, `"stg-backup job"` → `null`.
  - `two clusters named bind neither` (Review Focus 1) — `"bandingkan dev dan stg"` → `null`.
  - `an explicit switch` — `"pindah ke dev"`, `"switch to stg"` → `switch:true`.
  - `the note` — bound: contains `cluster="stg"` and `stg`; unbound: says there are no Kubernetes tools and lists `dev, stg`; unlabelled: says the alert has no `cluster` label.
  - In `src/agent/memory/index.test.ts` (or alongside): `getCluster` returns what `setCluster` stored, and the key carries the conversation TTL.
- [ ] **Step 2: Run** `npx tsx --test src/agent/cluster/binding.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** The note is prepended to the user message inside `DevOpsAgent.investigate` (never the system prompt — it stays byte-identical for the cache). In `mention.ts`, before investigating: a parsed cluster is stored with `setCluster`; a switch to a different cluster than the stored one posts the switch line (Global Constraints) in the thread first.
- [ ] **Step 4: Add the wiring test** `src/agent/cluster/wiring.test.ts`: a `DevOpsAgent` with a scripted LLM and a recording fake router in strict mode — a mention `"di stg pod mana yang restart?"` runs its `k8s_*` call against stg and the stored binding is `stg`; a later mention in the same thread with no cluster still uses stg; a mention in a fresh thread with no cluster offers the model no `k8s_*` tool. Run it and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): thread binding from mentions, switches and the incident row`.

### Task 4: The alert path — label, cap, correlation

**Files:**
- Modify: `src/app/alerts.ts` (~line 397 `investigate` call; `correlate`), `src/agent/confidence/index.ts`, `src/agent/loop/finalize.ts:40`, `src/agent/loop/run-state.ts`, `src/agent/trace/index.ts` (`GATE_NAMES` gains `"cluster-cap"`), `src/agent/incidents/index.ts` (`openRelatable(namespace, sinceMinutes, cluster)`)
- Test: `src/agent/confidence/cluster-cap.test.ts`, `src/app/alerts.test.ts` (or the existing alert-path test file)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `capForUnboundCluster(answer: string): { text: string; capped: boolean }` — High or Medium → Low, with the reason `no cluster label — Kubernetes was not read`.
  - Run state flag `clusterUnbound: boolean` (mode `alert`, strict, cluster `null`), read in `finalize.ts` after `capConfidence`; a cap records gate `cluster-cap`.

- [ ] **Step 1: Write the failing tests:**
  - `an unlabelled alert is capped to Low` — `capForUnboundCluster` on a High answer → Low with the reason; on Low → unchanged, `capped:false`.
  - `the alert label binds the run` — strict registry dev+stg; an Alertmanager payload with `cluster: "stg"` investigates with `opts.cluster === "stg"` and stores the thread binding; one without `cluster` investigates with `null` and the unlabelled note; `cluster: "prd"` (not in the registry) is treated as unlabelled.
  - `correlation stays inside one cluster` — an open stg incident in `kube-system` is not a relatable neighbour for a dev alert in `kube-system`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.** `openRelatable` filters `COALESCE(cluster, $local) = $cluster` in strict mode.
- [ ] **Step 4: Run** the tests and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): alerts bind by label; unlabelled alerts capped to Low; correlation per cluster`.

### Task 5: Postgres — migration 017, stores, background jobs, recall

**Files:**
- Create: `migrations/017_cluster.sql`
- Modify: `src/agent/incidents/index.ts` (`store` option `cluster`, passed explicitly by `src/app/alerts.ts` from the label — `store` runs after `investigate` returns, outside any `withCluster`; `recall` keyed by cluster), `src/agent/remediation/index.ts` (`propose(…, cluster)`), `src/agent/remediation/verify.ts` (`schedule`/`scheduleAwaiting` take `cluster`), `src/agent/remediation/remediator.ts` (`proposeRemediation` wraps `withCluster` with the thread's resolved cluster — it is called from the Slack layer after the investigation, outside its context; `executeRemediation`, `runDueRemediationChecks` and the awaiting watch wrap `withCluster(storedCluster(row.cluster))`), `src/agent/loop/runner.ts:65` (`begin` payload `cluster`)
- Test: `src/agent/incidents/recall-cluster.test.ts`, `src/agent/remediation/cluster.test.ts`

**Interfaces:**
- Consumes: Task 1 `storedCluster`, `currentCluster`.
- Produces: column `cluster TEXT NULL` on `incidents`, `remediations`, `remediation_checks`. Incidents get the alert's cluster passed in; remediations and checks write `currentCluster() ?? null` (they are created inside `withCluster`).

- [ ] **Step 1: Write the failing tests** (fake `pg` pool as the existing incident/remediation tests do):
  - `the migration adds a nullable cluster to three tables` — the SQL file contains `ADD COLUMN IF NOT EXISTS cluster` for `incidents`, `remediations`, `remediation_checks` and no `NOT NULL`.
  - `recall prefers the same cluster` — rows for `KubePodCrashLooping/kube-system` on dev (NULL) and stg; recall for stg puts the stg rows in the agent's-own tier and the dev row in "possibly related", labelled `seen on dev`; a human-confirmed dev cause is shown as `confirmed on dev`, not in the strong-prior tier.
  - `a card executes on its own cluster after a restart` (Review Focus 5) — a remediation row with `cluster: "stg"`, executed with no context set, calls the stg fake; a row with `cluster: NULL` calls the local one.
  - `a due check runs against its row's cluster` — same, for `runDueRemediationChecks`.
  - `a proposal runs on its thread's cluster` — thread bound to stg, `proposeRemediation` called with no context set: its guard reads and dry-run hit the stg fake, and the stored remediation row has `cluster = 'stg'`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.** Migration statements `ALTER TABLE … ADD COLUMN IF NOT EXISTS cluster TEXT;` only (no index needed at this size).
- [ ] **Step 4: Run** the tests and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): migration 017 — cluster on incidents, remediations, checks; recall and jobs per cluster`.

### Task 6: Slack — RCA badge and footer, approval card, GitOps refusal off-local

**Files:**
- Modify: `src/utils/slack/blocks.ts` (`buildRcaBlocks(rcaText, footer?, cluster?)`, `formatRunFooter` meta `cluster?`, `viaBridge?`), `src/utils/slack/remediation-card.ts` (`buildRemediationCard` gains `cluster?: string`), `src/app/alerts.ts:419`, `src/app/remediation.ts`, `src/agent/remediation/remediator.ts` (GitOps branch)
- Test: `src/utils/slack/blocks.test.ts`, `src/utils/slack/remediation-card.test.ts`, `src/agent/remediation/cluster.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5.
- Produces: `RunMeta.cluster?: string`, `RunMeta.viaBridge?: boolean` set by the runner from `currentCluster()` and the registry.

- [ ] **Step 1: Write the failing tests:**
  - `the RCA header carries the cluster` — `buildRcaBlocks(rca, footer, "stg")`'s header text contains `☸ stg`; without a cluster, the blocks equal today's output (deep-equal against the call without the argument).
  - `the footer names the cluster and the bridge` — `formatRunFooter({…, cluster:"stg", viaBridge:true})` contains `cluster stg (bridge)`; local → `cluster dev`.
  - `the approval card states the cluster above the buttons` — with `"stg"`, the section before the actions block contains `*Cluster: stg*`; without, unchanged.
  - `a Flux-managed target off the local cluster gets no PR` — inside `withCluster("stg")`, a dry-run that returns a GitOps preview yields `{ refused }` with the exact copy from Global Constraints, and the worker fake receives no `open_pr`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.** Pass the cluster only in strict mode, so single-cluster output is byte-identical.
- [ ] **Step 4: Run** the tests and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cluster): cluster on the RCA card, footer and approval card; no off-local GitOps PRs`.

### Task 7: Dashboard — cluster column, filter, incident title

**Files:**
- Modify: `src/dashboard/filters.ts` (`Filters.cluster: string | null`), `src/dashboard/queries.ts` (`list`, `detail` return `cluster` as `COALESCE(cluster, $local)`), `src/dashboard/incident-views.ts`, `src/dashboard/styles.ts` (re-pin `styles.test.ts` if CSS changes)
- Test: `src/dashboard/incident-views.test.ts`, `src/dashboard/filters.test.ts`

**Interfaces:**
- Consumes: Task 5 column; the registry's `names` passed to the views (empty in single-cluster mode).

- [ ] **Step 1: Write the failing tests:** with `clusters: ["dev","stg"]` the list renders a `Cluster` column and a filter with `All`, `dev`, `stg`, and `?cluster=stg` parses into `Filters.cluster`; the detail title contains the cluster; with `clusters: []` neither appears (output unchanged).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (dashboard conventions: invoke `ui-ux-pro-max` first; pages, not tabs — a filter, not a new rail item).
- [ ] **Step 4: Run** the tests and `npm test`; render `/incidents` once in Playwright (`~/.render-check`) — Expected: PASS, column and filter visible.
- [ ] **Step 5: Commit** `feat(dashboard): cluster column, filter and title`.

### Task 8: GitOps — dev labels `cluster=dev`, Alertmanager groups by cluster

**Files (gitops-devops-ai-manifest):**
- Modify: `apps/dev/systems/prometheus/release.yaml` (every scrape job's `relabel_configs` gains `- target_label: cluster` / `replacement: dev`, `cluster_name` kept), `apps/dev/systems/fluentbit/release.yaml` (outputs override with `cluster=dev`, as stg's), `apps/dev/systems/alertmanager/release.yaml:33` (`group_by: ["alertname", "namespace", "cluster"]`)

- [ ] **Step 1: Render and check** — `helm template` the Prometheus chart 29.14.0 with dev's rendered values (as done for `2f0fc4c`): Expected: every `job_name` in `prometheus.yml` has a relabel writing `cluster` = `dev`.
- [ ] **Step 2: Commit, push, reconcile** dev. Expected after one scrape interval: `count by (cluster) (up)` shows `dev` and `stg` and no series without `cluster` (`count(up{cluster=""})` = 0); Loki `label/cluster/values` = `["dev","stg"]`; Alertmanager config shows the new `group_by`.
- [ ] **Step 3: Commit message** `feat(multi-cluster): dev labels its own data cluster=dev; alerts grouped by cluster`.

### Task 9: GitOps — the read-only stg bridge

**Files (gitops-devops-ai-manifest):**
- Create: `apps/stg/applications/devops-mcp-bridge/{kustomization.yaml,release.yaml}` — HelmRelease of `devops-ai-stack` (chart version as dev's) with `devops-ai-agent.enabled: false`, `devops-llm-worker.enabled: false`, `global.postgresql.enabled: false`, `global.redis.enabled: false`, and `devops-mcp-server`: transport `sqs`, `aws.enabled: true`, env `MCP_SQS_REQUEST_QUEUE=devops-mcp-stg-request.fifo`, `MCP_SQS_RESPONSE_QUEUE=devops-mcp-response.fifo`, `MCP_ENABLE_WRITE_TOOLS=false`; `global.aws` as base's (secrets `aws-rolesanywhere-config`, `workload-tls`, referenced, never created).
- Modify: `apps/stg/applications/kustomization.yaml` (`resources: [devops-mcp-bridge]`), timeout `15m` (stg pulls are slow).

- [ ] **Step 1: Render** `kubectl kustomize apps/stg/applications`, then `helm template` the chart with those values. Expected: one Deployment (mcp-server) with `TRANSPORT=sqs`, the two queue env vars, `AWS_AUTH_MODE=iam-anywhere`, the `/certs` volume from `workload-tls`; no agent, worker, Postgres or Redis; `_validate.tpl` passes. If the chart refuses (validation or a missing knob), fix it in `devops-ai-helm-charts` with a test in `lint.yml`, release the next minor, and ledger the ruling.
- [ ] **Step 2: Commit and push.** Expected on stg: the HelmRelease waits on the two Secrets until the user creates them — tell the user, do not create them.
- [ ] **Step 3: Once the Secrets exist:** `npm run mcp:probe -- stg k8s_list_pods '{"namespace":"monitoring"}'` from the agent repo — Expected: stg's pods (`master1`/`worker1` nodes).

### Task 10: Turn it on, verify live, docs

**Files:**
- Modify (gitops): `apps/dev/applications/devops-ai-stack/release.yaml` — agent env `MCP_LOCAL_CLUSTER: dev`, `MCP_SQS_CLUSTERS: "stg=devops-mcp-stg-request.fifo"`
- Modify (docs): `devops-ai-agent/CLAUDE.md`, workspace `CLAUDE.md` (contract: the registry and routing), `confluence-docs/01-architecture.md`, `04-deployment-and-configuration.md`, `05-operations.md`

- [ ] **Step 1: Preconditions** — Task 8 verified (dev series and alerts labelled) and Task 9's probe answers. Not before: strict mode with unlabelled dev data would cap every dev alert.
- [ ] **Step 2: Enable, push, roll out** the agent (`kubectl -n devops-tools rollout restart deploy/devops-ai-agent`). Expected: boot log names the registry (`dev` local, `stg` bridge) and `/health` stays up.
- [ ] **Step 3: Live success checks (spec §Success):**
  1. On stg, a test Deployment that exits 1 (e.g. `busybox`, `command: ["sh","-c","exit 1"]`) in namespace `default` → the `KubernetesPodCrashLooping` alert arrives with `cluster="stg"` → RCA with the `☸ stg` badge; in Jaeger the `k8s_*` spans go through `SqsMCPClient`, and the PromQL in `agent_events` carries `cluster="stg"`. Delete the test Deployment afterwards.
  2. A dev alert (or `@agent di dev pod mana yang restart?`) → dev badge, local MCP.
  3. `@agent pod mana yang restart?` in a fresh thread → the question back, no `k8s_*` call in `agent_events`.
  4. Already proven by Task 5's restart test; no live restart needed.
- [ ] **Step 4: Remove the lab bridge** `devops-tools/devops-mcp-bridge-lab2` (label `purpose: multi-cluster-part1-lab`) — ask the user if the permission classifier refuses.
- [ ] **Step 5: Docs and commit** — the registry env vars, routing table, strict mode, `cluster=dev` labelling, the stg bridge's Secrets. Commit `docs: multi-cluster 2a`.
