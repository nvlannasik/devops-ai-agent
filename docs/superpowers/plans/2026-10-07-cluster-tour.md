# Cluster Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A newcomer asks the agent in Slack what runs in the cluster and how it is deployed, and gets a grounded answer; `/cluster` on the dashboard shows the same inventory with no LLM.

**Architecture:** One new read tool in `devops-mcp-server`, `k8s_cluster_inventory`, returns the whole cluster's workloads, owners, Services, Ingresses and CronJobs in one call (modelled on `k8s_cluster_health`). The agent routes tour questions (`wantsTour`) to conversation mode with their own tool budget through ONE shared `mentionBudget()` used by both the app and the bench, loads a `cluster-tour` skill, and suppresses remediation cards for tours. The dashboard renders the same tool output deterministically.

**Tech Stack:** TypeScript ESM (NodeNext), Node 24, `node:test` + tsx, `@kubernetes/client-node` (mcp-server), zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-cluster-tour-design.md`

## Global Constraints

- Node 24; TypeScript ESM; tests are `*.test.ts` with `node:test` + tsx; no new dependencies.
- Docs, comments and `CLAUDE.md`/`MEMORY_BANK.md` in English; chat in Indonesian.
- Depth is "inventory + how it is deployed" — no request flow, no troubleshooting pointers, no write action.
- `managedBy` comes from the SAME label reader the GitOps guard uses (`gitOpsVerdict` in `devops-mcp-server/src/tools/kubernetes/guardrails.ts`).
- The inventory payload carries no ConfigMap/Secret contents, no env values, no annotation text.
- A skill other than `rca-format` must never key on the `[mode:…]` tag (`skills/real.test.ts`).
- The app and the bench must choose the mention tool budget through the same function.
- Optional string tool params accept `""` as omitted (`blankToUndefined`).
- Push to `main` is authorized; deploy = wait for the "Build & Push Docker Images" run of the commit, then `kubectl -n devops-tools rollout restart deploy/<name>`.
- Dashboard UI work: ui-ux-pro-max skill first, browser check (desktop, phone, dark) via `~/.render-check`.

## Review Focus

1. A namespace with no workloads at all (only a ConfigMap) — inventory returns it with empty arrays, the dashboard renders "Nothing deployed here", the skill does not invent one. Tests in Task 1 and Task 6.
2. RBAC refuses the Kustomization CR list — the tool still succeeds, `path` is simply absent. Test in Task 1.
3. "jelasin kenapa storefront crash" mixes tour and investigation vocabulary — it must route as an investigation, not a tour. Test in Task 2.
4. A tour of a namespace holding a 0/2-ready Deployment must not produce a card. Test in Task 3.
5. A scan that hits the ceiling (`complete: false`) — the dashboard shows a "partial" note rather than reading as the whole cluster. Test in Task 6.

---

### Task 1: `k8s_cluster_inventory` (devops-mcp-server)

**Files:**
- Modify: `devops-mcp-server/src/tools/kubernetes/guardrails.ts` (Kustomization identity on the verdict), `guardrails.test.ts`
- Create: `devops-mcp-server/src/tools/kubernetes/handlers/inventory.ts`
- Create: `devops-mcp-server/src/tools/kubernetes/handlers/inventory.test.ts`
- Modify: `devops-mcp-server/src/tools/kubernetes/handlers/index.ts` (export)
- Modify: `devops-mcp-server/src/tools/kubernetes/index.ts` (register the tool after `k8s_cluster_health`)
- Modify: `devops-mcp-server/README.md` (tool table row)

**Interfaces:**
- Produces: tool `k8s_cluster_inventory`, input `{ namespace?: string }`, output JSON:
  `{ scanned: { namespaces: number, complete: boolean }, namespaces: Array<{ name: string, system: boolean, workloads: Array<{ kind: "Deployment"|"StatefulSet"|"DaemonSet"|"CronJob", name: string, ready: number|null, desired: number|null, images: string[], managedBy: ManagedBy, schedule?: string }>, services: Array<{ name: string, type: string, ports: string[] }>, ingresses: Array<{ name: string, hosts: string[] }> }> }`
  where `ManagedBy = { type: "helmrelease", name: string, namespace: string, chart?: string } | { type: "kustomization", name: string, namespace: string, path?: string } | { type: "helm", chart?: string } | { type: "unmanaged" }`.
- Produces: `shapeInventory(input: InventoryInput): Inventory` (pure, exported for tests).

- [ ] **Step 1: Give the Kustomization verdict its identity**

In `guardrails.ts`, extend the `GitOpsVerdict` managed branch with `kustomization?: { name: string; namespace: string }` and set it in the `kustomize.toolkit.fluxcd.io/name` branch:

```ts
      source: "flux-kustomization",
      kustomization: { name: ksName, namespace },
```

Add to `guardrails.test.ts` inside the existing "Kustomize and plain Helm" test:

```ts
  assert.deepEqual(ks.managed && ks.kustomization, { name: "apps", namespace: "flux-system" });
```

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/guardrails.test.ts`
Expected: FAIL before the edit (property missing), PASS after.

