---
name: gitops-drift
description: What the repo declares against what is running — settle this before blaming the symptom
when: drift|helmrelease|flux|unexpected (image|tag|replica)|imagepull|errimagepull|pull.?back.?off
---

Reach for this whenever the running spec might not be what anyone declared: a surprise image tag, replica count or resource limit, an incident with no corresponding release, a fresh ReplicaSet nobody deployed — and on every image-pull failure, where one error message has two opposite causes. **A change made straight in the cluster is often the root cause itself, not a footnote.**

1. **Is the workload Flux-managed?** Labels carry `helm.toolkit.fluxcd.io/name` + `/namespace` (Helm) or `kustomize.toolkit.fluxcd.io/name` + `/namespace` (plain manifests); workload listings and `k8s_describe_pod` show labels. Neither label → nothing here applies, and the symptom is the whole story.
2. **Read what Git DECLARES** — `k8s_get_custom_resources` with `group: "helm.toolkit.fluxcd.io"`, `version: "v2"`, `plural: "helmreleases"`, `namespace`/`name` from those labels — then compare `spec.values` against what is RUNNING (image tag, replicaCount, resources).
   - Flux-managed but no HelmRelease (Kustomize): the declared spec lives in Git, which cannot be read from the cluster. Say the workload is Flux-managed and that the declaration could not be verified, then judge on the symptom — the remediation dry-run compares against Git and refuses with the drift if there is one.
3. **Declared ≠ running → the drift IS the root cause**, and the symptom is only how it surfaced. Say so and name BOTH values: "running `repo:v9.9.9`, but the HelmRelease declares `repo:v1.4.0` — this was changed outside GitOps." Do not treat the running value as correct. **The GitOps repo is the source of truth.** Flux does NOT revert this by itself unless HelmRelease drift detection is enabled, so a manual change persists until the next upgrade — which is why it stays broken.
4. **Recommended Action wording for a mismatch:** state it as **restoring the declared value**, in the same form as any other change — "change container `api` image in `dev/api` back to `repo:v1.4.0` (the tag the HelmRelease declares)". The system recognises the drift from that and posts a **Flux reconcile** card instead of a PR. Do not phrase it as "run flux reconcile": that is a command instruction, and it also gives the proposal step nothing it can act on.
5. **Declared = running → this is not drift.** Reconciling would change nothing; the repo declares exactly what is failing. Keep investigating the symptom — but the fix belongs **in the repo, via a PR**, because a live write here is reverted at the next reconcile and buries the real fix.
