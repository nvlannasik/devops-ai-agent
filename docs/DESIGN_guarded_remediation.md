# Design — Guarded Remediation

> **Status: v1.1 IMPLEMENTED (2026-07-15)** — §8 steps 1–4 shipped, then extended beyond
> the §7 minimal cut: **4 typed actions** (`k8s_rollout_restart` for
> deployment/statefulset/daemonset, `k8s_set_image`, `k8s_set_resources`, `k8s_scale`
> with `MAX_SCALE_DELTA` + scale-to-zero refused), **mention-driven investigations** also
> get the flow (`remediations.incident_id` nullable), and **write tools are excluded from
> the agentic loop** via the `[WRITE]` description-prefix convention (two layers: filtered
> from the tools list + refused in executeToolCalls). Step 5 (RBAC review) is an ops task
> before production use. **§10 records a known limitation for GitOps-managed workloads
> (most of this cluster) and the PR-flow design that addresses it.** §11 lists v2. One deviation from §5.3: approve does a single
> atomic flip `proposed → executing` (with `approved_by` recorded) instead of a two-step
> approved→executing — same idempotency guarantees, fewer states in flight.
>
> **v1.2 (2026-07-16, from live testing):** every proposal null-path is logged (silent
> no-card was undebuggable); `container` is **optional** in `k8s_set_image`/`k8s_set_resources`
> — the MCP server auto-resolves single-container workloads and refuses multi-container ones
> with the name list (the proposal model cannot know container names and guessed wrong);
> proposal prompt: never guess container names, workload = controller name not pod name, an
> explicit user request is sufficient evidence for any whitelisted action (user-given tag +
> current repo from context); the approval card `<@mentions>` the approvers so they get
> notified. The alert flow is now **format-agnostic**: a recognized recurrence may reply
> concisely instead of the RCA template — incident store + proposal run either way.
>
> **v1.3 (2026-07-22):** 5th action **`k8s_delete_pod`** — delete ONE wedged pod so its
> controller recreates it. Server refuses pods without a recreating controller
> (ReplicaSet/StatefulSet/DaemonSet; naked/Job pods = no replacement = outage). GitOps-safe
> like restart (recreation is reconcile-safe) → not behind the GitOps guard. Proposal rule:
> only when one pod is sick while siblings are healthy; whole-workload issues → restart.
>
> **v1.4 (2026-07-28):** 6th action **`flux_reconcile`** — the only action that restores
> state instead of introducing it. Proposed automatically when the GitOps resolver reports
> **cluster/Git drift** (someone changed the cluster outside GitOps), which used to surface
> as a wrong refusal — see `DESIGN_gitops_pr_remediation.md` §3.4b. It annotates the owning
> HelmRelease with `reconcile.fluxcd.io/{requestedAt,forceAt}` so Flux re-applies the repo's
> declared state. NOT in `parseProposal`'s whitelist: the drift path constructs it, the
> proposal LLM cannot ask for it. Its namespace guard runs on the **workload's** namespace
> (HelmReleases live in the always-blocked `flux-system`) and the target release is derived
> from the workload's Flux labels, never named by the caller. Still approval-gated — the
> drifted value is occasionally the intended one, and then the human wants a PR instead.

## 1. Goal

Today the agent stops at **diagnosis** (RCA). Guarded Remediation lets the agent
**execute fixes** (restart, scale, rollback) — but **always through a human approval
gate** in the alert thread, **never** automatically without confirmation.

"Guarded" means every action is bounded by:
1. **Whitelist** of allowed actions (not arbitrary kubectl),
2. **Approval** from an authorized human before execution,
3. **Audit trail** of everything (who, when, what action, what result).

## 2. Non-goals (v1)

- ❌ Auto-remediation without approval (maybe v2 for low-risk + high-confidence; **not** now).
- ❌ Arbitrary command execution. Structured actions from the whitelist only.
- ❌ Remediation outside Kubernetes (no cloud API, no DB surgery).
- ❌ Multi-step orchestration / runbook automation. One action per approval for now.

## 3. Threat model — why "guarded"

