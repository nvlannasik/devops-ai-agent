# Postmortem draft — design

Date: 2026-10-14. Sub-project 4 of 4 (change timeline → rollback / revert PR → topology
correlation → **postmortem draft**). It reads what the first three store: `incidents.changes`,
remediations with their verdicts and PRs, and child incidents.

## Goal

After an incident, someone has to write it up: what happened when, what we changed, what fixed
it, what to do next. The agent already holds every fact needed for that, spread across the
incident row, its change timeline, its remediations and verdicts, its related alerts, the
human-confirmed `learn` feedback, the investigation trace and the Slack thread. On request, it
now assembles them into a postmortem draft:
- facts (timeline, durations) rendered from data;
- narrative (summary, impact, root cause, what went well / poorly, action items) drafted by the
  model, marked as a draft for review.

Success:
- `@agent postmortem` in an incident thread posts a short summary and action items into the
  thread, and stores the full draft. The draft is readable on the dashboard at
  `/incidents/:id/postmortem` and downloadable as Markdown.
- The Timeline and Numbers sections are byte-for-byte the data. Whatever the model writes, they
  cannot change.
- A human-confirmed root cause (`learn`) outranks the agent's own hypothesis, and a disagreement
  between the two is stated, not hidden.

Out of scope: automatic generation on resolve; a dashboard button or any dashboard write route;
pushing the draft anywhere else (wiki, repo PR); editing a draft in place.

## Components

### 1. Trigger — `postmortemIntent(text)` and `SlackApp.handlePostmortem`

