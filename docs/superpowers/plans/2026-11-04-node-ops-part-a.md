# Node ops (Part A: cordon, uncordon, drain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human-approved card can cordon, uncordon or drain a Kubernetes node on any registry cluster.

**Architecture:** Three `[WRITE]` MCP tools in devops-mcp-server (dry-run first, like every write tool), an RBAC switch in the umbrella chart, and three proposable actions in the agent's remediation flow. Nodes are cluster-scoped: a node proposal carries `namespace: ""`.

**Tech Stack:** TypeScript ESM, Node 26, `node:test` + tsx, `@kubernetes/client-node`, Helm, Flux.

**Spec:** `docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md` (Part A). Part B gets its own plan.

## Global Constraints

- Every write tool's description starts with `[WRITE]`; registered only when `MCP_ENABLE_WRITE_TOOLS=true`.
- Drain evicts through the Eviction API only (PDBs apply), never deletes pods directly.
- Refuse cordon/drain of a control-plane node (label `node-role.kubernetes.io/control-plane` or `node-role.kubernetes.io/master`) and of the cluster's last schedulable node (schedulable = `!spec.unschedulable` and no `NoSchedule`/`NoExecute` taint).
- Chart: `rbac.allowNodeOps` default `false`; `_validate.tpl` fails the render when it is on without `writeTools.enabled`.
- Single-cluster and existing actions behave exactly as today. No new dependencies. No model identifier in commits.

## Rulings (deviations from the spec, decided here)

- **No 5-minute verification for node actions** — the verifier measures pod readiness in a namespace and a node has none; the action's own result reports the node's state (cordoned, evicted / blocked / skipped), like `k8s_delete_orphan` which also returns no target. Cost if wrong: no delayed re-check of a node.
- **Drain has no `timeoutSeconds` and does not wait** for evicted pods to terminate; it reports the evictions it requested. Cost if wrong: the card says "evicted" while pods are still terminating.
- **Drain evicts pods in every namespace**, not only `ALLOWED_REMEDIATION_NAMESPACES` — a node drain is cluster-scoped and a partial drain is not a drain; skipped: DaemonSet-owned pods, mirror pods (`kubernetes.io/config.mirror`), and completed pods. Cost if wrong: a drain evicts a kube-system pod (PDB-protected ones are still blocked by the API).

## Review Focus

- Drain of a node whose pods have a PDB at `disruptionsAllowed: 0` → those pods come back as `blocked` (HTTP 429), the rest are evicted, no exception → Task 1 test `drain reports PDB-blocked pods instead of failing`.
- Cordon of the last schedulable node (stg: master1 is tainted, worker1 is the only schedulable one) → refused → Task 1 test.
- `dry_run: true` must change nothing: no node patch, evictions sent with `dryRun: ["All"]` → Task 1 test.
- A node proposal (no namespace) passes the gates that key on namespace without crashing, and its pending-card key is `k8s_cordon:/<node>` (cluster-prefixed in strict mode) → Task 3 test.
- Uncordon of a node that is not cordoned → a clear "already schedulable" refusal on the dry run, not a no-op card → Task 1 test.

---

### Task 1: devops-mcp-server — `k8s_cordon`, `k8s_uncordon`, `k8s_drain`

**Files:**
- Create: `devops-mcp-server/src/tools/kubernetes/handlers/remediation/node.ts`
- Modify: `devops-mcp-server/src/tools/kubernetes/handlers/remediation.ts` (barrel: `export * from "./remediation/node.js"`)
- Modify: `devops-mcp-server/src/tools/kubernetes/write.ts` (three entries)
- Test: `devops-mcp-server/src/tools/kubernetes/handlers/node-ops.test.ts`

**Interfaces:**
- Produces MCP tools: `k8s_cordon {node: string, dry_run?: boolean}`, `k8s_uncordon {node, dry_run?}`, `k8s_drain {node, dry_run?}`. Results: `{ action: "cordon"|"uncordon"|"drain", node, dryRun, result: string, evicted?: string[], blocked?: string[], skipped?: string[] }` (pods as `ns/name`).
- Uses `getApi(k8s.CoreV1Api)`: `readNode`, `listNode`, `patchNode` (merge patch `{spec:{unschedulable:true|false}}`), `listPodForAllNamespaces({fieldSelector: "spec.nodeName=<node>"})`, `createNamespacedPodEviction`.

- [ ] **Step 1: Write the failing tests** with a fake CoreV1Api installed through `k8s.KubeConfig.prototype.makeApiClient` (the pattern in `remediation.test.ts:254-269`):
  - `cordon refuses a control-plane node`; `cordon refuses the last schedulable node` (two nodes: one tainted `NoSchedule`, one target); `cordon dry run patches nothing`; `cordon patches unschedulable=true`.
  - `uncordon refuses a node that is already schedulable`; `uncordon patches unschedulable=false`.
  - `drain skips DaemonSet, mirror and completed pods`, `drain reports PDB-blocked pods instead of failing` (eviction rejects with `{ code: 429 }` → in `blocked`), `drain dry run sends evictions with dryRun ["All"] and cordons nothing`.
  - `write tools list the three node tools with [WRITE] descriptions`.