- [ ] **Step 2: Write the failing inventory tests** — `inventory.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeInventory } from "./inventory.js";

const meta = (ns: string, name: string, labels: Record<string, string> = {}) => ({ metadata: { namespace: ns, name, labels } });
const base = {
  namespaces: ["sample-apps", "kube-system", "empty"],
  deployments: [
    { ...meta("sample-apps", "storefront", { "helm.toolkit.fluxcd.io/name": "storefront", "helm.toolkit.fluxcd.io/namespace": "flux-app", "helm.sh/chart": "storefront-0.3.1" }),
      spec: { replicas: 2, template: { spec: { containers: [{ name: "web", image: "ghcr.io/x/storefront:1.4.2", env: [{ name: "SECRET", value: "s3cret" }] }] } } },
      status: { readyReplicas: 1 } },
    { ...meta("kube-system", "coredns"), spec: { replicas: 1, template: { spec: { containers: [{ name: "c", image: "coredns:1.11" }] } } }, status: { readyReplicas: 1 } },
  ],
  statefulsets: [
    { ...meta("sample-apps", "db", { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" }),
      spec: { replicas: 1, template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } }, status: { readyReplicas: 1 } },
  ],
  daemonsets: [],
  cronjobs: [{ ...meta("sample-apps", "nightly", { "app.kubernetes.io/managed-by": "Helm", "helm.sh/chart": "jobs-1.0.0" }),
    spec: { schedule: "0 2 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "j", image: "busybox:1.36" }] } } } } } }],
  services: [{ ...meta("sample-apps", "storefront"), spec: { type: "ClusterIP", ports: [{ port: 80, protocol: "TCP", targetPort: 3000 }] } }],
  ingresses: [{ ...meta("sample-apps", "storefront"), spec: { rules: [{ host: "shop.example.com" }] } }],
  kustomizations: [{ metadata: { name: "apps", namespace: "flux-system" }, spec: { path: "./apps/dev" } }] as Array<{ metadata: { name: string; namespace: string }; spec?: { path?: string } }> | null,
  complete: true,
};

test("every owner type is read with the GitOps guard's own reader", () => {
  const ns = shapeInventory(base).namespaces.find((n) => n.name === "sample-apps")!;
  const by = Object.fromEntries(ns.workloads.map((w) => [w.name, w.managedBy]));
  assert.deepEqual(by.storefront, { type: "helmrelease", name: "storefront", namespace: "flux-app", chart: "storefront-0.3.1" });
  assert.deepEqual(by.db, { type: "kustomization", name: "apps", namespace: "flux-system", path: "./apps/dev" });
  assert.deepEqual(by.nightly, { type: "helm", chart: "jobs-1.0.0" });
  const core = shapeInventory(base).namespaces.find((n) => n.name === "kube-system")!;
  assert.deepEqual(core.workloads[0]!.managedBy, { type: "unmanaged" });
  assert.equal(core.system, true);
});

test("counts, images, ports, hosts and schedules — and nothing from env", () => {
  const out = shapeInventory(base);
  const ns = out.namespaces.find((n) => n.name === "sample-apps")!;
  const sf = ns.workloads.find((w) => w.name === "storefront")!;
  assert.deepEqual([sf.kind, sf.ready, sf.desired, sf.images], ["Deployment", 1, 2, ["ghcr.io/x/storefront:1.4.2"]]);
  assert.deepEqual(ns.services, [{ name: "storefront", type: "ClusterIP", ports: ["80/TCP→3000"] }]);
  assert.deepEqual(ns.ingresses, [{ name: "storefront", hosts: ["shop.example.com"] }]);
  assert.equal(ns.workloads.find((w) => w.name === "nightly")!.schedule, "0 2 * * *");
  assert.doesNotMatch(JSON.stringify(out), /s3cret|SECRET/);
});

test("a namespace with nothing deployed is listed with empty arrays, not dropped", () => {
  const empty = shapeInventory(base).namespaces.find((n) => n.name === "empty")!;
  assert.deepEqual([empty.workloads, empty.services, empty.ingresses], [[], [], []]);
});

test("unreadable Kustomizations leave the path absent, never guessed", () => {
  const ns = shapeInventory({ ...base, kustomizations: null }).namespaces.find((n) => n.name === "sample-apps")!;
  assert.deepEqual(ns.workloads.find((w) => w.name === "db")!.managedBy, { type: "kustomization", name: "apps", namespace: "flux-system" });
});

test("system namespaces sort last, and complete:false survives to the caller", () => {
  const out = shapeInventory({ ...base, complete: false });
  assert.deepEqual(out.scanned, { namespaces: 3, complete: false });
  assert.equal(out.namespaces.at(-1)!.name, "kube-system");
});
```

Run: `cd devops-mcp-server && npx tsx --test src/tools/kubernetes/handlers/inventory.test.ts`
Expected: FAIL — `Cannot find module './inventory.js'`.

- [ ] **Step 3: Implement `inventory.ts`**

