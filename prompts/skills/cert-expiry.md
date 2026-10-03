---
name: cert-expiry
description: A TLS certificate that expired or stopped renewing — cert-manager states the reason, the symptom does not
when: certificate|certmanager|x509|expired|expiry|renew|notAfter|acme|letsencrypt|issuer|tls (cert|secret)|sertifikat|kadaluarsa|kedaluwarsa
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
4. **Read the dates right.** `status.renewalTime` is when cert-manager WILL renew — on a healthy
   certificate it is in the future, and it is never evidence that a renewal happened. The current
   key pair was issued at `status.notBefore`; a renewal has happened only if `status.revision` is
   above 1 or a CertificateRequest is newer than the first issuance. Do not write "renewed" or
   "updated certificate" unless one of those says so.
5. **Expiring soon, and healthy.** `Ready: True`, `renewalTime` still ahead, issuer Ready: nothing
   is wrong. cert-manager renews at `renewalTime` — say so and quote it. The finding is that the
   alert fires earlier than the certificate's `spec.renewBefore` window; the Immediate action is
   none, and the fix is the alert threshold, not the workload.
6. A stale mount is a renewal that HAPPENED (step 4) plus a client still failing TLS. Then a pod
   that started before `status.notBefore` holds the previous key pair, and the fix is a rolling
   restart of THAT workload — name it from the pods that mount the Secret
   (`k8s_describe_pod` volumes). Never "the workload that uses the Secret": a restart needs a name
   you read.

`k8s_list_secrets` shows the TLS Secret exists but never its expiry — the dates live only on the
Certificate object. Do not infer validity from the Secret.

*Recommended Actions*: for a stuck renewal name the issuer and the refusal reason. For a stale
mount, a rolling restart of the named workload. For a healthy certificate whose renewal is simply
not due yet, no Immediate action — say when it renews. Never propose deleting the Secret to force
re-issue — cert-manager may not recreate it before the next request arrives, turning a warning
into an outage.
