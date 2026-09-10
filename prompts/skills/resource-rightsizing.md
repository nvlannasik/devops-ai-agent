---
name: resource-rightsizing
description: Turning "the limit is wrong" or "what can we clean up" into concrete numbers and named objects
when: unused|orphan|unclaimed|idle|wasted|clean ?up|cost|right.?siz|over.?provision|under.?provision|resource limit|limit resource|resource request|request resource|requests and limits|oomkill|out of memory|exit code 137|throttl|insufficient (cpu|memory)|evicted|tidak terpakai|tak terpakai|menganggur|boros
---

Two tools answer this, and they read different things — pick by the question, not by both.

**Sizing — "is the limit wrong / how much does it really use":**
1. `k8s_recommend_resources` with the namespace (and `workload` when you already know it). It
   joins the configured requests/limits with real Prometheus usage and returns the number to
   change. Read `flags` before anything else: `oom_risk`, `cpu_throttled`,
   `cpu_under_provisioned`, `memory_under_provisioned`, `no_requests`, `over_provisioned`.
2. `no_data` on the container you care about means the workload was scaled to zero, is newer
   than the window, or cadvisor is not scraped — say which is unknown, do not read it as "uses
   nothing". If `scanned.withMetrics` is `0` the metrics are missing cluster-wide; report that
   instead of a recommendation.
3. Default `window` is 24h. Widen it (`7d`) before you trust a low number on a workload with a
   daily or weekly peak — `method` says the same thing and is worth quoting when confidence is
   the question.

**Cleanup — "what is unused / orphaned / costing us nothing":**
1. `k8s_find_unused_resources`, namespace optional (omit it for the whole cluster). Lead with
   `PersistentVolumeClaim` findings — those bill every day — then endpoint-less Services, then
   the idle workloads, then ConfigMaps/Secrets/ServiceAccounts.
2. It is a review list. An object an operator or CRD reads through the API looks unused here and
   is not, so a finding is "worth checking with the owner", never "safe to delete". Never turn
   one into a delete proposal.
3. `scanned.complete: false` means the scan hit its ceiling — say so rather than presenting the
   list as the whole picture.

**In an RCA**, this is the *Short-term* Recommended Action, not a separate investigation. An
OOMKill, a CPU-throttling alert or a Pending pod already tells you the container; one
`k8s_recommend_resources` call turns the vague advice into the change:

    *Short-term:* Raise `orders-api` memory limit `512Mi` → `900Mi` (peak working set `600Mi`
    over 24h) — _k8s_recommend_resources_ `sample-apps/orders-api`

Quote the observed value next to the recommended one — a number with no evidence behind it is
the thing an on-call refuses to apply. Both tools are read-only: they propose, they change
nothing, and the change itself still goes through the normal remediation/GitOps path.
