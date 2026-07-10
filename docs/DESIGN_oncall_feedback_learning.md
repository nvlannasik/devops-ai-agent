# Design — On-call Feedback Learning

> **Status:** design discussion (2026-07-07). Goal: the agent learns from what on-call
> engineers say in Slack alert threads (confirmed root causes, actions taken, outcomes),
> stores it as **high-trust** knowledge, and recalls it on future similar incidents to
> reduce hallucination and to make future remediation safer. This is the source of truth
> for the feature; implementation follows §8.

## 1. Goal

Today the agent stores only its **own** RCA (`storeIncident`, LLM-generated). Human
corrections and fixes in the thread are lost. This feature captures on-call feedback so
the agent stops re-guessing incidents it has effectively already been taught.

Serves four user goals:
- **Less hallucination** — ground future diagnosis in human-confirmed facts, not just past LLM guesses.
- **Fast / cheap for recurring incidents** — a confirmed prior lets the agent verify lightly instead of investigating cold (later phase).
- **Remember on-call actions** — the core of this doc.
- **Safer execution** — confirmed action history feeds the Guarded Remediation proposal (see `DESIGN_guarded_remediation.md`).

## 2. The trust-tier principle (backbone)

Separate two kinds of memory by **trust**, physically (different tables) and in **prompt framing**:

| Tier | Source | Table | Prompt framing |
|------|--------|-------|----------------|
| **Hypothesis** | Agent RCA (LLM) | `incidents` | "Prior hypothesis — verify with fresh evidence." (existing anti-anchoring) |
| **Confirmed** | On-call human | `incident_feedback` (new) | "Previously confirmed by on-call: cause X, fixed by Y. Strong prior — still confirm current state." |

Retrieving past **LLM guesses** as if true increases anchoring/hallucination. Retrieving
**human-confirmed** knowledge is what actually grounds the model. The tiers must never be
flattened into one.

## 3. Non-goals (v1)

- ❌ Passive capture of *every* channel message (`message.channels` subscription) — deferred to v2. v1 uses an **explicit trigger** to avoid the broad Slack scope and message-noise problem.
- ❌ Semantic/vector recall (pgvector) — separate phase; v1 keeps exact `(alertname, namespace)` match.
- ❌ Auto-extraction on every reply — only on an explicit human signal, to avoid storing "thanks"/"looking into it" noise and burning tokens.
- ❌ Acting on the learned knowledge (execution) — that's Guarded Remediation; this only *stores & recalls*.

## Decisions summary

| Question | Decision | § |
|----------|----------|---|
| How to capture human feedback? | **Explicit trigger** (`@agent learn` mention, or a ✅ `reaction_added`) — not passive message capture in v1 | 5.1 |
| How to structure free text into knowledge? | **One structured-output LLM call** over the thread → `{root_cause, action, outcome}` | 5.2 |
| Where to store? | New **`incident_feedback`** table (1:N, FK to `incidents`), the "confirmed" tier | 5.3 |
| How to link a thread reply to an incident? | Store **`thread_ts` + `channel` on `incidents`** (currently missing) | 5.3 |
| How to recall? | `recall()` also pulls confirmed feedback, framed as a **strong prior** (distinct from hypothesis) | 5.4 |
| Multi-pod safety? | Extraction is idempotent per `(incident_id, trigger)` via unique index / row-flip | 5.5 |

## 4. Flow

```
Alert → investigate → RCA posted (existing); incident row now stores thread_ts + channel
                          ↓
        On-call discusses in the thread: "real cause was the DB connection pool, I scaled the deployment, resolved"
                          ↓
        On-call gives an EXPLICIT signal:  @agent learn   (or reacts ✅ on the RCA message)
                          ↓
        Agent maps the thread_ts → incident_id (owned-thread lookup)
                          ↓
        One structured-output LLM call over the thread → { confirmed_root_cause, action_taken, outcome }
                          ↓
        Insert into incident_feedback (source=human, confirmed) — idempotent per (incident, trigger)
                          ↓
        Ack in thread: "📚 Learned: root cause = ..., action = ... — I'll recall this next time."
                          ↓
   (future incident, same alertname+namespace) → recall() injects the CONFIRMED block as a strong prior
```

## 5. Components

### 5.1 Capture — explicit trigger (v1)
- **Trigger options (support both):**
  - `@agent learn` — a mention, already handled via `app_mention`; a keyword router branches it to the learn flow.
  - ✅ **`reaction_added`** on the agent's RCA message — needs the `reactions:read` scope + event subscription (small). Natural UX: on-call just reacts when the RCA/discussion is settled.
- **Why explicit, not passive:** Slack only pushes `app_mention` by default. Passive capture of thread replies needs `message.channels`/`message.groups` (broad scope, all channel traffic, self/bot-loop guards, privacy surface). An explicit human signal sidesteps all of that AND guarantees the human decided "this is worth learning" — no noise filtering, no wasted extraction tokens. Passive capture is a v2 refinement.
- **Ownership guard:** only act if `thread_ts` maps to an incident row we own (§5.3). Ignore triggers in unrelated threads.

### 5.2 Extraction — free text → structured knowledge
- Fetch the thread messages (`conversations.replies`), run **one structured-output LLM call**:
  ```json
  { "confirmed_root_cause": "DB connection pool exhausted", "action_taken": "scaled payment-api to 4 replicas", "outcome": "resolved" }
  ```
