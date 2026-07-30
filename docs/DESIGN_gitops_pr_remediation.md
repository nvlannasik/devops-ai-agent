# Design — GitOps-aware Remediation (PR flow)

> **Status: IMPLEMENTED (2026-07-23)** — v2 of Guarded Remediation, all of §10 steps 1–4
> shipped across the 3 repos. Extends `DESIGN_guarded_remediation.md` §10/§11.
> **Key constraint (§4):** GitHub Enterprise is reachable ONLY from the private network, so
> all GitHub operations run in the **llm-worker** (the private-network SQS bridge) — NOT the
> cluster. **Remaining before production use:** ops step 5 (mount a repo-scoped PAT — chosen
> for the initial phase — in the worker, create the `gitops` queue, branch protection);
> live E2E test on a real GHE + Flux repo. All 3 mutating actions (image / scale /
> set_resources) are resolver-supported.

## 1. Goal

For a Flux-managed workload, a remediation must change the **source of truth (Git)**, not
the live cluster — Flux reverts direct patches on its next reconcile. Turn the current dead
end ("🚫 managed by Flux, change it in the GitOps repo") into an actionable flow: the agent
opens a **Pull Request** against the GitOps repo that makes the exact change, posts the PR
URL into the incident thread, and lets PR review + merge be the deployment gate. Flux syncs
after merge; the existing resolved-alert loop + status check confirm recovery.

Covers the 3 spec-mutating actions already whitelisted: `set_image`, `set_resources`,
`scale`. (`rollout_restart` and `delete_pod` stay on the direct-patch path — they are
GitOps-safe and never refused.)

## 2. Non-goals (v2)

- No arbitrary Git commits. This is a **typed** action that changes exactly ONE already-set
  scalar in a HelmRelease's `spec.values` — the same "never a generic patch" principle as
  the k8s write tools, carried into Git.
- No creating new values keys, no editing charts, no multi-file changes.
- No auto-merge. The PR is opened; a human reviews and merges. (Merge = the real gate.)
- No GitHub webhook / merge-event infrastructure. Verification rides the existing
  resolved-alert loop, not a new event source.
- No support for non-HelmRelease sources in v2 (raw Kustomize Deployment manifests are a
  later extension — see §11).

## 3. Two insights that make this tractable

The naive version has two seemingly-impossible sub-problems. Both are sidestepped, not
solved head-on — and both degrade to an honest **refuse + report**, never a wrong guess.

### 3.1 "Which values key do I change?" → the value already tells us

Third-party charts expose different values schemas (`controller.image.tag` vs `image.tag`
vs a digest; `replicaCount` vs `replicas`). Guessing a chart's schema is a losing game.

Instead: **only change a key that is already set in the HelmRelease `spec.values`.** We know
the *current* value from the cluster (image tag `v1.15.1`, memory limit `512Mi`, replicas
`1`). Walk `spec.values` for a leaf that (a) matches the current value AND (b) sits under a
key-name consistent with the action. Unique match → that's the edit target. No match (value
not overridden, relies on chart default) → **refuse**: "no `<field>` override in HelmRelease
`X` to change — add one manually first." Multiple matches → **refuse + report** (ambiguous).

