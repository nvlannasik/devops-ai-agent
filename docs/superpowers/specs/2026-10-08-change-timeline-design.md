# Change timeline before the alert — design

Date: 2026-10-08. Sub-project 1 of 4 (change timeline → rollback/revert PR → topology
correlation → postmortem draft). Sub-project 2 consumes the commit SHAs this one produces;
sub-project 4 consumes the stored timeline.

## Goal

Most incidents follow a change. Today the model has to think of calling the right tools to
find out what changed, and often does not. On the alert path the agent now assembles a
**deterministic timeline of what changed in the alert's namespace in the 24 h before it
fired**, hands it to the model as data, shows it in the RCA card from data (never from the
model's prose), and stores it with the incident.

Success:
- An alert whose cause is a recent rollout gets an RCA that names that rollout (bench A14).
- The Slack card carries a `🕑 Recent changes` block built from the tool result.
- A source that could not be read is reported as unread, never as "no changes".
- Recorded replay cases keep replaying unchanged; the investigation never waits more than
  ~8 s for the timeline and never fails because of it.

Out of scope: rollback actions (sub-project 2), cross-namespace changes, ConfigMap/Secret
content diffs, the mention path (the model can call the new MCP tool itself there).

## Components

### 1. `k8s_change_timeline` — devops-mcp-server (new read tool)

Input: `{ namespace: string, sinceHours?: number (default 24, max 168) }`.

Output (JSON):
```ts
{
  namespace: string;
  window: { from: string; to: string };          // ISO
  changes: Array<{
    at: string;                                   // ISO
    source: "rollout" | "helm" | "config";
    kind: "spec-change" | "restart" | "chart-upgrade" | "values-changed" | "config-updated" | "created";
    workload: string;                             // "Deployment/orders-api", "HelmRelease/checkout-gateway", "ConfigMap/app-config"
    revision?: string;                            // RS revision or Helm release version
    diff?: Array<{ field: string; from: string; to: string }>;
  }>;
  helmReleases: Array<{ name: string; namespace: string }>;  // HRs that deploy INTO this namespace
  unread: string[];                               // sources that failed, e.g. "helm: 403 forbidden"
}
```

Sources:
- **Rollout.** ReplicaSets in the namespace owned by a Deployment, created inside the window. Each is
  compared with the previous revision of the same Deployment (`deployment.kubernetes.io/revision`).
  The comparison is the **pod template**, not the image tag: in this cluster every revision runs
  `:latest`, so a tag diff says nothing. Compared per container: `image`, `env` (name → value), `args`,
  `command`, `resources.requests/limits`, `readinessProbe`/`livenessProbe` (serialized). A diff whose
  only change is the `kubectl.kubernetes.io/restartedAt` template annotation is `kind: "restart"`
  with no `diff`. Revision 1 is `kind: "created"`. StatefulSet/DaemonSet use `ControllerRevision`
  the same way.
- **Secrets never leak.** An env var from `valueFrom.secretKeyRef` shows as `secret:<name>/<key>`,
  never its value. Literal env values are shown; they are already visible through the existing
  pod-describe tools.
- **Helm.** HelmReleases (`helm.toolkit.fluxcd.io/v2`) whose `spec.targetNamespace` (or own
  namespace when unset) is the namespace. Each `status.history` entry whose `lastDeployed` is inside
  the window becomes a change: a chart version different from the next-older entry is
  `chart-upgrade`; the same chart with a different `configDigest` is `values-changed`. The
  HelmRelease list is returned in `helmReleases` whether or not it changed.
- **Config.** ConfigMaps referenced by a workload in the namespace (env `configMapKeyRef`,
  `envFrom`, volumes) whose latest `managedFields[].time` is inside the window: `config-updated`,
  no diff (Kubernetes keeps no previous content).
- Each source is read independently. A failing source lands in `unread` with its error, and the
  other sources still return.
- Sorted newest first, capped at 50 changes.

Pure functions (exported for tests): `diffPodTemplates(prev, next)`, `helmChanges(history, window)`,
`configChanges(configMaps, window)`.

### 2. `history` op — llm-worker (GitOps SQS contract, change on both sides)

Request on the gitops request queue:
```ts
{ requestId, op: "history", helmRelease: { name, namespace }, pathPrefix?: string, since: string /* ISO */ }
```
`action` and `changes` are NOT required for `op: "history"`. `parseGitOpsRequest` validates per op.

Response on the shared response queue:
```ts
{ requestId, response: { ok: true, op: "history", commits: Array<{ sha: string; at: string; author: string; message: string; url: string; paths: string[] }> } }
| { requestId, response: { ok: false, reason: string } }
```
- The worker finds the files that belong to the HelmRelease with the same candidate-file logic
  `runGitOps` uses (overlay under `pathPrefix`, plus the base derived by `deriveBasePrefix`). It then
  lists commits per file via GitHub `GET /repos/{o}/{r}/commits?path=<file>&since=<since>`,
  de-duplicates by sha, sorts newest first, and caps at 10.
- `author` is the GitHub login, falling back to the commit author name. **Never an email.**
- `message` is the first line, truncated to 120 chars.
- Read-only: no branch, no write.
- `GitOpsBackend` gains `listCommits(path: string, since: string)`.

### 3. Agent — `src/agent/changes/`

```ts
collectChanges(deps: { mcp, gitops? }, namespace: string, alertAt: Date, subjects: string[]): Promise<ChangeTimeline>
renderForModel(t: ChangeTimeline): string      // the [CHANGE TIMELINE] block
renderForSlack(t: ChangeTimeline): Block | null // the 🕑 Recent changes block; null when nothing to show
```
`ChangeTimeline` = the MCP output's `changes` + `commits` (merged per HelmRelease) + `unread` (MCP
`unread` plus per-source failures on the agent side) + `subjects`.

