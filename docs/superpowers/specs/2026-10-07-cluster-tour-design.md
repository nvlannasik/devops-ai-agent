# Cluster tour — onboarding explanation of what runs and how it is deployed

**Status:** approved design (2026-10-07), spec under review
**Repos:** `devops-mcp-server` (one new read tool), `devops-ai-agent` (intent, skill, gate, dashboard page)

## 1. Purpose

Someone new to the cluster asks the agent in Slack what runs here and how it gets deployed. Today
the agent can only answer that piecemeal: a mention gets a 2-round tool budget, every listing tool
is per-namespace, and nothing reports *who manages* a workload. The answer has to be grounded —
an onboarding document that invents a workload is worse than none, because a newcomer has no way
to tell.

**Depth (decided):** inventory + how it is deployed. Request flow between services and
per-workload troubleshooting are out of scope for this iteration.

**Media (decided):** Slack is the primary surface. A dashboard page follows as phase 2 if it
costs little — and it does, because it renders the same tool output with no LLM.

## 2. Success criteria

1. `@agent jelasin cluster ini` returns, in one reply, every namespace with the workloads in it,
   who manages each (HelmRelease / Kustomization / Helm without Flux / unmanaged) and what each
   exposes (Ingress hosts) — every name taken from tool output.
2. A follow-up in the thread (`jelasin sample-apps`) returns that namespace in detail: per
   workload kind, image, ready/desired replicas, Services and ports, Ingress, CronJobs, and where
   it is deployed from.
3. The reply separates what was **read** from what is **inferred** (a workload's purpose from its
   name or labels), and marks the inference as such.
4. A tour never produces a remediation card, even when the inventory lists a pod that is not ready.
5. `/cluster` on the dashboard shows the same inventory with no LLM call.

## 3. Design

### 3.1 `k8s_cluster_inventory` (devops-mcp-server)

One read tool, modelled on `k8s_cluster_health`: the whole cluster in one call, `namespace`
optional to narrow, a scan ceiling reported as `scanned.complete`.

```jsonc
{
  "scanned": { "namespaces": 14, "complete": true },
  "namespaces": [
    {
      "name": "sample-apps",
      "workloads": [
        {
          "kind": "Deployment", "name": "storefront", "ready": 2, "desired": 2,
          "images": ["ghcr.io/example/storefront:1.4.2"],
          "managedBy": { "type": "helmrelease", "name": "storefront", "namespace": "flux-app",
                         "chart": "storefront-0.3.1" }
        }
      ],
      "services": [{ "name": "storefront", "type": "ClusterIP", "ports": ["80/TCP→3000"] }],
      "ingresses": [{ "name": "storefront", "hosts": ["shop.example.com"] }],
      "cronjobs": [{ "name": "nightly-report", "schedule": "0 2 * * *" }]
    }
  ]
}
```

- Kinds: Deployment, StatefulSet, DaemonSet, CronJob. Pods, ReplicaSets and Jobs are not
  listed — they are the workloads' children and would triple the payload.
- `managedBy` is derived from the object's labels with the SAME reader the GitOps guard uses
  (`guardrails.ts`: `helm.toolkit.fluxcd.io/*`, `kustomize.toolkit.fluxcd.io/*`,
  `app.kubernetes.io/managed-by: Helm`, `helm.sh/chart`). One source of truth for "is this
  GitOps-managed" — the guard that refuses a patch and the tour that explains the owner must not
  disagree. `type: "unmanaged"` when no label says otherwise: on a GitOps cluster that is itself a
  finding worth showing a newcomer.
- `kustomization` entries add the Kustomization's `spec.path` when the CR is readable
  (`k8s_get_custom_resources` RBAC); absent, not guessed, when it is not.
- No ConfigMap or Secret contents, no env values, no annotations' free text — the payload is
  names, counts, images, ports and hosts. That keeps it small, and keeps the injection surface
  (`agent/injection/`) to names.
- Ceiling: a namespace cap like `k8s_cluster_health`'s; past it `complete: false`, and the skill
  must say the inventory is partial.

