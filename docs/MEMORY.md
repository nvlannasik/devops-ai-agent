# Incident memory

Set `DB_HOST` (+ `DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`/`DB_SSL_MODE`, see
[CONFIGURATION.md](CONFIGURATION.md#storage-conversation-memory-incident-memory)) to give the agent a
durable memory of past incidents (distinct from conversation memory, which is a short-lived
Redis/in-memory cache). Disabled unless `DB_HOST` is set. On each Alertmanager-triggered
investigation the agent:

1. **Recalls** prior resolved incidents with the same `alertname` (+ `namespace` if present) and injects a compact digest — *"2026-06-19 (critical, High): OOMKilled — connection pool leak"* — into the prompt.
2. **Stores** the resulting RCA (alertname, namespace, severity, confidence, root cause) after it's posted.

Past incidents are framed to the model as **hypotheses to verify**, not facts, to avoid anchoring on a stale root cause — deploy a Postgres component alongside the agent.

## Three trust tiers (never flattened)

1. **human-confirmed** — `@agent learn` captures root cause, action taken, and outcome with provenance (`incident_feedback`). Injected first as a *strong prior* ("check this hypothesis FIRST"). Feedback is idempotent per trigger (unique `(incident_id, trigger_key)`), so a double-click or multi-pod delivery can't store twice. See [USAGE.md](USAGE.md#teaching-the-agent-learn).
2. **agent hypothesis** — the agent's own past RCAs for the exact same `(alertname, namespace)`. "Verify before reuse."
3. **possibly related** — incidents whose recorded root cause merely *shares wording* with the current alert, so a `NodeMemoryPressure` can surface the `OOMKilled` it caused. This is Postgres's built-in full-text search (a generated `tsvector` column + GIN index — no pgvector, no embeddings API, no extension), ranked by how many distinct terms overlap. Weakest tier: a lead to check, never an explanation, and skipped entirely when there is no query text.

Past remediations are recalled too, each carrying the **verdict** of its post-remediation check — so "we already tried this and the alert stayed up" is something the agent can read, not something it has to rediscover. See [REMEDIATION.md](REMEDIATION.md#remediation-memory).

## Database migrations

Schema lives in versioned `.sql` files under `migrations/` and is applied by a small framework-free runner (`src/db/migrate.ts`):

```bash
npm run migrate          # dev (tsx)
npm run migrate:prod     # prod (node dist/src/db/migrate-cli.js)
```

The runner tracks applied versions in a `schema_migrations` table and wraps each file in a transaction. It takes a **Postgres advisory lock**, so multiple agent pods starting at once (autoscaling) serialize instead of racing on DDL. The agent also runs migrations on startup, so a separate step is optional — but for a clean rollout you can run it as a Kubernetes `Job` or `initContainer` (`command: ["node","dist/src/db/migrate-cli.js"]`) before the Deployment. Add a new change as the next numbered file (`001`–`015` exist; next is `migrations/016_*.sql`). Because migrations run at pod startup, a migration that fails is a pod that won't start — so avoid anything needing a privilege the app role may not have (`CREATE EXTENSION`, for one).