Per-action candidate key-name patterns (value must equal the current cluster value):
- `set_image` → leaf under `image` / named `tag`; also handle `repository`+`tag` split and a
  combined `image: repo:tag` string. Digest present → refuse (can't safely rewrite a digest).
- `set_resources` → leaf under a `resources.{requests,limits}.{cpu,memory}` subtree.
- `scale` → leaf named `replicaCount` / `replicas`. (Bare integers are ambiguity-prone —
  the key-name constraint is what disambiguates here; still refuse if >1 candidate.)

### 3.2 "Which file in the repo do I edit?" → grep the current value

base vs `apps/{dev,stg,prd}` overlays, and a kustomize patch can override the base
HelmRelease's values. Statically resolving the kustomize build to a source file is complex.

Instead: **grep the repo for the current value + HelmRelease name.** The effective value we
read from the cluster is the one that actually renders, so the file literally containing
`tag: v1.15.1` near HelmRelease `X` IS the authoritative edit target (an overlay patch wins
over base precisely because its value is the effective one). Exactly one file → edit it.
Zero or many → **refuse + report**. `// ponytail:` grep-based location; upgrade to a real
kustomize-graph resolver only if this proves too coarse in practice.

Consequence: **no cluster→overlay config needed.** The value-grep self-locates the file
regardless of which overlay set it. (An optional `GITOPS_PATH_PREFIX` can scope the search
to a subtree for safety, but it is not required.)

**In practice, base + overlay both define the HelmRelease** (the overlay is a full
`kind: HelmRelease` strategic-merge patch), so a name-match finds ≥2 files → ambiguous
refusal. Solved by scoping the search to the right overlay, **auto-detected from Flux's own
config** (§3.3) — no static per-environment config.

### 3.3 Auto-detecting the overlay path (per environment, zero config)

The agent is deployed per-cluster; its environment is knowable from Flux. A workload's
**HelmRelease CR** carries `kustomize.toolkit.fluxcd.io/{name,namespace}` labels (stamped by
the Flux Kustomization that applied the HR — the HR CR *is* applied by kustomize-controller,
unlike the Helm-rendered workloads). That Kustomization's **`spec.path`** is the environment
overlay, e.g. `./apps/dev/applications`. Chain (agent side, reusing the read-only
`k8s_get_custom_resources` tool):

```
workload → HelmRelease {name,namespace}  (from helm.toolkit.fluxcd.io/name label — Flux adds it to the workload)
  → read HR CR → kustomize.toolkit.fluxcd.io/{name,namespace}
  → read Kustomization CR → spec.path  → pathPrefix "apps/dev/applications"
```

The agent sends `pathPrefix` in the gitops request; the worker scopes `listYamlFiles` to it
→ only the dev overlay's `release.yaml` → unique HR file, no ambiguity, and the correct
per-env file. Applications vs systems is handled automatically (each HR points at its own
Kustomization/path). Best-effort: on any miss the worker falls back to `GITOPS_PATH_PREFIX`.

### 3.4 Value only in base → ADD it to the overlay (don't refuse over a trivial gap)

Overlays override base per-env; a value may be set only in **base** (e.g. `replicaCount`,
resources), so a per-env edit finds nothing in the overlay. Rather than refuse "not set
inline" over that, the worker: (a) derives the base prefix from the overlay prefix
(`apps/dev/systems` → `apps/base/systems`, env segment → `base`), fetches the base HR file;
(b) learns the value's **path** from base by KEY (not value — so it works even if the cluster
drifted from base); (c) **adds** that path to the overlay's `spec.values` via the `yaml`
Document API (`setIn` — creates the nested key cleanly, preserves the rest), overriding base
for that environment only. Safe by construction — the path is copied from base, never guessed
from the chart schema (still "only-change/add an existing key"). Scope: **scale + resources**
(image tags essentially always live in overlays already). Refuses if the value is in neither
overlay nor base (a genuine chart default) or if the base path is ambiguous. This is the one
place a `yaml` dependency is used — in-overlay edits stay line-based (minimal diff).

### 3.4b Cluster drifted from Git → reconcile, don't PR

§3.1's trick — "find the line whose value equals the workload's CURRENT value" — assumes the
cluster still matches Git. It doesn't when somebody edits the cluster directly
(`kubectl set image` on a Flux-managed workload). The incident context's `from` is then the
**drifted** value, which of course appears nowhere in the repo, and the value-matching search
comes back empty — indistinguishable from "the overlay never set this key". In practice that
surfaced as a wrong, unactionable refusal:

> Remediation not proposed — the value is not set in the overlay and can't be auto-added for
> this action — set it in the overlay values first

**The failed lookup is itself the drift signal.** When the value search finds nothing, the
resolver re-scans by KEY alone (`findKeyLines`). Exactly one hit whose value differs from the
cluster's ⇒ drift, returned as `{ok:false, reason, drift:{path, valuesKey, gitValue, clusterValue}}`.
Checked BEFORE the §3.4 base fallback — the key is right here, it just disagrees. Ambiguous
matches stay silent and fall through (never guesses).