- [ ] **Step 2: Run** `npx tsx --test src/tools/kubernetes/handlers/node-ops.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `cordonNode`, `uncordonNode`, `drainNode` in `node.ts` (zod input, `withUpstream("kubernetes", …)`, `ValidationError` for refusals, as `workload.ts` does) and register them in `write.ts`.
- [ ] **Step 4: Run** the file, then `npx tsc --noEmit -p .` and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(write-tools): k8s_cordon, k8s_uncordon, k8s_drain — evictions only, never the control plane or the last schedulable node`.

### Task 2: chart — `rbac.allowNodeOps`, release 0.8.1; gitops turns it on

**Files:**
- Modify: `devops-ai-helm-charts/charts/devops-ai-stack/charts/devops-mcp-server/templates/rbac.yaml`, `…/values.yaml` (`rbac.allowNodeOps: false` with a comment), `charts/devops-ai-stack/templates/_validate.tpl`, `charts/devops-ai-stack/Chart.yaml` (`version: 0.8.1`)
- Modify: `gitops-devops-ai-manifest/apps/base/applications/devops-ai-stack/release.yaml` and `apps/stg/applications/devops-mcp-bridge/release.yaml` (chart `0.8.1`, `rbac.allowNodeOps: true`)

**Interfaces:** with `allowNodeOps`, the ClusterRole gains `nodes: [patch]` (core group) and `pods/eviction: [create]`.

- [ ] **Step 1:** `helm template` the umbrella with `devops-mcp-server.rbac.allowNodeOps=true` and write tools on → renders both rules; with write tools off → fails naming `allowNodeOps`; default values → no node rules.
- [ ] **Step 2:** Commit the chart (`feat(mcp-server): rbac.allowNodeOps — patch nodes, create evictions; release 0.8.1`), push, tag `v0.8.1`, push the tag, wait for the release workflow to succeed.
- [ ] **Step 3:** Gitops: bump both releases to `0.8.1`, set `allowNodeOps: true`; `kubectl kustomize` dev and stg build. Commit (push in Task 4, after the mcp-server image is out).

### Task 3: agent — node actions in the remediation flow

**Files:**
- Modify: `devops-ai-agent/src/agent/remediation/proposal.ts` (parse cases, `PROPOSABLE_ACTIONS`, prompt lines, `REQUIRED`)
- Modify: `devops-ai-agent/src/agent/remediation/remediator.ts` (execution result: no `target` for the three node actions)
- Test: `devops-ai-agent/src/agent/remediation/proposal.test.ts` (+ the gate test file if a gate needs a node case)

**Interfaces:**
- Consumes the Task 1 tool names and inputs.
- Produces `Proposal` for `{"action":"k8s_cordon"|"k8s_uncordon"|"k8s_drain","node":"...","reason":"..."}` with `namespace: ""`, `name: <node>`, `toolParams: { node }`, summaries `cordon node \`<node>\` (no new pods are scheduled there)`, `uncordon node \`<node>\``, `drain node \`<node>\` (cordon, then evict its pods; DaemonSet pods stay)`.
- Prompt guidance (one line each): cordon/drain ONLY when the investigation shows the NODE itself failing (NotReady, pressure condition, hardware/IO fault) and not one workload on it; uncordon ONLY for a node cordoned earlier whose fault is gone.

- [ ] **Step 1: Write the failing tests:** each JSON parses to the Proposal above; `REQUIRED` covers the three (the existing coverage test enforces it); the existing `prompt-offers-every-parseable-action` test passes with the new lines; `targetKey("k8s_cordon", "", "worker1", "stg")` is `"stg:k8s_cordon:/worker1"`; executing a node action returns no `target`.
- [ ] **Step 2: Run** the proposal test — Expected: FAIL.
- [ ] **Step 3: Implement.** Run every gate in `remediator.ts`'s pre-dry-run chain against a node proposal in a test; any gate that throws or misreads `namespace: ""` gets a node case.
- [ ] **Step 4: Run** focused tests, `npx tsc --noEmit -p .`, `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(remediation): cordon, uncordon and drain a node through the approval card`.

### Task 4: ship and verify live

- [ ] Push devops-mcp-server, wait for its CI image; push the agent, wait for CI; push gitops (Task 2 Step 3); reconcile Flux on dev and stg; confirm both mcp-servers list `k8s_cordon` and the agent sees them (dev and stg tool counts +3).
- [ ] Live: dry-run cordon of stg `worker1` is refused as the last schedulable node; a dev worker cordon card appears from a mention, the user approves, `kubectl get node` shows `SchedulingDisabled`; uncordon restores it.
- [ ] Docs: `devops-ai-agent/CLAUDE.md` (node actions), confluence `03-remediation-and-safety.md` (three actions + guards), `06-slack-user-guide.md` (one line), README pin. Commit and push.
