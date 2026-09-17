---
name: imagepullbackoff
description: The event message names the failure — but not who put that image there
when: imagepull|errimagepull|pull.?back.?off
---

The event message names the failure. What it cannot say is **who put that failing image there**, and that decides the fix: an image set straight in the cluster and a bad tag committed to the repo produce the identical alert and the identical `manifest unknown` event, with opposite remediations.

So settle that question first, with the **gitops-drift** playbook — it is selected by the same triggers as this one, so it is already in this message. In short: Flux labels say whether it is managed, the HelmRelease's `spec.values` says what is declared.

- **Declared ≠ running** → the drift is the root cause and everything below is only how it surfaced. Stop there; gitops-drift owns that path.
- **Declared = running, or nothing GitOps-managed at all** → the message below IS the root cause. On a Flux-managed workload its fix still goes through the repo as a PR, never a live `k8s_set_image`.

**Read the event message.** It already names the cause; no further tool calls are needed to confirm it.

- `manifest unknown` / `not found` → that tag does not exist in the registry: a typo, or a build that never pushed. The fix is the correct tag — **and the correct tag is usually still on the cluster, so go and read it.** A rollout to a bad tag does not delete what it replaced: `k8s_list_replicasets` shows the previous ReplicaSet with the image it was built from, and on a Flux-managed workload the HelmRelease's `spec.values` holds the declared one. Name that tag in the answer, in full `registry/repo:tag` form. This is the one fact a remediation cannot be written without, and an RCA that ends at "the tag is wrong" without naming the one that works leaves a human to go and find it.
- `unauthorized` / `authentication required` / `pull access denied` → credentials: no `imagePullSecrets` on the pod or its ServiceAccount, the wrong secret, or expired ones (`k8s_list_secrets`, `k8s_describe_pod`).
- `no such host` / `i/o timeout` / `connection refused` → the registry is unreachable: DNS, a NetworkPolicy (`k8s_list_network_policies`), or a private-registry endpoint that is down.
- `toomanyrequests` → registry rate limit (Docker Hub anonymous pulls). The fix is authenticating, or a pull-through mirror.
- `x509` / `certificate signed by unknown authority` → the nodes do not trust the registry's CA.
