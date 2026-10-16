# Cluster onboarding: request flow, dependencies, and where to change it — design

Date: 2026-10-16. Builds on `2026-10-07-cluster-tour-design.md` (the inventory, the Slack tour, the
`/cluster` tables) and `2026-10-08-cluster-map-design.md` (the React Flow map).
**Repos:**
- `devops-mcp-server`: env-derived dependencies on the inventory;
- `devops-ai-agent-worker`: a read-only `locate` op;
- `devops-ai-agent`: the cluster model, the map edges and panel, and the Slack tables.

## Context

The tour today answers what runs, who manages it, and what each workload exposes. It deliberately
left out two things a newcomer asks next:
- **how the services talk to each other and what they depend on**;
- **where in Git to change a workload**.

The model's only contribution is a *Dugaan fungsi* line per workload, inferred from a name.

The scanning scheme is adapted from archify's repository authoring (`tt-a1i/archify`,
`references/repository-authoring.md`):
1. **Freeze identity.** Every fact is pinned to one revision.
2. **Map from the entry points**, and follow the connected slice rather than scanning everything.
3. **Trace each relationship from what was observed**, and keep a configured provider distinct from
   a service that is actually used.
4. **Record evidence for each component and relationship while reading.**
5. **Name uncertainty next to the claim** instead of turning a label into an unobserved behaviour.

