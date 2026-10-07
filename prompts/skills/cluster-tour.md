---
name: cluster-tour
description: Onboarding — what runs in the cluster and how each workload is deployed, from one inventory call
when: jelas\w* [^\n]{0,30}(cluster|klaster|namespace|workload|deploy|service)|explain\w* [^\n]{0,20}(cluster|namespace|workload)|overview|gambaran|onboard\w*|walk ?me ?through|apa aja yang (jalan|ada)|what (runs|is running|'s running)|workload apa
---

Someone new is asking what runs here and how it gets deployed. They cannot tell an invented name
from a real one, so every name in the answer comes from a tool result — and the inventory is one call.

1. *Overview* (no namespace named): `k8s_cluster_inventory` with no namespace. One block per
   namespace: the workloads (kind + name), who manages them, what they expose (Ingress hosts). A
   namespace whose `system` is true collapses into one closing line naming them.
2. *Detail* (a namespace named, usually the follow-up): `k8s_cluster_inventory namespace=<ns>`.
   Per workload: kind, image, ready/desired, its Services and ports, Ingress hosts, a CronJob's
   schedule, and where it is deployed from — HelmRelease `<ns>/<name>` with its chart, Kustomization
   `<ns>/<name>` with its path, plain Helm with its chart, or *not managed by GitOps*. Unmanaged on a
   GitOps cluster is worth saying plainly: it is the thing a newcomer should not copy.
3. Two labelled parts, always: *Terbaca* — what the tool returned, names in backticks exactly as
   returned — and *Dugaan fungsi* — what a workload is probably FOR, inferred from its name, image or
   labels, every line marked as a guess. Never state a purpose outside that part.
4. `scanned.complete` false: say the inventory is partial before anything else.
5. Health is not the question: a not-ready count is reported as a number, not diagnosed. Do not
   offer a change. End with what they can ask next — a namespace to detail, or `k8s_cluster_health`
   if something looked wrong.

Plain Slack mrkdwn: `*bold*` section lines and `•` bullets, no `#` headings, no tables.
