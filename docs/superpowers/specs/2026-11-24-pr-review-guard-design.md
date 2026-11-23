# Pre-merge review of GitOps PRs — design (D3+)

Status: **proposed, not built** (2026-11-24). Needs the owner's yes on the three questions at the end.

## Intent

The agent's own GitOps PRs are checked before they exist (the gate chain: no-op, OOM shrink, kind,
rollback, …) and carry informative pre-merge checks (`agent/gitops/preflight.ts`). A PR a PERSON opens
against `gitops-devops-ai-manifest` gets nothing. Two mistakes in such a PR are knowable before merge
from data the agent already reads, and each turns into an incident minutes after Flux applies it:

1. a container's **memory limit lowered below what it really uses** (its 7-day peak working set, or
   the limit-based floor `k8s_recommend_resources` gives an OOMKilled container) — the next spike is an
   OOMKill (bench A02/C02 are this incident);
2. an **image tag that does not exist** in its registry — ImagePullBackOff on the next rollout
   (bench A03/A08 are this incident).

The agent comments on the PR with what it found and the evidence. It never approves, requests
changes, blocks or merges: the reviewer decides, exactly as with the pre-merge checks.

## Goals

- One comment per PR, edited in place as the head moves (a hidden marker finds it), and edited to
  "no longer applies" when a new head fixes it. No comment at all on a PR with no finding.
- Findings only for the two checks above, each with its number and where it came from
  (`max_over_time(container_memory_working_set_bytes[7d])`, the registry's manifest answer).
- The worker stays the only holder of GitHub credentials; the agent holds none (unchanged).
- Off unless enabled (`PR_REVIEW_ENABLED`, default `false`): it writes to GitHub.

## Non-goals

- Reviewing anything but HelmRelease values the worker already understands (image, replicas,
  container resources) — no generic YAML review, no style.
- Reviewing PRs in other repositories.
- Blocking merges (no required status check). A check that could block would be an approval gate with
  no human in it — the same reasoning as the pre-merge checks.

## Anti-goals

- A comment that restates the diff, or praises it. Silence is the clean result.
- A finding from a read that failed: an unread source is listed as not checked, never as fine.

## Worker (devops-ai-agent-worker) — two ops on the gitops queue

Same request/response queues and `requestId` routing as `dry_run`/`open_pr`/`history`/`revert_pr`/`locate`.
Changing the shape breaks both sides; an older worker answers an unknown op with an error and the
agent skips the scan (logged, no comment).

- `pr_scan` — read-only. `{ requestId, op: "pr_scan", pathPrefix? }` →
  `{ ok: true, op: "pr_scan", prs: [{ number, url, title, author, headSha, baseSha, changes: [{ helmRelease: {name, namespace}, path, field, from, to }] }] }`.
  Open PRs against the default branch whose changed files are HelmRelease YAML under `pathPrefix`; for
  each, the file at `baseSha` and at `headSha`, diffed at the keys `locate` already resolves —
  `<container>.image`, `replicas`, `<container>.resources.limits.memory` (the change-timeline vocabulary
  the GitOps PR contract uses). Anything else in the diff is ignored, never guessed. ≤20 PRs per scan.
- `pr_comment` — write. `{ requestId, op: "pr_comment", number, headSha, body }` → `{ ok: true, op: "pr_comment", commentUrl }`.
  Creates the PR's one agent comment, or edits it (found by the marker
  `<!-- devops-ai-agent:pr-review -->`). Refuses when `headSha` is no longer the PR's head — a review of
  a stale head must not be posted on a newer one.

## Agent — the reviewer

- A poller every 10 min (one replica: a claim per `(pr, headSha)` in a new `pr_reviews` table, the
  `daily_digests` pattern). New heads only; a PR closed or merged is dropped.
- Memory: for each `…resources.limits.memory` change, the container's 7-day peak working set from
  Prometheus (`max_over_time(container_memory_working_set_bytes{namespace, pod=~"<workload>-.*", container}[7d])`)
  and, when the container was OOMKilled, `k8s_recommend_resources`' `recommended.memoryLimit` (the
  floor `oomShrinkRefusal` already enforces on the agent's own cards). Finding when `to` < peak × 1.1
  or `to` < the OOM floor.
- Image: for each `…image` change, a manifest `HEAD` against the registry (anonymous token for Docker
  Hub and GHCR; a private registry is "not checked"). Finding on 404; "not checked" on any other error.
- The comment: findings first, each with its number and source; then "not checked" for what failed
  to read. Edited to "no longer applies (head `abc1234`)" when a later head clears every finding.
- Recorded like everything else: a trace event per scan, the gate-style log line on every decision.

## Measurement

Unit tests with recorded `pr_scan` payloads (a lowered limit, a missing tag, a harmless replica bump,
a stale head) on both sides; one bench-style end-to-end check against a scratch PR on a fork before it
is enabled on the real repository.

## Effort

About a day per side: the worker's `pr_scan` diff (it already parses HelmRelease values for `locate`
and `dry_run`) and `pr_comment`; the agent's poller, the two checks and the comment body.

## Questions for the owner

1. Review every PR, or only PRs NOT opened by the agent (its own are already gated before they exist)?
2. Enable it on dev once built (`PR_REVIEW_ENABLED=true` in gitops), or keep it off until a trial on a fork?
3. Are all images public (docker.io/nvlannasik, ghcr.io, quay.io)? A private one would be "not checked" unless the agent gets registry credentials.
