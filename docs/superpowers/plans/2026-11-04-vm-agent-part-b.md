# VM agent (Part B: restart a systemd service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An alert about a service on a VM can end in an approved `systemctl restart <unit>` that the VM itself pulls and runs.

**Architecture:** The VM runs `devops-vm-agent` (Python 3 stdlib) that heartbeats and claims approved actions from three bearer-token routes on the agent's express app. Actions live in Postgres. Inside the agent, `vm_restart_service` is a virtual `[WRITE]` tool in a thin `McpTools` wrapper: its dry run checks the VM's heartbeat allowlist, its real call enqueues an action — so the existing proposal, gate, card and approval flow is unchanged. VM alerts (label `hostname`) are investigated as VM incidents.

**Tech Stack:** TypeScript ESM / Node 26 / `node:test` + tsx / `pg` / express; Python 3 stdlib + `unittest` for the VM side.

**Spec:** `docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md` (Part B).

## Global Constraints

- Only action: restart a unit. The VM runs nothing that is not in ITS OWN config `units`.
- Host identity comes from the bearer token (`VM_AGENT_TOKENS="vm-web-01=<token>,…"`), compared in constant time; never from the request body.
- A pending action older than 15 min is never handed out; a claimed action is never handed out again (one atomic `UPDATE … RETURNING`).
- A VM is registered when it heartbeated within the last 5 minutes. Host label: `VM_HOST_LABEL`, default `hostname`.
- Exposure: HTTPS Ingress path `/vm/` (on) and a LAN HTTP Service (off) are separate gitops switches; the VM agent warns at start on an `http://` URL.
- No new dependencies on either side. Single-cluster/K8s behaviour unchanged when `VM_AGENT_TOKENS` is unset (no routes, no virtual tool).

## Rulings (deviations from the spec, decided here)

- **No delayed verification** for `vm_restart_service`: the VM's own report (exit code, `systemctl is-active`, last journal lines) is the verification, posted to the card's thread when it arrives (`NO_POD_TARGET` gains the action). Cost if wrong: no 5-minute re-check of the alert.
- **The VM agent lives in this repo** (`devops-ai-agent/vm-agent/`), beside the endpoints it speaks to — one contract, one repo. Cost if wrong: a later move.

## Review Focus

- Token for `vm-a` claiming → only `vm-a`'s actions, even with `host: "vm-b"` in the body → Task 1 test.
- A pending action older than 15 min → not claimable, marked `expired` → Task 1 test.
- The model proposes a unit the VM did not list, or a VM that stopped heartbeating → the dry run refuses, no card → Task 2 test.
- A claimed action whose unit is not in the VM's local `units` → reported `refused`, `systemctl` never invoked → Task 4 test.
- `VM_AGENT_TOKENS` unset → `/vm/*` answers 404 and no `vm_restart_service` tool exists → Task 1 / Task 2 tests.

---

### Task 1: storage, auth and the three routes

**Files:**
- Create: `migrations/018_vm_agent.sql` (`vm_hosts`, `vm_actions` per spec)
- Create: `src/agent/vm/store.ts` (`VmStore`), `src/app/vm-routes.ts` (express `Router`)
- Modify: `src/config/index.ts` (`vm: { tokens: parseVmTokens(process.env.VM_AGENT_TOKENS), hostLabel: process.env.VM_HOST_LABEL || "hostname" }`), `src/app/index.ts` (mount the router when tokens exist)
- Test: `src/agent/vm/store.test.ts`, `src/app/vm-routes.test.ts`

**Interfaces:**
- `parseVmTokens(raw?: string): Map<string, string>` (name → token; same name/format rules and boot-failing errors as `parseHttpClusters`).
- `VmStore(pool)`: `heartbeat(host, units: string[], version: string)`, `registered(host): Promise<{ units: string[] } | null>` (last_seen ≤ 5 min), `enqueue(host, unit, remediationId: number | null): Promise<number>`, `claim(host): Promise<{ id: number; unit: string; action: "restart" } | null>` (expires stale first), `finish(id, host, status: "succeeded"|"failed"|"refused", result: object): Promise<{ remediationId: number | null } | null>`.
- Routes: `POST /vm/heartbeat {units, version}` → 204; `POST /vm/actions/claim` → 200 `{id, unit, action}` | 204; `POST /vm/actions/:id/result {status, exitCode, active, journal}` → 204; 401 on a missing/unknown token. `vmRoutes(deps: { tokens, store, onResult(host, id, remediationId, result) })`.

- [ ] Step 1: failing tests — store (fake pool asserting SQL shape: claim is one `UPDATE … RETURNING` scoped by host and the 15-min window; finish scoped by host), routes (start the router on an ephemeral `http.createServer` and `fetch` it): unknown token 401; body `host` ignored; claim returns the caller's action only; result calls `onResult` once.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: focused tests, `tsc`, `npm test` → PASS.
- [ ] Step 5: commit `feat(vm): heartbeat, claim and result endpoints for the VM agent, per-VM tokens (migration 018)`.