```ts
import { z } from "zod";
import { getApi, k8s, listAll } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { blankToUndefined } from "../schemas.js";
import { gitOpsVerdict } from "../guardrails.js";

// The whole cluster's workloads, their owners and what they expose, in ONE call — the onboarding
// counterpart of k8s_cluster_health. Every other list tool is per-namespace, so "what runs here"
// cost one call per namespace per kind. Names, counts, images, ports and hosts only: no env, no
// ConfigMap/Secret content, no annotation text — small, and nothing in it is free text to inject.

const SYSTEM = new Set(["kube-system", "kube-public", "kube-node-lease", "flux-system"]);

type Labels = Record<string, string> | undefined;
interface Obj { metadata?: { name?: string; namespace?: string; labels?: Labels } }
interface PodSpecHolder { spec?: { containers?: Array<{ image?: string }> } }
interface WorkloadObj extends Obj { spec?: { replicas?: number; template?: PodSpecHolder }; status?: { readyReplicas?: number; numberReady?: number; desiredNumberScheduled?: number } }
interface CronObj extends Obj { spec?: { schedule?: string; jobTemplate?: { spec?: { template?: PodSpecHolder } } } }
interface ServiceObj extends Obj { spec?: { type?: string; ports?: Array<{ port?: number; protocol?: string; targetPort?: number | string }> } }
interface IngressObj extends Obj { spec?: { rules?: Array<{ host?: string }> } }
interface KustomizationObj { metadata: { name: string; namespace: string }; spec?: { path?: string } }

export type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };

export interface InventoryWorkload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";
  name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string;
}

export interface InventoryInput {
  namespaces: string[];
  deployments: WorkloadObj[];
  statefulsets: WorkloadObj[];
  daemonsets: WorkloadObj[];
  cronjobs: CronObj[];
  services: ServiceObj[];
  ingresses: IngressObj[];
  /** null = the CR list was refused (RBAC) — paths are then absent, not guessed. */
  kustomizations: KustomizationObj[] | null;
  complete: boolean;
}

function managedBy(labels: Labels, paths: Map<string, string>): ManagedBy {
  const v = gitOpsVerdict(labels, "");
  const chart = labels?.["helm.sh/chart"];
  if (!v.managed) return { type: "unmanaged" };
  if (v.source === "flux-helmrelease" && v.helmRelease) return { type: "helmrelease", ...v.helmRelease, ...(chart ? { chart } : {}) };
  if (v.source === "flux-kustomization" && v.kustomization) {
    const path = paths.get(`${v.kustomization.namespace}/${v.kustomization.name}`);
    return { type: "kustomization", ...v.kustomization, ...(path ? { path } : {}) };
  }
  return { type: "helm", ...(chart ? { chart } : {}) };
}

const images = (t: PodSpecHolder | undefined): string[] =>
  [...new Set((t?.spec?.containers ?? []).map((c) => c.image).filter((i): i is string => !!i))];

export function shapeInventory(input: InventoryInput) {
  const paths = new Map(
    (input.kustomizations ?? []).filter((k) => k.spec?.path).map((k) => [`${k.metadata.namespace}/${k.metadata.name}`, k.spec!.path!] as const)
  );
  const byNs = new Map(
    input.namespaces.map((name) => [name, {
      name, system: SYSTEM.has(name),
      workloads: [] as InventoryWorkload[],
      services: [] as Array<{ name: string; type: string; ports: string[] }>,
      ingresses: [] as Array<{ name: string; hosts: string[] }>,
    }])
  );
  const at = (o: Obj) => byNs.get(o.metadata?.namespace ?? "");
  const owner = (o: Obj) => managedBy(o.metadata?.labels, paths);
  const workload = (kind: InventoryWorkload["kind"], o: WorkloadObj, ready: number, desired: number | null) =>
    at(o)?.workloads.push({ kind, name: o.metadata?.name ?? "", ready, desired, images: images(o.spec?.template), managedBy: owner(o) });
  for (const d of input.deployments) workload("Deployment", d, d.status?.readyReplicas ?? 0, d.spec?.replicas ?? null);
  for (const s of input.statefulsets) workload("StatefulSet", s, s.status?.readyReplicas ?? 0, s.spec?.replicas ?? null);
  for (const d of input.daemonsets) workload("DaemonSet", d, d.status?.numberReady ?? 0, d.status?.desiredNumberScheduled ?? null);
  for (const c of input.cronjobs)
    at(c)?.workloads.push({
      kind: "CronJob", name: c.metadata?.name ?? "", ready: null, desired: null,
      images: images(c.spec?.jobTemplate?.spec?.template), managedBy: owner(c), schedule: c.spec?.schedule,
    });
  for (const s of input.services)
    at(s)?.services.push({
      name: s.metadata?.name ?? "", type: s.spec?.type ?? "ClusterIP",
      ports: (s.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? "TCP"}${p.targetPort !== undefined && p.targetPort !== p.port ? `→${p.targetPort}` : ""}`),
    });
  for (const i of input.ingresses)
    at(i)?.ingresses.push({ name: i.metadata?.name ?? "", hosts: (i.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => !!h) });
  const namespaces = [...byNs.values()].sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
  return { scanned: { namespaces: namespaces.length, complete: input.complete }, namespaces };
}
export type Inventory = ReturnType<typeof shapeInventory>;

const InventoryInputSchema = z.object({ namespace: blankToUndefined(z.string().min(1).optional()) });