- `outcome` ∈ `resolved | mitigated | unresolved | unknown`.
- If the call yields nothing substantive (e.g. the thread has no real conclusion), store nothing and reply "nothing concrete to learn yet."
- This is deliberately a *separate* call from investigation — cheap, easy to validate, and keeps extraction logic out of the agentic loop.

### 5.3 Storage — schema (migration `002`)
Two changes:

```sql
-- (a) Link incidents to their Slack thread so replies can be mapped back.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS thread_ts TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS channel   TEXT;
CREATE INDEX IF NOT EXISTS idx_incidents_thread ON incidents (thread_ts);

-- (b) The confirmed (human) tier.
CREATE TABLE IF NOT EXISTS incident_feedback (
  id                   BIGSERIAL PRIMARY KEY,
  incident_id          BIGINT REFERENCES incidents(id),
  source               TEXT NOT NULL DEFAULT 'human',   -- 'human' (on-call)
  slack_user           TEXT,                            -- who confirmed
  confirmed_root_cause TEXT,
  action_taken         TEXT,
  outcome              TEXT,                            -- resolved | mitigated | unresolved | unknown
  raw_excerpt          TEXT,                            -- provenance: the thread text extracted from
  trigger_key          TEXT,                            -- for idempotency, e.g. reaction ts / message ts
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: the same trigger must not store twice (multi-pod, double-react).
CREATE UNIQUE INDEX IF NOT EXISTS one_feedback_per_trigger
  ON incident_feedback (incident_id, trigger_key);
```

> **`storeIncident` must return `id`** (same prerequisite as Guarded Remediation) and must
> now persist `thread_ts` + `channel`. The alert path already has both (`threadId`, `channel`).

### 5.4 Recall — inject as a strong prior
Extend `IncidentMemory.recall()` to also query `incident_feedback` for matching incidents
and render it **separately** from the hypothesis block:

```
## Previously CONFIRMED by on-call (same alert in namespace payment)
- 2026-06-19 — root cause: DB connection pool exhausted; action: scaled payment-api to 4 replicas; outcome: resolved
These were confirmed by a human. Treat as a strong prior, but still confirm the current state matches before reusing.
```

The existing hypothesis (agent-RCA) block stays as-is. The model now sees two clearly
labeled tiers. This dual framing is the anti-hallucination lever.

### 5.5 Multi-pod safety
`reaction_added` / mention events can land on any pod. Extraction + store must be
idempotent: the `unique (incident_id, trigger_key)` index makes a duplicate insert a no-op
(catch the unique violation, treat as "already learned"). Same trick as dedup / remediation.

## 6. How this feeds Guarded Remediation
When the agent later proposes an action, the proposal step consults
`incident_feedback.action_taken` for similar incidents: *"on-call previously resolved this
by scaling payment-api"* → propose that action with a stronger rationale, or at minimum
surface it on the approval card so the approver sees prior art. Confirmed action history is
exactly what makes the future execute path safer.

## 7. v1 scope (minimal cut)
1. Migration `002`: `incidents.thread_ts/channel` + `incident_feedback` table + indexes.
2. `storeIncident` returns `id` and persists `thread_ts` + `channel`.
3. One trigger to start: `@agent learn` (reuses `app_mention`; add `reaction_added` next).
4. Extraction: one structured-output LLM call over `conversations.replies`.
5. Store to `incident_feedback` (idempotent), ack in thread.
6. `recall()` also injects the confirmed block as a strong prior.

**Skip for v1:** passive `message.channels` capture, semantic/pgvector recall, fast-path
short-circuit, auto-trigger on alert-resolved. Add once the explicit-trigger loop is proven.

## 8. Implementation order
| Step | Task |
|------|------|
| 1 | Migration `002` (schema above) + `storeIncident` returns id & stores thread_ts/channel |
| 2 | `IncidentFeedback` store/recall in `agent/incidents/` (or a sibling module) |
| 3 | `@agent learn` router in `app_mention` → ownership lookup → extraction call → store → ack |
| 4 | Extend `recall()` to inject the confirmed tier; update `prompts/system.md` framing |
| 5 | Add `reaction_added` (✅) as a second trigger (scope `reactions:read`) |

Step 2 needs 1. Steps 3–4 need 2. Step 5 is additive.

## 9. Prerequisites / risks
- **Slack scopes:** `@agent learn` reuses existing `app_mention`. `reaction_added` needs `reactions:read` + event subscription. Passive capture (v2) would need `message.channels`/`message.groups` — deliberately avoided in v1.
- **Extraction quality:** the LLM might mis-extract. Mitigate by echoing what was learned in the ack ("📚 Learned: …") so on-call can correct it (re-trigger overwrites/adds).
- **Privacy:** v1 only reads a thread the human explicitly pointed at — no broad message ingestion.
- **Provenance:** store `raw_excerpt` so a learned fact can be traced back to who said it and where.

## 10. v2 (after v1 is proven)
- **Passive capture** via `message.channels`, scoped to owned threads, with self/bot guards — learn without an explicit trigger.
- **Semantic recall (pgvector)** — recognize *similar* incidents across different alertnames; reuse existing Postgres, no new datastore.
- **Fast path** — on a strong confirmed match, verify lightly instead of a full agentic loop (token + latency savings).
- **Auto-trigger on resolve** — tie into the resolved-alert loop (roadmap §D): when an alert resolves, prompt/extract the outcome automatically.
