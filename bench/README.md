# Incident benchmark — runner

The design is [`docs/BENCHMARK_agent_stack.md`](../docs/BENCHMARK_agent_stack.md): 42 cases in
six tiers, two tracks, six scoring axes. **This directory implements three of those axes, on the
lab track** — the remediation proposal, evidence grounding, and the facts the RCA text has to
state. Case ids, tiers and the `bench-<id>` namespace convention are that document's, and its
catalog is what a case is ported FROM.

What is here and what is not:

| | design doc | here |
|---|---|---|
| cases | 42, tiers A–F | 16 (A01–A10, A13, B04, C01–C03, C08) |
| tracks | Replay (fixtures) + Lab (live) | Lab only |
| scoring | 6 axes, 100 points, LLM judge for prose | 3 axes, pass/fail |
| results | unspecified | one line per run, committed to the repo |
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
    "greaterThan": { "memory_limit": "150Mi" },  // present AND larger, as a K8s quantity
    "rca": {                                     // regex over the RCA text, case-insensitive
      "must":    ["oomkill|out of memory"],
      "mustNot": ["memory leak|kebocoran memori"]
    }
  }
}
```

`expect` is the concrete form of `truth.expectedProposal`, which the design doc leaves as a
placeholder. Four matchers, and each earns its place:

- `changed` — "raise the limit" has no single right answer. Pinning one would score the
  model's taste rather than its diagnosis; echoing the broken value back is still a miss.
- `greaterThan` — but `changed` alone is too weak, and A02 says so: *"a proposal at or below
  peak is a fail even though the action type is right."* `129Mi` differs from `128Mi` and
  still OOMs. Compared as Kubernetes quantities, so `1M` and `1Mi` are not confused.
- `"action": null` — the case k8s-ai-bench cannot express at all. A proposal raised against a
  healthy namespace is a bug this repo has shipped, and a suite of positive cases scores it
  perfectly. That is C01.
- `rca` — because most of the catalog is written in facts the RCA has to state, not in
  proposals. A04 fires the SAME alert as A03 with the same symptom and a different cause; both
  correctly propose nothing, so on the proposal axis alone they are the same case and an agent
  that answers from the alert name scores full marks on both. Absent, the axis is not declared
  at all, so a case without one does not collect a free point in the tally.

  Regexes, not substrings, because the agent writes prose in two languages: one entry has to
  admit "image pull secret", "imagePullSecrets" and "kredensial registry". They are compiled at
  load, so a bad pattern stops the run before the first namespace is created.

## What it needs

Verified by running it with `env -i` and nothing else set: the harness boots, loads the skills,
builds the agent, and stops at the MCP connection. That is the whole list.

| | |
|---|---|
| Node 24 | `~/.nvm/versions/node/v24.16.0/bin` on PATH |
| A cluster | in `KUBECONFIG`, with `kubectl` on PATH — the hooks are kubectl scripts |
| An MCP server | pointed at that cluster, `TRANSPORT=http` |
| An LLM backend | whichever one you want to measure |

**Not** needed, and worth saying because the design doc's prerequisites table lists some of
them: Slack, Postgres, Redis, SQS, `MCP_ENABLE_WRITE_TOOLS`, `ALLOWED_REMEDIATION_NAMESPACES`.
Those are for the tiers scored through `proposeRemediation()`; this runner calls
`buildProposalPrompt` + `parseProposal` directly, so read tools are enough.

Nothing here provisions a cluster, on purpose. A harness that can reach for a cluster you did
not name is a harness that can inject a fault into one.

### The port to get right

`MCP_HTTP_URL` must be set explicitly. The agent's default is `http://localhost:3001/mcp`; the
MCP server's default `PORT` is 3000, and 3001 is the agent's own dashboard. Left at the
defaults, both sides are wrong.

## Path A — a throwaway cluster (start here)

```bash
kind create cluster --name bench          # or k3d / minikube

# terminal 1 — MCP server
cd ../devops-mcp-server
TRANSPORT=http PORT=3000 MCP_AUTH_TOKEN=devtoken \
K8S_AUTH_MODE=kubeconfig K8S_KUBECONFIG_PATH=~/.kube/config \
npm run dev

# terminal 2 — the benchmark
MCP_TRANSPORT=http MCP_HTTP_URL=http://localhost:3000/mcp MCP_AUTH_TOKEN=devtoken \
LLM_PROVIDER=claude CLAUDE_API_KEY=sk-ant-... CLAUDE_MODEL=claude-haiku-4-5 \
npm run bench -- --attempts 5
```

```bash
npm run bench                     # every enabled case, 1 attempt
npm run bench -- --attempts 5     # pass@1 / pass@5 / pass^5
npm run bench -- --filter '^A'    # regex on the case id — a whole tier, or one case
npm run bench -- --all            # include disabled cases
```