export const clusterInventory = (raw: unknown) => {
  const { namespace } = InventoryInputSchema.parse(raw);
  return withUpstream("kubernetes", "Failed to read the cluster inventory", async () => {
    const core = getApi(k8s.CoreV1Api), apps = getApi(k8s.AppsV1Api), batch = getApi(k8s.BatchV1Api), net = getApi(k8s.NetworkingV1Api);
    type P<T> = Promise<{ items: T[]; metadata?: { _continue?: string } }>;
    const scan = <T>(all: (o: { limit: number; _continue?: string }) => P<T>, one: (o: { namespace: string; limit: number; _continue?: string }) => P<T>) =>
      listAll<T>((o) => (namespace ? one({ ...o, namespace }) : all(o)));
    const [nsList, deps, sts, dss, crons, svcs, ings] = await Promise.all([
      namespace ? Promise.resolve({ items: [{ metadata: { name: namespace } }] as Obj[], complete: true }) : listAll<Obj>((o) => core.listNamespace(o) as P<Obj>),
      scan<WorkloadObj>((o) => apps.listDeploymentForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedDeployment(o) as P<WorkloadObj>),
      scan<WorkloadObj>((o) => apps.listStatefulSetForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedStatefulSet(o) as P<WorkloadObj>),
      scan<WorkloadObj>((o) => apps.listDaemonSetForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedDaemonSet(o) as P<WorkloadObj>),
      scan<CronObj>((o) => batch.listCronJobForAllNamespaces(o) as P<CronObj>, (o) => batch.listNamespacedCronJob(o) as P<CronObj>),
      scan<ServiceObj>((o) => core.listServiceForAllNamespaces(o) as P<ServiceObj>, (o) => core.listNamespacedService(o) as P<ServiceObj>),
      scan<IngressObj>((o) => net.listIngressForAllNamespaces(o) as P<IngressObj>, (o) => net.listNamespacedIngress(o) as P<IngressObj>),
    ]);
    // Best effort: the ServiceAccount may not read Flux CRs. Refused = no paths, never an error.
    const kustomizations = await getApi(k8s.CustomObjectsApi)
      .listCustomObjectForAllNamespaces({ group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations" })
      .then((r) => (r as { items?: KustomizationObj[] }).items ?? [])
      .catch(() => null);
    return shapeInventory({
      namespaces: nsList.items.map((n) => n.metadata?.name).filter((n): n is string => !!n),
      deployments: deps.items, statefulsets: sts.items, daemonsets: dss.items,
      cronjobs: crons.items, services: svcs.items, ingresses: ings.items,
      kustomizations,
      complete: [nsList, deps, sts, dss, crons, svcs, ings].every((l) => l.complete),
    });
  });
};
```

Executor note: the list-call option names follow `health.ts` (`{ namespace, limit, _continue }`), the shape verified in this repo; if `tsc` rejects one, match `health.ts` rather than casting further.

Export from `handlers/index.ts`: `export * from "./inventory.js";`

- [ ] **Step 4: Register the tool** — in `src/tools/kubernetes/index.ts`, directly after the `k8s_cluster_health` entry:

```ts
  {
    name: "k8s_cluster_inventory",
    description:
      "WHAT RUNS in the cluster and HOW it is deployed, in one call: per namespace the Deployments, StatefulSets, DaemonSets " +
      "and CronJobs (ready/desired, images), who manages each (Flux HelmRelease + chart, Flux Kustomization + path, plain " +
      "Helm, or unmanaged), Services with ports and Ingress hosts. USE THIS for onboarding and overview questions — " +
      "'what runs here', 'explain this cluster/namespace', 'how is X deployed'. Omit namespace for the whole cluster; " +
      "pass it to detail one namespace. Not for health: use k8s_cluster_health for 'is anything broken'. " +
      "If scanned.complete is false the scan hit its ceiling — say the inventory is partial.",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Optional — omit for the whole cluster (no default namespace)" } },
    },
    handler: h.clusterInventory,
  },
```

README tool-table row after `k8s_cluster_health`:

```
| `k8s_cluster_inventory` | **Whole-cluster inventory in ONE call** — per namespace the workloads (ready/desired, images), who manages each (`managedBy`: HelmRelease+chart / Kustomization+path / Helm / unmanaged, read with the GitOps guard's own label reader), Services+ports, Ingress hosts, CronJob schedules. No env, ConfigMap or Secret content. `scanned.complete` like `k8s_cluster_health`. Pass `namespace` to detail one |
```

- [ ] **Step 5: Run, build, commit, push**

Run: `cd devops-mcp-server && npm test && npm run build`
Expected: all pass, build exit 0.

```bash
git add src/tools/kubernetes/guardrails.ts src/tools/kubernetes/guardrails.test.ts src/tools/kubernetes/handlers/inventory.ts src/tools/kubernetes/handlers/inventory.test.ts src/tools/kubernetes/handlers/index.ts src/tools/kubernetes/index.ts README.md
git commit -m "feat(k8s): k8s_cluster_inventory — what runs and who manages it, cluster-wide in one call"
git push -u origin main
```

---

### Task 2: Tour routing and one shared mention budget (devops-ai-agent)

**Files:**
- Modify: `src/agent/intent/index.ts`, `src/agent/intent/index.test.ts`
- Modify: `src/config/index.ts` (`tourToolRounds`)
- Modify: `src/app/index.ts:331-334` (use `mentionBudget`)
- Modify: `src/bench/run.ts:158,172` (use `mentionBudget` per turn)

**Interfaces:**
- Produces: `wantsTour(text: string): boolean`; `mentionBudget(text: string, rounds: { mention: number; tour: number }): { maxToolRounds?: number }` — `{}` (unlimited) for an investigation, `{ maxToolRounds: rounds.tour }` for a tour, `{ maxToolRounds: rounds.mention }` otherwise.
- Produces: `config.tourToolRounds: number` (env `TOUR_TOOL_ROUNDS`, default 4).

- [ ] **Step 1: Failing tests** — append to `src/agent/intent/index.test.ts`, extend its import to `{ wantsInvestigation, wantsTour, mentionBudget }`:

```ts
test("tour questions are detected (en + id) and need explain vocabulary plus a subject", () => {
  for (const t of ["jelasin cluster ini dong", "jelaskan workload di namespace sample-apps", "workload apa aja yang jalan di cluster?",
                   "explain this cluster to me, I just joined", "give me an overview of the namespaces", "onboarding cluster dong",
                   "gambaran namespace devops-tools"]) assert.equal(wantsTour(t), true, t);
  for (const t of ["check status semua pod di devops-tools", "halo, kamu bisa apa?", "jelasin dong"]) assert.equal(wantsTour(t), false, t);
});

test("a tour sentence that asks why is an investigation, not a tour", () => {
  assert.equal(wantsTour("jelasin kenapa storefront crash di sample-apps"), false);
  assert.deepEqual(mentionBudget("jelasin kenapa storefront crash di sample-apps", { mention: 2, tour: 4 }), {});
});

test("one budget for every caller: investigation unlimited, tour its own, the rest the mention cap", () => {
  const r = { mention: 2, tour: 4 };
  assert.deepEqual(mentionBudget("investigate the 5xx spike", r), {});
  assert.deepEqual(mentionBudget("jelasin cluster ini", r), { maxToolRounds: 4 });
  assert.deepEqual(mentionBudget("show me services in monitoring", r), { maxToolRounds: 2 });
});
```

Run: `npx tsx --test src/agent/intent/index.test.ts`
Expected: FAIL — `wantsTour` is not exported.

- [ ] **Step 2: Implement** — append to `src/agent/intent/index.ts`:

```ts
// A newcomer's "what runs here" (spec 2026-10-07-cluster-tour). Explain vocabulary AND a subject —
// "jelasin dong" alone is a reply to the last turn, not a tour. An investigation wins: "jelasin
// kenapa X crash" asks why, and why is an investigation.
const TOUR_VERB = /\b(jelas\w*|explain\w*|describe|overview|gambaran|onboard\w*|walk ?me ?through|apa aja yang (jalan|ada)|what (runs|is running|'s running)|workload apa)\b/i;
const TOUR_SUBJECT = /\b(cluster|klaster|namespace\w*|workload\w*|deploy\w*|service\w*|apa aja|what runs|onboard\w*)\b/i;

export function wantsTour(text: string): boolean {
  return !wantsInvestigation(text) && TOUR_VERB.test(text) && TOUR_SUBJECT.test(text);
}

/** The tool budget for one mention — the app and the bench both call this, so they cannot drift. */
export function mentionBudget(text: string, rounds: { mention: number; tour: number }): { maxToolRounds?: number } {
  if (wantsInvestigation(text)) return {};
  return { maxToolRounds: wantsTour(text) ? rounds.tour : rounds.mention };
}
```

`src/config/index.ts`, beside `mentionToolRounds`:

```ts
  // tool rounds for a cluster-tour mention (agent/intent wantsTour) — one inventory call covers the
  // overview; the rest are for a drill-down or a Flux CR the model wants to read
  tourToolRounds: parseInt(process.env.TOUR_TOOL_ROUNDS ?? "4"),
```

- [ ] **Step 3: Route both callers through it**

`src/app/index.ts` — replace

```ts
    const investigation = wantsInvestigation(text);
    const budget = investigation ? {} : { maxToolRounds: config.mentionToolRounds };
```

with

```ts
    const investigation = wantsInvestigation(text);
    const budget = mentionBudget(text, { mention: config.mentionToolRounds, tour: config.tourToolRounds });
```

(import `mentionBudget` beside `wantsInvestigation`; keep `investigation` if later code reads it, delete it if `tsc --noUnusedLocals` complains).

`src/bench/run.ts` — replace the line-158 budget with a per-turn function and use it for the follow-up:

```ts
  const rounds = { mention: config.mentionToolRounds, tour: config.tourToolRounds };
  const budgetFor = (text: string) => (task.mode === "conversation" ? mentionBudget(text, rounds) : {});
  const budget = budgetFor(task.message ?? "");
```

and in the follow-up call `{ ...budgetFor(task.followUp!), mode: task.mode }`.

- [ ] **Step 4: Run, commit**

Run: `npx tsx --test src/agent/intent/index.test.ts && npx tsc --noEmit -p . && npm test`
Expected: all pass.

```bash
git add src/agent/intent/index.ts src/agent/intent/index.test.ts src/config/index.ts src/app/index.ts src/bench/run.ts
git commit -m "feat(intent): wantsTour + one mentionBudget for the app and the bench"
```

---

### Task 3: No remediation card from a tour

**Files:**
- Modify: `src/agent/remediation/proposal.ts` (`worthProposing`, `explainGate`)
- Test: `src/agent/remediation/index.test.ts`

**Interfaces:**
- Consumes: `wantsTour` from Task 2.

- [ ] **Step 1: Failing test** — append to `src/agent/remediation/index.test.ts`:

```ts
// spec 2026-10-07-cluster-tour §3.4: an inventory says "0/2 ready" in the words a fault report uses.
test("a tour reply listing a not-ready workload does not propose", () => {
  const reply = "*sample-apps* — `storefront` Deployment, 0/2 ready, CrashLoopBackOff on both pods; managed by HelmRelease `flux-app/storefront`.";
  const g = worthProposing("jelasin namespace sample-apps", reply, false);
  assert.equal(g.propose, false);
  assert.match(g.reason, /tour/);
  // an explicit request still proposes
  assert.equal(worthProposing("restart storefront di sample-apps", reply, false).propose, true);
});
```

Run: `npx tsx --test src/agent/remediation/index.test.ts`
Expected: FAIL — `propose` is true via the fault-evidence branch.

- [ ] **Step 2: Implement** — in `worthProposing`, inside `if (hit)`, directly after the `CAPACITY_QUESTION` block:

```ts
    // Same reasoning for a cluster tour (agent/intent wantsTour): an inventory reports state, it
    // does not diagnose it, and a newcomer asking "what runs here" never asked for a change.
    if (wantsTour(userText)) {
      return { propose: false, reason: `cluster tour — "${hit[0]}" is inventory, not a fault to repair`, byUser: false };
    }
```

Import `wantsTour` from `../intent/index.js`. In `explainGate`, add `tour=${b(wantsTour(userText))} ` beside `capacity=…`.

- [ ] **Step 3: Run, commit**

Run: `npx tsx --test src/agent/remediation/index.test.ts && npm test`
Expected: all pass.

```bash
git add src/agent/remediation/proposal.ts src/agent/remediation/index.test.ts
git commit -m "fix(proposal): a cluster tour never produces a remediation card"
```

---

### Task 4: The `cluster-tour` skill

**Files:**
- Create: `prompts/skills/cluster-tour.md`
- Modify: `src/agent/skills/real.test.ts` (selection agreement test)

**Interfaces:**
- Consumes: `wantsTour` (Task 2), tool `k8s_cluster_inventory` (Task 1).

- [ ] **Step 1: Failing test** — append to `src/agent/skills/real.test.ts` (import `wantsTour` from `../intent/index.js`). Read how the file's `namesFor(mode)` builds a trigger and selects; define `selectedFor(text, mode)` next to it doing the same with `text` in place of the fixed trigger:

```ts
test("every sentence wantsTour accepts also selects cluster-tour", () => {
  const sentences = ["jelasin cluster ini dong", "workload apa aja yang jalan di cluster?", "explain this cluster to me, I just joined",
                     "gambaran namespace devops-tools", "onboarding cluster dong"];
  for (const s of sentences) {
    assert.equal(wantsTour(s), true, s);
    assert.ok(selectedFor(s, "conversation").includes("cluster-tour"), `cluster-tour not selected for: ${s}`);
  }
});
```

Run: `npx tsx --test src/agent/skills/real.test.ts`
Expected: FAIL — no skill named `cluster-tour`.

- [ ] **Step 2: Write the skill** — `prompts/skills/cluster-tour.md`:

```markdown
---
name: cluster-tour
description: Onboarding — what runs in the cluster and how each workload is deployed, from one inventory call
when: jelas\w* [^\n]{0,30}(cluster|klaster|namespace|workload|deploy|service)|explain\w* [^\n]{0,20}(cluster|namespace|workload)|overview|gambaran|onboard\w*|walk ?me ?through|apa aja yang (jalan|ada)|what (runs|is running|'s running)|workload apa
---

Someone new is asking what runs here and how it gets deployed. They cannot tell an invented name
from a real one, so every name in the answer comes from a tool result — and the inventory is one call.

1. *Overview* (no namespace named): `k8s_cluster_inventory` with no namespace. One block per
   namespace: the workloads (kind + name), who manages them, what they expose (Ingress hosts). A
   namespace whose `system` is true collapses into one closing line naming them.
2. *Detail* (a namespace named, usually the follow-up): `k8s_cluster_inventory namespace=<ns>`.
   Per workload: kind, image, ready/desired, its Services and ports, Ingress hosts, a CronJob's
   schedule, and where it is deployed from — HelmRelease `<ns>/<name>` with its chart, Kustomization
   `<ns>/<name>` with its path, plain Helm with its chart, or *not managed by GitOps*. Unmanaged on a
   GitOps cluster is worth saying plainly: it is the thing a newcomer should not copy.
3. Two labelled parts, always: *Terbaca* — what the tool returned, names in backticks exactly as
   returned — and *Dugaan fungsi* — what a workload is probably FOR, inferred from its name, image or
   labels, every line marked as a guess. Never state a purpose outside that part.
4. `scanned.complete` false: say the inventory is partial before anything else.
5. Health is not the question: a not-ready count is reported as a number, not diagnosed. Do not
   offer a change. End with what they can ask next — a namespace to detail, or `k8s_cluster_health`
   if something looked wrong.

Plain Slack mrkdwn: `*bold*` section lines and `•` bullets, no `#` headings, no tables.
```

- [ ] **Step 3: Run, commit**

Run: `npx tsx --test src/agent/skills/real.test.ts && npm test`
Expected: all pass, including "none matches the mode tag by accident".

```bash
git add prompts/skills/cluster-tour.md src/agent/skills/real.test.ts
git commit -m "feat(skills): cluster-tour — onboarding from one inventory call, read vs guessed kept apart"
git push -u origin main
```

---

### Task 5: Deploy, then bench cases D01/D02

**Files:**
- Create: `bench/cases/D01-tour-overview/{case.json,setup.sh,cleanup.sh}`
- Create: `bench/cases/D02-tour-namespace-detail/{case.json,setup.sh,cleanup.sh}`

**Interfaces:**
- Consumes: deployed `k8s_cluster_inventory` (Task 1), routing + skill (Tasks 2–4).

- [ ] **Step 1: Deploy** — wait for "Build & Push Docker Images" of Task 1's commit (`devops-mcp-server`) and of Task 4's push (`devops-ai-agent`); `kubectl -n devops-tools rollout restart deploy/devops-mcp-server deploy/devops-ai-agent`; wait for both rollouts.
Expected: the agent pod's `GIT_SHA` is Task 4's commit; `kubectl -n devops-tools exec deploy/devops-mcp-server -- grep -c k8s_cluster_inventory dist/src/tools/kubernetes/index.js` ≥ 1.

- [ ] **Step 2: `D01-tour-overview`** — `setup.sh` (same shape as the other cases: `set -euo pipefail`, recreate the namespace, wait for the fault to land):

```bash
#!/usr/bin/env bash
set -euo pipefail
NS="bench-d01"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: catalog-api, labels: { app: catalog-api } }
spec:
  replicas: 1
  selector: { matchLabels: { app: catalog-api } }
  template:
    metadata: { labels: { app: catalog-api } }
    spec: { containers: [{ name: api, image: "nginx:1.27-alpine", ports: [{ containerPort: 80 }] }] }
---
apiVersion: v1
kind: Service
metadata: { name: catalog-api }
spec: { selector: { app: catalog-api }, ports: [{ port: 80, targetPort: 80 }] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: catalog-api }
spec:
  rules:
    - host: catalog.bench-d01.local
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: catalog-api, port: { number: 80 } } } }] }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: price-sync }
spec:
  schedule: "*/30 * * * *"
  jobTemplate: { spec: { template: { spec: { restartPolicy: Never, containers: [{ name: sync, image: "busybox:1.36", command: ["true"] }] } } } }