Write actions are **irreversible-ish** with real blast radius:
- The LLM can misdiagnose → restart/scale the wrong component → cause a new outage.
- Without auth/whitelist, an MCP write-tool is RCE against the cluster.
- Without approval, a single false-positive alert can trigger a destructive action at 3am.

So **least-privilege RBAC + whitelist + approval + audit** is not optional — it *is* the
feature. See §5.5 for **enforcement layering** (where each guard is enforced).

## Decisions summary

| Question | Decision | §  |
|----------|----------|----|
| Write tools: separate server or flag? | **Flag `MCP_ENABLE_WRITE_TOOLS`** on one server; write tools are **not registered** when off (conditional spread, not a conditional handler) | 5.1 |
| Who may approve? | **`SLACK_APPROVER_USERS`** allowlist, fallback `SLACK_ONCALL_USERS`; non-approver → ephemeral "not authorized" | 5.2 |
| Audit schema | **Separate `remediations` table (1:N)** — not extra columns on `incidents` | 5.4 |
| LLM-proposed or rule-based? | **LLM proposes** (structured output) + **server-side validation** before the card | 6 |
| Approval expiry | **15 minutes, checked at click time** (not at post time) | 5.2 |
| Dry-run | **Mandatory**, its result is shown on the approval card | 5.3 |
| Namespace allowlist / blast radius | **Env var, enforced in the MCP server + RBAC** (not just the agent) | 5.5 |

## 4. Flow

```
Alert → investigate → RCA posted (existing)
                          ↓
        LLM proposal call (structured output) — only if a known action fits
                          ↓
        Server-side validate (whitelist + namespace allowlist); invalid → no card, log warn
                          ↓
        Dry-run the action → insert remediations row (status=proposed)
                          ↓
        Post APPROVAL CARD in the thread (Block Kit buttons)
           ┌─────────────────────────────────────────────┐
           │ 🔧 Proposed: restart deploy/payment-api       │
           │    namespace: payment · reason: OOM loop      │
           │    Predicted: pod payment-api-xyz restarts    │
           │    [ Approve ]   [ Reject ]                   │
           └─────────────────────────────────────────────┘
                          ↓ (approver clicks — handled by app.action, NOT the investigation loop)
        ack() <3s → update card "⏳ Executing..." → row-flip lock → execute MCP write-tool
                          ↓
        Update card ✅/❌ + write result to the remediations row
```

The investigation loop **ends after posting the card** — the rest of the flow
(approve/reject/execute) is handled entirely by a separate `app.action` handler. Do not
block the investigation loop waiting on approval.

## 5. Components

### 5.1 MCP write-tools (`devops-mcp-server`)
- New tools: v1 is just **`k8s_rollout_restart`**; `k8s_scale` / `k8s_rollout_undo` come later. Strict zod input (namespace + workload **required**).
- **Conditional registration via flag** — write tools **must not appear** in `listTools()` when the flag is off. The agent caches `listTools()` once at startup (`discoverTools()`), so a tool that is listed but fails on call makes the LLM loop. Wire it in `src/tools/index.ts` (the existing spread pattern), **not** as a conditional handler:
  ```ts
  const writeEnabled = process.env.MCP_ENABLE_WRITE_TOOLS === "true";
  const allTools: Tool[] = [
    ...kubernetes, ...prometheus, ...loki, ...tracing,
    ...(writeEnabled ? writeTools : []),
  ];
  ```
- **Behind `MCP_AUTH_TOKEN`** (already done) — a write tool is never unauthenticated.
- Every write tool supports **dry-run** (`--dry-run=server`) to feed the predicted effect into the approval card.