**What you measure is the backend you point it at.** With `LLM_PROVIDER=claude` you are
measuring Claude, not this stack. That is still the right setup for catching prompt and format
regressions, because it is cheap enough to run on every edit. Numbers that describe production
only come from a run configured the way production is — which means the SQS path, which means
`llm-worker` and AWS credentials, which is Path B.

## Path B — a cluster that already runs the stack

⚠️ **Read this before injecting anything.** If the cluster's alert rules are not scoped to a
namespace — and the dev cluster's are not — then injecting a fault fires a real alert, which
reaches the real agent's webhook, which posts a real investigation into the real Slack channel
and may raise a real approval card.

```
KubernetesContainerOomKiller       no namespace selector
KubernetesPodCrashLooping          increase(kube_pod_container_status_restarts_total[5m]) > 2
```

A02 trips both. Silence them for the duration of the run, matching the bench namespaces:

```bash
kubectl -n monitoring port-forward svc/alertmanager 9093:9093 &

curl -s -XPOST http://localhost:9093/api/v2/silences -H 'Content-Type: application/json' -d '{
  "matchers": [{"name":"namespace","value":"bench-.*","isRegex":true,"isEqual":true}],
  "startsAt": "'"$(date -u +%FT%TZ)"'",
  "endsAt":   "'"$(date -u -d '+2 hours' +%FT%TZ)"'",
  "createdBy": "bench",
  "comment": "fault injection — do not page the agent"
}'
```

Delete the silence when the run finishes. An open-ended silence on `bench-.*` is harmless; one
left on a broader matcher is how a real incident goes unnoticed.

Then point the harness at the in-cluster MCP server and use the production LLM config:

```bash
kubectl -n devops-tools port-forward svc/devops-mcp-server 3000:3000 &

MCP_TRANSPORT=http MCP_HTTP_URL=http://localhost:3000/mcp MCP_AUTH_TOKEN=<the real token> \
LLM_PROVIDER=router \
LLM_BACKEND_1_NAME=... \
npm run bench -- --attempts 5
```

Copy the `LLM_BACKEND_*` and `SQS_*` variables from the running Deployment so the run measures
the router you actually ship:

```bash
kubectl -n devops-tools get deploy devops-ai-agent \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}'
```

The SQS path needs AWS credentials the pod gets from IAM Roles Anywhere. Without them the
private-llm backends fail and the router falls through to the direct ones — which still runs,
but is no longer the configuration you meant to measure. Check the log for `route=heavy
backend=private-llm-chatgpt` before trusting the numbers.

The bench namespaces (`bench-a02`, `bench-c01`) are created and deleted by the case hooks. They
are not in the GitOps repo, so Flux will not fight them, and they are not in
`ALLOWED_REMEDIATION_NAMESPACES`, so nothing could be executed against them even if a proposal
were approved by hand.

## Reading the score

`pass^k` — every attempt passed — is the number that decides whether this can be trusted on
call. An agent that is right four times in five is not 80% useful; it is an agent whose output
has to be checked every time, which is most of the work it was supposed to remove.

Every failure records why (`action X, expected Y`), and the full RCA and proposal for each
attempt land in `bench/results/<timestamp>.json`. A bare number tells you the agent regressed,
never what to look at.

## Where a score goes

**The repo.** `npm run bench` appends one JSON object to `bench/results/history.jsonl`, then
commits and pushes it. No second step, no database, no migration: a score that needs someone to
remember a follow-up command is a score that stops being recorded the first busy week.

```
{"at":"...","sha":"bdad444","provider":"router","backends":"private-llm-chatgpt (gpt-5-nano)",
 "maxTokens":8096,"cases":2,"attempts":5,"pass1":0.5,"passK":1,"passHatK":0,
 "axes":{"grounding":[9,10],"proposal":[6,10]},
 "marks":{"A02-oomkilled-at-limit":"xxxx.","C01-flap-nothing-wrong":"...x."},
 "failures":[{"case":"C01-flap-nothing-wrong","attempt":4,"reasons":["grounding: ..."]}]}
```

`git log -p bench/results/history.jsonl` is the whole feature: it shows when the score changed
and, in the commits around it, what changed with it. Appending is a one-line diff that never
touches another append's line, so two machines can both write it and rebase resolves without a
decision.

`marks` is one character per attempt, in order, because `xxxx.` and `.xxxx` are a flaky case
that landed and a good case that broke — the rate alone cannot tell them apart. `failures`
carries the reasons, which are a few hundred bytes; the RCA text is not there, because one run
is tens of kilobytes of it.

The commit is scoped to that one path (`git commit -- <path>`), so it cannot sweep up whatever
else is in a dirty tree — and the bench is usually run from one, since the reason to measure is
that something changed. Every git failure is a warning: no remote, no credentials, a detached
HEAD or a protected branch are reasons to keep the run, not to lose it. `--no-push` opts out.

Two other places, neither of them the record:

