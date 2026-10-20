# The system prompt and skills

## Customizing the system prompt

The agent's system prompt lives in `prompts/system.md` at the project root — plain Markdown, no TypeScript required.

To update the prompt:
1. Edit `prompts/system.md`
2. Restart the agent (no rebuild needed)

The prompt is read once on first use and cached in memory. Key sections you may want to tune:
- **Response Mode** — conversation vs investigation mode rules
- **Failure Mode Playbooks** — investigation steps per symptom (CrashLoopBackOff, OOMKilled, etc.)
- **RCA Output Format** — Slack Block Kit formatting rules
- **Severity / Confidence thresholds**

The dashboard's `/prompt` page shows the prompt the running process holds.

## The query sections are a contract, not examples

The **Loki** and **Prometheus** sections name real labels and real metrics, and they are the one
part of this prompt that can be wrong without anything failing. LogQL answers an unknown *label*
and PromQL answers an unknown *metric* with an **empty result, never an error** — so a wrong name
comes back looking exactly like "there is nothing there", and the agent reports evidence of absence
it never actually gathered. Both have happened here: the prompt shipped `{namespace="X", app="Y"}`
while the log shipper set no `app` label, and `http_requests_total` while the apps expose
`http_server_requests_total`.

So the two lists are pinned by `src/agent/skills/real.test.ts`, as allowlists:

| The prompt may name | Defined by | Kept honest by |
|---|---|---|
| Loki stream labels `namespace`, `app`, `pod`, `container`, `job`, `stream` | fluentbit's `Labels` line + `identity.lua` (GitOps repo) | `the Loki patterns only select on labels fluentbit actually sets` |
| App metrics `http_server_*`, `http_client_*`, `db_*`, `queue_*`, `cache_*`, `build_info` | `packages/platform/src/metrics.ts` in the sample-app repo | `the PromQL patterns only name metrics that exist in this cluster` |

Anything the application logs as a **JSON field** (`service`, `level`, `msg`) is not a label: it
belongs after a `| json` stage and matches nothing inside `{...}`. If you change the log shipper or
re-instrument a service, update the prompt and those allowlists in the same change — nothing else
connects the three repos.

## Skills (`prompts/skills/`)

The system prompt carries what applies to *every* investigation. Anything that applies to
*one symptom* is a skill: a Markdown file with frontmatter (`name`, `description`, `when`)
whose body is injected only when `when` matches the incoming alert or message. `when` is
either `always` or a case-insensitive regex — `crashloop|restarting|restart count`.
`crashloopbackoff.md`, `oomkilled.md`, `pvc-pending.md`, `rca-format.md` and the rest ship in
the repo; drop in another file and restart — no rebuild, no code change.

At most `MAX_MATCHED_SKILLS` (3) skills are injected per turn, each capped at
`SKILL_MAX_CHARS` (8000), ranked by match count. Selection runs again on every tool round —
against the tool *evidence*, not just the alert text, so a generically-named alert picks up the
playbook its first round of output earns (`KubernetesPodNotHealthy` → `imagepullbackoff`) — and a
thread accumulates up to `MAX_THREAD_SKILLS` (5) across rounds, earliest match winning. Under
context-budget pressure skills are dropped before history: history is evidence already gathered,
a skill is advice. Loading is **fail-fast**: a malformed
frontmatter, a duplicate `name`, or an empty skills directory throws at startup rather than
letting the agent run without an RCA output format. The `/context` dashboard page shows what
loaded.

Skills ride in as a separate message, never appended to the system prompt — that keeps the
cached prompt byte-identical across turns, so a per-incident playbook never invalidates the
prompt cache.
