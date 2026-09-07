# Incident benchmark — runner

The design is [`docs/BENCHMARK_agent_stack.md`](../docs/BENCHMARK_agent_stack.md): 42 cases in
six tiers, two tracks, six scoring axes. **This directory implements one axis of one track** —
the remediation proposal, on the lab track. Case ids, tiers and the `bench-<id>` namespace
convention are that document's, and its catalog is what a case is ported FROM.

What is here and what is not:

| | design doc | here |
|---|---|---|
| cases | 42, tiers A–F | 2 (A02, C01) |
| tracks | Replay (fixtures) + Lab (live) | Lab only |
| scoring | 6 axes, 100 points, LLM judge for prose | proposal only, pass/fail |
| suite gates | 10 metrics incl. calibration, cost, cache | pass^k |

The scenario *shape* — a directory per case holding setup, cleanup and a declaration of what
solved means — is borrowed from [k8s-ai-bench](https://github.com/gke-labs/k8s-ai-bench).

## Why not run k8s-ai-bench directly

Its shape is right — a directory per scenario holding setup, cleanup and a declaration of what
"solved" means — and that shape is what this borrows. Its **scoring** does not transfer, for one
structural reason: all 26 of its verifiers diff cluster state.

```bash
# k8s-ai-bench tasks/fix-oomkilled/verify.sh
MEMORY_LIMIT=$(kubectl get deployment/$DEPLOYMENT -o jsonpath='...limits.memory')
if [ $MEMORY_LIMIT == $ORIGINAL_MEMORY_LIMIT ]; then exit 1; fi
```

That is correct for an agent that wields kubectl (it runs `kubectl-ai` with `--skip-permissions`).
This agent never acts: `[WRITE]` tools are filtered out of the agentic loop and every remediation
waits on a human clicking Approve. Scored on cluster state, a perfect investigation and a refusal
to look are indistinguishable — both leave the cluster exactly as they found it, and both score 0.

So we score the artefact this agent does produce: the **remediation proposal**, already
structured JSON validated by `parseProposal()`. That has a second effect worth naming — because
the artefact is structured, there is ONE verifier for every task, declared as data in the task
file, instead of a bash script per task.

## A case

```
bench/cases/<id>/
  case.json     the trigger, and what a correct proposal looks like
  setup.sh      installs the fault; must FAIL if the fault did not land
  cleanup.sh    tears it down
```

The id is the catalog id from the design doc, and it is also the directory name and the tier —
`A02-oomkilled-at-limit` is Tier A, case A02. The loader rejects a mismatch rather than
guessing.

`case.json` carries a real Alertmanager group, so a case enters through the door production
uses — `buildGroupAlertText()`, the same function the webhook calls.

```jsonc
{
  "id": "A02-oomkilled-at-limit",     // must match the directory
  "tier": "A",
  "title": "OOMKilled at the limit",
  "settleSeconds": 15,                // after setup, before investigating
  "groupLabels": { "alertname": "PodOOMKilled", "namespace": "bench-a02", "severity": "warning" },
  "alerts": [{ "labels": { ... }, "annotations": { ... } }],
  "expect": {
    "action": "k8s_set_resources",           // null = the correct answer is NO proposal
    "namespace": "bench-a02",
    "target": "backend-api",                 // the workload, not the pod
    "params":      { "kind": "deployment" }, // exact match
    "changed":     { "memory_limit": "128Mi" },  // present AND different
    "greaterThan": { "memory_limit": "150Mi" }   // present AND larger, as a K8s quantity
  }
}
```

`expect` is the concrete form of `truth.expectedProposal`, which the design doc leaves as a
placeholder. Three matchers, and each earns its place:

- `changed` — "raise the limit" has no single right answer. Pinning one would score the
  model's taste rather than its diagnosis; echoing the broken value back is still a miss.
- `greaterThan` — but `changed` alone is too weak, and A02 says so: *"a proposal at or below
  peak is a fail even though the action type is right."* `129Mi` differs from `128Mi` and
  still OOMs. Compared as Kubernetes quantities, so `1M` and `1Mi` are not confused.
- `"action": null` — the case k8s-ai-bench cannot express at all. A proposal raised against a
  healthy namespace is a bug this repo has shipped, and a suite of positive cases scores it
  perfectly. That is C01.

## Running it

Needs three things, none of which this creates:

1. **A cluster** in `KUBECONFIG`. `kind create cluster` is enough; the tasks only use core
   objects. Nothing here provisions one, on purpose — the harness should not be able to point
   at a cluster you did not choose.
2. **An MCP server** pointed at that cluster (`MCP_HTTP_URL`, `MCP_AUTH_TOKEN`). Set the server's
   `kubernetes.authMode: kubeconfig` with `kubeconfigPath`.
3. **An LLM backend** — whatever `LLM_PROVIDER` you want to measure.

A database is not needed: the runner calls `buildProposalPrompt` + `parseProposal` directly
rather than `agent.proposeRemediation()`, which would store a row and require write tools to
have been registered. The part under test is the model's judgement, and those are its two
pure ends.

```bash
npm run bench                          # every enabled case, 1 attempt
npm run bench -- --attempts 5          # pass@1 / pass@5 / pass^5
npm run bench -- --filter '^A'         # regex on the case id — a whole tier, or one case
npm run bench -- --all                 # include disabled cases
```

Exits non-zero unless **pass^k is 100%**, so it can gate CI without a second script deciding
what good means.

## Reading the score

`pass^k` — every attempt passed — is the number that decides whether this can be trusted on
call. An agent that is right four times in five is not 80% useful; it is an agent whose output
has to be checked every time, which is most of the work it was supposed to remove.

Every failure records why (`action X, expected Y`), and the full RCA and proposal for each
attempt land in `bench/results/<timestamp>.json`. A bare number tells you the agent regressed,
never what to look at.

## What this cannot measure yet

- **Five of the six scoring axes.** Only the proposal is checked. Root cause, evidence
  grounding, tool policy, format and efficiency are all specified in the design doc and none
  of them are implemented here; the two prose axes need the LLM judge that document describes.
- **The replay track.** Everything here needs a live cluster. The fixture-backed track that
  makes the suite cheap enough to run on every prompt edit does not exist yet.
- **Anything needing Prometheus, Loki or Jaeger.** A bare kind cluster has none, so the
  `high-latency`, `high-error-rate` and `gitops-drift` playbooks have no case here — and those
  are exactly what distinguishes this agent from a kubectl wrapper. Closing that gap means
  running the observability stack against the bench cluster, not writing more tasks.

## Porting more cases

Port from the design doc's catalog, not from k8s-ai-bench's task list: the catalog already
states the truth, the required tools and the proposal rule for each case. k8s-ai-bench is
useful for the other half — ten of its `setup.sh` scripts are ready-made fault injectors for
cases the catalog describes but does not inject:

| catalog case | upstream injector | playbook |
|---|---|---|
| A01 CrashLoopBackOff, missing config key | `fix-crashloop` | `crashloopbackoff` |
| A03 ImagePullBackOff, tag missing | `fix-image-pull` | `imagepullbackoff` |
| A05 Pod Pending, insufficient CPU | `fix-pending-pod` | `pod-pending` |
| A07 PVC Pending | `resize-pvc` | `pvc-pending` |
| A08 Running but never Ready | `fix-probes` | `pod-not-ready` |
| A09 Rollout stuck | `rolling-update-deployment` | `rollout-stuck` |
| A10 Service has no endpoints | `fix-service-with-no-endpoints` | `service-unavailable` |
| A13 RBAC Forbidden | `fix-rbac-wrong-resource` | `forbidden` |

Take the `setup.sh`, write the alert that would have fired, and replace `verify.sh` with an
`expect` block. Note `fix-oomkilled`, `fix-crashloop` and `list-images-for-pods` are
`disabled: true` upstream — their setup scripts need checking before you trust them.

Cases with no upstream injector are the ones that need real work: A11/A12 (5xx and latency)
need Prometheus and Jaeger, A14/A15 and E03/E04 need a genuinely Flux-managed namespace, and
Tier B needs a multi-service cascade. `devops-sample-apps` already has the fault knobs for
those — see its `docs/DEPLOYMENT_CONTRACT.md §3`.