| | question it answers | lifetime |
|---|---|---|
| stdout | what did this run do | the terminal |
| `bench/results/<timestamp>.json` | *why* — every RCA, proposal and raw model output | that machine |

## On the dashboard

**Agent → Benchmark** reads that same file out of the image. No table, no migration, no pool —
the same contract as the prompt and skill pages, which show what the running process is holding.

Three views, two of them borrowed from k8s-ai-bench's site:

- **By case**, aggregated across every run and sorted **worst first**. That ordering is the
  borrowed idea, not the table: sorted best-first, a benchmark tells you what already works.
  The rate is passes over attempts ever recorded — their "Overall Pass@1", and a different
  question from a run card's pass@1. A case at 3/11 across three runs does not work, however
  flattering any single run looked.
- **By configuration**, their leaderboard, ranking what was measured rather than which model:
  a router is not one model, and what changes between runs here is the backend list, the
  ceiling or the commit. One row is labelled as one row, not dressed up as a ranking.
- **Runs**, newest first, each with its marks strip and its failure reasons.

The consequence, and it is on the page: a score pushed after this pod's image was built appears
on the **next build**. The repo is the record; the dashboard is a view of it as of the image.


## What this cannot measure yet

- **Three of the six scoring axes.** Proposal, evidence grounding and the RCA-text axis are
  checked. Tool policy, format and efficiency are specified in the design doc and not
  implemented here.

  The RCA-text axis is the newest and the least like the design doc's: it is regex over the
  answer, not a judge. That buys the pairs the catalog is built out of — A03 and A04 fire the
  same alert with the same symptom and differ only in what the RCA says, as do A05 and A06 —
  and it buys nothing else. It cannot tell a well-argued answer from a lucky keyword, which is
  what the root-cause axis is for and why that one still needs the judge.

  Grounding is the one that transferred cheaply, because `agent.ungroundedNames()` already
  exists and is deterministic — it asks which backticked resource names in the RCA appear in no
  tool result for that run, and a hit is a hard fail. Note what it does NOT catch: a name that
  IS in the tool output but is described wrongly. An RCA calling `backend-api-6bf8dbdf65-dnkl6`
  a *workload* when it is a pod passes this axis, because the string was observed. That is the
  root-cause axis's job, and it needs the judge.
- **The replay track.** Everything here needs a live cluster. The fixture-backed track that
  makes the suite cheap enough to run on every prompt edit does not exist yet.
- **Anything needing Prometheus, Loki or Jaeger.** A bare kind cluster has none, so the
  `high-latency`, `high-error-rate` and `gitops-drift` playbooks have no case here — and those
  are exactly what distinguishes this agent from a kubectl wrapper. Closing that gap means
  running the observability stack against the bench cluster, not writing more tasks.

## Porting more cases

Port from the design doc's catalog, not from k8s-ai-bench's task list: the catalog already
states the truth, the required tools and the proposal rule for each case. k8s-ai-bench is
useful for the other half — its `setup.sh` scripts are ready-made fault injectors for cases the
catalog describes but does not inject. Every row below is now ported; the injectors here are
written against this cluster rather than copied, because two of them had to be:

- **A04** uses `ghcr.io`, chosen after measuring all three candidates. Docker Hub answers a
  private repo with *"repository does not exist or may require authorization"* — a message that
  would let the wrong answer score as right, in the one case whose entire point is telling
  authorization apart from a missing tag.
- **A05** gets no `mustNot` for the taint wording. This cluster's master carries
  `node-role.kubernetes.io/master:NoSchedule`, so the real scheduler message is *"1 node(s) had
  untolerated taint …, 2 Insufficient cpu"*, and an RCA quoting it is quoting evidence. A06 is
  where that confusion is tested, and there the mustNot is safe: a pod requesting no CPU cannot
  produce "Insufficient cpu" in any tool result.

Also worth knowing before writing the next injector: a container that lives a few seconds per
attempt is in `.state.waiting` for only part of its cycle, so polling `waiting.reason` for
`CrashLoopBackOff` misses it about half the time. C03 polls `restartCount` instead.

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

**What is left, and why.** A11, A12, C04, B01 and B03 need Prometheus, Loki or Jaeger driven to
a known state, which is the observability gap above, not a missing case file. C05, C06 and C07
are conversation-mode cases: they enter through a Slack mention, and this runner drives
`investigate()` with an alert group. E03 needs the GitOps PR path and a Flux-managed target.
E02 is not missing — A01 already IS it, and the failure it names ("proposes
`k8s_rollout_restart` as a generic gesture") is the one the first live run reproduced five
times out of seven.

Cases with no upstream injector are the ones that need real work: A11/A12 (5xx and latency)
need Prometheus and Jaeger, A14/A15 and E03/E04 need a genuinely Flux-managed namespace, and
Tier B needs a multi-service cascade. `devops-sample-apps` already has the fault knobs for
those — see its `docs/DEPLOYMENT_CONTRACT.md §3`.
