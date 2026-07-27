# Design — FinOps Agent (org-wide AWS cost intelligence)

> **Status:** design agreed in principle (2026-07-26). Supersedes and folds in the parked
> 2026-07-08 in-cluster-only note (OpenCost / Prometheus waste audit — now §5.1 here). The
> IAM model (§7) must be ratified before any code. Nothing here is committed work yet.

## 1. Goal

Give the org an AI-driven **cost optimization** capability that goes past what AWS's own
engines (Trusted Advisor, Compute Optimizer) produce: those are **static-threshold and
context-blind**. Our value-add is **behaviour- and context-aware tuning** — the agent
learns how each service actually behaves over time, cross-references our own context (tags,
incident history, known purpose), and refines/rejects the generic AWS recommendation.

**Motivating example.** Trusted Advisor: *"EC2 X underutilized, stop it."* The agent pulls
90-day behaviour → weekly spike every Monday, tag `purpose=weekly-etl` → verdict: *"Keep —
scheduled job. But rightsize m5.xlarge → m5.large; peak uses 40% CPU."* TA can never do
this. That gap is the whole point.

## 2. Scope & positioning — two surfaces

FinOps splits along **trigger/cadence**, and the two halves belong in different places:

| Surface | Trigger | Home | Why |
|---|---|---|---|
| **Reactive — cost-anomaly RCA** ("why did cost spike *now*?") | Alertmanager cost-spike rule → `/alert` webhook | **existing `devops-ai-agent`** | It's genuinely an incident: real-time, RCA format, Slack thread. Reuses the entire alert→investigate→RCA flow + incident memory, unchanged |
| **Proactive — cost optimization** (waste/idle/rightsizing, org-wide, behaviour learning) | **Scheduled** (weekly/monthly) + on-demand Slack | **new `finops-agent`** | Batch, non-critical, different prompt/memory/output. Does not fit the reactive webhook model |

This doc is about the **proactive surface** (the new agent). The reactive surface is a small
prompt/Alertmanager addition to the existing agent — captured in §5.1 and left there.

## 3. Non-goals (v1)

- **Not** reimplementing AWS's ML forecasting/rightsizing math (Compute Optimizer / Cost
  Anomaly Detection already do it, free). We consume their output as *candidates*; we add
  context, not a competing model. (See §6 rung 4 — YAGNI.)
- **Not** auto-executing changes. v1 outputs recommendations (Slack digest) + optionally
  **opens a rightsizing PR** via the existing GitOps PR-flow — a human still merges.
- **Not** a cost dashboard. Dashboards show *what*; the agent explains *why* and *what to do*.
- **Not** multi-cloud. AWS only.

## Decisions summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **Separate `finops-mcp-server` repo** (not folded into `devops-mcp-server`) | Org-wide read + billing IAM is a different blast radius, account home, and cadence than the in-cluster RCA server (§4) |
| D2 | **Separate `finops-agent` repo** (not a mode in `devops-ai-agent`) | Different trigger (cron vs webhook), prompt, memory schema, output, criticality (§4) |
| D3 | **Reuse `llm-worker`, GitOps PR-flow, Postgres, and a shared `agent-core`** | The LLM bridge + PR-flow are already generic; the loop is a justified shared lib now there are 2 consumers |
| D4 | **Hybrid behaviour source**: Prometheus for K8s (free), free AWS candidates + *selective* CloudWatch for AWS-native | CloudWatch `GetMetricData` is billed per metric — an org-wide sweep is the expensive mistake to avoid (§5) |
| D5 | **Behaviour learning = persistent memory + deterministic features, not ML** | The differentiation is context + memory + reasoning, not forecasting math (§6) |
| D6 | **Org-wide via delegated-admin + per-account `FinOpsReadOnly` assume-role** | Account scope is org-wide/multi-account; Enterprise Support available (§7) |

## 4. Architecture — why two new services, and what's shared

```
finops-agent (NEW repo, CronJob + on-demand)      devops-ai-agent (existing, webhook)
   │ prompt: FinOps analyst                           │ prompt: incident investigator
   │ memory: behaviour_profiles, recommendations      │ memory: incidents, remediations
   ├─ finops-mcp-server (NEW) → cost + AWS candidates + selective CloudWatch + discovery
   ├─ devops-mcp-server (existing) → prometheus_*  (K8s behaviour, FREE — do NOT duplicate)
   └─┬─ llm-worker (SHARED, unchanged) ────────────────┘
     └─ GitOps PR-flow (SHARED) → rightsizing PR / remediation PR
   [ agent-core (SHARED lib): tool loop + MCP client + SQS dispatcher + trimToWindow ]
```