### 5.2 Approval gate (agent side, Slack)
- Block Kit message with **Approve/Reject buttons** (`actions` block; `action_id` carries the remediation id).
- **Interactivity:** Socket Mode → `app.action("approve_remediation", ...)` (no public URL — matches the current Socket Mode default). HTTP Mode needs an interactivity request URL (public).
- **Approver = `SLACK_APPROVER_USERS`** (fallback `SLACK_ONCALL_USERS`). Check `body.user.id` against the allowlist; non-approvers get an **ephemeral** "not authorized" — this never exposes the approver list to the channel.
- **Expiry: 15 minutes, checked in the handler at click time** (`created_at + 15m < now()`), not at post time. A card posted at 02:00 and approved at 02:14 is still valid; what's prevented is approving a stale 3am card first seen at 8am.
- **`ack()` must run < 3 seconds** (Slack hard timeout). Pattern:
  ```ts
  app.action("approve_remediation", async ({ ack, body, client }) => {
    await ack();                                   // < 3s, must come first
    await client.chat.update({ ..., text: "⏳ Executing..." });
    const result = await executeRemediation(...);  // MCP call, may take 10–30s
    await client.chat.update({ ..., text: result });
  });
  ```

### 5.3 Execution path
- On approve: the agent calls the MCP write-tool via the existing `MCPClient.callTool()`.
- **Dry-run is mandatory before execute** — if dry-run fails, abort and do not run the real action.
- **Idempotency / double-execute guard (atomic row-flip):** the button can be double-clicked, and under multi-pod, Socket Mode may deliver the interaction to any pod (especially on reconnect). Use the row as a lock:
  ```sql
  UPDATE remediations SET status='executing'
   WHERE id=$1 AND status='approved'
  ```
  Only one wins (atomic — same trick as dedup). **0 rows updated** = another process already executed → the losing pod **posts an ephemeral** "⚠️ This action is already being executed by another process." Never fail silently.

### 5.4 Audit trail (DB, `migration 002_remediations.sql`)
A **separate `remediations` table (1:N, FK to `incidents`)** — not extra columns on
`incidents`. A single incident that needs two actions (restart fails → scale) breaks the
1:1 approach immediately. This table also doubles as the **idempotency lock** (§5.3) and
the **duplicate-card guard** (below).

```sql
CREATE TABLE remediations (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT REFERENCES incidents(id),
  action TEXT NOT NULL,            -- e.g. "k8s_rollout_restart"
  params JSONB NOT NULL,           -- {namespace, workload, ...}
  status TEXT NOT NULL,            -- proposed | approved | rejected | executing | succeeded | failed
  proposed_by TEXT,                -- 'agent'
  approved_by TEXT,                -- Slack user id
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  executed_at TIMESTAMPTZ
);

-- Duplicate-card guard: at most one active remediation per incident.
-- SELECT-then-INSERT is NOT atomic across pods (TOCTOU); this index is the real
-- guarantee, not the SELECT. Without it, two pods can both insert → two cards.
CREATE UNIQUE INDEX one_active_remediation ON remediations (incident_id)
  WHERE status IN ('proposed', 'approved', 'executing');
```

> **`storeIncident` must return `id`.** It is currently `store(...): Promise<void>`. To
> link `remediations.incident_id`, change it to `Promise<number | null>` with
> `INSERT INTO incidents ... RETURNING id`. The caller in `investigateAlertInBackground`
> keeps `incidentId` to pass into the proposal flow.

> *Priority note:* `AlertDeduplicator` already prevents duplicate cards from the same
> alert. The TOCTOU above only opens up when an alert **re-fires after 12h** while an old
> card is still pending — so the unique index matters, but it isn't the hottest path.

### 5.5 Guardrails & enforcement layering (non-negotiable)
Defense in depth — each guard is enforced at the correct layer, **not just in the agent**:

```
RBAC ServiceAccount  ← floor, cannot be bypassed at the app layer
        ↑
MCP server validate  ← whitelist + namespace allowlist + block kube-system (trust boundary; holds cluster creds)
        ↑
Agent validate       ← UX only: don't show an invalid card
```

- **Action whitelist** — the agent may only propose from a fixed set; the MCP server rejects anything else.
- **Namespace allowlist is enforced in the MCP server** (which holds the credentials), not just the agent. A buggy/compromised agent still can't get through if the server + RBAC hold.
  ```
  ALLOWED_REMEDIATION_NAMESPACES=payment,orders,inventory   # empty = everything blocked
  MAX_SCALE_DELTA=5                                          # max replica change
  ```
  Always block `kube-system`, `kube-public`, `flux-system` **regardless of the allowlist**.