- `postmortemIntent(text): "postmortem" | "declined" | null` lives in `src/agent/postmortem/intent.ts`.
  - It matches a mention that asks for a postmortem / post-mortem / incident review / write-up
    (English and Indonesian: "bikin postmortem", "buat postmortem").
  - It returns `"declined"` for a deferral or refusal ("postmortem nanti aja", "jangan bikin
    postmortem dulu", "no postmortem"), the same shape as `learnIntent`'s decline rule.
  - It returns null when the mention is not about a postmortem.
- Routed in the mention handler next to `learn`, BEFORE the generic investigation path.
  - `"declined"` gets one acknowledgement line and nothing else.
- `handlePostmortem(event, client, threadId)`:
  1. Find the incident with `findIncidentByThread(channel, threadTs)`, which is top-level only. If there is none, reply "This thread is not an incident thread — `postmortem` works in the thread of an alert." and stop: no LLM call.
  2. Post a progress line ("Drafting the postmortem…"), and edit it in place when done.
  3. `facts = await agent.postmortemFacts(incidentId, humans)`, where `humans` comes from the thread (see §2).
  4. `draft = await agent.draftPostmortem(facts)`.
  5. Store it: `agent.storePostmortem(incidentId, requestedBy, markdown, backend)`.
  6. Post into the thread: the Summary section, the Action items section, and either the link `${DASHBOARD_PUBLIC_URL}/incidents/<id>/postmortem` (when configured) or the path `/incidents/<id>/postmortem`.

### 2. Facts — `src/agent/postmortem/facts.ts`

```ts
interface PostmortemFacts {
  incident: {
    id: number; alertname: string; namespace: string | null; severity: string | null; assessedSeverity: string | null;
    alertStartedAt: string | null; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; rootCause: string | null; rca: string;
  };
  changes: ChangeTimeline | null;        // incidents.changes
  remediations: Array<{ action: string; summary: string; status: string; approvedBy: string | null; createdAt: string; executedAt: string | null; verdict: string | null; result: string | null }>;
  related: Array<{ id: number; alertname: string; subjects: string[]; createdAt: string; resolvedAt: string | null }>;
  confirmed: Array<{ by: string | null; rootCause: string | null; action: string | null; outcome: string | null; at: string }>; // incident_feedback
  humans: string[];                       // humanStatements(thread)
  investigation: { startedAt: string | null; endedAt: string | null } | null;  // agent_events start/end of the investigate run
  unavailable: string[];                  // sources that could not be read
}
```

- **Gathering.** `DevOpsAgent.postmortemFacts(incidentId, humans)` reads, in parallel and each best-effort (a failed source is added to `unavailable`, never an empty answer passed off as a fact):
  - the incident row (with `alert_started_at`, `changes`, `resolved_by`);
  - the remediations with verdicts, using the same query the dashboard detail page uses;
  - the children;
  - `incident_feedback`;
  - the first investigate run's start/end from `agent_events`.

  The Slack thread is read by `SlackApp` (it owns the client) with `conversations.replies`, passed through the existing `humanStatements` (which drops the bot's own messages), and handed in as `humans`. When that read fails, `humans` is `[]` and `"slack thread"` joins `unavailable`.
- **Pure renderers:**
  - `timelineOf(facts): Array<{ at: string; event: string }>`, sorted ascending. The events are:
    - the alert fired;
    - each change;
    - the investigation started and the RCA posted;
    - each related alert joined;
    - each remediation proposed, approved by whom, executed, and its verdict, or "PR opened <url>";
    - resolved, and by whom.
  - `numbersOf(facts)`:
    - **time to RCA** = investigation end − alert start;
    - **time to mitigation** = execution time of the first remediation whose verdict is `recovered`, minus the alert start;
    - **duration** = resolved − alert start;
    - the counts of related alerts and remediations.
    Each is null when an input is missing, and is never guessed.
  - `renderFacts(facts): string`: the Markdown for the `## Timeline` table and `## Numbers` list. Table cells are escaped (`|`, newlines).

### 3. Narrative — `src/agent/postmortem/draft.ts`

- **The call.** `DevOpsAgent.draftPostmortem(facts)` makes ONE LLM call with no tools, on the light route. The prompt asks for Markdown only, with exactly these headings in this order:
  - `## Summary`
  - `## Impact`
  - `## Root cause`
  - `## What went well`
  - `## What went poorly`
  - `## Action items` (bullets, each ending with `_(draft — needs an owner)_`)
- **Input.** The prompt carries the RCA, `renderFacts(facts)`, the confirmed feedback and the human statements, framed as data, not instructions.
- **Root cause rule, stated in the prompt:**
  - if `confirmed` has a root cause, it is THE root cause, and the agent's RCA is quoted as its hypothesis;
  - if they disagree, say so in one sentence;
  - with nothing confirmed, write "Not confirmed by a human; the agent's hypothesis was: …".
- **Assembly** (pure: `assemblePostmortem(facts, narrative, generatedAt)`):
  - a title line `# Postmortem draft — <alertname> in <namespace> (incident #<id>)`;
  - a status line (open/resolved, "draft generated by the DevOps AI agent at <iso>; review before sharing");
  - the model's Summary and Impact;
  - `renderFacts(facts)`;
  - the model's remaining sections;
  - `## Sources` (what was read, what was unavailable).
  The model can never replace Timeline or Numbers: any `## Timeline` / `## Numbers` section in its output is dropped, up to the next heading.
- **Missing sections.** A required heading missing from the model's output is filled with `_Not drafted — the model returned no text for this section._`, so a malformed answer still yields a complete document.
- **Grounding.** `groundingGaps(narrative, [], evidence)`, where evidence is the RCA + `renderFacts` + human statements. Ungrounded names become a `> ⚠️ Names not found in this incident's evidence: …` note under the title. It is a warning, never a block.

### 4. Storage — migration `015_postmortems.sql`

```sql
CREATE TABLE IF NOT EXISTS postmortems (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES incidents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by TEXT,
  backend TEXT,
  markdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS postmortems_by_incident ON postmortems (incident_id, created_at DESC);
```

A `PostmortemStore` provides `store`, `latest(incidentId)` and `exists(incidentId)`. Markdown passes through `cleanDeep` (the trace recorder's cleaner, already exported) before INSERT. Each regeneration is a new row; the latest is shown.

### 5. Dashboard (read-only, no new write routes)

- `GET /incidents/:id/postmortem` renders the latest draft with the existing `dashboard/markdown.ts` renderer, which already escapes. It shows "Generated <time> by <requested_by> · backend <backend>". A missing draft returns 404 with "No postmortem draft yet — ask `@agent postmortem` in the incident thread."
- `GET /incidents/:id/postmortem.md` returns `text/markdown; charset=utf-8` with `Content-Disposition: attachment; filename="postmortem-<id>.md"`.
- The incident detail page gets a "Postmortem draft →" link when one exists.

### 6. Config

`DASHBOARD_PUBLIC_URL` (optional, not secret) is used only for the Slack link. The chart value is `dashboard.publicUrl` in `devops-ai-helm-charts`, which adds the env var when it is set.

## Error handling

| Condition | Behaviour |
|---|---|
| Thread has no top-level incident | one-line reply, no LLM |
| Incident still open | draft anyway; status says open; durations needing resolve are null |
| A facts source fails | it is listed in `unavailable` and in `## Sources` |
| LLM call fails / times out | progress line edited to "❌ Could not draft the postmortem: <reason>"; nothing stored |
| Store fails | Slack still gets summary + action items, plus "not stored — the dashboard will not have it" |

## Testing

- **intent:** asks in English and Indonesian → `"postmortem"`; deferrals and refusals → `"declined"`; unrelated mentions → null.
- **facts (pure):**
  - timeline order across sources;
  - numbers, including the first `recovered` verdict and null on missing inputs;
  - no remediation; an open incident; children;
  - table escaping.
- **draft (pure):**
  - Timeline/Numbers byte-identical to `renderFacts` even when the narrative carries its own `## Timeline`;
  - a missing heading is filled;
  - an invented name gets the grounding note.
- **prompt:** carries the confirmed root cause and the disagreement instruction when `confirmed` is non-empty.
- **store:** `cleanDeep` applied; `latest` returns the newest.
- **dashboard:**
  - the page renders escaped Markdown;
  - a missing draft is 404;
  - `.md` has the right content type and disposition;
  - the detail page shows the link only when a draft exists.
- **wiring (fake `this`):**
  - a non-incident thread → one line, no LLM;
  - an incident thread → store called, and the summary and action items posted with a link from `DASHBOARD_PUBLIC_URL`;
  - an LLM failure → the error line, no store.
- **live:** `@agent postmortem` in a real incident thread; read the stored draft on the dashboard.

## Docs

- `devops-ai-agent/CLAUDE.md` gets a gotcha bullet: facts come from data and the model never writes Timeline/Numbers; the confirmed root cause outranks the hypothesis; the dashboard stays read-only; the trigger is Slack only. The migrations line moves to the next file, `016_*.sql`.
- `README.md`: a Usage subsection "Postmortem draft", a Key Features row, migration `015`, and the `DASHBOARD_PUBLIC_URL` config row.
- Chart: the `dashboard.publicUrl` value, with a README line.