- **Window:** 24 h before the alert's `startsAt` (earliest in the group) up to now.
- **Namespace-wide on purpose.** The cause is often a neighbour: the alert is on `checkout-gateway`,
  but `orders-api` was redeployed. This also avoids new logic to guess a workload from alert labels.
  Changes on a workload named in `subjects` (from `distinctSubjects()` + pod-name prefixes) are
  marked and sorted first.
- **Calls.** One `k8s_change_timeline` call (5 s timeout), then `history` for up to 3 of its
  `helmReleases` in parallel (8 s timeout each, same `pathPrefix` auto-detection the PR flow uses).
  The two run sequentially only because the HelmRelease list comes from the first.
- **Placement.** Called in `investigateAlertInBackground` (`src/app/index.ts`) in the same
  `Promise.all` as `recallIncidents`/`recallRemediations`. `renderForModel` is prepended to the issue
  beside the memory block. Because replay replays the recorded issue, recorded cases never execute
  this code: no flag, no divergence. New traces carry the block in their recorded issue.
- **Model block.** Framed as data, like the injection framing: a header line stating that it is a
  machine-collected list, the window, then one line per change (`<at> <workload> <kind> rev <n>:
  <field> <from> → <to>`), then commits, then `unread:` lines. When nothing changed and nothing
  was unread: `No changes recorded in <namespace> in the window.` When a source was unread, the
  block says that this source was NOT read, and that absence of changes from it is unknown.
- **Slack block.** Appended to the RCA card after the run footer, built from data: at most 5
  entries, subjects first, a commit rendered as `<url|sha7>` plus its message. Section text is capped
  under 3000 chars. When the card post fails `invalid_blocks`, `postRca`'s existing retry drops this
  block together with the tables. Unread sources get one context line: `Not read: git history (timeout)`.
- **Storage.** `migrations/012_incident_changes.sql`: `ALTER TABLE incidents ADD COLUMN changes jsonb`.
  Written with the incident row. The dashboard incident page shows it as a small table under the RCA.
- **Bench.** `bench/run.ts` calls the same `collectChanges` with the same placement, so the feature
  is measured. Bench namespaces are not Flux-managed, so only the cluster side runs there.

## Error handling

| Condition | Behaviour |
|---|---|
| MCP tool errors or times out | timeline = `unread: ["cluster: <err>"]`; investigation proceeds |
| One MCP source fails (e.g. HelmRelease RBAC) | that source in `unread`, others shown |
| Worker not configured (`GITOPS_*` unset) | git source skipped silently (not "unread": it does not exist here) |
| Worker times out / `ok:false` | `unread: ["git history (<reason>)"]` |
| Nothing changed, everything read | explicit "No changes recorded" line; Slack block omitted |
| Slack refuses the block | existing `postRca` retry without tables/timeline |

The invariant that the tests pin: **an unread source is never rendered as "no changes"**. This is
the same rule as `AlertState` `unknown ≠ none` in `remediation/verify.ts`.

## Testing

- mcp-server: `diffPodTemplates` (env value change; image change; restart-only → `restart`;
  `secretKeyRef` rendered as a reference, its value absent from the output; probe change),
  `helmChanges` (chart upgrade vs values change, window filter), `configChanges`, and the handler
  returning partial results with `unread` when one source throws.
- worker: `parseGitOpsRequest` accepts `history` without `action`/`changes` and still rejects a bad
  `dry_run`; `runGitOps` history with a fake backend (dedupe by sha, cap, newest first, no email in
  `author`, no write method called).
- agent: `collectChanges` with fake MCP and gitops (all ok; MCP timeout; worker timeout; worker
  absent); `renderForModel` — the unread invariant, subjects first; `renderForSlack` — cap of 5,
  under 3000 chars, null when empty; the migration applies.
- bench: new case `A14-env-change-crash`. Setup deploys a healthy Deployment, waits for the
  rollout, then changes one env var so the new revision crashloops. Expect: the RCA names the env
  change (variable name and the revision) as the cause.
- Full suites green in all three repos; replay cases unchanged.

## Contract and docs updates (same commits)

- Workspace `CLAUDE.md`, section "agent ↔ llm-worker (GitOps PR flow)": the `history` op.
- `devops-ai-agent/docs/DESIGN_gitops_pr_remediation.md` §6: the `history` op.
- `devops-ai-agent/CLAUDE.md`: a gotcha bullet for the timeline (placement before `investigate()`,
  unread ≠ none). `README.md`: feature row.
- `devops-mcp-server/README.md`: the new read tool (55 read tools).
- Chart/RBAC: the mcp-server ClusterRole must allow `list` on `replicasets`, `controllerrevisions`,
  `configmaps` (metadata only is enough) and `helmreleases.helm.toolkit.fluxcd.io`. Checked during
  implementation; any missing verb is added to `devops-ai-helm-charts`.

## Deploy order

1. mcp-server (new tool; the agent tolerates its absence: unknown tool → unread).
2. llm-worker (new op; an old worker answers `history` as a poison message → the agent's 8 s
   timeout → unread).
3. agent (migration 012 runs at startup).