The agent branches on `drift` before treating the reply as a refusal and proposes
**`flux_reconcile`** instead of a PR: annotate the owning HelmRelease with
`reconcile.fluxcd.io/{requestedAt,forceAt}` (= `flux reconcile helmrelease --force`) so Flux
re-applies what the repo declares. `forceAt` matters — `requestedAt` alone only re-evaluates
the release; in-cluster drift is reverted by the forced helm upgrade.

Direction is deliberate: **the repo is the source of truth**, so the fix restores Git's value
rather than writing the drifted value into Git. It stays approval-gated because the drifted
value is occasionally the intended one — in which case the human wants a PR declaring it, and
the card shows both values so they can tell.

`flux_reconcile` is the one spec-affecting write tool the GitOps guard does not refuse: it
introduces no new state. Its namespace guard runs on the **workload's** namespace (HelmReleases
live in the permanently-blocked `flux-system`) and the target release is derived from the
workload's own Flux labels, never named by the caller.

### 3.5 Multi-component charts → disambiguate by the workload's component

A chart may render several components each with their own `replicaCount`/`resources` (e.g.
`values.controller.replicaCount` + `values.proxy.replicaCount`). The remediation targets a
specific workload, which maps to a specific component. The MCP guard reads the workload's
`app.kubernetes.io/component` label and passes it through (preview → agent request → resolver).
When several values paths match, the resolver keeps only the one whose path contains that
component key (`narrowByComponent`). Layered with the edit path's value-match, that's two
disambiguation signals. Fail-safe: if the component doesn't narrow to exactly one (label
absent, or component not a values sub-key), it **refuses — never guesses**. (Edits already
disambiguate by value when components hold different current values; the component signal
covers the same-value case.) `// ponytail:` label-only; a workload-name → component fallback
could be added if charts omit the label.

## 4. Network topology (GitHub Enterprise is private-network only)

**Constraint:** GitHub Enterprise Server is reachable ONLY from the private network — the
same zone the private LLM lives in — NOT from the K8s cluster. So the cluster-side
components (agent, MCP server) cannot call GHE directly. GitHub operations must cross the
network boundary the same way LLM calls already do: over **SQS**, executed by a worker in
the private network. This mirrors the existing agent → SQS → llm-worker → private-LLM bridge.

```
  Cluster zone                          │  Private network zone
    devops-ai-agent ── SQS(llm) ───────────▶ llm-worker ──▶ private LLM
         │          ── SQS(gitops) ─────────▶ gitops handler ──▶ GitHub Enterprise
         ▼                                │        (GitHub App auth; private key lives here)
    devops-mcp-server ──▶ K8s API         │
    (GitOps guard: refuse + signal HR)    │
```

## 4.1 Split of responsibilities across the boundary

`gitops_propose_change` is split by what each side can reach:

- **Cluster side (agent + MCP server)** — everything that needs the K8s API. The GitOps
  guard already reads the workload to refuse; extend its refusal to carry the owning
  **HelmRelease {name, namespace}** and the **current field value** being changed. The agent
  already knows `newValue` (from the proposal) and `currentValue` (read during the
  investigation), so it has the full change context without any GHE access.
- **Private-network side (gitops handler)** — everything that touches GHE. Given
  `{repo, helmRelease, action, currentValue, newValue}` over SQS: locate the file by
  grepping the repo for `currentValue` near the HelmRelease (§3.2), resolve the values key
  (§3.1) against the **Git YAML** (more correct than the cluster object — the Git file is
  what we edit), compute the diff (dry-run) or open the PR (execute). No K8s access needed.

**Two SQS operations**, mirroring the llm request/response pattern (routed by `requestId`
over the shared FIFO response queue), on a **separate `gitops` request queue** so the LLM
contract stays untouched:
- `gitops.dry_run` → `{file, valuesPath, before, after, diff}` — feeds the approval card.
  Any unresolved step (key absent / file ambiguous / value not found) → `{error}` → the
  agent posts the reason, no card. Same "full validation, zero side effects" as a k8s dry-run.