YAML
kubectl -n "$NS" rollout status deploy/catalog-api --timeout=120s
```

`cleanup.sh`:

```bash
#!/usr/bin/env bash
kubectl delete namespace bench-d01 --ignore-not-found --wait=false
```

`case.json`:

```json
{
  "id": "D01-tour-overview",
  "tier": "D",
  "title": "Onboarding overview — every workload named, who manages it, no card",
  "mode": "conversation",
  "settleSeconds": 5,
  "message": "aku baru join, jelasin workload apa aja yang jalan di namespace bench-d01 dan gimana deploy-nya",
  "expect": {
    "action": null,
    "rca": {
      "must": ["catalog-api", "price-sync", "catalog\\.bench-d01\\.local", "(unmanaged|tidak (dikelola|di-?manage)|not managed|bukan gitops|tanpa gitops)"],
      "mustNot": ["\\*📍 Root Cause\\*"]
    }
  }
}
```

- [ ] **Step 3: `D02-tour-namespace-detail`** — the same `setup.sh`/`cleanup.sh` with `NS="bench-d02"` and host `catalog.bench-d02.local`; `case.json`:

```json
{
  "id": "D02-tour-namespace-detail",
  "tier": "D",
  "title": "Onboarding drill-down — image and replicas from the inventory, no card",
  "mode": "conversation",
  "settleSeconds": 5,
  "message": "gambaran cluster ini dong, aku anak baru",
  "followUp": "jelasin namespace bench-d02 lebih detail",
  "expect": {
    "action": null,
    "rca": {
      "must": ["nginx:1\\.27-alpine", "catalog-api", "(1/1|1 of 1|1 dari 1)", "\\*/30"],
      "mustNot": ["\\*📍 Root Cause\\*"]
    }
  }
}
```

`chmod +x` both `setup.sh`/`cleanup.sh` pairs. `case.ts` cross-checks a conversation case's `mode` against `wantsInvestigation()` — both messages must read as NOT investigations (they do: no investigate/kenapa/why).

- [ ] **Step 4: Run the cases** with the established local runner (`env -u DB_HOST -u REDIS_HOST`, MCP port-forward, `private-llm-agus` — the scratchpad's `run-bench-c03.sh` with `--filter '^D0[12]'`):
Run: `npm run bench -- --attempts 3 --filter '^D0[12]'`
Expected: both 3/3. On a miss, read the RCA in `bench/results/<run>.json` first: a term the model phrased differently is a case fix (widen the regex), an invented name is a skill fix.

- [ ] **Step 5: Commit** (the bench commits its own result line)

```bash
git add bench/cases/D01-tour-overview bench/cases/D02-tour-namespace-detail
git commit -m "bench: D01/D02 — cluster tour overview and namespace detail"
git push -u origin main
```

---

### Task 6: Dashboard `/cluster`

**Files:**
- Modify: `src/agent/index.ts` (`clusterInventory()`), `index.ts` (pass it to `DashboardServer`)
- Modify: `src/dashboard/server.ts` (dependency, route, 60 s cache), `src/dashboard/views.ts` (`clusterPage`, nav entry)
- Test: `src/dashboard/views.test.ts`, `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: the `k8s_cluster_inventory` output shape (Task 1).
- Produces: `DevOpsAgent.clusterInventory(): Promise<string>`; `DashboardServer` 4th constructor param `inventory?: () => Promise<string>`; `clusterPage(inv: ClusterInventory | null, error: string | null, openIncidents?: number): string`; `ClusterInventory` type in `views.ts` mirroring Task 1's output (structural — the dashboard does not import the mcp-server's types).

