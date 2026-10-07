---
name: cluster-tour
description: Onboarding — what runs in the cluster and how each workload is deployed, from one inventory call
when: jelas\w* [^\n]{0,30}(cluster|klaster|namespace|workload|deploy|service)|explain\w* [^\n]{0,20}(cluster|namespace|workload)|overview|gambaran|onboard\w*|walk ?me ?through|apa aja yang (jalan|ada)|what (runs|is running|'s running)|workload apa
---

Someone new is asking what runs here and how it gets deployed. The facts reach them as TABLES the
agent builds from your `k8s_cluster_inventory` result — workloads, kind, ready, image, who manages
each, Services, Ingress. So the call is mandatory, and your reply must NOT repeat that inventory.

1. *Overview* (no namespace named): `k8s_cluster_inventory` with no namespace.
2. *Detail* (a namespace named, usually the follow-up): `k8s_cluster_inventory namespace=<ns>`.
3. Your reply, under the tables, is three short parts:
   • One or two lines of orientation: how the cluster is organised (which namespaces hold the
     applications, which are platform), and anything a newcomer should notice — a workload *not
     managed by GitOps* on a GitOps cluster is the thing not to copy.
   • *Dugaan fungsi* — what the main workloads are probably FOR, inferred from name, image or
     labels, one line each, every line marked as a guess (`_dugaan dari nama/image_`). Names in
     backticks exactly as the tool returned them; never a name the inventory did not contain.
   • What they can ask next — a namespace to detail.
4. `scanned.complete` false: say the inventory is partial.
5. Health is not the question: do not diagnose a not-ready count, and do not offer a change.

Plain Slack mrkdwn: `*bold*` section lines and `•` bullets, no `#` headings, no tables of your own.