### Task 2: the virtual tool and the remediation flow

**Files:**
- Create: `src/agent/vm/tools.ts` (`withVmTools(mcp: McpTools, store: VmStore): McpTools`)
- Modify: `src/agent/index.ts` (wrap `this.mcp` when tokens are configured), `src/agent/remediation/proposal.ts` (parse case, `PROPOSABLE_ACTIONS`, prompt line, `REQUIRED`), `src/agent/remediation/remediator.ts` (`NO_POD_TARGET` gains `vm_restart_service`; execute passes `remediation_id`), `src/app/index.ts` (`onResult` posts to the remediation's `card_channel`/`card_thread_ts`)
- Test: `src/agent/vm/tools.test.ts`, `src/agent/remediation/index.test.ts` fixture row

**Interfaces:**
- Proposal `{"action":"vm_restart_service","host":"...","unit":"...","reason":"..."}` → `namespace: ""`, `name: "<host>/<unit>"`, `toolParams: { host, unit }`, summary ``restart `<unit>` on VM `<host>` (systemctl restart, run by the VM's own agent)``.
- Tool `vm_restart_service` (`[WRITE]` description, `{host, unit, dry_run?, remediation_id?}`): dry run → `Error: …` unless `store.registered(host)` and `unit ∈ units`, else a validated line naming host, unit, last heartbeat; real → `enqueue` and `queued for <host> — the VM picks it up within its poll interval`. Every other tool passes through to the wrapped `McpTools`.

- [ ] Step 1: failing tests — dry run refuses an unregistered VM and an unlisted unit; real call enqueues once with the remediation id; other tools delegate; parse fixture.
- [ ] Steps 2–4 as Task 1. Step 5: commit `feat(vm): vm_restart_service through the approval card — a virtual tool the VM pulls`.

### Task 3: VM incidents in the investigation

**Files:**
- Modify: `src/agent/cluster/binding.ts` (a VM note), `src/agent/index.ts` (`vmFor(labels): Promise<{ host, units } | null>`), `src/app/alerts.ts` (pass `vm` into investigate opts), the confidence-cap site (skip the unlabelled cap for a VM run)
- Test: `src/agent/cluster/wiring.test.ts`

**Interfaces:** `InvestigateOptions.vm?: { host: string; units: string[] }`. Note: ``[Target: VM `<host>`] Not a Kubernetes workload: no Kubernetes tools. Its metrics, logs and traces are in the central stack under `<label>="<host>"`. The only action available is restarting one of its units: <units>.`` A VM run gets no `cluster` matcher injected (it runs under `withCluster(null)`), and no unlabelled cap.

- [ ] Step 1: failing test — an alert with `hostname=vm-web-01` (registered) runs with the VM note, no `k8s_*` tools, and is not capped to Low.
- [ ] Steps 2–4. Step 5: commit `feat(vm): an alert about a registered VM is a VM incident, not an unlabelled one`.

### Task 4: `devops-vm-agent`

**Files:**
- Create: `vm-agent/devops-vm-agent.py`, `vm-agent/devops-vm-agent.service`, `vm-agent/devops-vm-agent.conf.example`, `vm-agent/README.md`, `vm-agent/test_vm_agent.py`

**Interfaces:** config keys `name url token units poll_seconds ca_file` (INI `[agent]`); speaks Task 1's routes; `systemctl restart <unit>` with a 60 s timeout; reports `{status, exitCode, active, journal}` (last 20 lines).

- [ ] Step 1: failing `unittest` — against a stub HTTP server (stdlib `http.server` in a thread) and an injected runner: a listed unit runs `systemctl restart` and reports succeeded; an unlisted one reports `refused` and runs nothing; 204 on claim does nothing; `http://` URL logs the warning.
- [ ] Steps 2–4 with `python3 -m unittest vm-agent/test_vm_agent.py`. Step 5: commit `feat(vm): devops-vm-agent — pulls approved restarts, runs only its own allowlist`.

### Task 5: ship and verify

- [ ] Gitops: Ingress path `/vm/` → `devops-ai-agent` port `http` (3000) on `agent.annasik.cloud`; agent env `VM_AGENT_TOKENS` from Secret `devops-vm-agent-tokens` (key `VM_AGENT_TOKENS`, **created by the user**) and `VM_HOST_LABEL: hostname`. Push agent → CI → push gitops → reconcile → restart agent.
- [ ] Live (needs the user: the Secret, a test VM, and the Approve click): install the agent on a test VM with one harmless unit, see `vm_hosts` heartbeat, mention "restart <unit> di VM <host>", approve, see the result posted in the thread.
- [ ] Docs: agent `CLAUDE.md`, workspace `CLAUDE.md` (the VM contract), confluence 01/03/04/06 + README.