- **Least-privilege RBAC** — the agent/MCP server ServiceAccount gets only the verbs it needs (`patch deployments` for restart/scale; `create deployments/rollback`), scoped to allowed namespaces. This is the last line: even if every app-layer guard fails, RBAC holds.
- **Rate limit** (v2) — max N remediations per hour per namespace, to stop a flapping alert from restarting repeatedly.

## 6. Proposal generation

**LLM proposes + server-side validation.** After the RCA completes, a **separate LLM
call** with structured output produces the proposal:

```json
{ "action": "k8s_rollout_restart", "namespace": "payment", "workload": "payment-api", "reason": "OOM loop confirmed in pod logs" }
```

- The LLM already has full context (RCA, namespace, workload from tool results); a deterministic rule (`alertname → action`) would drift from reality and need maintenance.
- The output is **validated** (whitelist + namespace allowlist) **before** any DB insert or card. Failed validation → no card, log a warning. A bad LLM proposal = no card = no execution.
- **Trade-off (accepted):** +1 LLM round-trip per incident (token + latency). Cleaner and easier to validate than parsing RCA text. The alternative (a `propose_remediation` tool in the final RCA turn) is deferred — a separate call is safer.
- The call always runs on the **heavy** chain: `proposeRemediation` calls `llm.chat` outside any
  route context, and the router treats "no context" as heavy (`llm/router.ts`). That is correct —
  a proposal names a namespace and a workload — but it makes §6.1 worth the trouble.

### 6.1 When the proposal call is worth making (mention path only)

The flow above is the **alert** path, and it asks no question: an alert firing IS the evidence
that something needs fixing. Mentions are different. Every mention used to trigger a proposal
call, so `@agent status check` on a healthy cluster spent a heavy call to be told
`{"action": null}` — and once produced a hallucinated `k8s_rollout_restart` for a Deployment
that does not exist, caught only by the mandatory dry-run.

`worthProposing(userText, reply, isRca)` in `remediation/proposal.ts` gates it. Propose when
**any** of three hold, skip otherwise and log the reason:

