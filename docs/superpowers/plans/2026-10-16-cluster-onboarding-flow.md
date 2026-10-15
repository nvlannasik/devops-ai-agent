# Cluster onboarding v2: request flow, dependencies, where to change it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a namespace, the onboarding tour and `/cluster` show three things, with typed evidence on each, built by code and not by the model:
- who calls whom;
- what each workload is configured to depend on;
- which Git file and line holds a workload's image and replicas.

**Architecture:**
- **mcp-server:** `k8s_cluster_inventory` learns env-derived dependencies. Values are read inside the handler and never returned; only env names and the matched Service leave it.
- **worker:** gains a read-only, batched `locate` op.
- **agent:** `src/agent/onboarding/` assembles a validated `ClusterModel` from the inventory, the existing call graph (`serviceGraph`) and `locate`. It is cached for 5 minutes.
- **Slack:** the tour prefetches the model as data and posts two new tables.
- **`/cluster`:** draws the new edges and a "where to change it" panel.

**Tech Stack:** TypeScript ESM, Node 24, `node:test` + tsx, React 19 + `@xyflow/react` (dashboard client), Slack Block Kit, `yaml` (worker).

**Spec:** `devops-ai-agent/docs/superpowers/specs/2026-10-16-cluster-onboarding-flow-design.md`

## Global Constraints

- **Repos and checks.**
  - Repos: `devops-mcp-server`, `devops-ai-agent-worker`, `devops-ai-agent`, plus the workspace `CLAUDE.md` contract bullet. That file is not in git, so it is edited and not committed.
  - `npm test` and `npx tsc --noEmit` pass in each repo; `npm run build` passes in the agent and the mcp-server.
- **No new dependencies.**
- **Env values never leave the mcp-server's inventory handler.** Only env variable *names* (`via`), matched Services and host names do. `secretKeyRef` and `envFrom.secretRef` are never resolved. Userinfo is stripped before any parsing.
- **Edge evidence types:** `k8s`, `metric`, `env`.
- **Certainties:** `routes` is `declared`; `calls` is `observed`; `depends` is `configured`.
- **Telemetry.** Env names matching `/^(OTEL_|JAEGER_|ZIPKIN_|PROMETHEUS_|LOKI_)/`, or a target Service matching `/(jaeger|tempo|zipkin|otel|opentelemetry|collector|prometheus|loki|fluent|grafana|alertmanager)/i`, get `role: "telemetry"`. Telemetry is hidden by default.
- **A source that could not be read is an `unknowns` line, never an empty edge set.**
- **Model cache:** 5 min (`300_000` ms), keyed by namespace scope (`""` = whole cluster). Rebuilt in the background on expiry; `peek` never waits.
- **The dashboard stays LLM-free and GET-only.** The dashboard never imports agent types at runtime. Its model type is a structural mirror, checked by a compile-time test.
- **A tour never produces a remediation card** (unchanged).
- **Process.**
  - Docs are written in English.
  - Commit after each task. **Do not push until Task 8.**
  - Never print secrets.
  - Don't stage `.serena/`.
  - Any dashboard UI task starts by invoking the `ui-ux-pro-max:ui-ux-pro-max` skill, and ends with a browser check (Playwright in `~/.render-check`).

**Rulings vs the spec** (made while writing this plan; the spec is updated in Task 8 Step 1):
1. **`locate` is batched.** `{ op: "locate", targets: [...], pathPrefix? }` answers several HelmReleases from ONE tree listing, and the agent sends one request per distinct overlay `pathPrefix`.
   - Why: a single listing costs 3–14 s of GitHub calls (worker comment, 2026-10-09), so one request per HelmRelease would multiply that cost.
   - Cost if wrong: a slightly bigger message.
2. **Flux revisions are reported cluster-wide** as `fluxRevisions: [{ kustomization, revision }]`, not per workload.
   - Why: a HelmRelease-managed workload does not carry its Kustomization's label, so a per-workload revision needs an extra HelmRelease list. The model takes the single distinct revision, and when Kustomizations differ it says so in unknowns.
   - Cost if wrong: multi-source clusters get "revisions differ" rather than one revision per workload.
3. **The narrative's grounding check uses the existing `warnIfUngrounded`, with the model text as evidence.** There is no regenerate-once loop.
   - Why: every other mention path warns rather than rewrites, and a rewrite doubles the light-route cost.
   - Cost if wrong: an ungrounded name gets a warning instead of a rewrite.
4. **`depends` is drawn DOTTED** (`2 4`) in the info colour, because `manages` is already dashed (`6 4`). `calls` is solid with an arrowhead.
5. **The dashboard fills in edges on reload, not live.** The first load after a cold cache shows the inventory map with a note that the flow is being computed.
6. **Namespace-scoped inventory calls still match Services cluster-wide.** One extra Service list across all namespaces, so `orders-api → postgresql/postgresql` resolves when only `sample-apps` is scanned.

## Review Focus

1. **An env value that is a credential-bearing URL** (`postgres://app:s3cret@postgresql.postgresql:5432/db`) resolves to `postgresql/postgresql`, and `s3cret` appears in no output: not the inventory JSON, not the model, not Slack. Tests: Task 1 and Task 2.
2. **Ordinary values that look like words** (`DB_SSL_MODE=disable`, `LOG_LEVEL=info`, `DB_TYPE=postgres` beside a Service named `postgres`) create no edge. A bare word counts only under a host-ish env name. Test: Task 1.
3. **The call graph names a service that is neither a Service nor a workload** in the namespace. It becomes an unknowns line, not a dropped fact or a crash. Test: Task 4.
4. **`locate` meets a value only in base, a drifted value, or two files defining the HelmRelease.** These give a base line, `drift: true`, and a refusal note respectively; it never guesses. Test: Task 3.
5. **A tour where the model build fails or GitOps is not configured.** The tour still posts the inventory tables and the reply, and the flow tables say why they are empty. Tests: Task 6.

---

### Task 1: Env → dependency extraction (devops-mcp-server, pure)

**Files:**
- Create: `devops-mcp-server/src/tools/kubernetes/handlers/dependency-hosts.ts`
- Test: `devops-mcp-server/src/tools/kubernetes/handlers/dependency-hosts.test.ts`

**Interfaces:**
- Produces:
  - `stripUserinfo(value: string): string`
  - `hostsIn(value: string): string[]`
  - `type HostMatch = { kind: "service"; namespace: string; name: string } | { kind: "unresolved" } | { kind: "external" } | null`
  - `matchHost(host: string, workloadNs: string, services: ReadonlySet<string> /* "ns/name" */, hostishName: boolean): HostMatch`
  - `interface EnvDeps { dependsOn: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>; externalHosts: Array<{ host: string; via: string }>; unresolved: Array<{ host: string; via: string }> }`
  - `interface ContainerEnv { env?: Array<{ name: string; value?: string; valueFrom?: { configMapKeyRef?: { name: string; key: string }; secretKeyRef?: unknown } }>; envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: unknown }> }`
  - `envDeps(containers: ContainerEnv[], workloadNs: string, services: ReadonlySet<string>, configMaps: ReadonlyMap<string, Record<string, string>> | null): EnvDeps`
  - `configMapRefs(containers: ContainerEnv[], workloadNs: string): string[]` (`"ns/name"`, de-duplicated)

- [ ] **Step 1: Write the failing tests** — `dependency-hosts.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUserinfo, hostsIn, matchHost, envDeps, configMapRefs } from "./dependency-hosts.js";

const SERVICES = new Set(["postgresql/postgresql", "sample-apps/orders-api", "monitoring/jaeger", "sample-apps/postgres"]);

test("userinfo is stripped before anything parses the value", () => {
  assert.equal(stripUserinfo("postgres://app:s3cret@postgresql.postgresql:5432/db"), "postgres://postgresql.postgresql:5432/db");
  assert.equal(stripUserinfo("redis://:pw@redis-master.redis:6379"), "redis://redis-master.redis:6379");
  assert.equal(stripUserinfo("plain-value"), "plain-value");
});

test("hostsIn: URLs, host:port, comma lists; IPs and non-hosts are not hosts", () => {
  assert.deepEqual(hostsIn("postgres://app:s3cret@postgresql.postgresql:5432/db"), ["postgresql.postgresql"]);
  assert.deepEqual(hostsIn("orders-api:8080"), ["orders-api"]);
  assert.deepEqual(hostsIn("kafka-0.kafka:9092,kafka-1.kafka:9092"), ["kafka-0.kafka", "kafka-1.kafka"]);
  assert.deepEqual(hostsIn("10.0.0.12:5432"), []);
  assert.deepEqual(hostsIn("http://jaeger.monitoring.svc.cluster.local:4318"), ["jaeger.monitoring.svc.cluster.local"]);
  // A bare word IS a candidate here — matchHost decides (only a host-ish env name, only a real Service).
  assert.deepEqual(hostsIn("disable"), ["disable"]);
  assert.deepEqual(hostsIn("!!! 123"), []);
});

test("matchHost: svc, svc.ns, svc.ns.svc.cluster.local; unresolved in-cluster; external; a bare word only under a host-ish name", () => {
  assert.deepEqual(matchHost("orders-api", "sample-apps", SERVICES, true), { kind: "service", namespace: "sample-apps", name: "orders-api" });
  assert.deepEqual(matchHost("postgresql.postgresql", "sample-apps", SERVICES, false), { kind: "service", namespace: "postgresql", name: "postgresql" });
  assert.deepEqual(matchHost("postgresql.postgresql.svc.cluster.local", "sample-apps", SERVICES, false), { kind: "service", namespace: "postgresql", name: "postgresql" });
  assert.deepEqual(matchHost("payments.billing.svc.cluster.local", "sample-apps", SERVICES, false), { kind: "unresolved" });
  assert.deepEqual(matchHost("api.stripe.com", "sample-apps", SERVICES, false), { kind: "external" });
  // DB_TYPE=postgres beside a Service named postgres: not a host-ish env name → no edge
  assert.equal(matchHost("postgres", "sample-apps", SERVICES, false), null);
  assert.equal(matchHost("disable", "sample-apps", SERVICES, true), null);
});

test("envDeps: literal env, configMapKeyRef, envFrom configMapRef; secrets never resolved; values never returned", () => {
  const cms = new Map([["sample-apps/app-config", { CACHE_HOST: "redis-master.redis", MODE: "fast" }]]);
  const services = new Set([...SERVICES, "redis/redis-master"]);
  const secretRead: string[] = [];
  const deps = envDeps(
    [
      {
        env: [
          { name: "DATABASE_URL", value: "postgres://app:s3cret@postgresql.postgresql:5432/db" },
          { name: "DB_SSL_MODE", value: "disable" },
          { name: "DB_TYPE", value: "postgres" },
          { name: "ORDERS_HOST", value: "orders-api" },
          { name: "STRIPE_URL", value: "https://api.stripe.com/v1" },
          { name: "PAYMENTS_URL", value: "http://payments.billing.svc.cluster.local" },
          { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://jaeger.monitoring.svc.cluster.local:4318" },
          { name: "DB_PASSWORD", valueFrom: { get secretKeyRef() { secretRead.push("x"); return { name: "s", key: "k" }; } } },
        ],
        envFrom: [{ configMapRef: { name: "app-config" } }, { secretRef: { name: "app-secrets" } }],
      },
    ],
    "sample-apps",
    services,
    cms
  );
  assert.deepEqual(deps.dependsOn, [
    { service: "postgresql", namespace: "postgresql", via: "DATABASE_URL", role: "app" },
    { service: "orders-api", namespace: "sample-apps", via: "ORDERS_HOST", role: "app" },
    { service: "jaeger", namespace: "monitoring", via: "OTEL_EXPORTER_OTLP_ENDPOINT", role: "telemetry" },
    { service: "redis-master", namespace: "redis", via: "CACHE_HOST", role: "app" },
  ]);
  assert.deepEqual(deps.externalHosts, [{ host: "api.stripe.com", via: "STRIPE_URL" }]);
  assert.deepEqual(deps.unresolved, [{ host: "payments.billing.svc.cluster.local", via: "PAYMENTS_URL" }]);
  assert.equal(secretRead.length, 0, "a secretKeyRef is never even looked at");
  assert.doesNotMatch(JSON.stringify(deps), /s3cret|disable|fast/);
});

test("envDeps with configMaps=null (the read was refused) still reads literal env", () => {
  const deps = envDeps([{ env: [{ name: "DB_HOST", value: "postgresql.postgresql" }], envFrom: [{ configMapRef: { name: "x" } }] }], "sample-apps", SERVICES, null);
  assert.equal(deps.dependsOn.length, 1);
});

test("configMapRefs lists every referenced ConfigMap once, never a Secret", () => {
  assert.deepEqual(
    configMapRefs([{ env: [{ name: "A", valueFrom: { configMapKeyRef: { name: "cfg", key: "a" } } }], envFrom: [{ configMapRef: { name: "cfg" } }, { configMapRef: { name: "other" } }, { secretRef: { name: "s" } }] }], "ns1"),
    ["ns1/cfg", "ns1/other"]
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/dependency-hosts.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement** — `dependency-hosts.ts`

```ts
// What a workload is CONFIGURED to depend on, from its env (spec 2026-10-16-cluster-onboarding-flow
// §1). Values are read here and nowhere else, and never returned: the output is env NAMES, matched
// Services and host names. userinfo is stripped before any parsing, so a password in a URL is gone
// before a regex sees it. Secrets are never resolved — the ServiceAccount can read them for other
// tools; this path must not.

export interface ContainerEnv {
  env?: Array<{ name: string; value?: string; valueFrom?: { configMapKeyRef?: { name: string; key: string }; secretKeyRef?: unknown } }>;
  envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: unknown }>;
}
export interface EnvDeps {
  dependsOn: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>;
  externalHosts: Array<{ host: string; via: string }>;
  unresolved: Array<{ host: string; via: string }>;
}
export type HostMatch = { kind: "service"; namespace: string; name: string } | { kind: "unresolved" } | { kind: "external" } | null;