**Why separate (both server and agent):** blast radius (an org-wide-read identity must not
sit on the in-cluster, webhook-exposed RCA server), account home (RCA lives in the workload
cluster; FinOps assumes into the org from a delegated-admin account), cadence (real-time vs
batch), dependency bloat, and independent lifecycle. See the conversation seam: AWS concerns
split cleanly by account-scope — single-account cluster-adjacent RCA vs org-wide cost hub.

**What is shared (reused, not duplicated):**
- **`llm-worker`** — generic `{requestId, messages, tools, systemPrompt}` SQS bridge to the
  private LLM. finops-agent uses it **as-is, zero change**.
- **GitOps PR-flow** (`DESIGN_gitops_pr_remediation.md`) — finops-agent reuses it to open a
  **rightsizing PR** (a `set_resources` change) to the GitOps repo.
- **Postgres** — same instance, separate schema/tables (§9).
- **`agent-core`** — extract the tool-calling loop, MCP client, SQS dispatcher, and
  `trimToWindow` into a small shared package. Justified now (2 consumers); **not** premature.

## 5. Data-source strategy — the cost-control heart

CloudWatch `GetMetricData` is billed per metric requested. A periodic org-wide **full
sweep** across thousands of resources is the expensive anti-pattern. Split the source by
resource type:

### 5.1 Kubernetes/EKS layer → Prometheus (free, already scraped)

Reuse `devops-mcp-server`'s existing `prometheus_*` tools. **Zero marginal cost, zero new
code, higher resolution, and it has the requests-vs-usage context CloudWatch lacks:**
- usage: `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`
- **request/limit vs usage**: `kube_pod_container_resource_requests` (kube-state-metrics) —
  over-provisioned requests waste node capacity → waste EC2 $. Biggest, cheapest win.
- (optional) **OpenCost** HelmRelease (CNCF; engine under Kubecost) exports K8s cost
  allocation as Prometheus metrics → `opencost_*` queryable by the same tools, no new code.
  This is the folded-in idea from the parked note.

Prior art: **KRR** (Robusta) and **Goldilocks** rightsize K8s from Prometheus. We build the
agent-tuned, context-aware version of the same idea.

### 5.2 AWS-native layer (RDS/ALB/EBS/Lambda/NAT/standalone EC2) → free candidates, selective validation

**Never sweep CloudWatch.** Instead:
1. **Candidates (free):** Compute Optimizer + Cost Optimization Hub already analysed
   CloudWatch internally and produce rightsizing/idle recommendations at **no API cost**.
   Pull these as the candidate list.
2. **Validation (selective, cheap):** pull raw CloudWatch (`GetMetricData`) **only for the
   few hundred resources a candidate flagged**, to tune against real behaviour — not for the
   whole fleet. Collapses cost by orders of magnitude.
3. **Optional continuous:** **YACE** (yet-another-cloudwatch-exporter) can scrape hot AWS
   metrics (ALB/RDS) into Prometheus. Honest caveat: YACE still calls `GetMetricData` under
   the hood — the cost **moves, it doesn't vanish**. Only worth it for frequently-viewed
   resources.

### 5.3 Retention / coverage caveats
- **Prometheus retention** (~15d default) is **fine for rightsizing** (2 weeks of
  usage-vs-request already exposes waste) but too short for **monthly-batch** patterns —
  those need Thanos/Cortex long-term storage, else lean on selective CloudWatch (up to 455d
  at 1h resolution).
- **EC2 memory** needs the CloudWatch agent (basic metrics = CPU/net/disk only). Behaviour is
  only as good as the metrics present.
- **Multi-cluster** = one Prometheus per cluster. Start single-cluster / Thanos-federated;
  don't overbuild.

## 6. Behaviour learning — how we beat Trusted Advisor (and why it's not ML)

A ladder; stop at the rung that delivers. Source-agnostic — works on a series from
Prometheus or CloudWatch.

**Rung 1 — Persistent behaviour profile (the 80%).** Each scheduled scan pulls a window
(30–90d) per resource and stores a profile in Postgres: p50/p95/p99, min/max, pattern class,
tags/purpose, last-seen. Next scan **updates + diffs** (drift). "Learning" = knowledge
compounding per run, no human labelling. This is exactly the `recallForAlert` /
`DESIGN_oncall_feedback_learning.md` memory pattern applied to behaviour.

**Rung 2 — Deterministic pattern features (cheap, not ML).** Don't feed the LLM 2000 raw
datapoints. Compute a few pure functions over the series (live in `finops-mcp-server`, pure +
unit-tested): periodicity via autocorrelation (diurnal/weekly/monthly-batch), trend via
regression slope (growth), burstiness = p99/p50, idle = p95 below threshold, change-point =
rolling-mean shift. Return **structured features** ("weekly period, p99/p50=4.2, +12%/mo") —
lean context, better reasoning input. This is the engine that beats TA's fixed threshold.