1. the reply is an RCA — the agent only reaches for the incident template when it diagnosed a fault
2. the user asked for a change — an explicit request is sufficient evidence on its own (§6's prompt says as much), so it must survive the gate on a perfectly healthy cluster
3. the answer carries fault evidence — Kubernetes reason strings the agent quotes verbatim out of tool output (`CrashLoopBackOff`, `ImagePullBackOff`, `Unschedulable`, …)

**Deliberately asymmetric.** A false positive costs exactly what the ungated path costs — one
call that answers `null`. A false negative silently drops a legitimate fix. So every rule is a
reason to *spend* the call, and skipping is only what is left when none of them fire. Widen the
vocabulary when it misses; do not tighten it.

Two properties the tests pin down, both non-obvious:

- **A clean bill of health uses the same words a broken one does** — the reply that motivated
  this gate says "no alerts firing" and "0 restarts in the last hour". Negated forms are stripped
  before matching, the keyword group repeats (one negation covers a list: *"No alerts are firing
  and nothing is pending"* has to lose `firing` too), and the strip stops at a contrastive
  conjunction so *"no logs, **but** it is in CrashLoopBackOff"* keeps its evidence.
- **Indonesian action verbs need stem matching** — the affix carries the request, so `perbaiki`
  arrives as `diperbaiki` and `ganti` as `mengganti`. A `\b`-anchored stem matches none of them.

Text-only on purpose: no extra `prometheus_get_alerts` call to ask whether anything is firing.
The agent has just looked, so the answer is already in the reply, and a second call would add
latency and a failure mode to the one path whose entire point is spending less.

## 7. v1 scope (minimal cut)

The smallest thing that's actually useful **and** safe:
1. **One** write tool: `k8s_rollout_restart` (most common, reversible-ish, low blast radius).
2. Approval gate: Socket Mode `app.action` + `SLACK_APPROVER_USERS` (fallback oncall).
3. `remediations` table + unique index + `storeIncident` returns id.
4. Mandatory dry-run before execute; row-flip idempotency lock.
5. Guardrails: whitelist (trivially 1 action), namespace allowlist + block kube-system **in the MCP server**, least-privilege RBAC.

**Skip for v1:** scale/rollback, rate limiting, auto-remediation, multi-step. Add once the single-action flow is proven.

## 8. Implementation order

Steps 1 & 2 can run in parallel (server & agent are independent early on):

| Step | Repo | Task |
|------|------|------|
| 1 | `devops-ai-agent` | Migration `002_remediations.sql` (table + unique index) + `storeIncident` returns `id` |
| 2 | `devops-mcp-server` | Tool `k8s_rollout_restart` + flag `MCP_ENABLE_WRITE_TOOLS` (conditional spread) + dry-run + namespace/whitelist enforced server-side |
| 3 | `devops-ai-agent` | Proposal flow: LLM structured output → validate → insert `remediations` → post approval card |
| 4 | `devops-ai-agent` | `app.action` handlers `approve_remediation` / `reject_remediation` (ack → update card → row-flip → execute → result) |
| 5 | Ops | K8s RBAC: add `patch deployments` in the allowed namespaces |

Dependencies: Step 3 needs 1. Step 4 needs 2+3. Step 5 any time before deploy.

## 9. Dependencies / prerequisites
- ✅ MCP HTTP auth (done) — write tools must sit behind it.
- ✅ Migration system (done) — `002_*.sql` for the remediation schema.
- ⬜ Slack interactivity (Socket Mode `app.action` handlers) — new.
- ⬜ Agent/MCP server RBAC reviewed for least-privilege write verbs — ops task.

## 10. Known limitation / TECH DEBT — GitOps-managed workloads

> Recorded 2026-07-15. The spec-mutating actions shipped in v1.1 assume the workload is
> managed by direct `kubectl apply` / manual manifests. **In this cluster almost
> everything is Flux-managed**, so this limitation applies to most targets.

### The problem
Flux continuously reconciles cluster state back to the git source (interval here: 5m).
A direct patch on a Flux-managed workload is **silently reverted on the next reconcile**
— the approval card reports success, then the change quietly disappears. A false-success
remediation is worse than a refused one.

Per-action impact:

| Action | GitOps impact |
|--------|---------------|
| `k8s_rollout_restart` | ✅ **Safe** — the `restartedAt` annotation is not a field Flux/Helm manages (SSA field ownership); it survives reconciles |
| `k8s_set_image` | ❌ Reverted on next reconcile |
| `k8s_set_resources` | ❌ Reverted on next reconcile |
| `k8s_scale` | ❌ Reverted (and additionally fought by HPA if one targets the workload) |

### Near-term mitigation — ✅ SHIPPED (2026-07-17)
Implemented as `assertNotGitOpsManaged` in the MCP server's guardrails (unit-tested),
called by all three mutating handlers after reading the workload; also refuses plain
Helm-managed workloads (`app.kubernetes.io/managed-by: Helm` — lost on the next
`helm upgrade`). Original design:

**Detect Flux ownership server-side and refuse the mutating actions with an explanatory
error.** Flux-managed resources carry labels (`helm.toolkit.fluxcd.io/name` +
`.../namespace` from helm-controller; `kustomize.toolkit.fluxcd.io/name` from
kustomize-controller). The handlers already read the workload before patching — checking
labels is one more condition. Refusal message names the owning HelmRelease so the human
knows where the real fix lives. Dry-run then fails → **no misleading card is ever
posted**. `k8s_rollout_restart` stays allowed.
(Escape hatch if ever needed: `flux suspend` + patch + `resume` as a deliberate,
human-driven emergency path — NOT automated in this phase.)

### v2 — GitOps-aware remediation (PR flow) — ✅ IMPLEMENTED (2026-07-23)
**Now shipped as its own design + code: `DESIGN_gitops_pr_remediation.md`.** Several of the
open questions below were resolved differently than this original sketch — read that doc as
the source of truth. Key deviations: GitHub is reachable only from the private network, so
the PR is opened by the **llm-worker over SQS** (not an MCP tool in the cluster); auth is a
**PAT** for the initial phase (App later); the values key is found by **only changing a key
already set** in the HelmRelease values (no per-chart convention needed) and the file by
**grepping the current value** (no cluster→overlay config); all 3 mutating actions
(image / scale / set_resources) resolver-supported. The original sketch, kept for context:

For Flux-managed workloads the remediation must change the **source**, not the cluster:

```
RCA → proposal → target is Flux-managed (labels) →
  read the owning HelmRelease CRD (chart, values, sourceRef) →
  locate the values file in the GitOps repo (env overlay) →
  generate the change (e.g. values image.tag / resources / replicaCount) →
  open a GitHub PR (branch + commit + PR body linking the incident thread) →
  post the PR link in the Slack thread →
  approval gate = PR review + merge (GitHub takes over from Slack buttons) →
  Flux syncs after merge → agent can verify & report back in the thread
```

Notes / open questions to resolve before building:
- **Workload → values mapping is the hard part**: which values key controls the image/
  resources/replicas is chart-specific. For in-house charts, standardize a convention
  (`image.tag`, `resources.*`, `replicaCount`) and only support charts that follow it;
  refuse otherwise. Never guess.
- **Repo/path resolution**: HelmRelease → `sourceRef` → GitRepository URL; the env overlay
  path (e.g. `apps/dev/...` vs `apps/prd/...`) must be derived from cluster identity —
  needs an explicit config map of cluster → overlay path.
- **Credentials**: a GitHub App (scoped to the GitOps repo, PR-only permissions) over a
  PAT. The MCP server should hold it (trust boundary), exposed as e.g. a
  `[WRITE] gitops_propose_change` tool.
- **Audit**: the `remediations` row records the PR URL as `result`; status maps to PR
  lifecycle (proposed=PR open, succeeded=merged+synced, rejected=PR closed).
- The Slack approval card is still useful as the *initiation* gate ("open this PR?"),
  with the PR review as the second, stronger gate.

## 11. v2 (after v1 is proven)
- **Rate limiting** — max N remediations/hour/namespace via a Redis counter (`INCR remediation:{ns} EX 3600`), same pattern as dedup.
- **Did the approved action actually fix it?** — ✅ **SHIPPED (2026-08-08)** as an active check
  rather than the passive resolved-alert loop originally sketched here. `migrations/006` +
  `agent/remediation/verify.ts`: approving a card schedules a check **in Postgres** (default 300s
  later, `REMEDIATION_VERIFY_DELAY_SECONDS`), and whichever replica polls next claims it — so the
  verdict survives the pod that approved the action. The check is deterministic, no LLM: re-read
  the alert and the workload's pods, compare against a baseline snapshot taken at approval time,
  and record one of `recovered` / `unchanged` / `worse` / `inconclusive` on the `remediation_checks`
  row. `recallForAlert` joins the verdict in, which turns a failed fix into a **negative prior** —
  the agent can see it already tried this and it did not hold. Three rules that cost live debugging:
  - `k8s_list_pods` returns the pod **phase**, not container reasons — a CrashLoopBackOff pod is
    `Running` with `ready:false`, so readiness comes from the `ready` boolean
  - **`worse` triggers on readiness falling only.** A rollout replaces the pod set, so the old
    crashing pod's restart counter sits in the baseline while the new pods start at 0 — restart
    deltas compare different pods and cannot mean regression
  - `verdict` ≠ `status`. `status='succeeded'` only means the MCP call did not error
  - The verdict is an **agent** judgement: it goes to `remediation_checks`, never to
    `incident_feedback`, which is the human-confirmed tier
  The resolved-alert loop (roadmap §D) still runs alongside it and remains the passive confirmation.
- **Auto-remediation for low-risk + high-confidence** — e.g. confidence=High + action=restart + non-prod namespace → skip approval. **Explicit opt-in** via env (`ALLOW_AUTO_REMEDIATION_NAMESPACES`), never the default.
