# Rollback and revert-PR remediation — design

Date: 2026-10-09. Sub-project 2 of 4 (change timeline → **rollback / revert PR** → topology
correlation → postmortem draft). It builds on sub-project 1 (spec
`2026-10-08-change-timeline-design.md`): the change timeline is both the evidence a rollback is
proposed from and the gate it must pass.

## Goal

The most common real fix for an incident that follows a change is to undo the change. The agent
can investigate that change today (the timeline names it), but it cannot propose undoing it.
`k8s_set_image` cannot stand in: every image in this cluster is `:latest`, so a bad rollout is a
pod-template change (env, args, resources, probes), not a tag. A Flux-managed workload cannot be
rolled back in the cluster either, because Flux reverts the patch on its next reconcile, so there
the undo is a revert of the Git commit.

Success:
- Bench A14 (an env change crashloops a new revision) gets a `k8s_rollout_undo` card back to
  revision 1, through the same gate chain production uses.
- On a Flux-managed workload whose timeline holds the causing commit, the card opens a revert PR
  for that commit.
- A rollback the timeline does not support never reaches a card. That includes a revision the
  model invented, a target with no recorded change, and a timeline that was unread.

Out of scope: StatefulSet/DaemonSet rollback; reverting a commit that later commits have touched
(no 3-way merge); multi-commit reverts; rollback on the mention path when the thread has no
timeline.

## Components

### 1. `k8s_rollout_undo`, a devops-mcp-server write tool

Registered only under `MCP_ENABLE_WRITE_TOOLS=true`, beside the other write tools, behind the
same guardrails (namespace allowlist, provenance checks) and with the same `dryRun` parameter.

Input: `{ namespace: string, name: string, kind?: "deployment", toRevision: number, dryRun?: boolean }`.

- **Plain workload.**
  - Find the ReplicaSet the Deployment owns whose `deployment.kubernetes.io/revision` equals `toRevision`.
  - Patch the Deployment's `spec.template` to that ReplicaSet's `spec.template`, with the `pod-template-hash` label removed from `metadata.labels`. This is what `kubectl rollout undo --to-revision` does.
  - `dryRun: true` uses a server-side dry-run.
  - The result names the revision rolled back from and to, and the template diff (the same `diffPodTemplates` the timeline uses).
- **Flux-managed workload** (the existing `gitOpsPreviewOrRefuse` provenance check): no patch.
  - The dry-run returns the existing preview shape with `action: "rollback"`, `changes: []` and `toRevision`. This is how the agent knows to take the PR path.
- **Refusals:**
  - no ReplicaSet with that revision;
  - `toRevision` is the revision currently running;
  - `kind` other than `deployment`;
  - a workload outside the allowlist.
- **RBAC:** `patch` on `deployments` already exists for `k8s_rollout_restart`, and `list` on `replicasets` already exists. No chart change.

### 2. `revert_pr`, a llm-worker op (GitOps SQS contract; change both sides together)

Request on the gitops request queue:
```ts
{ requestId, op: "revert_pr", helmRelease: { name, namespace }, sha: string, pathPrefix?: string,
  dryRun?: boolean, incident?: { summary?: string; threadUrl?: string } }
```
Response:
```ts
{ ok: true, op: "revert_pr", dryRun: true,  paths: string[], diff: string }
{ ok: true, op: "revert_pr", dryRun: false, paths: string[], prUrl: string }
{ ok: false, reason: string }
```
- **Which files.** Take the files of the HelmRelease: overlay and base, found with the same candidate-file reader and the metadata-name matcher `history` uses. Keep only those the commit `sha` touched (GitHub `GET /repos/{o}/{r}/commits/{sha}` → `files[].filename`). If there are none, refuse: "commit <sha7> does not touch HelmRelease <name>".
- **Clean revert only.** For each touched file, the content at HEAD must equal the content at `sha`. If they differ, a later commit changed the file, so refuse "not a clean revert: <path> changed after <sha7> (by <later sha7>)". The new content is the file at `sha^`, the first parent. A file that `sha` created is refused (no file deletes).
- **`dryRun: true`** returns the unified diff and writes nothing.
- **`dryRun: false`** re-checks cleanliness against the current sha, then creates branch `revert/<hr>-<sha7>-<requestId8>`, commits each file, and opens PR "Revert <sha7>: <first line of message>". The body carries the incident summary and thread link, as `open_pr` does.
- **Read-only cache.** The 10-minute candidate-file memo is NEVER used here: this op writes a file from content it read (the same rule as `dry_run`/`open_pr`).
- **Backend.** `GitOpsBackend` gains `commitFiles(sha): Promise<string[]>` and `fileAt(path, ref): Promise<string | null>`. Writing reuses `createBranch`/`putFile`/`openPr`.

### 3. Agent

