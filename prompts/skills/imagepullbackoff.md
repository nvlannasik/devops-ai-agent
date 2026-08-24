---
name: imagepullbackoff
description: Check what GitOps declares before trusting the event message, then read the message
when: imagepull|errimagepull|pull.?back.?off
---

The event message names the failure. What it cannot tell you is **who put that image there** — and for a Flux/GitOps-managed workload that is what decides the fix. Check the declaration first, then read the message.

**1. Is the workload GitOps-managed?** Its labels carry `helm.toolkit.fluxcd.io/name` + `/namespace` (Helm) or `kustomize.toolkit.fluxcd.io/name` + `/namespace` (plain manifests). `k8s_describe_pod` and the workload listings show labels. Neither label → skip straight to step 3.

**2. Compare what the repo DECLARES against what is RUNNING.** For a HelmRelease, read it with `k8s_get_custom_resources` (`group: "helm.toolkit.fluxcd.io"`, `version: "v2"`, `plural: "helmreleases"`, namespace/name from those labels) and compare its `spec.values` image and tag with the image the pod is actually trying to pull.

- **They differ → the drift IS the root cause.** Someone set an image the repo never declared, and Flux does not revert that by itself, so it stays broken. Name both values explicitly, and write the Recommended Action as restoring the declared one — "change container `api` image in `dev/api` back to `repo:v1.4.0` (the tag the HelmRelease declares)". The system recognises the drift from that wording and posts a **Flux reconcile** card. Stop here: whatever step 3 would have said is a symptom of the drift, not the cause.
- **They match → the repo itself declares the failing image.** Reconciling would change nothing. Go to step 3, and read its answer as something to fix **in the repo, via a PR** — a live `k8s_set_image` here is reverted at the next reconcile and buries the real fix.
- **Flux-managed but no HelmRelease (Kustomize):** the declared image lives in Git, which cannot be read from the cluster. Say the workload is Flux-managed and that the declaration could not be verified, then continue to step 3 — the remediation dry-run compares against Git and refuses with the drift if there is one.

**3. Read the event message — it already names the root cause.** No further tool calls are needed to confirm it; match the text and fix what it points at.

- `manifest unknown` / `not found` → that tag does not exist in the registry: a typo, or a build that never pushed. The fix is the correct tag.
- `unauthorized` / `authentication required` / `pull access denied` → credentials: no `imagePullSecrets` on the pod or its ServiceAccount, the wrong secret, or expired ones (`k8s_list_secrets`, `k8s_describe_pod`).
- `no such host` / `i/o timeout` / `connection refused` → the registry is unreachable: DNS, a NetworkPolicy (`k8s_list_network_policies`), or a private-registry endpoint that is down.
- `toomanyrequests` → registry rate limit (Docker Hub anonymous pulls). The fix is authenticating, or a pull-through mirror.
- `x509` / `certificate signed by unknown authority` → the nodes do not trust the registry's CA.

For a workload nobody manages through GitOps, step 3 alone is the whole procedure.