**Rung 3 — Outcome feedback (Tier 2, closes the loop).** Track which recommendations were
actioned (rightsizing PR merged) → measure realized savings / regressions after. Cross-ref
**incident memory**: if rightsizing a service class previously caused an incident/throttling,
the agent learns to be more conservative there. Quality improves from outcomes.

**Rung 4 — Training our own ML → avoid (YAGNI).** Prophet/ARIMA/anomaly-ML per service =
reinventing Compute Optimizer + Cost Anomaly Detection. Our edge is rungs 1–3.

**Split:** feature computation (rung 2) = pure functions in `finops-mcp-server` (stateless).
Profiles + outcomes (rungs 1, 3) = memory in the agent's Postgres (the agent owns state,
like incident memory). MCP fetches + computes; agent remembers + reasons.

## 7. Auth — org-wide, multi-account (ratify before code)

Account scope is org-wide; Enterprise Support is available (Trusted Advisor cost checks +
org view usable). Model:

- **Base identity in a delegated-admin account** (a dedicated FinOps/audit member account —
  **not** the org root/management account; best practice). The finops-agent/mcp-server runs
  or assumes here.
- **Org-consolidated reads** from this account: Cost Explorer (payer/management-linked),
  Cost Optimization Hub, Compute Optimizer, Trusted Advisor — all support org-wide view via
  delegated admin / Enterprise Support.
- **Per-account behaviour + discovery:** a least-priv **`FinOpsReadOnly`** role deployed to
  **every member account** (via CloudFormation StackSets / Terraform); its trust policy
  allows the base identity to `sts:AssumeRole`. The base identity enumerates accounts via
  `organizations:ListAccounts` and assumes per account to run Describe/List + CloudWatch.

**Two IAM policies (action families — exact JSON is an open question, §14):**

1. *Base / delegated-admin role* — read-only:
   `ce:Get*`, `ce:List*`, `cost-optimization-hub:ListRecommendations`/`GetRecommendation`,
   `compute-optimizer:Get*`/`Describe*`, `trustedadvisor:Describe*`/`Get*`,
   `budgets:ViewBudget`, `organizations:ListAccounts`/`DescribeOrganization`,
   `sts:AssumeRole` (→ the member-account role only).
2. *`FinOpsReadOnly` member-account role* — read-only:
   `*:Describe*`, `*:List*`, `*:Get*` (scoped to the services we inventory — EC2/EBS/ELB/
   RDS/Lambda/etc.), `cloudwatch:GetMetricData`/`ListMetrics`/`GetMetricStatistics`,
   `tag:GetResources`. **No** billing here (cost lives at the payer level). Trust = the base
   role's ARN.

Everything is `Describe/List/Get` — read-only end to end. HTTP transport + `MCP_AUTH_TOKEN`
(as `devops-mcp-server` already does) if the server must be reachable "from anywhere";
AWS credentials stay server-side.

## 8. `finops-mcp-server` — tool tiers (read-only, native AWS SDK v3)

Native TS tools (same pattern as the K8s tools: `getClient(...)` + `withUpstream(...)` +
compact LLM-shaped output). **Reuse, don't duplicate:** K8s behaviour comes from
`devops-mcp-server`'s `prometheus_*` — finops-mcp-server owns only the AWS side.

**Candidate tools (free AWS engines):**
- `finops_cost_breakdown` — Cost Explorer by service/tag/account/time; forecast.
- `finops_recommendations` — Cost Optimization Hub + Compute Optimizer (idle + rightsizing).
- `finops_trusted_advisor` — Enterprise cost checks + org view.

**Behaviour tools (validate/tune candidates):**
- `finops_resource_utilization` — CloudWatch over a window, returning the **rung-2 pattern
  features** (not raw datapoints). Selective — call for flagged candidates only.
- `finops_inventory` — cross-account resource + tag inventory (Resource Groups Tagging API /
  Resource Explorer), the org-wide discovery.

**Idle/waste scan (gaps AWS engines miss):**
- `finops_find_idle` — curated per-account scans: unattached EBS, unassociated EIP, ELB with
  ~0 requests, orphaned snapshots, stopped instances still billing EBS, empty NAT gateways.

Pull `@aws-sdk/client-*` **per service, as implemented** (ponytail: not all at once).

## 9. `finops-agent` — loop, prompt, memory

- **Trigger:** Kubernetes `CronJob` (weekly/monthly full scan) + on-demand Slack command.
  A scan is a map-reduce over accounts/resources, not a single deep dive.
