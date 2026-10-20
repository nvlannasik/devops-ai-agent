# Guarded remediation (approval-gated execution)

Design records: [`DESIGN_guarded_remediation.md`](DESIGN_guarded_remediation.md) and
[`DESIGN_gitops_pr_remediation.md`](DESIGN_gitops_pr_remediation.md). Settings:
[CONFIGURATION.md](CONFIGURATION.md#remediation-and-incident-lifecycle).

When the MCP server has write tools enabled (`MCP_ENABLE_WRITE_TOOLS=true` +
`ALLOWED_REMEDIATION_NAMESPACES` there), the agent may propose **one** remediation after
an RCA (alert-driven or mention-driven). It is off unless the MCP server enables write tools.

## Whitelisted actions

| Action | When proposed | Extra guardrails |
|--------|---------------|------------------|
| `k8s_rollout_restart` | transient faults a clean restart plausibly fixes | — |
| `k8s_set_image` | RCA shows a wrong/nonexistent image AND evidence names a working one, or the user explicitly requests a tag | never invents tags; `container` optional (auto-resolved when the workload has one container) |
| `k8s_set_resources` | OOMKilled / resource exhaustion | only provided values patched |
| `k8s_scale` | under-capacity (load, HPA at max) | `MAX_SCALE_DELTA` bound; scale-to-zero only as a **quarantine** of a workload a `k8s_recommend_resources` run in the same thread listed as idle |
| `k8s_delete_pod` | ONE pod wedged/crash-looping while siblings are healthy | only controller-owned pods (ReplicaSet/StatefulSet/DaemonSet — the controller recreates it); GitOps-safe |
| `k8s_delete_orphan` | an orphaned object (e.g. a ConfigMap nothing references) found by a scan in the same thread | the manifest is backed up to Postgres and posted into the thread before the delete; the server re-checks provenance/ownership/age live |
| `k8s_rollout_undo` (rollback) | a bad rollout on the thread's change timeline | gated on the timeline; on a Flux-managed workload it opens a **revert PR** (`revert_pr`) instead of patching the cluster |

All workload actions support deployment/statefulset/daemonset (except `k8s_scale`: no daemonset).

## The gate chain

Before a card is posted, the proposal passes one **gate chain** (`refusalFor`, shared with the
benchmark): placeholder and fabricated-evidence checks, asks-for-input, replacement/no-op (e.g. a
restart of a workload whose pods are healthy, an OOM fix that shrinks memory, an image "change" to
the image already running, a restart that cannot fix an RBAC `forbidden`), resource fault,
scale-out, ungrounded target, offer mismatch and duplicate target. A refusal gets one re-ask with
the refusal text; the re-asked proposal runs the chain again.

An alert firing is evidence enough to propose. A **mention** is not, so the proposal call there
runs only when the reply is an RCA, the message asked for a change, or the answer actually
contains fault evidence — otherwise `@agent status check` on a healthy cluster would spend a
heavy LLM call to be told there is nothing to do. Alerts are never gated this way.

## Flow

```
RCA posted → agent proposes (separate LLM call, whitelist-validated)
          → mandatory server-side dry-run (bad target / blocked namespace = no card)
          → approval card in the thread:  [ ✅ Approve ]  [ 🚫 Reject ]
          → approver clicks Approve → atomic claim (double-click/multi-pod safe)
          → execute → card updated ✅/❌ → full audit trail in the `remediations` table
          → verification scheduled in Postgres (default 5 min later)
          → any replica picks it up → verdict posted into the thread:
            recovered / unchanged / worse / inconclusive — and remembered
```

**Nothing ever executes without a human click.** Cards expire after 15 minutes (checked at
click time). Approvers = `SLACK_APPROVER_USERS` (fallback `SLACK_ONCALL_USERS`) — the card
@-mentions them so they get notified.
Requires **Interactivity enabled** on the Slack app (works over Socket Mode — no public URL).

## Post-remediation verification

Durable, not a timer: an executed remediation schedules a check row in Postgres, any replica
claims it once due, and the verdict (`recovered` / `unchanged` / `worse` / `inconclusive`) is
posted into the same thread and remembered. PR remediations get no check — nothing is live until
merge+sync.

## Remediation memory

Past executed remediations (+ their PRs/outcomes and verification verdicts) for the same alert are
recalled into future investigations & proposals, so a recurrence's proven fix isn't re-proposed —
and a fix that didn't work comes back as a negative prior. All remediations persist in the
`remediations` table (change from→to, file, PR URL, status). See [MEMORY.md](MEMORY.md).

**Recurrence shortcut:** when incident memory holds a CONFIRMED prior for the same alert
and fresh evidence matches, the agent may reply concisely ("known recurrence + confirmed
fix") instead of the full RCA card — incident store and the remediation proposal still run.

## GitOps guard

> ⚠️ On Flux/Helm-managed workloads a direct spec patch would be reverted
> by the next reconcile, so the spec-mutating actions (`set_image`/`set_resources`/`scale`)
> don't patch directly. `rollout_restart`/`delete_pod` stay allowed (reconcile-safe).
> - **Flux HelmRelease + `GITOPS_REMEDIATION_ENABLED=true`:** the remediation opens a **PR**
>   against the GitOps repo instead (image + scale; the card shows the diff, approve opens
>   the PR, merge applies it). The PR is opened by the **llm-worker** — the private-network
>   bridge to GitHub Enterprise. The overlay path is auto-detected from the Flux Kustomization.
>   See [`DESIGN_gitops_pr_remediation.md`](DESIGN_gitops_pr_remediation.md).
> - **Drift** (the repo declares a value the cluster is not running): the worker refuses the PR
>   and the agent proposes `flux_reconcile` instead — restore what Git declares, still approval-gated.
> - **Otherwise** (flow disabled, Kustomize, or plain Helm): refused with the reason posted
>   to the thread, naming where the real fix lives.
