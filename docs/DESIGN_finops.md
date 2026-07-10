# Design — FinOps Capabilities

> **Status:** discussion / parked (2026-07-08). Ideas agreed in principle, to be revisited
> when prioritized. Nothing here is committed work; §7 lists what to decide when we pick
> this up.

## 1. Goal

Extend the agent beyond incident RCA into **cost intelligence** for the Kubernetes +
observability scope: answer cost questions in Slack, detect waste, and investigate cost
anomalies the same way it investigates incidents.

**Positioning:** dashboards (Grafana/Kubecost UI) show *what* ("cost went up"); the agent's
value-add is *why* — multi-tool correlation ("cost doubled because deploy v2.3 raised
replicas and added a 500Gi PVC") plus natural-language access in Slack. The agent is an
**analyst on top of OpenCost**, not a replacement for it.

## 2. Key architectural insight (why this is cheap)

**OpenCost** (CNCF; the engine under Kubecost) computes K8s cost allocation and **exports
it as Prometheus metrics** (plus a REST API). That means:

```
OpenCost (new HelmRelease — Flux/GitOps already in place)
   ↓ cost metrics
Prometheus (already deployed)
   ↓ prometheus_query / prometheus_query_range
devops-mcp-server (existing tools — ZERO code change)
   ↓
Agent (ZERO code change; new playbook section in prompts/system.md, no rebuild)
```

Tiers 1–3 below are almost entirely **config + prompt**, not TypeScript.

## 3. Feature tiers

### Tier 1 — Cost visibility Q&A (nearly free)
```
@devops-agent what did namespace payment cost over the last 7 days?
@devops-agent which workloads are most expensive in this cluster?
```
Needs: OpenCost deployed + a FinOps playbook section in the system prompt (example PromQL
over `opencost_*` metrics). No new tools.

### Tier 2 — Waste detection / rightsizing audit (most actionable)
The gap between **requests and actual usage** = overprovisioning = wasted spend. The data
already exists in Prometheus even without OpenCost:
- `kube_pod_container_resource_requests` vs `container_cpu_usage_seconds_total` / `container_memory_working_set_bytes`
- idle workloads (running, no traffic), unattached PVs, underutilized nodes

Playbook: "audit namespace X → report over-requested workloads with suggested
requests/limits." Output is a recommendation, not an action (see Tier 4).

### Tier 3 — Cost anomaly as an "incident" (most elegant fit)
Alertmanager rule on cost spike (e.g. namespace cost rate > 50% above baseline) → existing
`/alert` webhook → the **existing investigate pipeline**, unchanged: correlate the spike
with deploys (k8s events), HPA scale-ups (metrics), new PVs, image changes → cost RCA in
the Slack thread. Incident memory applies too ("similar spike last month — HPA
maxReplicas was oversized").

Reuses the entire alert→investigate→RCA flow; only the symptom domain is new.

### Tier 4 — Rightsizing execution (later; rides on Guarded Remediation)
Agent proposes a requests/limits patch → approval card → apply. This is exactly an
additional whitelisted action (`k8s_patch_resources`) for the flow designed in
`DESIGN_guarded_remediation.md` — same `remediations` table, approval gate, dry-run,
audit trail. Do not build before remediation v1 is proven.

### Out of scope (deferred indefinitely)
- **Cloud-bill level** (AWS Cost Explorer / CUR): new credentials + scope, low added value
  while the focus is in-cluster.

## 4. Implementation ladder (lazy)

| Step | What | Kind | Code? |
|------|------|------|-------|
| 1 | OpenCost HelmRelease in `gitops-devops-ai-manifest` (base + overlays) | infra | none |
| 2 | FinOps playbook section in `prompts/system.md` (cost queries, waste audit) | prompt | none (no rebuild) |
| 3 | Alertmanager cost-anomaly rules → existing webhook | config | none |
| 4 | *(only if needed)* dedicated MCP `cost_*` tools hitting the OpenCost REST API (`/allocation`) — pre-aggregated, token-cheaper than raw PromQL | code | small |
| 5 | *(later)* rightsizing action via Guarded Remediation | code | medium |

Steps 1–3 make Tiers 1–3 live with zero TypeScript.

## 5. Honest caveats
- **Pricing source:** on EKS, OpenCost pulls AWS pricing automatically (fine for this
  setup); on-prem would need custom pricing config.
- **Not real-time:** cost data aggregates hourly/daily. Anomaly baselines must account for
  this or the alert gets noisy — the baseline/threshold design is the main open question
  for Tier 3.
- **Token cost of raw PromQL:** if Tier 1/2 answers get verbose, that's the signal to add
  Step 4 (`cost_*` tools with pre-aggregated OpenCost API responses).

## 6. Dependencies
- ✅ Prometheus + Alertmanager + Flux GitOps (all in place).
- ✅ Alert webhook pipeline + incident memory (in place).
- ⬜ OpenCost deployed.
- ⬜ (Tier 4 only) Guarded Remediation v1 shipped.

## 7. To decide when picked up
- Which tier first (1 = Q&A, 2 = waste audit, 3 = anomaly-as-incident)? They're
  independent; 3 reuses the most existing machinery.
- Cost-anomaly baseline: static threshold vs `predict_linear`/avg-over-window vs
  recording rules — pick the simplest that isn't noisy.
- Whether Tier 2 audits run on-demand only (mention) or scheduled (e.g. weekly report to a
  channel — would need a small scheduler or a Slack workflow trigger).
- Label hygiene: cost allocation quality depends on namespaces/labels; decide the minimum
  labeling convention worth enforcing.
