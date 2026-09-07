# Incident benchmark

Scenarios borrowed from [k8s-ai-bench](https://github.com/gke-labs/k8s-ai-bench), scored the
way this agent actually works.

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

## A task

```
bench/tasks/<name>/
  task.json     the alert, and what a correct proposal looks like
  setup.sh      installs the fault; must FAIL if the fault did not land
  cleanup.sh    tears it down
```

`task.json` carries a real Alertmanager group, so a task enters through the door production
uses — `buildGroupAlertText()`, the same function the webhook calls.

```jsonc
{
  "name": "oom-backend",              // must match the directory
  "difficulty": "medium",
  "settleSeconds": 15,                // after setup, before investigating
  "groupLabels": { "alertname": "PodOOMKilled", "namespace": "bench-oom", "severity": "warning" },
  "alerts": [{ "labels": { ... }, "annotations": { ... } }],
  "expect": {
    "action": "k8s_set_resources",    // null = the correct answer is NO proposal
    "namespace": "bench-oom",
    "target": "backend-api",          // the workload, not the pod
    "params":  { "kind": "deployment" },        // must match exactly
    "changed": { "memory_limit": "128Mi" }      // must be present AND different
  }
}
```

`changed` exists because "raise the limit" has no single right answer. Pinning one would score
the model's taste rather than its diagnosis; echoing the broken value back is still a miss.

`"action": null` is the case k8s-ai-bench cannot express at all, and it is not padding. A
proposal raised against a healthy namespace is a bug this system has shipped, and a suite of
positive tasks scores it perfectly. See `tasks/stale-alert-healthy-namespace`.

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
npm run bench                              # every enabled task, 1 attempt
npm run bench -- --attempts 5              # pass@1 / pass@5 / pass^5
npm run bench -- --filter 'oom|crashloop'  # regex on the task name
npm run bench -- --all                     # include disabled tasks
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

- **The RCA prose.** Only the proposal is scored. Judging the narrative needs an LLM judge,
  which is a benchmark of its own.
- **Anything needing Prometheus, Loki or Jaeger.** A bare kind cluster has none, so the
  `high-latency`, `high-error-rate` and `gitops-drift` playbooks have no task here — and those
  are exactly what distinguishes this agent from a kubectl wrapper. Closing that gap means
  running the observability stack against the bench cluster, not writing more tasks.

## Porting more scenarios

k8s-ai-bench's `setup.sh` scripts are ready-made fault injectors and ten of them line up with a
playbook in `prompts/skills/`:

| upstream task | playbook |
|---|---|
| `fix-crashloop` | `crashloopbackoff` |
| `fix-image-pull` | `imagepullbackoff` |
| `fix-oomkilled` | `oomkilled` |
| `fix-pending-pod` | `pod-pending` |
| `fix-probes` | `pod-not-ready` |
| `fix-rbac-wrong-resource` | `forbidden` |
| `fix-service-with-no-endpoints` | `service-unavailable` |
| `debug-app-logs` | `log-alert` |
| `resize-pvc` | `pvc-pending` |
| `rolling-update-deployment` | `rollout-stuck` |

Take the `setup.sh`, write the alert that would have fired, and replace `verify.sh` with an
`expect` block. Note `fix-oomkilled`, `fix-crashloop` and `list-images-for-pods` are
`disabled: true` upstream — their setup scripts need checking before you trust them.