const TELEMETRY_ENV = /^(OTEL_|JAEGER_|ZIPKIN_|PROMETHEUS_|LOKI_)/;
const TELEMETRY_SVC = /(jaeger|tempo|zipkin|otel|opentelemetry|collector|prometheus|loki|fluent|grafana|alertmanager)/i;
// A bare single word is a host only under a name that says it is one — `DB_TYPE=postgres` beside a
// Service named postgres is a value, not a dependency.
const HOSTISH_NAME = /(HOST|ADDR|URL|URI|ENDPOINT|SERVER|BROKER|DSN|SERVICE)/i;
const HOSTNAME = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function stripUserinfo(value: string): string {
  return value.replace(/(\/\/)[^/@\s]*@/g, "$1");
}

export function hostsIn(value: string): string[] {
  const out: string[] = [];
  for (const token of stripUserinfo(value).split(/[\s,;]+/).filter(Boolean)) {
    let host: string | undefined;
    if (token.includes("://")) {
      try { host = new URL(token).hostname; } catch { host = undefined; }
    } else {
      const noPath = token.split("/")[0] ?? "";
      const m = /^([^:]+)(?::(\d+))?$/.exec(noPath);
      host = m ? m[1] : undefined;
    }
    host = host?.toLowerCase();
    if (host && host.length <= 253 && HOSTNAME.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

export function matchHost(host: string, workloadNs: string, services: ReadonlySet<string>, hostishName: boolean): HostMatch {
  const inCluster = /\.svc(\.cluster\.local)?$/.test(host);
  const labels = host.replace(/\.svc(\.cluster\.local)?$/, "").split(".");
  if (labels.length === 1) {
    if (!inCluster && !hostishName) return null;
    if (services.has(`${workloadNs}/${labels[0]}`)) return { kind: "service", namespace: workloadNs, name: labels[0]! };
    return inCluster ? { kind: "unresolved" } : null;
  }
  if (labels.length === 2) {
    const [name, ns] = labels as [string, string];
    if (services.has(`${ns}/${name}`)) return { kind: "service", namespace: ns, name };
    return inCluster ? { kind: "unresolved" } : { kind: "external" };
  }
  return inCluster ? { kind: "unresolved" } : { kind: "external" };
}

/** Every (envName, value) pair the container exposes — literal env and ConfigMap-sourced, never Secrets. */
function* pairs(c: ContainerEnv, ns: string, cms: ReadonlyMap<string, Record<string, string>> | null): Generator<[string, string]> {
  for (const e of c.env ?? []) {
    if (typeof e.value === "string") yield [e.name, e.value];
    const ref = e.valueFrom?.configMapKeyRef; // secretKeyRef is never touched
    if (ref && cms) {
      const v = cms.get(`${ns}/${ref.name}`)?.[ref.key];
      if (typeof v === "string") yield [e.name, v];
    }
  }
  for (const f of c.envFrom ?? []) {
    if (!f.configMapRef || !cms) continue; // secretRef is never touched
    for (const [k, v] of Object.entries(cms.get(`${ns}/${f.configMapRef.name}`) ?? {})) yield [k, v];
  }
}

export function envDeps(
  containers: ContainerEnv[],
  workloadNs: string,
  services: ReadonlySet<string>,
  configMaps: ReadonlyMap<string, Record<string, string>> | null
): EnvDeps {
  const out: EnvDeps = { dependsOn: [], externalHosts: [], unresolved: [] };
  const seen = new Set<string>();
  for (const c of containers) {
    for (const [via, value] of pairs(c, workloadNs, configMaps)) {
      for (const host of hostsIn(value)) {
        const m = matchHost(host, workloadNs, services, HOSTISH_NAME.test(via));
        if (!m) continue;
        const key = `${m.kind}\u0000${via}\u0000${m.kind === "service" ? `${m.namespace}/${m.name}` : host}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (m.kind === "service") {
          const role = TELEMETRY_ENV.test(via) || TELEMETRY_SVC.test(m.name) ? "telemetry" : "app";
          out.dependsOn.push({ service: m.name, namespace: m.namespace, via, role });
        } else if (m.kind === "external") out.externalHosts.push({ host, via });
        else out.unresolved.push({ host, via });
      }
    }
  }
  return out;
}

export function configMapRefs(containers: ContainerEnv[], workloadNs: string): string[] {
  const refs = new Set<string>();
  for (const c of containers) {
    for (const e of c.env ?? []) if (e.valueFrom?.configMapKeyRef) refs.add(`${workloadNs}/${e.valueFrom.configMapKeyRef.name}`);
    for (const f of c.envFrom ?? []) if (f.configMapRef) refs.add(`${workloadNs}/${f.configMapRef.name}`);
  }
  return [...refs];
}
```

The test's expected `dependsOn` order is the literal envs in order, then the `envFrom` keys. The implementation yields in that order.

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/dependency-hosts.test.ts && npm test > /tmp/claude-1000/mcp-ob1.log 2>&1; tail -5 /tmp/claude-1000/mcp-ob1.log; npx tsc --noEmit && echo TSC_OK`
Expected: 6/6 pass, the suite green, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-mcp-server && git add src/tools/kubernetes/handlers/dependency-hosts.ts src/tools/kubernetes/handlers/dependency-hosts.test.ts && git commit -m "feat(inventory): env → dependency extraction (values never returned, secrets never resolved)"
```

---

### Task 2: Dependencies and Flux revisions on the inventory (devops-mcp-server)

**Files:**
- Modify:
  - `devops-mcp-server/src/tools/kubernetes/handlers/inventory.ts` (types, `shapeInventory`, `clusterInventory`, header comment);
  - `devops-mcp-server/CLAUDE.md`.
- Test: `devops-mcp-server/src/tools/kubernetes/handlers/inventory.test.ts` (extend it; `ls` first, and create it if missing).

**Interfaces:**
- Consumes: `envDeps`, `configMapRefs`, `ContainerEnv`, `EnvDeps` (Task 1).
- Produces, on the detail inventory (namespace-scoped or `detail: true`):
  - each workload gains `dependsOn`, `externalHosts`, `unresolved` (the `EnvDeps` fields);
  - `scanned.configMaps: boolean`;
  - top-level `fluxRevisions: Array<{ kustomization: string /* "ns/name" */; revision: string }>`;
  - `InventoryInput` gains `configMaps: Array<{ metadata?: { name?: string; namespace?: string }; data?: Record<string, string> }> | null` and `allServices: string[]` (every Service cluster-wide, as `"ns/name"`);
  - `KustomizationObj` gains `status?: { lastAppliedRevision?: string }`.
- `overviewOf` is unchanged apart from `scanned` carrying `configMaps`.

- [ ] **Step 1: Write the failing tests** (in `inventory.test.ts`; reuse its existing fixtures if any, else this inline input)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeInventory } from "./inventory.js";

const base = {
  namespaces: ["sample-apps"],
  deployments: [{
    metadata: { name: "orders-api", namespace: "sample-apps", labels: {} },
    spec: { replicas: 2, template: { metadata: { labels: { app: "orders-api" } }, spec: { containers: [{
      image: "ghcr.io/x/orders-api:1.0",
      env: [{ name: "DATABASE_URL", value: "postgres://app:s3cret@postgresql.postgresql:5432/db" }],
      envFrom: [{ configMapRef: { name: "orders-config" } }],
    }] } } },
    status: { readyReplicas: 2 },
  }],
  statefulsets: [], daemonsets: [], cronjobs: [],
  services: [{ metadata: { name: "orders-api", namespace: "sample-apps" }, spec: { selector: { app: "orders-api" }, ports: [{ port: 80 }] } }],
  ingresses: [],
  kustomizations: [{ metadata: { name: "apps", namespace: "flux-app" }, spec: { path: "./apps/dev" }, status: { lastAppliedRevision: "main@sha1:aca660bbecc28f4088c4648db952e1bbdd915c16" } }],
  configMaps: [{ metadata: { name: "orders-config", namespace: "sample-apps" }, data: { CACHE_HOST: "redis-master.redis" } }],
  allServices: ["sample-apps/orders-api", "postgresql/postgresql", "redis/redis-master"],
  complete: true,
};

test("a workload carries its configured dependencies — matched against Services cluster-wide — and no env value", () => {
  const inv = shapeInventory(base as any);
  const w = inv.namespaces[0]!.workloads[0]! as any;
  assert.deepEqual(w.dependsOn, [
    { service: "postgresql", namespace: "postgresql", via: "DATABASE_URL", role: "app" },
    { service: "redis-master", namespace: "redis", via: "CACHE_HOST", role: "app" },
  ]);
  assert.doesNotMatch(JSON.stringify(inv), /s3cret/);
  assert.equal(inv.scanned.configMaps, true);
});

test("Flux applied revisions are reported, once per Kustomization", () => {
  const inv = shapeInventory(base as any) as any;
  assert.deepEqual(inv.fluxRevisions, [{ kustomization: "flux-app/apps", revision: "main@sha1:aca660bbecc28f4088c4648db952e1bbdd915c16" }]);
});

test("a refused ConfigMap read: literal env still resolves, scanned.configMaps says so", () => {
  const inv = shapeInventory({ ...base, configMaps: null } as any);
  assert.equal(inv.scanned.configMaps, false);
  assert.equal((inv.namespaces[0]!.workloads[0] as any).dependsOn.length, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/inventory.test.ts`
Expected: FAIL. `dependsOn` and `fluxRevisions` are undefined.

- [ ] **Step 3: Implement**

In `inventory.ts`:
1. Header comment: replace the last sentence ("Names, counts, images, ports and hosts only: no env, no ConfigMap/Secret content, no annotation text …") with: "Names, counts, images, ports and hosts. Env and ConfigMap VALUES are read only to find what a workload is configured to depend on (dependency-hosts.ts) and never returned — the output carries env names and matched Services. No Secret is resolved, and no annotation text is returned."
2. Types:
   - `PodSpecHolder.spec.containers` items become `Array<{ image?: string } & ContainerEnv>`. Import `ContainerEnv`, `EnvDeps`, `envDeps`, `configMapRefs` from `./dependency-hosts.js`.
   - `KustomizationObj` gets `status?: { lastAppliedRevision?: string }`.
   - `InventoryInput` gets `configMaps` and `allServices` as in Interfaces.
   - `InventoryWorkload` becomes `{ … } & EnvDeps`.
3. In `shapeInventory`, before `byNs`:

```ts
  const svcSet = new Set(input.allServices);
  const cmMap = input.configMaps
    ? new Map(input.configMaps.map((c) => [`${c.metadata?.namespace ?? ""}/${c.metadata?.name ?? ""}`, c.data ?? {}] as const))
    : null;
  const deps = (o: Obj, t: PodSpecHolder | undefined) => envDeps(t?.spec?.containers ?? [], o.metadata?.namespace ?? "", svcSet, cmMap);
```

   - in `workload(...)`'s pushed object, add `...deps(o, o.spec?.template)`;
   - in the CronJob push, add `...deps(c, c.spec?.jobTemplate?.spec?.template)`;
   - replace the return with:

```ts
  const fluxRevisions = (input.kustomizations ?? [])
    .filter((k) => k.status?.lastAppliedRevision)
    .map((k) => ({ kustomization: `${k.metadata.namespace}/${k.metadata.name}`, revision: k.status!.lastAppliedRevision! }));
  return { scanned: { namespaces: namespaces.length, complete: input.complete, configMaps: input.configMaps !== null }, namespaces, fluxRevisions };
```
4. In `clusterInventory`, after the `Promise.all` of lists:

```ts
    // Services cluster-wide for dependency matching, even on a namespace-scoped call — a dependency
    // on `postgresql.postgresql` must resolve while only `sample-apps` is being toured.
    const allSvc = namespace
      ? await listAll<ServiceObj>((o) => core.listServiceForAllNamespaces(o) as P<ServiceObj>).then((l) => l.items).catch(() => svcs.items)
      : svcs.items;
    // Only the ConfigMaps a workload references; a refusal (RBAC) makes the whole read null, a 404 is just absent.
    const templates = [
      ...[...deps.items, ...sts.items, ...dss.items].map((w) => ({ ns: w.metadata?.namespace ?? "", t: w.spec?.template })),
      ...crons.items.map((c) => ({ ns: c.metadata?.namespace ?? "", t: c.spec?.jobTemplate?.spec?.template })),
    ];
    const refs = [...new Set(templates.flatMap(({ ns, t }) => configMapRefs(t?.spec?.containers ?? [], ns)))];
    const configMaps = await Promise.all(
      refs.map((ref) => {
        const [ns, name] = ref.split("/") as [string, string];
        return core.readNamespacedConfigMap({ name, namespace: ns }).catch((e: unknown) => {
          if (/404|not found/i.test(String((e as { code?: number }).code ?? (e as Error).message ?? e))) return null;
          throw e;
        });
      })
    )
      .then((list) => list.filter((c) => c !== null) as Array<{ metadata?: { name?: string; namespace?: string }; data?: Record<string, string> }>)
      .catch(() => null);
```

   Pass `configMaps` and `allServices: allSvc.map((s) => `${s.metadata?.namespace}/${s.metadata?.name}`)` into `shapeInventory`.
5. `devops-mcp-server/CLAUDE.md`, one Gotchas bullet:

> **`k8s_cluster_inventory` reads env and ConfigMap VALUES to find dependencies, and never returns them** (`handlers/dependency-hosts.ts`, spec `devops-ai-agent/docs/superpowers/specs/2026-10-16-cluster-onboarding-flow-design.md`).
> - The output is env names (`via`), matched Services, external and unresolved hosts.
> - userinfo is stripped before parsing.
> - `secretKeyRef` / `envFrom.secretRef` are never resolved, though the ServiceAccount can read Secrets for other tools.
> - A bare word is a host only under a host-ish env name.
> - Matching uses every Service cluster-wide, even on a namespace-scoped call.

- [ ] **Step 4: Run the tests, the full suite, tsc and the build**

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/inventory.test.ts && npm test > /tmp/claude-1000/mcp-ob2.log 2>&1; tail -5 /tmp/claude-1000/mcp-ob2.log; npx tsc --noEmit && npm run build 2>&1 | tail -2 && echo BUILD_OK`
Expected: pass, the suite green, `BUILD_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-mcp-server && git add src/tools/kubernetes/handlers/inventory.ts src/tools/kubernetes/handlers/inventory.test.ts CLAUDE.md && git commit -m "feat(inventory): configured dependencies per workload + Flux applied revisions"
```

---

### Task 3: `locate` — where image and replicas live in Git (devops-ai-agent-worker)

**Files:**
- Modify:
  - `src/gitops/resolve.ts` (export `searchSpecs`; `findKeyLines` gains `lineIdx`; new `locateKeys`);
  - `src/gitops/message.ts` (request/payload types, parser);
  - `src/gitops/handler.ts` (`runLocate`, `GitOpsBackend.headSha`, `githubBackend.headSha`);
  - `src/gitops/github-client.ts` (`headSha`);
  - `src/worker.ts` (dispatch);
  - `CLAUDE.md`.
- Test: `src/gitops/resolve.test.ts`, `src/gitops/message.test.ts`, `src/gitops/handler.test.ts` (extend each).

**Interfaces:**
- Produces:
  - `interface LocateTarget { name: string; namespace: string; current: { image?: string; replicas?: number }; component?: string }`
  - `interface GitKey { path: string; line: number; key: string; gitValue: string; drift: boolean }`
  - `interface LocateResult { name: string; namespace: string; files: Array<{ path: string; role: "overlay" | "base" }>; keys: { image?: GitKey; replicas?: GitKey }; notes: string[] }`
  - `locateKeys(overlay: RepoFile[], base: RepoFile[], t: LocateTarget): LocateResult` (resolve.ts)
  - Request `GitOpsLocateRequest { requestId: string; op: "locate"; targets: LocateTarget[]; pathPrefix?: string }`.
  - Payload `{ ok: true; op: "locate"; revision: string; releases: LocateResult[] }`.
  - `runLocate(req: GitOpsLocateRequest, backend: GitOpsBackend): Promise<GitOpsPayload>`
  - `GitOpsBackend.headSha?(): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Append to `resolve.test.ts`:

```ts
import { locateKeys } from "./resolve.js";

const OVERLAY = {
  path: "apps/dev/applications/orders-api/release.yaml",
  content: [
    "apiVersion: helm.toolkit.fluxcd.io/v2",
    "kind: HelmRelease",
    "metadata:",
    "  name: orders-api",
    "spec:",
    "  values:",
    "    replicaCount: 2",
    "    image:",
    "      repository: ghcr.io/x/orders-api",
    "      tag: \"1.4.0\"",
  ].join("\n"),
};
const BASE = {
  path: "apps/base/applications/orders-api/release.yaml",
  content: ["apiVersion: helm.toolkit.fluxcd.io/v2", "kind: HelmRelease", "metadata:", "  name: orders-api", "spec:", "  values:", "    resources: {}"].join("\n"),
};

test("locateKeys: the overlay line holding the running replicas and image tag", () => {
  const r = locateKeys([OVERLAY], [BASE], { name: "orders-api", namespace: "flux-app", current: { image: "ghcr.io/x/orders-api:1.4.0", replicas: 2 } });
  assert.deepEqual(r.keys.replicas, { path: OVERLAY.path, line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: false });
  assert.deepEqual(r.keys.image, { path: OVERLAY.path, line: 10, key: "spec.values.image.tag", gitValue: "1.4.0", drift: false });
  assert.deepEqual(r.files, [{ path: OVERLAY.path, role: "overlay" }, { path: BASE.path, role: "base" }]);
  assert.deepEqual(r.notes, []);
});

test("locateKeys: a declared but different value is drift, with its line", () => {
  const r = locateKeys([OVERLAY], [BASE], { name: "orders-api", namespace: "flux-app", current: { replicas: 5 } });
  assert.deepEqual(r.keys.replicas, { path: OVERLAY.path, line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: true });
});

test("locateKeys: a value only in base is reported at its base line; absent everywhere is a note", () => {
  const baseWithReplicas = { ...BASE, content: BASE.content + "\n    replicaCount: 3" };
  const overlayNoReplicas = { ...OVERLAY, content: OVERLAY.content.replace("    replicaCount: 2\n", "") };
  const r = locateKeys([overlayNoReplicas], [baseWithReplicas], { name: "orders-api", namespace: "flux-app", current: { replicas: 3 } });
  assert.equal(r.keys.replicas?.path, BASE.path);
  assert.equal(r.keys.replicas?.drift, false);
  const none = locateKeys([overlayNoReplicas], [BASE], { name: "orders-api", namespace: "flux-app", current: { replicas: 3 } });
  assert.equal(none.keys.replicas, undefined);
  assert.match(none.notes.join("\n"), /replicas.*not declared/);
});

test("locateKeys: two files defining the HelmRelease is a refusal note, never a guess", () => {
  const twin = { ...OVERLAY, path: "apps/dev/applications/orders-api-copy/release.yaml" };
  const r = locateKeys([OVERLAY, twin], [], { name: "orders-api", namespace: "flux-app", current: { replicas: 2 } });
  assert.deepEqual(r.keys, {});
  assert.match(r.notes.join("\n"), /ambiguous: 2 files/);
});
```

Append to `message.test.ts`:

```ts
test("locate: targets parse; malformed targets are poison", () => {
  const ok = parseGitOpsRequest(JSON.stringify({ requestId: "r1", op: "locate", pathPrefix: "apps/dev/applications", targets: [{ name: "orders-api", namespace: "flux-app", current: { image: "x:1", replicas: 2 } }] }));
  assert.equal(ok?.op, "locate");
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r1", op: "locate", targets: [] })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r1", op: "locate", targets: [{ name: "a" }] })), null);
  assert.equal(parseGitOpsRequest(JSON.stringify({ requestId: "r1", op: "locate", targets: [{ name: "a", namespace: "b", current: { replicas: "2" } }] })), null);
});
```

Append to `handler.test.ts`. Read its existing fake backend first; it implements `GitOpsBackend`. Define the same `OVERLAY`/`BASE` fixtures there, since test files do not share them:

```ts
test("runLocate: one listing per prefix answers every target, with the head revision", async () => {
  let lists = 0;
  const backend = {
    ...fakeBackend(), // the file's existing helper; if it has another name, use that
    headSha: async () => "abc1234def5678abc1234def5678abc1234def56",
    listCandidateFiles: async (p?: string) => { lists++; return p?.includes("base") ? [BASE] : [OVERLAY]; },
  } as any;
  const out = await runLocate({ requestId: "r", op: "locate", pathPrefix: "apps/dev/applications", targets: [
    { name: "orders-api", namespace: "flux-app", current: { replicas: 2 } },
    { name: "missing", namespace: "flux-app", current: { replicas: 1 } },
  ] }, backend);
  assert.equal(out.ok, true);
  assert.equal((out as any).revision, "abc1234def5678abc1234def5678abc1234def56");
  assert.equal((out as any).releases.length, 2);
  assert.match((out as any).releases[1].notes.join("\n"), /no HelmRelease file/);
  assert.equal(lists, 2, "overlay + base, once each — not once per target");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent-worker && npx tsx --test src/gitops/resolve.test.ts src/gitops/message.test.ts src/gitops/handler.test.ts`
Expected: FAIL, because `locateKeys`, `runLocate` and the `locate` parse do not exist.

- [ ] **Step 3: Implement**

`resolve.ts`:
- `export function searchSpecs` (keep the body).
- `findKeyLines` returns `Array<{ key: string; value: string; path: string[]; lineIdx: number }>`. The `forEach` callback gets `(line, lineIdx)`, and `lineIdx` is added to the pushed object. Its existing callers ignore the new field.
- Add:

```ts
export interface LocateTarget { name: string; namespace: string; current: { image?: string; replicas?: number }; component?: string }
export interface GitKey { path: string; line: number; key: string; gitValue: string; drift: boolean }
export interface LocateResult { name: string; namespace: string; files: Array<{ path: string; role: "overlay" | "base" }>; keys: { image?: GitKey; replicas?: GitKey }; notes: string[] }

// Read-only "where would I change this": the line holding the RUNNING value (the same search the PR
// flow edits with, from = to = current), or the declared line when Git says something else (drift).
// Overlay first, then base. Ambiguity is a note, never a guess — the PR flow refuses the same way.
function locateIn(file: RepoFile, specs: ReturnType<typeof searchSpecs>, component?: string): GitKey | "ambiguous" | null {
  if ("error" in specs) return null;
  const lines = file.content.split("\n");
  const matches = narrowByComponent(findMatches(lines, specs.specs), component);
  if (matches.length > 1) return "ambiguous";
  if (matches.length === 1) {
    const m = matches[0]!;
    return { path: file.path, line: m.lineIdx + 1, key: m.path.join("."), gitValue: m.to, drift: false };
  }
  for (const spec of specs.specs) {
    const found = narrowByComponent(findKeyLines(lines, spec.keys), component);
    if (found.length !== 1) continue;
    const g = found[0]!;
    return { path: file.path, line: g.lineIdx + 1, key: g.path.join("."), gitValue: g.value, drift: g.value !== spec.from };
  }
  return null;
}

export function locateKeys(overlay: RepoFile[], base: RepoFile[], t: LocateTarget): LocateResult {
  const ref = `${t.namespace}/${t.name}`;
  const out: LocateResult = { name: t.name, namespace: t.namespace, files: [], keys: {}, notes: [] };
  const o = overlay.filter((f) => isHelmReleaseFile(f.content, t.name));
  const b = base.filter((f) => isHelmReleaseFile(f.content, t.name));
  for (const [set, label] of [[o, "overlay"], [b, "base"]] as const) {
    if (set.length > 1) out.notes.push(`ambiguous: ${set.length} files define a HelmRelease named \`${t.name}\` in ${label} (${set.map((f) => f.path).join(", ")}) — not guessing`);
  }
  if (o.length > 1) return out;
  const oFile = o[0];
  const bFile = b.length === 1 ? b[0] : undefined;
  out.files = [...(oFile ? [{ path: oFile.path, role: "overlay" as const }] : []), ...(bFile ? [{ path: bFile.path, role: "base" as const }] : [])];
  if (!oFile && !bFile) {
    out.notes.push(`no HelmRelease file for \`${ref}\` found in the repo`);
    return out;
  }
  const wanted: Array<["image" | "replicas", ChangeSpec | null]> = [
    ["image", t.current.image ? { action: "set_image", changes: [{ field: "image", from: t.current.image, to: t.current.image }] } : null],
    ["replicas", t.current.replicas !== undefined ? { action: "scale", changes: [{ field: "replicas", from: t.current.replicas, to: t.current.replicas }] } : null],
  ];
  for (const [what, spec] of wanted) {
    if (!spec) continue;
    const specs = searchSpecs(spec);
    let hit: GitKey | "ambiguous" | null = oFile ? locateIn(oFile, specs, t.component) : null;
    if (hit === null && bFile) hit = locateIn(bFile, specs, t.component);
    if (hit === "ambiguous") out.notes.push(`ambiguous: several lines in \`${ref}\`'s files could hold its ${what} — not guessing`);
    else if (hit) out.keys[what] = hit;
    else out.notes.push(`${what} of \`${ref}\` is not declared in the overlay or base — the chart default applies`);
  }
  return out;
}
```

`message.ts`:
- Add `GitOpsLocateRequest`.
- Add the payload variant `| { ok: true; op: "locate"; revision: string; releases: Array<{ name: string; namespace: string; files: Array<{ path: string; role: "overlay" | "base" }>; keys: { image?: { path: string; line: number; key: string; gitValue: string; drift: boolean }; replicas?: { path: string; line: number; key: string; gitValue: string; drift: boolean } }; notes: string[] }> }`.
- In `parseGitOpsRequest`, right after the `requestId` check and BEFORE the `helmRelease` check (locate has none), add:

```ts
  if (r.op === "locate") {
    if (r.pathPrefix !== undefined && typeof r.pathPrefix !== "string") return null;
    const ts = r.targets;
    if (!Array.isArray(ts) || ts.length === 0 || ts.length > 50) return null;
    for (const t of ts as Array<Record<string, unknown>>) {
      if (!t || typeof t.name !== "string" || typeof t.namespace !== "string") return null;
      const c = t.current as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") return null;
      if (c.image !== undefined && typeof c.image !== "string") return null;
      if (c.replicas !== undefined && typeof c.replicas !== "number") return null;
      if (t.component !== undefined && typeof t.component !== "string") return null;
    }
    return p as GitOpsLocateRequest;
  }
```
- Widen the function's return type to include `GitOpsLocateRequest`.

`github-client.ts`:

```ts
  /** The branch head's commit sha — what `locate` read, so the agent can compare it with Flux. */
  async headSha(branch: string): Promise<string> {
    const ref = (await this.api(`/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(branch)}`)) as { object: { sha: string } };
    return ref.object.sha;
  }
```

`handler.ts`:
- `GitOpsBackend` gains `headSha?(): Promise<string>;`.
- `githubBackend` returns `headSha: () => client.headSha(cfg.branch),`.
- Import `locateKeys` and the `GitOpsLocateRequest` type.
- Add:

```ts
// Read-only and batched: every target answered from ONE overlay listing and ONE base listing —
// a listing is 3-14 s of GitHub calls (see githubBackend), so one per HelmRelease would cost the
// agent's model build that much each. Fresh, never listHistoryFiles: a stale file is a wrong line.
// headSha is read first; a commit landing between it and the listing is a race the agent's
// revision note cannot see — ponytail: read the files at that sha if it ever bites.
export async function runLocate(req: GitOpsLocateRequest, backend: GitOpsBackend): Promise<GitOpsPayload> {
  const revision = backend.headSha ? await backend.headSha() : "unknown";
  const basePrefix = req.pathPrefix ? deriveBasePrefix(req.pathPrefix) : undefined;
  const [overlay, base] = await Promise.all([
    backend.listCandidateFiles(req.pathPrefix),
    basePrefix ? backend.listCandidateFiles(basePrefix) : Promise.resolve([] as RepoFile[]),
  ]);
  const releases = req.targets.map((t) => locateKeys(overlay, base, t));
  logger.info(`[gitops] locate ${req.requestId}: ${releases.length} release(s) at ${revision.slice(0, 7)}`);
  return { ok: true, op: "locate", revision, releases };
}
```

`worker.ts` `processGitOpsMessage`:
- the `action` label is `req.op === "locate" ? \`targets=${req.targets.length}\` : <existing>`;
- the log line's `${req.helmRelease.namespace}/${req.helmRelease.name}` must not be read for locate; it becomes `${req.op === "locate" ? "" : ` ${req.helmRelease.namespace}/${req.helmRelease.name}`}`;
- dispatch starts with `req.op === "locate" ? await runLocate(req, backend) : …`;
- `runLocate` is added to the import.

`CLAUDE.md` (worker), one bullet:

> **`locate` is read-only and batched.**
> - One overlay and one base listing answer every target; it reads fresh, never the history memo.
> - It returns `{ revision, releases[{ files, keys{ image, replicas }: GitKey, notes }] }`.
> - Ambiguity is a note, never a guess. Drift is `drift: true` at the declared line.

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-ai-agent-worker && npx tsx --test src/gitops/resolve.test.ts src/gitops/message.test.ts src/gitops/handler.test.ts && npm test > /tmp/claude-1000/worker-ob3.log 2>&1; tail -5 /tmp/claude-1000/worker-ob3.log; npx tsc --noEmit && echo TSC_OK`
Expected: pass, the suite green, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent-worker && git add src/gitops src/worker.ts CLAUDE.md && git commit -m "feat(gitops): locate — read-only, batched: where a HelmRelease's image and replicas live"
```

---

### Task 4: The cluster model — assemble, validate, render (devops-ai-agent, pure)

**Files:**
- Create: `devops-ai-agent/src/agent/onboarding/types.ts`, `devops-ai-agent/src/agent/onboarding/model.ts`
- Modify: `devops-ai-agent/src/agent/gitops/types.ts` (the `locate` contract mirror)
- Test: `devops-ai-agent/src/agent/onboarding/model.test.ts`

**Interfaces:**
- Consumes: `CallGraph`, `CALL_GRAPH_QUERY` (`src/agent/correlation/topology.ts`).
- Produces, in `gitops/types.ts` (mirror of the worker, Task 3):
  - `GitKey`, `LocateTarget`, `LocateResult`;
  - `GitOpsLocateBody { op: "locate"; targets: LocateTarget[]; pathPrefix?: string }`, added to `GitOpsRequestBody`;
  - `{ ok: true; op: "locate"; revision: string; releases: LocateResult[] }`, added to `GitOpsPayload`.
- Produces, in `onboarding/types.ts` (type-only imports from `../gitops/types.js` and nothing else):

```ts
export type ModelNode =
  | { id: string; kind: "host"; namespace: string; host: string }
  | { id: string; kind: "service"; namespace: string; name: string }
  | { id: string; kind: "workload"; namespace: string; name: string; workloadKind: string };
export type Evidence = { type: "k8s"; ref: string } | { type: "metric"; query: string } | { type: "env"; workload: string; via: string };
export interface ModelEdge { from: string; to: string; kind: "routes" | "calls" | "depends"; certainty: "observed" | "configured" | "declared"; role?: "app" | "telemetry"; evidence: Evidence[] }
export interface ClusterModel {
  snapshot: { at: string; appliedRevision: string | null; repoRevision: string | null };
  nodes: ModelNode[];
  edges: ModelEdge[];
  external: Array<{ workload: string; host: string; via: string }>;
  changeAt: Record<string, { image?: GitKey; replicas?: GitKey }>;
  unknowns: string[];
}
type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };
/** k8s_cluster_inventory's detail payload as the model reads it (mcp-server owns the shape). */
export interface InventoryDetail {
  scanned: { namespaces: number; complete: boolean; configMaps?: boolean };
  fluxRevisions?: Array<{ kustomization: string; revision: string }>;
  namespaces: Array<{
    name: string;
    system: boolean;
    workloads: Array<{
      kind: string; name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string;
      dependsOn?: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>;
      externalHosts?: Array<{ host: string; via: string }>;
      unresolved?: Array<{ host: string; via: string }>;
    }>;
    services: Array<{ name: string; type: string; ports: string[]; serves?: string[] }>;
    ingresses: Array<{ name: string; hosts: string[]; backends?: Array<{ host: string; service: string }> }>;
  }>;
}
export interface LocateOutcome {
  pathPrefix: string | undefined;
  payload: { ok: true; op: "locate"; revision: string; releases: LocateResult[] } | { ok: false; reason: string } | { error: string };
}
```

- Produces, in `onboarding/model.ts`:
  - `nodeId = { wl(ns, name), svc(ns, name), host(ns, host) }`, with ids `wl/<ns>/<name>`, `svc/<ns>/<name>`, `host/<ns>/<host>` (the same as `dashboard/cluster-graph.ts`);
  - `assembleModel(input: { inventory: InventoryDetail; graph: CallGraph | null; locate: LocateOutcome[] | null /* null = GitOps not configured */; at: string }): ClusterModel` (validated before return);
  - `validateClusterModel(m: ClusterModel): ClusterModel`;
  - `renderModelText(m: ClusterModel, namespace?: string): string`;
  - `namespaceNamed(text: string, names: string[]): string | null`;
  - `flowFacts(m: ClusterModel, namespace: string): string[]`.

- [ ] **Step 1: Write the failing tests** — `model.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleModel, validateClusterModel, renderModelText, namespaceNamed, flowFacts } from "./model.js";
import { CALL_GRAPH_QUERY } from "../correlation/topology.js";
import type { InventoryDetail, LocateOutcome } from "./types.js";

const INV: InventoryDetail = {
  scanned: { namespaces: 1, complete: true, configMaps: true },
  fluxRevisions: [{ kustomization: "flux-app/apps", revision: "main@sha1:aca660bbecc28f4088c4648db952e1bbdd915c16" }],
  namespaces: [{
    name: "sample-apps", system: false,
    workloads: [
      { kind: "Deployment", name: "storefront", ready: 2, desired: 2, images: ["ghcr.io/x/storefront:1.0"], managedBy: { type: "helmrelease", name: "storefront", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
      { kind: "Deployment", name: "checkout-gateway", ready: 1, desired: 1, images: ["ghcr.io/x/checkout:1.0"], managedBy: { type: "helmrelease", name: "checkout-gateway", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
      { kind: "Deployment", name: "orders-api", ready: 2, desired: 2, images: ["ghcr.io/x/orders-api:1.4.0"], managedBy: { type: "helmrelease", name: "orders-api", namespace: "flux-app" },
        dependsOn: [{ service: "postgresql", namespace: "postgresql", via: "DB_HOST", role: "app" }, { service: "jaeger", namespace: "monitoring", via: "OTEL_EXPORTER_OTLP_ENDPOINT", role: "telemetry" }],
        externalHosts: [{ host: "api.stripe.com", via: "STRIPE_URL" }], unresolved: [{ host: "payments.billing.svc.cluster.local", via: "PAYMENTS_URL" }] },
    ],
    services: [
      { name: "storefront", type: "ClusterIP", ports: ["80/TCP"], serves: ["storefront"] },
      { name: "checkout-gateway", type: "ClusterIP", ports: ["80/TCP"], serves: ["checkout-gateway"] },
      { name: "orders-api", type: "ClusterIP", ports: ["80/TCP"], serves: ["orders-api"] },
    ],
    ingresses: [{ name: "storefront", hosts: ["shop.example.com"], backends: [{ host: "shop.example.com", service: "storefront" }] }],
  }],
};
const GRAPH = { "sample-apps": [{ from: "storefront", to: "checkout-gateway" }, { from: "checkout-gateway", to: "orders-api" }, { from: "checkout-gateway", to: "ghost-svc" }] };
const LOCATE: LocateOutcome[] = [{
  pathPrefix: "apps/dev/applications",
  payload: { ok: true, op: "locate", revision: "aca660bbecc28f4088c4648db952e1bbdd915c16", releases: [
    { name: "orders-api", namespace: "flux-app", files: [{ path: "apps/dev/applications/orders-api/release.yaml", role: "overlay" }],
      keys: { replicas: { path: "apps/dev/applications/orders-api/release.yaml", line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: false } }, notes: [] },
    { name: "storefront", namespace: "flux-app", files: [], keys: {}, notes: ["no HelmRelease file for `flux-app/storefront` found in the repo"] },
  ] },
}];
const AT = "2026-10-16T10:00:00.000Z";

test("entry points first: host → Service → workload routes, declared, with k8s evidence", () => {
  const m = assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT });
  const r = m.edges.filter((e) => e.kind === "routes");
  assert.ok(r.some((e) => e.from === "host/sample-apps/shop.example.com" && e.to === "svc/sample-apps/storefront" && e.certainty === "declared" && e.evidence[0]!.type === "k8s"));
  assert.ok(r.some((e) => e.from === "svc/sample-apps/storefront" && e.to === "wl/sample-apps/storefront"));
});

test("calls: observed, Prometheus evidence, resolved through the Service to its workloads; an unknown name is an unknowns line", () => {
  const m = assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT });
  const calls = m.edges.filter((e) => e.kind === "calls").map((e) => `${e.from}>${e.to}`);
  assert.deepEqual(calls, ["wl/sample-apps/storefront>wl/sample-apps/checkout-gateway", "wl/sample-apps/checkout-gateway>wl/sample-apps/orders-api"]);
  assert.deepEqual(m.edges.find((e) => e.kind === "calls")!.evidence, [{ type: "metric", query: CALL_GRAPH_QUERY }]);
  assert.match(m.unknowns.join("\n"), /ghost-svc/);
});

test("depends: configured, env NAME evidence, a node for the Service in another namespace; telemetry marked; external and unresolved kept", () => {
  const m = assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT });
  const dep = m.edges.find((e) => e.kind === "depends" && e.to === "svc/postgresql/postgresql")!;
  assert.equal(dep.certainty, "configured");
  assert.deepEqual(dep.evidence, [{ type: "env", workload: "orders-api", via: "DB_HOST" }]);
  assert.ok(m.nodes.some((n) => n.id === "svc/postgresql/postgresql"));
  assert.equal(m.edges.find((e) => e.to === "svc/monitoring/jaeger")!.role, "telemetry");
  assert.deepEqual(m.external, [{ workload: "orders-api", host: "api.stripe.com", via: "STRIPE_URL" }]);
  assert.match(m.unknowns.join("\n"), /payments\.billing\.svc\.cluster\.local/);
});

test("changeAt from locate, its notes as unknowns, and the revisions pinned", () => {
  const m = assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT });
  assert.equal(m.changeAt["wl/sample-apps/orders-api"]!.replicas!.line, 7);
  assert.match(m.unknowns.join("\n"), /no HelmRelease file for `flux-app\/storefront`/);
  assert.equal(m.snapshot.appliedRevision, "main@sha1:aca660bbecc28f4088c4648db952e1bbdd915c16");
  assert.equal(m.snapshot.repoRevision, "aca660bbecc28f4088c4648db952e1bbdd915c16");
  assert.doesNotMatch(m.unknowns.join("\n"), /ahead of what Flux applied/);
});

test("a repo ahead of Flux, an unreadable graph, no GitOps, a failed locate, a partial or ConfigMap-less scan: each is an unknowns line", () => {
  const ahead: LocateOutcome[] = [{ ...LOCATE[0]!, payload: { ...(LOCATE[0]!.payload as any), revision: "ffff000000000000000000000000000000000000" } }];
  const m = assembleModel({ inventory: { ...INV, scanned: { namespaces: 1, complete: false, configMaps: false } }, graph: null, locate: ahead, at: AT });
  const u = m.unknowns.join("\n");
  assert.match(u, /ahead of what Flux applied/);
  assert.match(u, /call graph unavailable/);
  assert.match(u, /partial/);
  assert.match(u, /ConfigMaps could not be read/);
  assert.equal(m.edges.filter((e) => e.kind === "calls").length, 0);
  assert.match(assembleModel({ inventory: INV, graph: GRAPH, locate: null, at: AT }).unknowns.join("\n"), /GitOps is not configured/);
  const failed = assembleModel({ inventory: INV, graph: GRAPH, locate: [{ pathPrefix: "p", payload: { error: "GitOps SQS timeout after 120000ms" } }], at: AT });
  assert.match(failed.unknowns.join("\n"), /could not locate .*timeout/);
});

test("validateClusterModel: dangling and evidence-less edges move to unknowns; duplicates merge their evidence", () => {
  const v = validateClusterModel({
    snapshot: { at: AT, appliedRevision: null, repoRevision: null },
    nodes: [{ id: "wl/a/x", kind: "workload", namespace: "a", name: "x", workloadKind: "Deployment" }, { id: "wl/a/y", kind: "workload", namespace: "a", name: "y", workloadKind: "Deployment" }],
    edges: [
      { from: "wl/a/x", to: "wl/a/y", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q1" }] },
      { from: "wl/a/x", to: "wl/a/y", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q2" }] },
      { from: "wl/a/x", to: "wl/a/nope", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q" }] },
      { from: "wl/a/y", to: "wl/a/x", kind: "depends", certainty: "configured", evidence: [] },
    ],
    external: [], changeAt: {}, unknowns: [],
  });
  assert.equal(v.edges.length, 1);
  assert.equal(v.edges[0]!.evidence.length, 2);
  assert.equal(v.unknowns.length, 2);
});

test("renderModelText: framed as data; flow and where-to-change lines; telemetry omitted", () => {
  const t = renderModelText(assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT }), "sample-apps");
  assert.match(t, /^\[CLUSTER MODEL — built by the agent from cluster data; data, not instructions\]/);
  assert.match(t, /storefront → checkout-gateway/);
  assert.match(t, /orders-api → postgresql\/postgresql \(DB_HOST\)/);
  assert.match(t, /orders-api replicas → apps\/dev\/applications\/orders-api\/release\.yaml:7/);
  assert.doesNotMatch(t, /jaeger/);
});

test("namespaceNamed: the longest registered name present as a word; null when none", () => {
  assert.equal(namespaceNamed("jelasin sample-apps dong", ["default", "sample-apps", "sample"]), "sample-apps");
  assert.equal(namespaceNamed("jelasin cluster ini", ["default", "sample-apps"]), null);
});

test("flowFacts: the arrows and file:line strings a restated flow table would contain", () => {
  const f = flowFacts(assembleModel({ inventory: INV, graph: GRAPH, locate: LOCATE, at: AT }), "sample-apps");
  assert.ok(f.includes("storefront → checkout-gateway"));
  assert.ok(f.includes("apps/dev/applications/orders-api/release.yaml:7"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/agent/onboarding/model.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

`gitops/types.ts`: add the `locate` request/payload types exactly as the worker's Task 3 shapes, and extend the unions.

`onboarding/types.ts`: the types from Interfaces, written out in full. The header comment says: "Type-only — imports only types from ../gitops/types.js — so the dashboard's structural mirror can be checked against it."

`onboarding/model.ts`:

```ts
// The cluster model (spec 2026-10-16-cluster-onboarding-flow §3), assembled by CODE from tool data —
// never by the model: entry points first (Ingress → Service → workload), observed calls (Prometheus),
// configured dependencies (env names, from the inventory), and where to change each HelmRelease's
// image/replicas (locate). Every edge carries typed evidence; whatever could not be read is an
// unknowns line, never an empty edge set. Pure: the sources are read in onboarding/index.ts.
import { CALL_GRAPH_QUERY, type CallGraph } from "../correlation/topology.js";
import type { ClusterModel, InventoryDetail, LocateOutcome, ModelEdge, ModelNode } from "./types.js";

export const nodeId = {
  wl: (ns: string, name: string) => `wl/${ns}/${name}`,
  svc: (ns: string, name: string) => `svc/${ns}/${name}`,
  host: (ns: string, host: string) => `host/${ns}/${host}`,
};

const shaOf = (rev: string | null): string | null => (rev ? (rev.split("sha1:")[1] ?? rev) : null);

export function assembleModel(input: { inventory: InventoryDetail; graph: CallGraph | null; locate: LocateOutcome[] | null; at: string }): ClusterModel {
  const inv = input.inventory;
  const nodes = new Map<string, ModelNode>();
  const edges: ModelEdge[] = [];
  const unknowns: string[] = [];
  const external: ClusterModel["external"] = [];
  const changeAt: ClusterModel["changeAt"] = {};
  const addNode = (n: ModelNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };

  if (!inv.scanned.complete) unknowns.push(`the inventory is partial (scan ceiling after ${inv.scanned.namespaces} namespace(s)) — what is missing is not shown`);
  if (inv.scanned.configMaps === false) unknowns.push("ConfigMaps could not be read — dependencies come from literal env only");

  for (const ns of inv.namespaces) {
    for (const w of ns.workloads) addNode({ id: nodeId.wl(ns.name, w.name), kind: "workload", namespace: ns.name, name: w.name, workloadKind: w.kind });
    for (const s of ns.services) {
      addNode({ id: nodeId.svc(ns.name, s.name), kind: "service", namespace: ns.name, name: s.name });
      for (const w of s.serves ?? []) {
        edges.push({ from: nodeId.svc(ns.name, s.name), to: nodeId.wl(ns.name, w), kind: "routes", certainty: "declared", evidence: [{ type: "k8s", ref: `Service/${ns.name}/${s.name}` }] });
      }
    }
    for (const i of ns.ingresses) {
      for (const b of i.backends ?? []) {
        addNode({ id: nodeId.host(ns.name, b.host), kind: "host", namespace: ns.name, host: b.host });
        edges.push({ from: nodeId.host(ns.name, b.host), to: nodeId.svc(ns.name, b.service), kind: "routes", certainty: "declared", evidence: [{ type: "k8s", ref: `Ingress/${ns.name}/${i.name}` }] });
      }
    }
    for (const w of ns.workloads) {
      for (const d of w.dependsOn ?? []) {
        addNode({ id: nodeId.svc(d.namespace, d.service), kind: "service", namespace: d.namespace, name: d.service });
        edges.push({ from: nodeId.wl(ns.name, w.name), to: nodeId.svc(d.namespace, d.service), kind: "depends", certainty: "configured", role: d.role, evidence: [{ type: "env", workload: w.name, via: d.via }] });
      }
      for (const h of w.externalHosts ?? []) external.push({ workload: w.name, host: h.host, via: h.via });
      for (const u of w.unresolved ?? []) unknowns.push(`\`${w.name}\` env ${u.via} names \`${u.host}\`, which is not a Service in this cluster`);
    }
  }

  // A call-graph name is a Service (→ the workloads it serves) or a workload; anything else is named.
  const resolve = (ns: string, name: string): string[] => {
    const svc = inv.namespaces.find((n) => n.name === ns)?.services.find((s) => s.name === name);
    if (svc) return (svc.serves ?? []).map((w) => nodeId.wl(ns, w));
    return nodes.has(nodeId.wl(ns, name)) ? [nodeId.wl(ns, name)] : [];
  };
  if (!input.graph) {
    unknowns.push("call graph unavailable (Prometheus) — no observed calls are shown");
  } else {
    for (const ns of inv.namespaces) {
      for (const e of input.graph[ns.name] ?? []) {
        const from = resolve(ns.name, e.from);
        const to = resolve(ns.name, e.to);
        for (const [name, ids] of [[e.from, from], [e.to, to]] as const) {
          if (ids.length === 0) unknowns.push(`the call graph names \`${name}\` in ${ns.name}, which is neither a Service nor a workload there`);
        }
        for (const f of from) for (const t of to) edges.push({ from: f, to: t, kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: CALL_GRAPH_QUERY }] });
      }
    }
  }

  const revisions = [...new Set((inv.fluxRevisions ?? []).map((r) => r.revision))];
  const appliedRevision = revisions.length === 1 ? revisions[0]! : null;
  if (revisions.length > 1) unknowns.push(`Kustomizations are at different revisions (${revisions.join(", ")})`);
  let repoRevision: string | null = null;
  if (input.locate === null) {
    unknowns.push("GitOps is not configured — where-to-change is unavailable");
  } else {
    for (const o of input.locate) {
      const where = o.pathPrefix ?? "the default prefix";
      if ("error" in o.payload) { unknowns.push(`could not locate HelmRelease files under ${where}: ${o.payload.error}`); continue; }
      if (!o.payload.ok) { unknowns.push(`could not locate HelmRelease files under ${where}: ${o.payload.reason}`); continue; }
      repoRevision ??= o.payload.revision;
      for (const r of o.payload.releases) {
        unknowns.push(...r.notes);
        if (!r.keys.image && !r.keys.replicas) continue;
        for (const ns of inv.namespaces) {
          for (const w of ns.workloads) {
            if (w.managedBy.type === "helmrelease" && w.managedBy.name === r.name && w.managedBy.namespace === r.namespace) changeAt[nodeId.wl(ns.name, w.name)] = { ...r.keys };
          }
        }
      }
    }
  }
  const applied = shaOf(appliedRevision);
  if (applied && repoRevision && !repoRevision.startsWith(applied) && !applied.startsWith(repoRevision)) {
    unknowns.push(`the repo is ahead of what Flux applied (${appliedRevision} vs ${repoRevision.slice(0, 12)}) — line numbers are for the repo head`);
  }

  return validateClusterModel({ snapshot: { at: input.at, appliedRevision, repoRevision }, nodes: [...nodes.values()], edges, external, changeAt, unknowns });
}

export function validateClusterModel(m: ClusterModel): ClusterModel {
  const ids = new Set(m.nodes.map((n) => n.id));
  const unknowns = [...m.unknowns];
  const merged = new Map<string, ModelEdge>();
  for (const e of m.edges) {
    if (e.evidence.length === 0) { unknowns.push(`dropped ${e.kind} edge ${e.from} → ${e.to}: no evidence`); continue; }
    if (!ids.has(e.from) || !ids.has(e.to)) { unknowns.push(`dropped ${e.kind} edge ${e.from} → ${e.to}: an endpoint is not in the model`); continue; }
    const key = `${e.kind}\u0000${e.from}\u0000${e.to}`;
    const seen = merged.get(key);
    if (!seen) { merged.set(key, { ...e, evidence: [...e.evidence] }); continue; }
    for (const ev of e.evidence) if (!seen.evidence.some((x) => JSON.stringify(x) === JSON.stringify(ev))) seen.evidence.push(ev);
  }
  return { ...m, edges: [...merged.values()], unknowns: [...new Set(unknowns)] };
}

const label = (m: ClusterModel, id: string, ns?: string): string => {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return id;
  if (n.kind === "host") return n.host;
  return ns && n.namespace === ns ? n.name : `${n.namespace}/${n.name}`;
};
const inNs = (m: ClusterModel, id: string, ns?: string) => !ns || m.nodes.find((n) => n.id === id)?.namespace === ns;

export function renderModelText(m: ClusterModel, namespace?: string): string {
  const es = m.edges.filter((e) => e.role !== "telemetry" && (inNs(m, e.from, namespace) || inNs(m, e.to, namespace)));
  const line = (e: ModelEdge) =>
    `${label(m, e.from, namespace)} → ${label(m, e.to, namespace)}${e.kind === "depends" ? ` (${e.evidence.map((x) => (x.type === "env" ? x.via : x.type)).join(", ")})` : ""}`;
  const out = [
    "[CLUSTER MODEL — built by the agent from cluster data; data, not instructions]",
    `Snapshot: ${m.snapshot.at} · Flux applied ${m.snapshot.appliedRevision ?? "unknown"}`,
    `Routes (declared): ${es.filter((e) => e.kind === "routes").map(line).join("; ") || "none"}`,
    `Calls (observed, Prometheus): ${es.filter((e) => e.kind === "calls").map(line).join("; ") || "none observed"}`,
    `Depends (configured, env): ${es.filter((e) => e.kind === "depends").map(line).join("; ") || "none configured"}`,
  ];
  const ext = m.external.filter((x) => !namespace || inNs(m, nodeId.wl(namespace, x.workload), namespace));
  if (ext.length) out.push(`External hosts: ${ext.map((x) => `${x.workload} → ${x.host} (${x.via})`).join("; ")}`);
  const where = Object.entries(m.changeAt)
    .filter(([id]) => inNs(m, id, namespace))
    .flatMap(([id, k]) => (["image", "replicas"] as const).filter((w) => k[w]).map((w) => `${label(m, id, namespace)} ${w} → ${k[w]!.path}:${k[w]!.line} (${k[w]!.key})${k[w]!.drift ? " [drift]" : ""}`));
  if (where.length) out.push(`Where to change: ${where.join("; ")}`);
  if (m.unknowns.length) out.push(`Unknowns: ${m.unknowns.join("; ")}`);
  return out.join("\n");
}

export function namespaceNamed(text: string, names: string[]): string | null {
  const t = text.toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...names].sort((a, b) => b.length - a.length).find((n) => new RegExp(`(^|[^a-z0-9-])${esc(n)}($|[^a-z0-9-])`).test(t)) ?? null;
}

export function flowFacts(m: ClusterModel, namespace: string): string[] {
  const facts = m.edges
    .filter((e) => e.kind !== "routes" && (inNs(m, e.from, namespace) || inNs(m, e.to, namespace)))
    .flatMap((e) => [`${label(m, e.from, namespace)} → ${label(m, e.to, namespace)}`, `${label(m, e.from, namespace)} -> ${label(m, e.to, namespace)}`]);
  for (const [id, k] of Object.entries(m.changeAt)) {
    if (!inNs(m, id, namespace)) continue;
    for (const g of [k.image, k.replicas]) if (g) facts.push(`${g.path}:${g.line}`);
  }
  return [...new Set(facts)];
}
```

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-ai-agent && npx tsx --test src/agent/onboarding/model.test.ts && npm test > /tmp/claude-1000/agent-ob4.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-ob4.log; npx tsc --noEmit && echo TSC_OK`
Expected: 9/9 pass, the suite `fail 0`, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent && git add src/agent/onboarding src/agent/gitops/types.ts && git commit -m "feat(onboarding): the cluster model — entry points, observed calls, configured depends, where to change; validated"
```

---

### Task 5: Build from the live sources + the 5-minute cache (devops-ai-agent)

**Files:**
- Create: `devops-ai-agent/src/agent/onboarding/index.ts`
- Modify: `devops-ai-agent/src/agent/index.ts` (construct the cache; add `clusterModel`, `peekClusterModel`, `tourNamespace`)
- Test: `devops-ai-agent/src/agent/onboarding/index.test.ts`

**Interfaces:**
- Consumes:
  - `assembleModel`, `namespaceNamed` and the types (Task 4);
  - `serviceGraph` (`correlation/topology.ts`);
  - `SqsGitOpsClient.request` (`gitops/sqs.ts`);
  - `DevOpsAgent`'s private `resolveOverlayPath(hr)` (existing).
- Produces:
  - `interface ModelSources { inventory(namespace?: string): Promise<string>; callGraph(): Promise<CallGraph | null>; locate?: (pathPrefix: string | undefined, targets: LocateTarget[]) => Promise<GitOpsPayload>; overlayPath(hr: { name: string; namespace: string }): Promise<string | undefined>; now(): number }`
  - `buildClusterModel(src: ModelSources, namespace?: string): Promise<ClusterModel | null>` (null = the inventory itself could not be read; logged)
  - `class ClusterModelCache { constructor(build: (ns?: string) => Promise<ClusterModel | null>, ttlMs?: number, now?: () => number); get(ns?: string): Promise<ClusterModel | null>; peek(ns?: string): ClusterModel | null }`
  - `DevOpsAgent.clusterModel(namespace?: string): Promise<ClusterModel | null>`
  - `DevOpsAgent.peekClusterModel(): ClusterModel | null` (whole cluster)
  - `DevOpsAgent.tourNamespace(text: string): Promise<string | null>`

- [ ] **Step 1: Write the failing tests** — `index.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClusterModel, ClusterModelCache, type ModelSources } from "./index.js";

const INV = JSON.stringify({
  scanned: { namespaces: 1, complete: true, configMaps: true }, fluxRevisions: [],
  namespaces: [{ name: "sample-apps", system: false, services: [], ingresses: [], workloads: [
    { kind: "Deployment", name: "orders-api", ready: 1, desired: 2, images: ["x:1"], managedBy: { type: "helmrelease", name: "orders-api", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
    { kind: "Deployment", name: "storefront", ready: 1, desired: 1, images: ["y:1"], managedBy: { type: "helmrelease", name: "storefront", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
  ] }],
});

function sources(over: Partial<ModelSources> = {}): ModelSources & { locateCalls: any[] } {
  const locateCalls: any[] = [];
  return {
    locateCalls,
    inventory: async () => INV,
    callGraph: async () => ({}),
    locate: async (p, targets) => { locateCalls.push({ p, targets }); return { ok: true, op: "locate", revision: "abc", releases: [] } as any; },
    overlayPath: async () => "apps/dev/applications",
    now: () => 1_000,
    ...over,
  };
}

test("one locate per distinct overlay prefix, with the running image and desired replicas", async () => {
  const s = sources();
  const m = await buildClusterModel(s, "sample-apps");
  assert.ok(m);
  assert.equal(s.locateCalls.length, 1);
  assert.equal(s.locateCalls[0].p, "apps/dev/applications");
  assert.deepEqual(s.locateCalls[0].targets, [
    { name: "orders-api", namespace: "flux-app", current: { image: "x:1", replicas: 2 } },
    { name: "storefront", namespace: "flux-app", current: { image: "y:1", replicas: 1 } },
  ]);
});

test("every source fails open: a throwing call graph and locate become unknowns; an unreadable inventory is null", async () => {
  const m = await buildClusterModel(sources({ callGraph: async () => { throw new Error("prom down"); }, locate: async () => { throw new Error("GitOps SQS timeout"); } }), "sample-apps");
  assert.match(m!.unknowns.join("\n"), /call graph unavailable/);
  assert.match(m!.unknowns.join("\n"), /GitOps SQS timeout/);
  assert.equal(await buildClusterModel(sources({ inventory: async () => "Error: forbidden" }), "sample-apps"), null);
  const noGitops = await buildClusterModel(sources({ locate: undefined }), "sample-apps");
  assert.match(noGitops!.unknowns.join("\n"), /GitOps is not configured/);
});

test("cache: warm within 5 min; stale is served while rebuilding; peek never waits and kicks a build", async () => {
  let t = 0;
  let builds = 0;
  const cache = new ClusterModelCache(async () => { builds++; return { snapshot: { at: String(builds) } } as any; }, 300_000, () => t);
  assert.equal(cache.peek("a"), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 1, "peek on a cold key starts one build");
  assert.equal((await cache.get("a"))!.snapshot.at, "1");
  t = 299_999;
  await cache.get("a");
  assert.equal(builds, 1);
  t = 300_001;
  assert.equal((await cache.get("a"))!.snapshot.at, "1", "stale is served while the rebuild runs");
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 2);
  assert.equal(cache.peek("a")!.snapshot.at, "2");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/agent/onboarding/index.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

`onboarding/index.ts`:

```ts
// Reads the cluster model's sources (spec 2026-10-16-cluster-onboarding-flow §3) — each one
// fail-open — and caches the result 5 minutes. Runs outside any investigation, like the change
// timeline, so replay never executes it.
import logger, { errDetail } from "../../utils/logger/index.js";
import type { CallGraph } from "../correlation/topology.js";
import type { GitOpsPayload, LocateTarget } from "../gitops/types.js";
import { assembleModel } from "./model.js";
import type { ClusterModel, InventoryDetail, LocateOutcome } from "./types.js";

export interface ModelSources {
  inventory(namespace?: string): Promise<string>;
  callGraph(): Promise<CallGraph | null>;
  locate?: (pathPrefix: string | undefined, targets: LocateTarget[]) => Promise<GitOpsPayload>;
  overlayPath(hr: { name: string; namespace: string }): Promise<string | undefined>;
  now(): number;
}

function parseInventory(raw: string): InventoryDetail | null {
  try {
    const v = JSON.parse(raw) as InventoryDetail;
    return v && Array.isArray(v.namespaces) && v.scanned ? v : null;
  } catch {
    return null;
  }
}

export async function buildClusterModel(src: ModelSources, namespace?: string): Promise<ClusterModel | null> {
  const [rawInv, graph] = await Promise.all([
    src.inventory(namespace).catch((e) => `Error: ${errDetail(e)}`),
    src.callGraph().catch(() => null),
  ]);
  const inventory = parseInventory(rawInv);
  if (!inventory) {
    logger.warn(`[onboarding] inventory unreadable for ${namespace ?? "the cluster"}: ${rawInv.slice(0, 160)}`);
    return null;
  }
  let locate: LocateOutcome[] | null = null;
  const locateFn = src.locate;
  if (locateFn) {
    const byPrefix = new Map<string | undefined, LocateTarget[]>();
    for (const ns of inventory.namespaces) {
      for (const w of ns.workloads) {
        if (w.managedBy.type !== "helmrelease") continue;
        const hr = { name: w.managedBy.name, namespace: w.managedBy.namespace };
        const prefix = await src.overlayPath(hr).catch(() => undefined);
        const list = byPrefix.get(prefix) ?? [];
        if (!list.some((t) => t.name === hr.name && t.namespace === hr.namespace)) {
          list.push({ ...hr, current: { ...(w.images[0] ? { image: w.images[0] } : {}), ...(w.desired !== null ? { replicas: w.desired } : {}) } });
        }
        byPrefix.set(prefix, list);
      }
    }
    locate = await Promise.all(
      [...byPrefix].map(async ([pathPrefix, targets]): Promise<LocateOutcome> => {
        try {
          const payload = await locateFn(pathPrefix, targets);
          if (payload.ok && payload.op === "locate") return { pathPrefix, payload };
          return { pathPrefix, payload: payload.ok ? { ok: false, reason: `unexpected op ${payload.op}` } : { ok: false, reason: payload.reason } };
        } catch (e) {
          return { pathPrefix, payload: { error: e instanceof Error ? e.message : String(e) } };
        }
      })
    );
  }
  return assembleModel({ inventory, graph, locate, at: new Date(src.now()).toISOString() });
}

/** Per namespace scope ("" = whole cluster). ponytail: per process — replicas each build their own. */
export class ClusterModelCache {
  private readonly entries = new Map<string, { at: number; model: ClusterModel | null; building?: Promise<ClusterModel | null> }>();
  constructor(
    private readonly build: (ns?: string) => Promise<ClusterModel | null>,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = Date.now
  ) {}

  private rebuild(key: string): Promise<ClusterModel | null> {
    const e = this.entries.get(key);
    if (e?.building) return e.building;
    const building = this.build(key || undefined)
      .catch((err) => { logger.warn(`[onboarding] model build failed for ${key || "the cluster"}: ${errDetail(err)}`); return null; })
      .then((model) => {
        const prev = this.entries.get(key)?.model ?? null;
        // A failed rebuild keeps the last good model rather than replacing it with nothing.
        const kept = model ?? prev;
        this.entries.set(key, { at: model ? this.now() : this.entries.get(key)?.at ?? 0, model: kept });
        return kept;
      });
    this.entries.set(key, { at: e?.at ?? 0, model: e?.model ?? null, building });
    return building;
  }

  async get(ns?: string): Promise<ClusterModel | null> {
    const key = ns ?? "";
    const e = this.entries.get(key);
    if (e?.model && this.now() - e.at < this.ttlMs) return e.model;
    if (e?.model) { void this.rebuild(key); return e.model; }
    return this.rebuild(key);
  }

  peek(ns?: string): ClusterModel | null {
    const key = ns ?? "";
    const e = this.entries.get(key);
    if (!e?.model || this.now() - e.at >= this.ttlMs) void this.rebuild(key);
    return e?.model ?? null;
  }
}
```

`agent/index.ts` (`DevOpsAgent`):
- Imports:
  - `buildClusterModel, ClusterModelCache` from `./onboarding/index.js`;
  - `namespaceNamed` from `./onboarding/model.js`;
  - `type ClusterModel` from `./onboarding/types.js`;
  - `serviceGraph` from `./correlation/topology.js` (add it if it is not already imported).
- Field: `private readonly clusterModels: ClusterModelCache;`.
- Constructor, after `this.mcp` and `this.gitops` are assigned:

```ts
    this.clusterModels = new ClusterModelCache((ns) =>
      buildClusterModel(
        {
          inventory: (n) => this.mcp.callTool("k8s_cluster_inventory", n ? { namespace: n } : { detail: true }),
          callGraph: () => serviceGraph((name, input) => this.mcp.callTool(name, input)),
          locate: this.gitops ? (pathPrefix, targets) => this.gitops!.request({ op: "locate", targets, ...(pathPrefix ? { pathPrefix } : {}) }) : undefined,
          overlayPath: (hr) => this.resolveOverlayPath(hr),
          now: Date.now,
        },
        ns
      )
    );
```
- Methods:

```ts
  /** The onboarding cluster model (agent/onboarding) — called outside any investigation, like collectChanges. */
  async clusterModel(namespace?: string): Promise<ClusterModel | null> {
    return this.clusterModels.get(namespace);
  }

  /** The whole-cluster model for /cluster: never waits; a cold or stale cache kicks a background build. */
  peekClusterModel(): ClusterModel | null {
    return this.clusterModels.peek();
  }

  /** The namespace a tour mention names, matched against the live namespace list; null when it names none. */
  async tourNamespace(text: string): Promise<string | null> {
    const raw = await this.mcp.callTool("k8s_cluster_inventory", {}).catch(() => "");
    try {
      const names = ((JSON.parse(raw) as { namespaces?: Array<{ name: string }> }).namespaces ?? []).map((n) => n.name);
      return namespaceNamed(text, names);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-ai-agent && npx tsx --test src/agent/onboarding/*.test.ts && npm test > /tmp/claude-1000/agent-ob5.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-ob5.log; npx tsc --noEmit && echo TSC_OK`
Expected: pass, the suite `fail 0`, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent && git add src/agent/onboarding src/agent/index.ts && git commit -m "feat(onboarding): build the cluster model from live sources, fail-open, cached 5 min"
```

---

### Task 6: The Slack tour — prefetch, flow tables, grounding evidence (devops-ai-agent)

**Files:**
- Modify:
  - `devops-ai-agent/src/utils/slack/tour-tables.ts` (`flowMessages`; `stripRepeatedInventory` gains `extraFacts`);
  - `devops-ai-agent/src/app/index.ts` (`handleMention` tour branch; `postFlowTables`);
  - `devops-ai-agent/prompts/skills/cluster-tour.md` (one rule).
- Test: `devops-ai-agent/src/utils/slack/tour-tables.test.ts` (extend), `devops-ai-agent/src/app/tour-post.test.ts` (extend; read it first and reuse its harness).

**Interfaces:**
- Consumes: `ClusterModel` (Task 4 types); `renderModelText`, `flowFacts` (Task 4); `DevOpsAgent.clusterModel`, `DevOpsAgent.tourNamespace` (Task 5).
- Produces:
  - `flowMessages(model: ClusterModel, namespace: string): Array<{ blocks: KnownBlock[]; text: string }>`: always two, Request flow then Where to change it, each with at most one table;
  - `stripRepeatedInventory(reply: string, raw: string | null, extraFacts?: string[]): string`.

- [ ] **Step 1: Write the failing tests**

Append to `tour-tables.test.ts`:

```ts
import { flowMessages, stripRepeatedInventory } from "./tour-tables.js";

const MODEL: any = {
  snapshot: { at: "2026-10-16T10:00:00.000Z", appliedRevision: "main@sha1:aca660bb", repoRevision: "aca660bb" },
  nodes: [
    { id: "wl/sample-apps/checkout-gateway", kind: "workload", namespace: "sample-apps", name: "checkout-gateway", workloadKind: "Deployment" },
    { id: "wl/sample-apps/orders-api", kind: "workload", namespace: "sample-apps", name: "orders-api", workloadKind: "Deployment" },
    { id: "svc/postgresql/postgresql", kind: "service", namespace: "postgresql", name: "postgresql" },
    { id: "svc/monitoring/jaeger", kind: "service", namespace: "monitoring", name: "jaeger" },
  ],
  edges: [
    { from: "wl/sample-apps/checkout-gateway", to: "wl/sample-apps/orders-api", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/postgresql/postgresql", kind: "depends", certainty: "configured", role: "app", evidence: [{ type: "env", workload: "orders-api", via: "DB_HOST" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/monitoring/jaeger", kind: "depends", certainty: "configured", role: "telemetry", evidence: [{ type: "env", workload: "orders-api", via: "OTEL_EXPORTER_OTLP_ENDPOINT" }] },
  ],
  external: [],
  changeAt: { "wl/sample-apps/orders-api": { replicas: { path: "apps/dev/applications/orders-api/release.yaml", line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: false } } },
  unknowns: [],
};

test("flowMessages: two messages, one table each — the flow rows and where to change; telemetry counted, not listed", () => {
  const [flow, where] = flowMessages(MODEL, "sample-apps");
  const tables = (m: any) => m.blocks.filter((b: any) => b.type === "table");
  assert.equal(tables(flow).length, 1);
  assert.equal(tables(where).length, 1);
  assert.match(flow!.text, /`checkout-gateway` → `orders-api` · calls \(observed\)/);
  assert.match(flow!.text, /`orders-api` → `postgresql\/postgresql` · depends \(configured\) · env DB_HOST/);
  assert.doesNotMatch(flow!.text, /jaeger/);
  assert.match(flow!.text, /1 telemetry dependency hidden/);
  assert.match(where!.text, /`orders-api` replicas → `apps\/dev\/applications\/orders-api\/release\.yaml:7` `spec\.values\.replicaCount`/);
});

test("flowMessages: an empty flow says so with its unknowns, never a bare empty table", () => {
  const empty = { ...MODEL, edges: [], changeAt: {}, unknowns: ["call graph unavailable (Prometheus) — no observed calls are shown", "GitOps is not configured — where-to-change is unavailable"] };
  const [flow, where] = flowMessages(empty, "sample-apps");
  assert.equal(flow!.blocks.filter((b: any) => b.type === "table").length, 0);
  assert.match(flow!.text, /No calls observed and no dependencies configured/);
  assert.match(flow!.text, /call graph unavailable/);
  assert.match(where!.text, /GitOps is not configured/);
});

test("stripRepeatedInventory drops a restated flow row or file:line, but keeps Dugaan fungsi whole", () => {
  const reply = [
    "• `checkout-gateway` → `orders-api` (observed)",
    "• replicas: apps/dev/applications/orders-api/release.yaml:7",
    "*Dugaan fungsi*",
    "• `orders-api` checkout-gateway → orders-api — backend pesanan _dugaan_",
  ].join("\n");
  const inv = '{"scanned":{"namespaces":1,"complete":true},"namespaces":[{"name":"x","system":false,"workloads":["Deployment orders-api — unmanaged"]}]}';
  const out = stripRepeatedInventory(reply, inv, ["checkout-gateway → orders-api", "apps/dev/applications/orders-api/release.yaml:7"]);
  assert.doesNotMatch(out, /\(observed\)/);
  assert.doesNotMatch(out, /release\.yaml:7/);
  assert.match(out, /backend pesanan/);
});
```

Note: the first strip line contains `` `checkout-gateway` → `orders-api` ``, with backticks, while the fact is `checkout-gateway → orders-api`. To make the test hold, `stripRepeatedInventory` compares extra facts against the line with backticks removed: `line.replace(/`/g, "")`. Implement it that way.

Append to `tour-post.test.ts`, using its existing harness for `handleMention`. Two tests:
- **(a) A namespace detail tour builds the model first.**
  - Stub `agent.tourNamespace` → `"sample-apps"`, `agent.clusterModel` → `MODEL` (copy the literal above), and `agent.investigate` to capture its `message`. The `wantsTour` text is `"jelasin sample-apps"`.
  - The captured message starts with `[CLUSTER MODEL`.
  - After the inventory tables, two messages are posted whose `text` match `/\*Request flow\*/` and `/\*Where to change it\*/`.
  - The stubbed `warnIfUngrounded` receives a 4th argument matching `/\[CLUSTER MODEL/`.
- **(b) A failed build.**
  - `agent.clusterModel` → `null`.
  - The captured message does not contain `[CLUSTER MODEL`.
  - No message matches `/Request flow/`.
  - The inventory tables and the reply are still posted.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/utils/slack/tour-tables.test.ts src/app/tour-post.test.ts`
Expected: FAIL. `flowMessages` is missing, and the tour posts no flow.

- [ ] **Step 3: Implement**

`tour-tables.ts`:
1. Add `import type { ClusterModel } from "../../agent/onboarding/types.js";` (type-only).
2. `stripRepeatedInventory(reply, raw, extraFacts: string[] = [])`:
   - collect `extraFacts` as their own list;
   - in the drop loop, add `else if (extraFacts.some((f) => f && line.replace(/`/g, "").includes(f))) drop[i] = true;` after the existing `facts` check. The Dugaan guard before it already protects that section.
3. Add:

```ts
const where = (m: ClusterModel, id: string, ns: string): string => {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return code(id);
  if (n.kind === "host") return code(n.host);
  return code(n.namespace === ns ? n.name : `${n.namespace}/${n.name}`);
};

/**
 * The tour's request flow and where-to-change as TWO messages, one table each (a message's blocks are
 * refused whole, so a defect in one table must not cost the other). Built from the cluster model —
 * every row is an edge with evidence; an empty side says why it is empty.
 */
export function flowMessages(m: ClusterModel, ns: string): Array<{ blocks: KnownBlock[]; text: string }> {
  const touches = (e: ClusterModel["edges"][number]) => [e.from, e.to].some((id) => m.nodes.find((n) => n.id === id)?.namespace === ns);
  const flow = m.edges.filter((e) => e.kind !== "routes" && touches(e));
  const app = flow.filter((e) => e.role !== "telemetry");
  const telemetry = flow.length - app.length;
  const ev = (e: ClusterModel["edges"][number]) => e.evidence.map((x) => (x.type === "env" ? `env ${x.via}` : x.type === "metric" ? "metric" : x.ref)).join(", ");
  const unknownLines = m.unknowns.map((u) => `• _${u}_`).join("\n");

  const flowTitle = `*Request flow* — ${code(ns)}${telemetry ? ` · ${telemetry} telemetry dependenc${telemetry === 1 ? "y" : "ies"} hidden` : ""}`;
  let flowMsg: { blocks: KnownBlock[]; text: string };
  if (app.length) {
    flowMsg = {
      blocks: [
        section(flowTitle),
        ...tables(["From", "To", "Kind", "Evidence"], app.map((e) => [where(m, e.from, ns), where(m, e.to, ns), `${e.kind} · ${e.certainty}`, ev(e)]), [true, true, false, true]),
        ...(m.unknowns.length ? [section(unknownLines)] : []),
      ],
      text: [flowTitle, ...app.map((e) => `• ${where(m, e.from, ns)} → ${where(m, e.to, ns)} · ${e.kind} (${e.certainty}) · ${ev(e)}`), ...(m.unknowns.length ? [unknownLines] : [])].join("\n"),
    };
  } else {
    const t = [flowTitle, `No calls observed and no dependencies configured in ${code(ns)}.`, ...(m.unknowns.length ? [unknownLines] : [])].join("\n");
    flowMsg = { blocks: [section(t)], text: t };
  }

  const rows = Object.entries(m.changeAt)
    .filter(([id]) => m.nodes.find((n) => n.id === id)?.namespace === ns)
    .flatMap(([id, k]) =>
      (["image", "replicas"] as const)
        .filter((w) => k[w])
        .map((w) => [where(m, id, ns), w, code(`${k[w]!.path}:${k[w]!.line}`), `${code(k[w]!.key)}${k[w]!.drift ? ` · drift: Git says ${code(k[w]!.gitValue)}` : ""}`])
    );
  const whereTitle = `*Where to change it* — Git${m.snapshot.repoRevision ? ` at ${code(m.snapshot.repoRevision.slice(0, 7))}` : ""}`;
  const gitUnknowns = m.unknowns.filter((u) => /GitOps|HelmRelease|declared|ahead|locate/.test(u)).map((u) => `• _${u}_`).join("\n");
  let whereMsg: { blocks: KnownBlock[]; text: string };
  if (rows.length) {
    whereMsg = {
      blocks: [section(whereTitle), ...tables(["Workload", "What", "File", "Key"], rows, [true, false, true, true])],
      text: [whereTitle, ...rows.map((r) => `• ${r[0]} ${r[1]} → ${r[2]} ${r[3]}`)].join("\n"),
    };
  } else {
    const t = [whereTitle, "Nothing located in Git for this namespace.", ...(gitUnknowns ? [gitUnknowns] : [])].join("\n");
    whereMsg = { blocks: [section(t)], text: t };
  }
  return [flowMsg, whereMsg];
}
```

`app/index.ts`:
1. Imports:
   - extend the tour-tables import to `flowMessages, stripRepeatedInventory, tourBlocks`;
   - add `import { flowFacts, renderModelText } from "../agent/onboarding/model.js";`;
   - add `import type { ClusterModel } from "../agent/onboarding/types.js";`.
2. In `handleMention`, inside the `threadQueue.run` callback, right after `previousReply` is read:

```ts
        // A namespace tour gets the cluster model PREFETCHED, outside the investigation like the
        // change timeline (so replay never re-runs it): the reply can then cite the flow, and the
        // flow tables are posted from the same model. Best-effort: a failed build is today's tour.
        let flowNs: string | null = null;
        let flowModel: ClusterModel | null = null;
        if (wantsTour(text)) {
          flowNs = await this.agent.tourNamespace(text).catch(() => null);
          flowModel = flowNs ? await this.agent.clusterModel(flowNs).catch(() => null) : null;
        }
        const flowText = flowModel && flowNs ? renderModelText(flowModel, flowNs) : "";
        const tourMessage = flowText ? `${flowText}\n\n---\n\n${message}` : message;
```
   Use `tourMessage` in place of `message` in both `this.agent.investigate(threadId, message, …)` calls.
3. In the `if (wantsTour(text))` branch, replace the `stripRepeatedInventory` line with:

```ts
            if (flowModel && flowNs) await this.postFlowTables(event.channel, threadId, client, flowModel, flowNs);
            if (inventory) reply = stripRepeatedInventory(reply, inventory, flowModel && flowNs ? flowFacts(flowModel, flowNs) : []) || reply;
```
4. Where this mention path calls `await this.warnIfUngrounded(event.channel, threadId, reply);`, pass the model text as evidence: `await this.warnIfUngrounded(event.channel, threadId, reply, flowText);`.
5. Next to `postTourTables`, add:

```ts
  /** The cluster model's flow and where-to-change, one message each; a refused table re-posts as text. */
  private async postFlowTables(channel: string, threadTs: string, client: AllMiddlewareArgs["client"], model: ClusterModel, ns: string): Promise<void> {
    for (const msg of flowMessages(model, ns)) {
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg.text, blocks: msg.blocks });
      } catch (err) {
        logger.warn(`[slack] flow table refused, posting it as text (thread ${threadTs}): ${errDetail(err)}`);
        await client.chat
          .postMessage({ channel, thread_ts: threadTs, text: msg.text, mrkdwn: true })
          .catch((e) => logger.warn(`[slack] flow text post failed (thread ${threadTs}): ${errDetail(e)}`));
      }
    }
  }
```

`prompts/skills/cluster-tour.md`, in step 3, append one sentence to the *Dugaan fungsi* bullet:

> When a `[CLUSTER MODEL …]` block is in the message, a guess may cite its flow ("the entry point: `shop.example.com` routes to `storefront`"; "`orders-api` keeps its data in `postgresql/postgresql`"), still marked `_dugaan_` — but never restate its Request flow or Where to change lines: they are posted as tables.

The file must stay under `SKILL_MAX_CHARS` (8000). `src/agent/skills/real.test.ts` loads it.

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-ai-agent && npx tsx --test src/utils/slack/tour-tables.test.ts src/app/tour-post.test.ts src/agent/skills/real.test.ts && npm test > /tmp/claude-1000/agent-ob6.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-ob6.log; npx tsc --noEmit && echo TSC_OK`
Expected: pass, the suite `fail 0`, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent && git add src/utils/slack/tour-tables.ts src/utils/slack/tour-tables.test.ts src/app/index.ts src/app/tour-post.test.ts prompts/skills/cluster-tour.md && git commit -m "feat(tour): request flow + where to change it, from the prefetched cluster model"
```

---

### Task 7: `/cluster` — flow edges, telemetry toggle, where-to-change panel (devops-ai-agent dashboard)

**Files:**
- Modify:
  - `devops-ai-agent/src/dashboard/cluster-types.ts` (the structural model mirror);
  - `devops-ai-agent/src/dashboard/cluster-graph.ts` (calls/depends edges);
  - `devops-ai-agent/src/dashboard/client/cluster-layout.ts` (edge styles);
  - `devops-ai-agent/src/dashboard/client/cluster.tsx` (toggle, panel, read the model);
  - `devops-ai-agent/src/dashboard/views.ts` (`clusterFrame`/`clusterPage` embed the model, unknowns, the computing note);
  - `devops-ai-agent/src/dashboard/server.ts` (a 5th constructor dependency);
  - `devops-ai-agent/index.ts` (wire `() => agent.peekClusterModel()`);
  - `devops-ai-agent/CLAUDE.md` (gotcha bullet).
- Test:
  - `devops-ai-agent/src/dashboard/cluster-graph.test.ts` (extend);
  - `devops-ai-agent/src/dashboard/views.test.ts` (extend);
  - `devops-ai-agent/src/dashboard/cluster-types.check.test.ts` (new).

**Interfaces:**
- Consumes: `ClusterModel` (agent type, used ONLY by the check test).
- Produces:
  - `DashboardClusterModel` in `cluster-types.ts`, a field-for-field structural copy of `ClusterModel`, with no imports;
  - `buildClusterGraph(inv, expanded, showSystem, model: DashboardClusterModel | null = null, showTelemetry = false)`;
  - `ClusterEdge.kind`: `"routes" | "manages" | "calls" | "depends"`;
  - `clusterPage(inv, error, openIncidents?, nonce = "", assets = null, model: DashboardClusterModel | null = null)`.

- [ ] **Step 1: Invoke the UI skill**

Invoke `ui-ux-pro-max:ui-ux-pro-max` with the Skill tool before any markup or CSS. Read `src/dashboard/CLAUDE.md`.

- [ ] **Step 2: Write the failing tests**

`cluster-types.check.test.ts`:

```ts
import { test } from "node:test";
import type { ClusterModel } from "../agent/onboarding/types.js";
import type { DashboardClusterModel } from "./cluster-types.js";

// The dashboard never imports agent types at runtime; this compile-time check is what keeps the
// structural mirror honest — tsc fails here if the two drift apart.
test("the dashboard's model mirror accepts the agent's model", () => {
  const assign = (m: ClusterModel): DashboardClusterModel => m;
  void assign;
});
```

Append to `cluster-graph.test.ts`. Reuse its existing inventory fixture if it has `sample-apps` with `checkout-gateway` and `orders-api` workloads; otherwise build one inline in the file's style. Add `MODEL` as in Task 6:

```ts
test("model edges join only an expanded namespace; telemetry hidden unless asked; a cross-namespace target gets a card in this panel", () => {
  const g = buildClusterGraph(INV, new Set(["ns/sample-apps"]), false, MODEL);
  assert.ok(g.edges.some((e) => e.kind === "calls" && e.source === "wl/sample-apps/checkout-gateway" && e.target === "wl/sample-apps/orders-api"));
  assert.ok(g.edges.some((e) => e.kind === "depends" && e.target === "svc/postgresql/postgresql"));
  const pg = g.nodes.find((n) => n.id === "svc/postgresql/postgresql");
  assert.equal(pg?.data.namespace, "sample-apps");
  assert.equal(pg?.data.label, "postgresql/postgresql");
  assert.ok(!g.edges.some((e) => e.target === "svc/monitoring/jaeger"));
  assert.ok(buildClusterGraph(INV, new Set(["ns/sample-apps"]), false, MODEL, true).edges.some((e) => e.target === "svc/monitoring/jaeger"));
  assert.ok(!buildClusterGraph(INV, new Set(), false, MODEL).edges.some((e) => e.kind === "calls"), "a collapsed namespace draws no flow");
});
```

Append to `views.test.ts`, using its existing cluster fixtures and fake assets; check how the existing `clusterPage` tests build them:

```ts
test("clusterPage embeds the model and its unknowns, or says the flow is still being computed", () => {
  const model = { ...MODEL, unknowns: ["call graph unavailable (Prometheus) — no observed calls are shown"] };
  const withModel = clusterPage(INV, null, undefined, "n", ASSETS, model);
  assert.match(withModel, /id="cluster-model"/);
  assert.match(withModel, /call graph unavailable/);
  const without = clusterPage(INV, null, undefined, "n", ASSETS, null);
  assert.match(without, /Request flow is being computed — reload in a few seconds/);
  assert.doesNotMatch(without, /id="cluster-model"/);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/dashboard/cluster-graph.test.ts src/dashboard/views.test.ts; npx tsc --noEmit`
Expected: FAIL, and tsc errors because `DashboardClusterModel` does not exist.

- [ ] **Step 4: Implement**

`cluster-types.ts`: append `DashboardClusterModel`, written out field for field from `onboarding/types.ts` `ClusterModel`, including `GitKey`, `ModelNode`, `ModelEdge` and `Evidence` under dashboard-local names, with no imports. A comment points at `cluster-types.check.test.ts`.

`cluster-graph.ts`:
- import `DashboardClusterModel`;
- widen `ClusterEdge.kind`;
- add the params `model: DashboardClusterModel | null = null, showTelemetry = false`;
- after the namespace loop, before `return`:

```ts
  // The cluster model's flow (spec 2026-10-16-cluster-onboarding-flow §4): only inside an OPEN
  // namespace, from its workloads. A target in another namespace gets a card in THIS panel — its id
  // unchanged, its label naming its namespace — because the panel it lives in may be closed.
  for (const e of model?.edges ?? []) {
    if (e.kind === "routes" || (e.role === "telemetry" && !showTelemetry)) continue;
    const from = nodes.get(e.from);
    if (!from || from.data.kind !== "workload" || !expanded.has(nsId(from.data.namespace))) continue;
    const ns = from.data.namespace;
    if (!nodes.has(e.to)) {
      const t = model!.nodes.find((n) => n.id === e.to);
      if (!t || t.kind === "host") continue;
      const local = t.namespace === ns;
      node(e.to, { kind: t.kind === "workload" ? "workload" : "service", label: local ? t.name : `${t.namespace}/${t.name}`, namespace: ns, ...(local ? {} : { sub: "other namespace" }) });
    }
    edge(e.kind, e.from, e.to);
  }
```

`client/cluster-layout.ts`: import `MarkerType` from `@xyflow/react`, and in the edges map after the existing `manages` spread add:

```ts
    // calls: solid, arrowhead caller → callee, and a curve — both ends sit in the workload lane,
    // where a smoothstep between two cards in one column loops around both of them.
    ...(e.kind === "calls" ? { type: "default", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "var(--accent)" } } : {}),
    // depends: DOTTED (`manages` already owns the dash); the panel and the tables name the env var.
    ...(e.kind === "depends" ? { type: "default", style: { strokeDasharray: "2 4", stroke: "var(--mark-info)" } } : {}),
```

A cross-namespace Service card is `kind: "service"`, so it lands in the service lane, and the layout's last-resort slot loop gives it a row.

`client/cluster.tsx`:
- read `cluster-model` like `cluster-data`; a missing or invalid block → `null`. Pass it to `ClusterMap` as `model`;
- add `const [showTelemetry, setShowTelemetry] = useState(false)` and `const [selected, setSelected] = useState<string | null>(null)`;
- `buildClusterGraph(inv, expanded, showSystem, model, showTelemetry)`, with the `useMemo` deps extended;
- a second checkbox "Show telemetry", next to the system one, rendered only when `model` is non-null;
- `<ReactFlow … onNodeClick={(_, n) => { if (n.data.kind === "workload") setSelected(n.id); }}>`;
- below the map frame and before the legend, render when `selected && model`: an `<aside aria-label="Where to change">` containing
  - the workload name as a heading;
  - for each of `image`/`replicas` in `model.changeAt[selected]`: `path:line` in `<code>`, the key in `<code>`, the Git value, and a warning-toned "drift" badge when `drift`;
  - `Flux applied {appliedRevision ?? "unknown"} · repo {repoRevision?.slice(0, 7) ?? "unknown"}`;
  - "Not located in Git — see the notes under the map" when there is no entry;
  - a close `<button aria-label="Close">✕</button>` that sets `selected` to null.

  Use the existing Tailwind tokens (`text-muted-foreground`, `border-[var(--border)]`, `bg-card`).
- legend: add a `calls` item (solid `--accent` line) and a `configured dependency` item (dotted `--mark-info` line).

`views.ts`:
- `clusterFrame(inv, nonce, assets, model: DashboardClusterModel | null)` adds `jsonBlock("cluster-model", nonce, model)` when `model` is non-null;
- `clusterPage` gains the last parameter `model: DashboardClusterModel | null = null`;
- right after the frame:
  - with a model and unknowns: `<p class="meta"><strong>Not known</strong></p><ul class="meta">${model.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`;
  - with no model: `<p class="meta">Request flow is being computed — reload in a few seconds.</p>`.

`server.ts`:
- a 5th constructor parameter `clusterModel?: () => unknown`, stored in a field;
- in the `cluster` route: `const model = (this.clusterModel?.() ?? null) as DashboardClusterModel | null;`, passed as `clusterPage`'s last argument.

`index.ts` (repo root): add `() => agent.peekClusterModel()` as the 5th `DashboardServer` argument.

`devops-ai-agent/CLAUDE.md`, one gotcha bullet after the cluster-tour bullet:

> **The onboarding cluster model is gathered by code with typed evidence, never by the model** (`agent/onboarding/`, spec `docs/superpowers/specs/2026-10-16-cluster-onboarding-flow-design.md`, adapted from archify's repository authoring).
> - Edges: `routes` (declared, k8s), `calls` (observed, the call-graph PromQL), `depends` (configured, env NAMES; the inventory never returns a value).
> - Where-to-change comes from the worker's batched read-only `locate`, pinned to the repo head and compared with Flux's applied revision.
> - A source that could not be read is an `unknowns` line, never an empty edge set.
> - Cached 5 min per namespace scope; `/cluster` peeks and never waits.
> - The tour prefetches it (like the change timeline, so replay never runs it) and posts Request flow + Where to change it as two one-table messages.

- [ ] **Step 5: Run the tests, the full suite, tsc and the build**

Run: `cd devops-ai-agent && npx tsx --test src/dashboard/cluster-graph.test.ts src/dashboard/views.test.ts src/dashboard/cluster-types.check.test.ts && npm test > /tmp/claude-1000/agent-ob7.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-ob7.log; npx tsc --noEmit && npm run build 2>&1 | tail -2 && echo BUILD_OK`
Expected: pass, the suite `fail 0`, `BUILD_OK`.

- [ ] **Step 6: Browser check (required)**

Playwright is in `~/.render-check`, and the driver script must run with its cwd there.
- Boot `DashboardServer` on a spare port with a stub `inventory` (a detail inventory JSON shaped like Task 4's `INV`) and a stub `clusterModel` (the Task 6 `MODEL`, plus routes). Mint a cookie with `mintSession()`. Write the scripts as `*.tmp.ts` in the repo root and delete them afterwards.
- Load `/cluster`, expand `sample-apps`, and click `orders-api`.
- Save four screenshots under `/tmp/claude-1000/ob7-shots/`: desktop light, desktop dark, phone 390px light, phone dark.
- Assert:
  - one edge terminates at the `orders-api` node from `checkout-gateway`. Count edges at the node, scoped to `.react-flow__edge`; React Flow silently drops an edge whose endpoint it cannot find;
  - an edge reaches the `postgresql/postgresql` card;
  - the panel shows `release.yaml:7`;
  - there is no horizontal page scroll at 390px.
- LOOK at every screenshot (Read the PNG) and fix what reads badly: a `calls` curve buried under cards, the panel overflowing on a phone, dark-mode contrast.

- [ ] **Step 7: Commit**

```bash
cd devops-ai-agent && git add src/dashboard index.ts CLAUDE.md && git commit -m "feat(dashboard): /cluster draws observed calls and configured dependencies, with a where-to-change panel"
```

---

### Task 8: Spec update, deploy, live check (controller)

Run by the controller after the final review.

- [ ] **Step 1: Bring the spec in line with the rulings**

Edit `docs/superpowers/specs/2026-10-16-cluster-onboarding-flow-design.md` in place, applying the six rulings in Global Constraints:
- §2: `locate` is batched (`targets`).
- §3: `fluxRevisions` is cluster-wide; the "regenerated once" line becomes "the existing ungrounded-names warning, with the model text as evidence".
- §4: `depends` is dotted; the map fills in on reload.
- §1: Services are matched cluster-wide.

Add the workspace `CLAUDE.md` contract sentence, after the `revert_pr` sentence in the agent ↔ llm-worker GitOps bullet:

> A fifth op, `locate` — `{ requestId, op: "locate", targets: [{ name, namespace, current: { image?, replicas? }, component? }], pathPrefix? }` → `{ ok: true, op: "locate", revision, releases: [{ name, namespace, files, keys: { image?, replicas?: { path, line, key, gitValue, drift } }, notes }] }` — is read-only and batched (one listing per prefix), reads fresh, and notes ambiguity instead of guessing.

Commit the spec: `git add docs/superpowers/specs/2026-10-16-cluster-onboarding-flow-design.md && git commit -m "docs(spec): onboarding — batched locate, cluster-wide revisions, warning not rewrite"`.

- [ ] **Step 2: Push the three repos and wait for their image builds**

```bash
cd devops-mcp-server && git pull --rebase origin main && git push origin main
cd ../devops-ai-agent-worker && git pull --rebase origin main && git push origin main
cd ../devops-ai-agent && git pull --rebase --autostash origin main && git push origin main
```

Wait for each repo's latest GH Actions run (`gh run view <id> --json status,conclusion`). Then:
```bash
kubectl -n devops-tools rollout restart deploy/devops-mcp-server deploy/devops-llm-worker deploy/devops-ai-agent
```
Wait for all three rollouts, and check the agent pod's `GIT_SHA`.

- [ ] **Step 3: Live checks**

1. **`/cluster`.** Open it twice, about 10 s apart, so the background build finishes. Expected:
   - `checkout-gateway → orders-api` and `storefront → checkout-gateway` as `calls` edges;
   - `orders-api` dotted to `postgresql/postgresql`;
   - clicking `orders-api` shows a replicas `path:line` in the GitOps repo;
   - the unknowns list names anything not read.
2. **No values leak.** Fetch `/cluster` with a session cookie and grep the embedded `cluster-model` JSON for the literal secret *names* that live in `orders-api`'s env (`orders-api-secret`, `loadgen-secret`): expect 0. Grep it for `DB_HOST`: expect >0, because env names do appear. Do not print any value.
3. **Ask the user** to post `@agent jelasin sample-apps` in Slack. Expect, in order:
   - the inventory tables;
   - **Request flow**, with `checkout-gateway → orders-api` observed and `orders-api → postgresql/postgresql` configured `DB_HOST`;
   - **Where to change it**;
   - the reply.

   Read the agent log for `[onboarding]` and `flow table refused` lines.

Report the push ranges, the three results, and any unknowns line that looks wrong.