- [ ] **Step 0:** Load the ui-ux-pro-max skill (dashboard rule) and read `src/dashboard/CLAUDE.md` on tables (`table(…, "pairs")`, `data-label`, `breakable()`).

- [ ] **Step 1: Failing tests** — append to `src/dashboard/views.test.ts`:

```ts
test("the cluster page lists each namespace's workloads with owner, and collapses system namespaces", async () => {
  const { clusterPage } = await import("./views.js");
  const html = clusterPage({
    scanned: { namespaces: 3, complete: true },
    namespaces: [
      { name: "sample-apps", system: false, services: [{ name: "storefront", type: "ClusterIP", ports: ["80/TCP→3000"] }], ingresses: [{ name: "storefront", hosts: ["shop.example.com"] }],
        workloads: [{ kind: "Deployment", name: "storefront", ready: 1, desired: 2, images: ["ghcr.io/x/storefront:1.4.2"], managedBy: { type: "helmrelease", name: "storefront", namespace: "flux-app", chart: "storefront-0.3.1" } }] },
      { name: "empty", system: false, workloads: [], services: [], ingresses: [] },
      { name: "kube-system", system: true, workloads: [{ kind: "Deployment", name: "coredns", ready: 1, desired: 1, images: ["coredns:1.11"], managedBy: { type: "unmanaged" } }], services: [], ingresses: [] },
    ],
  }, null);
  assert.match(html, /<h1>Cluster<\/h1>/);
  assert.match(html, /storefront/);
  assert.match(html, /1\/2/);
  assert.match(html, /HelmRelease[^<]*flux-app\/storefront/);
  assert.match(html, /shop\.example\.com/);
  assert.match(html, /Nothing deployed here/);
  assert.match(html, /<details[^>]*>[\s\S]*kube-system[\s\S]*<\/details>/);
  assert.doesNotMatch(html.slice(html.indexOf("<body")), /undefined|NaN/);
});

test("a partial scan says so, and an unreachable tool is a note, not a crash", async () => {
  const { clusterPage } = await import("./views.js");
  assert.match(clusterPage({ scanned: { namespaces: 1, complete: false }, namespaces: [] }, null), /partial/i);
  assert.match(clusterPage(null, "MCP server not connected"), /MCP server not connected/);
});
```