- `gitops.open_pr` → `{prUrl}` — after approval: branch + one-file commit via the GHE
  **contents API** (no local clone), PR body links the incident thread + RCA + diff.

The approval machinery (proposal → card → atomic claim → audit → note-in-thread) is
unchanged; only the dry-run and execute steps become SQS round-trips instead of MCP calls
when the workload is GitOps-managed.

**Component placement (DECIDED): a second handler inside the existing `llm-worker`.** Its
role broadens from "LLM bridge" to "the private-network SQS bridge" — LLM and GHE are both
private resources it fronts for the cluster. Internal separation keeps concerns clean:
`src/llm/` (existing) vs `src/gitops/` (new), a separate `gitops` request queue, and the
GitHub App private key mounted into the same pod alongside the LLM path. Reuses the worker's
SQS polling loop, deployment, AWS creds, and private-network placement — no new service.

## 5. Flow end-to-end

```
1. Alert/user → RCA recommends "change image of X to Y"
2. Agent proposal LLM call → { action: set_image, namespace, workload, image, ... }   (unchanged)
3. Agent dry-runs k8s_set_image → MCP GitOps guard REFUSES, returning the owning
        HelmRelease {name, namespace} + the current field value
4. NEW: agent recognizes a GitOps refusal → routes to the PR path over SQS:
        gitops.dry_run { repo, helmRelease, action, currentValue, newValue }  → gitops handler (private net)
        → handler: locate file (grep currentValue), resolve values key against the Git YAML → diff
        • key absent / file ambiguous → {error} → agent posts the reason, no card
        • success → {file, valuesPath, diff} returned over SQS
5. Approval card: "🔀 GitOps remediation — Flux-managed.
        PR to `apps/dev/.../release.yaml`: `controller.image.tag`  v1.15.1 → latest
        [diff]   [✅ Approve — open PR]  [🚫 Reject]"   (mentions approvers)
6. Approve → gitops.open_pr over SQS → handler opens PR on GHE → {prUrl} → card updates:
        "✅ PR opened: <url> — review & merge to apply"   + [system note] in thread
7. Human reviews & merges. Flux reconciles (~minutes).
        Resolved-alert loop + a delayed status check confirm recovery in-thread.
```

**Separation of concerns:** the *proposal* (WHAT to change) is unchanged — the agent picks
the *execution path* (direct patch vs PR) based purely on whether the workload is
GitOps-managed. The model never has to know about Git.

**Two effective gates:** Slack approve (opens a PR — low-risk, reversible: just close it) +
merge (the real gate, GitHub review). Consistent with the current UX.

## 6. Auth — PAT (initial phase) or GitHub App (configurable base URL — GHE)

Lives in the **llm-worker** (the only component that reaches GHE) — NOT the cluster. Two
modes, PAT taking precedence when set:

- **PAT (`GITHUB_TOKEN`) — chosen for the initial phase** (registering a GitHub App was
  access-limited on the target GHE). Used directly as the `Authorization: Bearer`. Scope it
  to the GitOps repo: fine-grained PAT with `contents:write` + `pull_requests:write`, or a
  classic `repo` token where fine-grained isn't available. Tied to a user account and
  long-lived — acceptable as a stopgap; move to the App when access allows.
- **GitHub App** (preferred long-term): non-human bot identity, per-repo scope, short-lived
  installation tokens, higher rate limits.

App auth flow (hand-rolled with `node:crypto` — no new dependency; ~30 lines):
1. Build a JWT signed **RS256** with the app private key (`iss = appId`, `exp` ≤ 10 min).
   `crypto.createSign("RSA-SHA256")` over `base64url(header).base64url(payload)`.
2. Exchange it for an installation token: `POST {apiBase}/app/installations/{id}/access_tokens`.
3. Use that token (≤1h) as the bearer for contents/PR calls, via global `fetch` (Node 24).

