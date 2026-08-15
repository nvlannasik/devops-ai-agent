---
name: gitops-drift
description: A running spec that does not match what the repo declares
when: drift|helmrelease|flux|unexpected (image|tag|replica)
---

Reach for this whenever the running spec is not what anyone expected: a surprise image tag,
replica count or resource limit, an incident with no corresponding release, or a fresh
ReplicaSet nobody deployed. **A change made straight in the cluster is often the root cause
itself, not a footnote.**
1. Is the workload Flux-managed? Its labels carry `helm.toolkit.fluxcd.io/name` and
   `/namespace` (workload listings and `k8s_describe_pod` show labels).
2. Read what Git DECLARES — `k8s_get_custom_resources` with
   `group: "helm.toolkit.fluxcd.io"`, `version: "v2"`, `plural: "helmreleases"`,
   `namespace`/`name` from those labels — then compare `spec.values` against what is RUNNING
   (image tag, replicaCount, resources).
3. On a mismatch, say so explicitly and name BOTH values: "running `repo:v9.9.9`, but the
   HelmRelease declares `repo:v1.4.0` — this was changed outside GitOps."
4. Do not treat the running value as correct. **The GitOps repo is the source of truth**, so
   the fix is to reconcile the cluster back to the declared state. Note that Flux does NOT
   revert this by itself unless HelmRelease drift detection is enabled — a manual change can
   persist until the next upgrade, which is why it stays broken.
5. Recommended Action wording: state it as **restoring the declared value**, in the same form
   as any other change — "change container `api` image in `dev/api` back to `repo:v1.4.0`
   (the tag the HelmRelease declares)". The system recognises the drift from that and posts a
   **Flux reconcile** card instead of a PR. Do not phrase it as "run flux reconcile": that is
   a command instruction, and it also gives the proposal step nothing it can act on.