Update the two nav-count tests (`views.test.ts` ~747 "six destinations" and ~1923) to seven — Cluster joins *Agent* after Topology.

`src/dashboard/server.test.ts`:

```ts
test("/cluster is routed, and the inventory is read once per 60 s", async () => {
  assert.deepEqual(matchRoute("/cluster"), { kind: "cluster" });
  // build a DashboardServer the way the file's other request tests do, with a counting stub:
  let calls = 0;
  const inventory = async () => (calls++, JSON.stringify({ scanned: { namespaces: 0, complete: true }, namespaces: [] }));
  // …issue two authenticated GET /cluster requests through the file's existing request helper…
  assert.equal(calls, 1);
});
```

(Use the file's existing server-construction and authenticated-request helper — read it first; the assertion that matters is `calls === 1` after two requests.)

Run: `npx tsx --test src/dashboard/views.test.ts src/dashboard/server.test.ts`
Expected: FAIL — `clusterPage` not exported, route unknown.

- [ ] **Step 2: Implement the view** (`views.ts`):
  - `ClusterInventory` type = Task 1's output shape.
  - `managed(m)`: `HelmRelease ns/name · chart` | `Kustomization ns/name · path` | `Helm · chart` | `not managed by GitOps` (every part through `esc()`).
  - `clusterPage(inv, error, open)` → `layout("Cluster", …, { current: "/cluster", openIncidents: open })`:
    - `error` → `empty(error, "The inventory comes from the MCP server's k8s_cluster_inventory.", ICON.plug)`;
    - `!inv.scanned.complete` → a `<p class="meta">` saying the scan is partial and how many namespaces it covered;
    - per non-system namespace: `section(ICON.layers, name, …)`, then `table(headers("Workload", "Kind", ["Ready", "num"], "Image", "Managed by"), rows, "pairs")` with `cell(...)` (ready as `${ready}/${desired}`, `—` for a CronJob, which shows its schedule in Kind), then one `<p class="meta">` with Services (`name ports`) and Ingress hosts; a namespace with no workloads gets `empty("Nothing deployed here.", "…", ICON.layers)`;
    - system namespaces inside one `<details><summary>System namespaces (N)</summary>…</details>`.
  - `NAV_GROUPS` Agent items: `{ href: "/cluster", label: "Cluster", icon: ICON.layers }` after Topology.

- [ ] **Step 3: Wire the server**
  - `src/agent/index.ts`: `async clusterInventory(): Promise<string> { return this.mcp.callTool("k8s_cluster_inventory", {}); }`
  - `index.ts`: `new DashboardServer(undefined, () => agent.mcpTools(), () => agent.skillsView(), () => agent.clusterInventory())`
  - `server.ts`: 4th constructor param `inventory?: () => Promise<string>`; `Route` gains `{ kind: "cluster" }` and `matchRoute` `if (p === "/cluster") return { kind: "cluster" };`; a private cache `{ at: number; inv: ClusterInventory | null; error: string | null } | null` reused for 60 s; the handler awaits `inventory()`, `JSON.parse`s it (a throw or a non-object becomes `error` text — never a 500; no `inventory` dependency → `error: "MCP server not connected"`), then `send(200, clusterPage(inv, error, open))`.

Run: `npx tsx --test src/dashboard/views.test.ts src/dashboard/server.test.ts && npm run build && npm test`
Expected: all pass.

- [ ] **Step 4: Browser check** — throwaway `render.tmp.ts` in the repo root writes `clusterPage(<Step 1 data>, null)` to scratchpad HTML (delete it after); screenshot at 1280 and 390, light and dark, with the `~/.render-check` Playwright setup. Expected: no horizontal overflow, no `undefined`/`NaN`. LOOK at the screenshots.

- [ ] **Step 5: Commit, deploy, verify live**

```bash
git add src/agent/index.ts index.ts src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/views.ts src/dashboard/views.test.ts
git commit -m "feat(dashboard): /cluster — the inventory, rendered with no LLM"
git push -u origin main
```

Wait for the image, `kubectl -n devops-tools rollout restart deploy/devops-ai-agent`, then load `/cluster` through a dashboard port-forward and screenshot it with real data.

---

### Task 7: Docs

**Files:**
- Modify: `devops-ai-agent/CLAUDE.md` (one Gotcha bullet), `devops-ai-agent/MEMORY_BANK.md` (one numbered entry), `devops-mcp-server/CLAUDE.md` (one bullet beside `k8s_cluster_health`'s)

- [ ] **Step 1:** Agent `CLAUDE.md` bullet: tours route through `wantsTour` → `mentionBudget` (the one budget function the app AND the bench call); the `cluster-tour` skill keys on vocabulary, never the mode tag (pinned by the agreement test); `worthProposing` suppresses cards for tours like `CAPACITY_QUESTION`; `/cluster` renders `k8s_cluster_inventory` with no LLM behind a 60 s cache.
- [ ] **Step 2:** mcp-server `CLAUDE.md` bullet: `k8s_cluster_inventory` derives `managedBy` with `gitOpsVerdict` — change the guard's labels and the tour changes with it; never add env/ConfigMap/Secret content to its payload.
- [ ] **Step 3:** `MEMORY_BANK.md` entry with the D01/D02 result (pass^3 and anything the cases had to be widened for).
- [ ] **Step 4:** Commit and push both repos.