Archify then validates a typed IR before rendering it. Here the *gathering* is done by code, not by
the model. A model building the inventory already invented a Service name once in this repo (why
the tour's tables are built from tool output), and `/cluster` runs with no LLM at all. What we
take from archify is the discipline: entry points, typed evidence, observed versus configured,
explicit unknowns, and a validated model.

## Goal

For a namespace, the agent can say, with evidence for every line:
- **who calls whom** (observed in metrics);
- **what each workload is configured to depend on** (read from its env);
- **which Git file and line to edit** to change a workload's image or replicas, at the revision
  Flux applied.

All three render with no LLM on `/cluster` and in the Slack tour's namespace detail.

Success:
- `@agent jelasin sample-apps` in Slack posts a **Request flow** table showing
  `storefront → checkout-gateway → orders-api` (observed) and `orders-api → postgresql/postgresql`
  (configured, env `DB_HOST`).
- In the same reply, a **Where to change it** table gives each HelmRelease-managed workload's file,
  line and key for image and replicas.
- `/cluster`, when a namespace is expanded, draws the same edges: `calls` solid, `depends` dashed,
  telemetry hidden by default. Clicking a workload opens the where-to-change panel.
- No environment value and no Secret content appears anywhere in tool output, the model, the
  dashboard or Slack. Only env variable *names* and the matched Service do.
- A source that could not be read appears in the model's `unknowns`, never as "no edges".

Out of scope:
- edges inferred from names;
- Jaeger traces (in this cluster only one service sends any, and its dependencies endpoint is empty);
- the `resources` key in `locate`;
- mounted config files;
- an onboarding document download;
- per-claim clickable evidence in the UI (evidence is kept in the model and shown per edge in the
  tables, not as links).
- multi-cluster: this is built for the local cluster. Its multi-cluster adaptation (a cluster target,
  a `(cluster, namespace)` cache key, a `/cluster` selector, the "which clusters are there?" answer)
  belongs to multi-cluster part 2 and is recorded in `2026-10-15-multi-cluster-sqs-bridge-design.md`.

## Components

### 1. Env-derived dependencies — `k8s_cluster_inventory` (devops-mcp-server)

`shapeInventory` (`handlers/inventory.ts`) gains, per workload:

```ts
dependsOn: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>;
externalHosts: Array<{ host: string; via: string }>;
unresolved: Array<{ host: string; via: string }>;
```

- **Sources:**
  - each container's `env[].value`;
  - `env[].valueFrom.configMapKeyRef`, resolved through ConfigMaps read in the same scan;
  - `envFrom[].configMapRef`, where every key becomes a candidate.

  `secretKeyRef` and `envFrom.secretRef` are never resolved. The ClusterRole can read Secrets for
  other tools; this code path must not.
- **Host extraction** (pure, `dependency-hosts.ts`):
  - from `scheme://[userinfo@]host[:port][/…]`, or a bare `host[:port]`;
  - userinfo is dropped before anything else sees the value;
  - a candidate must look like a hostname (DNS-1123 labels, at least one letter).
- **Matching to a Service that exists in the cluster** (every Service cluster-wide, even on a
  namespace-scoped call, so `postgresql.postgresql` resolves while only `sample-apps` is toured):
  - `svc` resolves in the workload's own namespace;
  - `svc.ns`, `svc.ns.svc` and `svc.ns.svc.cluster.local` resolve to `ns/svc`.
- **What is not a match:**
  - a `*.svc` / `*.svc.cluster.local` host with no Service goes to `unresolved`;
  - any other dotted host goes to `externalHosts`;
  - a bare word with no Service is dropped. It is far more often an ordinary value
    (`DB_SSL_MODE=disable`) than a host.
- **`role: "telemetry"`** applies when the env name matches
  `/^(OTEL_|JAEGER_|ZIPKIN_|PROMETHEUS_|LOKI_)/` or the Service is a tracing, logging or metrics
  backend. Otherwise every instrumented app would "depend on" Jaeger.
- **The output carries no value.** It holds `via` (the env name), the matched Service and the
  host. `stripUserinfo` runs before host extraction, and a test asserts that a value with a
  password never reaches the output.
- ConfigMaps are listed once per namespace in the scan. A refused list (RBAC) leaves `dependsOn`
  computed from literal env only, and `scanned.configMaps: false` says so. The live ClusterRole
  already grants `configmaps` get/list.

### 2. `locate` — where a HelmRelease's image and replicas live (devops-ai-agent-worker)

A fifth op on the existing gitops request queue. It is read-only, like `history`, and **batched**
(decided in the plan: one tree listing costs 3–14 s of GitHub calls, so one request per HelmRelease
would multiply it). The agent sends one request per distinct overlay `pathPrefix`, in chunks of at
most 50 targets — the worker's parser drops a bigger one as poison:

```ts
{ requestId, op: "locate", targets: Array<{ name, namespace, current: { image?: string; replicas?: number }, component? }>, pathPrefix? }
→ { ok: true, op: "locate", revision: string,
    releases: Array<{ name, namespace, files: Array<{ path: string; role: "overlay" | "base" }>, keys: { image?: GitKey; replicas?: GitKey }, notes: string[] }> }
GitKey = { path: string; line: number; key: string; gitValue: string; drift: boolean }
```

- **Files.** The overlay file is found with `isHelmReleaseFile`; the base with `deriveBasePrefix`.
  This is the same discovery the PR flow uses.
- **Keys.** It reuses `searchSpecs` / `findMatches` with `from = to = current`, so the line is the
  one holding the running value. When the key is declared but holds a different value, it falls
  back to `detectDrift`, which returns the line with `drift: true`. A value that is only in base is
  reported at its base line.
- **Refusal.** Ambiguity (several files or several matching lines) is a refusal with the reason,
  exactly as the PR flow refuses. It is never a guess.
- **`revision`** is the commit sha the worker read: the branch head, through the GitHub API. The
  agent compares it with Flux's applied revision (§3).
- **No new cache.** Like `revert_pr`, it reads fresh: a stale cached line number is a wrong answer.
- **Contract.** The contract bullet in the workspace `CLAUDE.md` gains this op.

### 3. The cluster model — `src/agent/onboarding/` (devops-ai-agent)

`buildClusterModel(namespace?)` assembles a typed IR. Each source is read in parallel and fail-open
per source: a failure becomes an `unknowns` entry, never an absent edge set.

```ts
interface ClusterModel {
  snapshot: { at: string; appliedRevision: string | null; repoRevision: string | null };
  nodes: Array<
    | { id: string; kind: "host"; host: string }
    | { id: string; kind: "service"; namespace: string; name: string }
    | { id: string; kind: "workload"; namespace: string; name: string; workloadKind: string }
  >;
  edges: Array<{
    from: string; to: string;
    kind: "routes" | "calls" | "depends";
    certainty: "observed" | "configured" | "declared";
    role?: "app" | "telemetry";
    evidence: Array<
      | { type: "k8s"; ref: string }                   // "Ingress/sample-apps/storefront", "Service/…" selector
      | { type: "metric"; query: string }              // the call-graph PromQL
      | { type: "env"; workload: string; via: string } // env NAME, never its value
    >;
  }>;
  changeAt: Record<string, { image?: GitKey; replicas?: GitKey }>; // workload node id → keys
  unknowns: string[];
}
```

- **Entry points first.** Nodes and `routes` edges come from Ingress hosts → Service → workload
  (the existing `backends`/`serves` relations, certainty `declared`, evidence `k8s`).
- **`calls` edges.** `serviceGraph` (`correlation/topology.ts`, reused as-is) supplies them. Each
  is `observed` with the PromQL as evidence. A graph that could not be read adds
  `"call graph unavailable (Prometheus): <reason>"` to unknowns.
- **`depends` edges** come from the inventory's `dependsOn`, certainty `configured`. Its
  `unresolved` and `externalHosts` become unknowns and external notes.
- **`changeAt`.** One `locate` per HelmRelease-managed workload, through `SqsGitOpsClient`, with
  `current` taken from the inventory (the first image, `desired` replicas). It is skipped, with an
  unknowns line, when GitOps is not configured. A refusal or timeout adds its reason to unknowns.
- **Freeze identity.** The inventory reports `fluxRevisions` cluster-wide — every Kustomization's
  `status.lastAppliedRevision` (a HelmRelease-managed workload does not carry its Kustomization's
  label, so a per-workload revision would need an extra HelmRelease list). `appliedRevision` is the
  single distinct revision; when Kustomizations differ it is null and unknowns says so.
  `repoRevision` is `locate`'s `revision`.
  When they differ: `"the repo is ahead of what Flux applied (<applied> vs <repo>) — line numbers
  are for the repo head"`.
- **Validation** (pure, `validateClusterModel`):
  - every edge has at least one evidence item;
  - every edge endpoint is a node; an edge failing either check moves to unknowns with its reason;
  - duplicate edges merge their evidence.
- **Cache.** The model is cached 5 minutes per namespace scope and rebuilt in the background on
  expiry. A caller with a cold cache waits for one build. The dashboard never waits: it renders the
  inventory-only map and fills in the edges when the model is ready.

### 4. `/cluster` map and panel (devops-ai-agent dashboard)

- `cluster-graph.ts` maps model edges to React Flow edges:
  - `calls`: solid, labelled `calls`;
  - `depends`: DOTTED (`manages` already owns the dash), on the structure ramp like every edge — the
    meaning is the stroke and the legend, never a colour;
  - `routes`: as today;
  - `telemetry`: hidden unless a "Show telemetry" toggle is on.
- **Clicking a workload node** opens a side panel. For image and replicas it shows `path:line`, the
  key and the Git value, with a drift badge when `drift`, and the snapshot revisions. With no
  `changeAt` entry it shows the unknowns line that explains why.
- `unknowns` render as a small list under the map. The page never waits for the model: a cold cache
  says "Request flow is being computed — reload in a few seconds", and the next load has it.
- The tables below stay unchanged. The page stays LLM-free and GET-only.

### 5. Slack tour (devops-ai-agent)

- **Prefetch.** A tour (`wantsTour`) gets the model **prefetched**, like the change timeline,
  before `investigate()`. Replay therefore never re-runs it.
- **Namespace detail.** On a namespace detail turn, `postTourTables` adds two Block Kit tables built
  from the model:
  - **Request flow**: from, to, kind, certainty, evidence (`metric` / `env DB_HOST` / `k8s`);
  - **Where to change it**: workload, what, `path:line`, key.

  An empty flow says "no calls observed and no dependencies configured" plus the relevant unknowns,
  never a bare empty table.

  These tables are bound by the same rule as the existing ones: blank cells are filled, and a
  refused `invalid_blocks` post is re-posted as the same facts in mrkdwn. The overview turn is
  unchanged.
- **The model as data.** The model reaches the LLM as data: a compact text rendering of nodes,
  edges and unknowns in the first user message, framed as data. Skill rules:
  - `cluster-tour.md` gains one rule: *Dugaan fungsi* may cite the flow ("the entry point:
    `shop.example.com` routes to `storefront`"), still marked as inference;
  - the reply must not restate the tables, and `stripRepeatedInventory` extends to the flow rows.
- **Grounding.** The model text is passed to the existing `warnIfUngrounded` as evidence, so a name
  the narrative invents gets the ungrounded-names warning every other mention path posts. No
  regeneration (decided in the plan: no other mention path rewrites, and a rewrite doubles the light
  route's cost).
- **Bounded.** The prefetch waits at most 20 s; past that the tour goes on without the model and the
  build keeps running to fill the cache (a cold build waits on `locate` over SQS, 240 s live).
- **Trigger.** The prefetch is gated by `wantsTour`, like the tour's tables: "jelasin namespace
  sample-apps" is a tour, a bare "jelasin sample-apps" is not.
- The tour still never produces a remediation card.

## Error handling

| Condition | Behaviour |
|---|---|
| ConfigMap list refused | `dependsOn` from literal env only; `scanned.configMaps: false`; an unknowns line |
| Prometheus unreachable | no `calls` edges; an unknowns line; everything else renders |
| GitOps not configured | no `changeAt`; one unknowns line; panel says so |
| `locate` refuses (ambiguous, no file) / times out | that workload's `changeAt` absent; the reason in unknowns |
| Repo head ≠ Flux applied revision | lines shown for the repo head, with the explicit note |
| Model build fails entirely | the tour and the map fall back to today's inventory-only behaviour; logged |
| Env value contains credentials | userinfo stripped before parsing; values never emitted |
| Narrative names something not in the model | one regeneration with the gaps; then the existing warning |

## Testing

- **mcp-server, `dependency-hosts.ts` and `shapeInventory`:**
  - a URL with `user:pass@` matches its Service, and the password string appears nowhere in the
    output;
  - `svc` / `svc.ns` / `svc.ns.svc.cluster.local` resolve;
  - a bare non-host word is dropped;
  - an external host is listed;
  - an unmatched `*.svc.cluster.local` is unresolved;
  - an `OTEL_EXPORTER_OTLP_ENDPOINT` → jaeger edge gets `telemetry`;
  - `secretKeyRef` is never looked up (a fake ConfigMap/Secret reader asserts it is never called
    for secrets);
  - a refused ConfigMap list sets `scanned.configMaps: false`.
- **Worker, `locate`:**
  - the overlay line for replicas, and the base line when the value is only there;
  - drift on a declared but different value;
  - two HelmRelease files → refusal;
  - the request parser accepts `locate` and rejects a malformed one;
  - `revision` comes from the backend.
- **Agent:**
  - `buildClusterModel` with faked sources: entry-point routes, observed calls, configured
    depends, a failed source → unknowns, a revision mismatch note;
  - `validateClusterModel` drops dangling and evidence-less edges into unknowns and merges
    duplicates;
  - the cache serves a warm model and rebuilds after 5 minutes;
  - the two Slack tables, including the empty-flow wording and the mrkdwn fallback;
  - the grounding repair runs once.
- **Dashboard:**
  - `cluster-graph.ts` maps each edge kind to its style;
  - telemetry is hidden by default;
  - the panel renders `path:line`, the key and the drift badge;
  - a browser check of `/cluster` at desktop and phone widths, light and dark.
- **Live:** `jelasin sample-apps` in Slack shows `storefront → checkout-gateway → orders-api`
  (observed) and `orders-api → postgresql/postgresql` (configured `DB_HOST`), with
  `orders-api`'s replicas line in the GitOps repo. `/cluster` shows the same edges and panel.

## Docs

- `devops-ai-agent/CLAUDE.md`: a gotcha bullet covering:
  - the cluster model is gathered by code with typed evidence, not by the model;
  - observed versus configured;
  - env values never leave the inventory;
  - unknowns are never empty edges;
  - the 5-minute cache.
- `devops-mcp-server/CLAUDE.md`: the env-dependency rule (no Secret resolution, userinfo stripped
  before parsing, no values in output).
- `devops-ai-agent-worker/CLAUDE.md` and the workspace `CLAUDE.md` contract bullet: the `locate` op.