**Proposal action.** `k8s_rollout_undo` goes in `parseProposal`, `PROPOSABLE_ACTIONS` with its numbered JSON shape in `buildProposalPrompt`, `prompts/system.md` `## Execution & Remediation`, and the MCP tool. That is the four-places rule in `CLAUDE.md`, and the existing `prompt-offers-every-parseable-action` tests pin the first two.
- The prompt line: propose it only when the investigation names a recent change to the workload as the cause. `toRevision` is the revision just before that change.

**Timeline per thread.** `DevOpsAgent.collectChanges` gains a `threadId` and keeps the result in a per-process map (bounded, 24 h). `timelineFor(threadId)` reads the map, then falls back to `incidents.changes` by `thread_ts`, so a later mention, or another replica, still sees it. It returns `null` when neither has one.

**Rollback gate** (`refusalFor`, new name `remediation-rollback` in `GATE_NAMES`). Runs for `k8s_rollout_undo` only, user requests included, and fails closed like the quarantine gate:
- No timeline for the thread, or its rollout source unread → refuse: "no change timeline for this thread; a rollback needs the change it undoes".
- Find changes on `Deployment/<name>` with kind `spec-change` or `restart`, newest first. The allowed target is `revision - 1` of the newest one. Anything else is refused with the allowed revision named: "propose it again with toRevision: N". The existing re-ask can then correct it.
- No such change → refuse: "the timeline records no change to `<ns>/<name>` to undo".
- The gate makes no tool calls, so recorded replay cases do not diverge.

**PR path** (the dry-run returned a `rollback` preview):
- Pick the newest commit in the thread's timeline whose `helmRelease` is the preview's HelmRelease. The agent picks it; the model never supplies a sha.
- If there is none, refuse: "no Git commit in the timeline for this HelmRelease". If the timeline shows `values-changed` with no commit, that is the drift case and is left to the existing `flux_reconcile` flow.
- Send `revert_pr` with `dryRun: true`. On `ok`, post the card with the diff and the commit link. On approval, send `dryRun: false` and post the PR URL. On a refusal, post no card and log the reason, as the `open_pr` flow does.
- No post-remediation check (nothing is live until merge and sync).

**Card wording.**
- Cluster: "Roll back `ns/Deployment/name` to revision N", with the template diff (`worker.env.QUEUE_MODE streaming → batch`).
- PR: "Open a revert PR for `<sha7>` <message>".

**Verification.** The cluster path returns the Deployment as `target`, so the existing durable check runs.

## Error handling

| Condition | Behaviour |
|---|---|
| Thread has no timeline / rollout source unread | gate refuses; no card |
| Model's `toRevision` ≠ revision before the newest change | gate refuses naming N; one re-ask |
| Target ReplicaSet gone at execution | MCP refuses; remediation `failed`; nothing patched |
| A later commit touched the file | worker refuses "not a clean revert"; no card |
| Commit does not touch the HelmRelease files | worker refuses; no card |
| Worker timeout | no card (current PR behaviour) |
| Second rollback for the same target | existing duplicate guard |

## Testing

- **mcp-server:**
  - The template is taken from the target ReplicaSet with `pod-template-hash` removed.
  - Refusals: missing revision, current revision, non-Deployment kind.
  - A Flux-managed workload's dry-run returns the `rollback` preview.
  - The returned diff matches `diffPodTemplates`.
- **worker:**
  - A clean revert writes `sha^` content.
  - A later commit → refusal naming that commit.
  - A commit not touching the HelmRelease → refusal; a file created by `sha` → refusal.
  - `dryRun` calls no write method; the history memo is never used.
  - Parse accepts `revert_pr` and still rejects malformed `dry_run`.
- **agent:**
  - Gate: the right revision passes; the wrong revision is refused naming N; no timeline → refused; an unread rollout source → refused; no change to that workload → refused. It makes no tool calls.
  - Parser and prompt list stay in sync.
  - The PR path picks the sha from the timeline, ignores a sha in the model's params, and does not take the PR path when the timeline has no commit.
  - `timelineFor` falls back to the DB.
- **bench:** A14 `expect` becomes `{ "action": "k8s_rollout_undo", "namespace": "bench-a14", "target": "invoice-worker", "params": { "kind": "deployment", "toRevision": "1" } }`. `params` is an exact match in `bench/score.ts`; `changed` means "differs from the broken value", so it is the wrong field here. The two `rca.must` checks stay. Run 3 attempts after deploy.
- Full suites green in all three repos; replay cases unchanged.

## Contract and docs updates (same commits)

- Workspace `CLAUDE.md` GitOps contract bullet: the `revert_pr` op.
- `devops-ai-agent/docs/DESIGN_gitops_pr_remediation.md` §6: `revert_pr`.
- `devops-ai-agent/CLAUDE.md`: the four-places list now includes `k8s_rollout_undo`; a gotcha bullet on the rollback gate (fails closed, reads the thread's timeline, never takes a sha from the model).
- `README.md`: the Guarded Remediation row lists rollback.
- `devops-mcp-server/README.md`: the write tool (8 write tools).

## Deploy order

1. mcp-server (new write tool; an older agent never proposes it).
2. llm-worker (new op; an older agent never sends it).
3. agent.