Config (env) — on the **llm-worker**:
- `GITHUB_API_URL` — default `https://api.github.com`; GHE = `https://<host>/api/v3`.
- `GITHUB_TOKEN` — **PAT** (initial phase); used directly, takes precedence. Never logged.
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`(`_FILE`) — App mode (when no PAT); the key via mounted secret, **never logged**.
- `GITOPS_REPO` — `owner/repo` of the GitOps repository (the ONLY repo the tool may touch).
- `GITOPS_BRANCH` — base branch (default `main`).
- `GITOPS_PATH_PREFIX` — optional search-scope subtree (e.g. `apps/`).

On the **agent** side: the `gitops` SQS request-queue URL (the response queue is the shared
one it already uses). The agent holds no GitHub credentials.

**New cross-repo contract** (add to the workspace CLAUDE.md when built) — agent ↔ gitops
handler over SQS: `{ requestId, op: "dry_run"|"open_pr", repo, helmRelease:{name,namespace},
action, currentValue, newValue }` → `{ requestId, diff | prUrl | error }`, routed by
`requestId` on the shared FIFO response queue. Changing the shape breaks both sides.

> Alternative considered: `@octokit/auth-app` + `@octokit/rest`. Rejected for now to honor
> the project's "prefer stdlib / no new deps" rule — the JWT + 3 REST calls are small enough
> to own. Revisit if the surface grows.

## 7. Approval, audit & verification deltas

- **Card**: distinct GitOps variant (🔀, shows repo/file/valuesPath + diff). Approve opens
  the PR instead of patching; the button/claim machinery is identical.
- **Audit**: reuse the `remediations` row — `action` = the original (`k8s_set_image`), a
  flag/marker that it went the PR route, and `result` = the PR URL. `// ponytail:` store the
  PR URL in the existing `result` field, no schema change unless we later want to query PRs.
- **No 90s status check** for PR remediations — nothing is live until merge+sync. Instead a
  `[system note]` states verification happens post-merge, and the **resolved-alert loop** is
  the natural confirmation (alert stops firing → ✅). Optionally a longer delayed re-check.
- **Idempotency**: the atomic row-flip already prevents double-execute; additionally the
  branch name is derived from the remediation id, so a retry collides on branch/PR instead
  of opening a duplicate.

## 8. Security

- **Single-repo blast radius**: the tool may only ever touch `GITOPS_REPO`, only the one
  located file, only the one resolved scalar. If the located file resolves outside the
  configured repo/prefix → refuse. This is a typed action, not "commit arbitrary YAML".
- Enforcement layering unchanged: GitHub branch protection / required reviews (floor) → the
  narrow tool (one key, one file) → agent proposal whitelist (UX). Merge rights on the
  GitOps repo are the real authorization boundary.
- Private key handling: mounted secret, never logged, short-lived derived tokens.
- The PR body includes the incident thread link + RCA for reviewer context (provenance).

## 9. Open questions

- **Image split**: charts that store `repository` + `tag` separately vs a combined
  `image` string vs digest — v2 handles tag-in-`tag` and combined-string; digest → refuse.
  Enumerate the shapes actually used in this repo's HelmReleases before coding.
- **Multi-cluster**: ✅ handled — the overlay path is auto-detected from the Flux Kustomization
  `spec.path` (§3.3) and sent per-request, so one shared worker serves dev/stg/prd correctly.
- **HelmRelease values in a referenced ConfigMap/valuesFrom** (not inline `spec.values`) —
  out of scope for v2; detect and refuse with a clear message.

## 10. Implementation order

