---
name: cert-expiry
description: A TLS certificate that expired or stopped renewing — cert-manager states the reason, the symptom does not
when: certificate|cert-manager|x509|expired|expiry|renew|notAfter|acme|letsencrypt|issuer|tls (cert|secret)|sertifikat|kadaluarsa|kedaluwarsa
---

An expired certificate reaches you as something else: a 502 behind the ingress, `x509:
certificate has expired` in a client log, a browser warning. The symptom names the port, never
the renewal that failed weeks earlier.

1. `k8s_get_custom_resources` — `group: "cert-manager.io"`, `version: "v1"`, `plural:
   "certificates"`, with the namespace. The compact rows carry `ready` and its `message`. Any
   row with `ready: False` is the answer, and the message usually IS the root cause.
2. Fetch the failing one by `name` for the full object: `status.notAfter`, `status.renewalTime`,
   and the conditions. **Quote `notAfter` in the RCA** — "expired 6 days ago" is the fact that
   makes the symptom make sense.
3. Renewal failures live one level up. `plural: "certificaterequests"` in the same namespace
   shows the attempt and why it was refused; `clusterissuers` (cluster-scoped, omit namespace)
   shows whether the issuer itself is broken — a dead ACME issuer breaks EVERY certificate it
   signs, so check it before blaming one workload.
4. A `Ready: True` Certificate with a still-failing client means the workload has not reloaded
   the Secret. Check the pod's age against `status.renewalTime`: a pod older than the renewal is
   holding the previous key pair in memory, and the fix is a rolling restart, not a re-issue.

`k8s_list_secrets` shows the TLS Secret exists but never its expiry — the dates live only on the
Certificate object. Do not infer validity from the Secret.

*Recommended Actions*: for a stuck renewal name the issuer and the refusal reason. For a stale
mount, a rolling restart of the named workload. Never propose deleting the Secret to force
re-issue — cert-manager may not recreate it before the next request arrives, turning a warning
into an outage.