- **Prompt:** a FinOps-analyst system prompt (separate file; not the incident playbooks).
- **Memory (Postgres, new tables):**
  - `behaviour_profiles(resource_id, account, kind, p50/p95/p99, pattern_class, tags,
    first_seen, last_seen, updated_at, ...)` — rung 1.
  - `recommendations(id, resource_id, candidate_source, verdict, est_savings, status
    [proposed|pr_opened|merged|dismissed], pr_url, incident_refs, created_at, ...)` — rung 3.
- **Output:** Slack cost digest (top savings, ranked, with the agent's context-tuned
  reasoning) + optional **rightsizing PR** via the shared GitOps PR-flow (a `set_resources`
  change; human merges). Reuses the exact approval/audit surface already built.

## 10. Flow — one scan cycle

```
CronJob fires
  → list org accounts (organizations:ListAccounts)
  → pull candidates: Cost Optimization Hub / Compute Optimizer / Trusted Advisor (free)
  → pull K8s waste from Prometheus (devops-mcp-server, free)
  → for each candidate/flagged resource:
        fetch behaviour features (Prometheus for K8s; selective CloudWatch for AWS)
        load persistent profile + drift (Postgres)
        cross-ref context: tags, purpose, incident memory
        LLM reasons → tuned verdict (keep / rightsize-to-X / delete-idle)
  → persist updated profiles + recommendations
  → post Slack digest; open rightsizing PR(s) for high-confidence items
```

## 11. Implementation order (lazy)

| Step | What | Repo | Weight |
|---|---|---|---|
| 0 | **Ratify IAM** (§7) + create `FinOpsReadOnly` StackSet + delegated-admin | infra/aws-iam | — |
| 1 | `agent-core` extract (loop + MCP client + SQS dispatcher) from `devops-ai-agent` | shared | small |
| 2 | `finops-mcp-server` skeleton (copy transport/auth) + `finops_cost_breakdown` + `finops_recommendations` (candidates first — free, highest signal) | new | medium |
| 3 | K8s waste path via existing `prometheus_*` (prompt + rung-2 feature funcs) | reuse | small |
| 4 | `finops-agent` skeleton: CronJob, FinOps prompt, `behaviour_profiles` table, Slack digest | new | medium |
| 5 | `finops_resource_utilization` (selective CloudWatch + pattern features) + `finops_inventory` + `finops_find_idle` | new | medium |
| 6 | Rung 3 outcome loop (`recommendations` table, PR-merge tracking, incident cross-ref) | new | medium |
| 7 | Rightsizing PR via GitOps PR-flow (`set_resources`) | reuse | small |
| — | Reactive cost-anomaly-as-incident (§2/5.1) — Alertmanager rule + prompt, in `devops-ai-agent` | existing | small, independent |

Candidates (free engines) before behaviour (CloudWatch) — highest signal per dollar first.

## 12. Dependencies / prerequisites
- ✅ `llm-worker`, GitOps PR-flow, Postgres, Prometheus, Slack (all in place).
- ✅ Enterprise Support (Trusted Advisor cost checks + org view).
- ⬜ Org delegated-admin account chosen + `FinOpsReadOnly` StackSet rolled out (§0).
- ⬜ `agent-core` extracted.
- ⬜ (optional, monthly patterns) Thanos/long-term Prometheus.
- ⬜ (optional, EC2 memory) CloudWatch agent coverage.

## 13. Honest caveats
- **Cold start:** behaviour profiles need history; early scans are less confident and improve
  over runs. Weekly/monthly patterns need a long-enough window (retention, §5.3).
- **CloudWatch cost is real** even selective — cache profiles, don't re-pull unchanged
  resources, batch `GetMetricData` (≤500 metrics/call).
- **Label/tag hygiene** gates both K8s cost allocation and AWS context tuning. Decide a
  minimum tagging convention worth enforcing.
- **Org rollout friction:** the `FinOpsReadOnly` StackSet touches every account — needs the
  org/security team's sign-off (§0 is the real long-pole, not the code).

## 14. Open questions
- Exact per-engine account split: which reads run in the payer/management account vs the
  delegated-admin account (Cost Explorer vs Cost Optimization Hub vs Compute Optimizer vs
  Trusted Advisor org view). Ratify the two IAM policy JSONs.
- `agent-core`: extract as a shared package vs vendor/copy — decide based on how much the two
  agents actually diverge.
- Anomaly baseline for the reactive surface (static threshold vs `predict_linear` vs
  recording rules) — inherited open question from the parked note.
- Scan cadence + scope: full org monthly + targeted weekly? Per-account concurrency limits
  for STS/CloudWatch throttling.