| Step | Repo/zone | Task |
|------|------|------|
| 1 | `devops-mcp-server` | ✅ **DONE (2026-07-23).** GitOps guard is now `gitOpsVerdict` (structured: `managed`/`prEligible`/`source`/`helmRelease`). The 3 mutating handlers, on a Flux HelmRelease + **dry-run**, return a structured PR preview `{gitOpsPrEligible, source, helmRelease, workload, action, container?, changes:[{field,from,to}], message}`; on execute (or Kustomize/plain-Helm) they refuse. Unit-tested. |
| 2 | `llm-worker` → `src/gitops/` | ✅ **DONE (2026-07-23).** `github-app.ts` (`node:crypto` RS256 JWT → installation token, configurable `apiUrl`), `github-client.ts` (thin tree/contents/branch/PR client over `fetch`, token cached), `resolve.ts` (locate HelmRelease file + line-based edit: **image/scale** single scalar, **set_resources** nested leaves via an indentation-tracked parent stack — `limits.memory` vs `requests.memory` — with multi-change support; refuses on ambiguity). No `yaml` dep — targeted line edit keeps diffs minimal. JWT + resolver unit-tested with fixtures. |
| 3 | `llm-worker` | ✅ **DONE (2026-07-23).** Generic `pollLoop` extracted from `startWorker` (LLM path untouched); a second loop runs on the `gitops` queue when `config.gitops.enabled`. `processGitOpsMessage` (parse → `runGitOps` → publish on the shared response queue) + `runGitOps`/`githubBackend` (dry_run → diff, open_pr → branch+commit+PR). `parseGitOpsRequest` + orchestration unit-tested (fake backend). |
| 4 | `devops-ai-agent` | ✅ **DONE (2026-07-23).** `SqsGitOpsClient` (standalone, mirrors `SQSLLMClient` — not a shared base, to keep the LLM critical path untouched); `parseGitOpsPreview` detects the MCP PR preview and `proposeRemediation` routes to `proposeGitOpsPr` (SQS `dry_run` → store PR-flavored remediation); `executeRemediation` branches on `params.gitops` → `executeGitOpsPr` (SQS `open_pr` → PR URL in `result`, no 90s check); GitOps card variant (diff block + file/key). Gated on `GITOPS_REMEDIATION_ENABLED`. Preview parser + card unit-tested. |
| 5 | Ops | Auth: **PAT** (initial phase) scoped to the GitOps repo (`contents`+`pull_requests` write), or a GitHub App; mount it **into the llm-worker pod** (`GITHUB_TOKEN` / the App key). Create the `gitops` SQS queue; branch protection / required review on the repo. **RBAC (MCP server SA):** the overlay auto-detect (§3.3) needs `get` on `helm.toolkit.fluxcd.io/helmreleases` + `kustomize.toolkit.fluxcd.io/kustomizations` (ClusterRole — HRs/Kustomizations live in `flux-system`/`flux-app`); without it the detect fails and the worker refuses on base+overlay ambiguity. |
| 6 | all three | ✅ **DONE (2026-07-28).** Drift → reconcile (§3.4b): `detectDrift`/`findKeyLines` in the worker's `resolve.ts` + `drift` on the refusal payload; `flux_reconcile` write tool in the MCP server (workload-derived HelmRelease, workload-namespace guard, CRD-discovered API version, `requestedAt`+`forceAt`); `proposeFluxReconcile` in the agent. Drift detection unit-tested (set_image, scale, absent-key negative case). |
| 7 | Ops | **RBAC for `flux_reconcile`:** `patch` on `helm.toolkit.fluxcd.io/helmreleases` (was `get` only) — added to the **dev** overlay in `gitops-devops-ai-manifest`; **stg/prd still pending**. The existing `get` on `customresourcedefinitions` covers the API-version discovery. |

Steps 2–3 are the bulk (the private-net handler). Step 4 is glue on the existing flow.
Start with `set_image` (most standardized values key), then `scale`, then `set_resources` —
same handler, widening the key-resolver.

## 11. Later (v3+)

- Raw Kustomize Deployment manifests (locate the Deployment YAML / add a kustomize `images:`
  transformer) — for workloads not rendered through a HelmRelease.
- Per-chart values-key config as a fallback when a key isn't already set (create-key), if
  only-change-existing-key proves too restrictive in practice.
- Merge-event verification (GitHub webhook → confirm sync) instead of leaning on the
  resolved-alert loop.
- Auto-close the PR if the incident resolves by other means before merge.