Auto-discovered by the agent via `listTools()` — no agent change to register it.

### 3.2 Routing (devops-ai-agent, `agent/intent`)

`wantsTour(text)` beside `wantsInvestigation`: explain/describe/onboarding/overview vocabulary
(EN + ID: `jelasin`, `jelaskan`, `gambaran`, `onboarding`, `apa aja yang jalan`, `workload apa`)
together with a cluster/namespace/workload noun. A tour:

- runs in `mode: "conversation"` (plain mrkdwn, no RCA template);
- gets `TOUR_TOOL_ROUNDS` (config, default 4) instead of `MENTION_TOOL_ROUNDS` — with the
  inventory tool one round covers the overview, the rest are for follow-up drill-downs and for a
  model that wants a Flux CR;
- is checked before `wantsInvestigation`; "kenapa X tidak jalan" stays an investigation because a
  tour needs the explain vocabulary, not just a cluster noun.

### 3.3 Skill `prompts/skills/cluster-tour.md`

`when:` the same vocabulary plus `mode:conversation`. Body, in order:

1. Overview: one `k8s_cluster_inventory` call, no namespace. Per namespace one block — workloads
   (names, kind), managed by, exposed as. Namespaces with nothing but system components
   (`kube-system`, `flux-system`, …) collapse to one line.
2. Detail (a follow-up naming a namespace): `k8s_cluster_inventory namespace=<ns>`, then per
   workload: kind, image, ready/desired, Services+ports, Ingress hosts, CronJob schedule,
   deployed from (HelmRelease name + chart, or Kustomization + path).
3. Two labelled parts: *Terbaca* (facts from the tool) and *Dugaan fungsi* (purpose inferred
   from names/labels, each line marked as a guess). Never a purpose without the label.
4. `complete: false` → say the inventory is partial, and which namespaces were scanned.
5. Close with what the reader can ask next (a namespace to drill into) — not an offer to change
   anything.

Within `SKILL_MAX_CHARS`; `skills/real.test.ts` loads it.

### 3.4 No card from a tour

`worthProposing` gains a `TOUR_QUESTION` suppression of its fault-evidence branch, exactly like
`CAPACITY_QUESTION`: an inventory lists "0/1 ready" and "CrashLoopBackOff" in the same words a
fault report does. Explicit requests (`ACTION_INTENT`) still propose.

### 3.5 Dashboard `/cluster` (phase 2)

- `DashboardServer` gets a `callTool` dependency (a getter, like `mcpTools`, so the dashboard
  can start before MCP connects). Null → the page renders a note, not an error.
- `/cluster` renders `k8s_cluster_inventory` deterministically: one section per namespace, a
  workload table (kind, name, ready/desired, image, managed by) with the existing `table(…,
  "pairs")` narrow mode, Services and Ingress hosts beside it. System namespaces collapsed into a
  `<details>`.
- Cached 60 s in-process: a page reload must not rescan the cluster.
- Nav entry under *Agent*, after Topology. UI work goes through ui-ux-pro-max and a browser check
  (desktop, phone, dark).

## 4. Testing

- **mcp-server:** inventory unit tests against a fake client — owner derivation for each
  `managedBy` type (shared with the guard's tests), the ceiling, no ConfigMap/Secret content in
  the payload.
- **agent:** `wantsTour` positive/negative (incl. "kenapa X tidak jalan" → not a tour);
  `worthProposing` suppression; budget selection; skill loads.
- **bench:** two conversation-mode cases — `D01-tour-overview` (a `bench-d01` namespace with a
  Deployment, a Service, an Ingress and a CronJob: the RCA text must name each, no proposal) and
  `D02-tour-namespace-detail` (follow-up naming the namespace: image and replica count stated, no
  proposal). Both scored by the existing `rca.must` regex and grounding axis.
- **dashboard:** queries/views tests as for `/harness`; browser screenshot check.

## 5. Out of scope

Request flow between services, per-workload troubleshooting pointers, any write action, an LLM
summary on the dashboard, caching the tour answer.
