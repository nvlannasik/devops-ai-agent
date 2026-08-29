import { Pool } from "pg";
import type { UnresolvedIncident } from "./reconcile.js";
import { parseConfidence } from "../confidence/index.js";
import logger from "../../utils/logger/index.js";

// How many distinct stemmed terms an old root cause must share with the current alert
// before it is worth showing. 1 is noise — every Kubernetes alert shares *some* word with
// every other. 2 is the smallest number that means "these two texts are about the same
// thing" rather than "these two texts are both about Kubernetes".
const MIN_OVERLAP = 2;
const MAX_TERMS = 24; // ORing more than this into one tsquery buys nothing but planner work
const MIN_TERM_LEN = 4;

// Vocabulary every alert carries: it appears in the query text no matter what broke, so it
// can only manufacture overlap. Postgres already strips English stopwords when building the
// tsvector — this list is the DevOps envelope it doesn't know about. Words that name a
// *failure* (oom, evicted, throttled, timeout…) are deliberately absent: those are signal.
const ENVELOPE_WORDS = new Set([
  "alert", "alerts", "alertname", "alertmanager", "firing", "resolved", "severity", "warning",
  "critical", "info", "namespace", "cluster", "kubernetes", "kubelet", "container", "containers",
  "instance", "endpoint", "service", "deployment", "prometheus", "grafana", "label", "labels",
  "annotation", "annotations", "summary", "description", "runbook", "dashboard", "source",
  "value", "https", "http", "true", "false", "null", "none", "automated", "investigation",
  "incident", "webhook",
]);

// Split the alert text into the terms fed to the similarity tier. CamelCase is broken up
// first: `KubePodCrashLooping` is one token to a tokenizer and matches nothing, but
// `crash`/`looping` match plenty. Only `recallSimilar` calls this — exported for the test,
// because what this drops is the whole difference between a lead and noise.
export function queryTerms(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // KubePod   → Kube Pod
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // OOMKilled → OOM Killed
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (w.length < MIN_TERM_LEN || w.length > 32) continue;
    if (/^\d+$/.test(w)) continue; // bare numbers (ports, replica counts) aren't topics
    if (ENVELOPE_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

// Durable cross-incident memory (Postgres). Unlike conversation memory (Redis, 24h TTL,
// cache semantics), this is a system-of-record: resolved RCAs persist so the agent can
// recognize recurring incidents instead of re-diagnosing from scratch every time.
// Schema is owned by migrations/ (see src/db/migrate.ts), not created here.
// What a status flip hands back: the thread to tell, and the label set the dedup claim was
// taken under. `resolved_by` is who last set the status — 'alertmanager' (webhook),
// 'reconciler' (the sweeper), or a Slack user id when on-call said so.
export type ResolvedIncident = {
  channel: string | null;
  threadTs: string | null;
  alertname: string;
  namespace: string | null;
  groupLabels: Record<string, string> | null;
};

const shapeResolved = (r: Record<string, any>): ResolvedIncident => ({
  channel: r.channel ?? null,
  threadTs: r.thread_ts ?? null,
  alertname: r.alertname,
  namespace: r.namespace ?? null,
  groupLabels: r.group_labels ?? null,
});

export class IncidentMemory {
  constructor(
    private readonly pool: Pool | null,
    private readonly onStored?: (incidentId: number, threadTs: string) => void
  ) {}

  // Recall prior knowledge for the same alert (+ namespace when present), in trust tiers
  // that must never be flattened: human-CONFIRMED feedback (strong prior), agent
  // hypotheses for the same alert (verify before reuse), and — only when `queryText` is
  // supplied — incidents whose recorded root cause merely shares vocabulary with the
  // alert text (weakest; a lead, not an answer). See migrations/005.
  async recall(
    labels: Record<string, string>,
    opts: { queryText?: string; limit?: number } = {}
  ): Promise<string> {
    if (!this.pool) return "";
    const alertname = labels.alertname;
    if (!alertname) return ""; // nothing to key on (e.g. ad-hoc mention)
    const namespace = labels.namespace ?? null;
    const limit = opts.limit ?? 3;

    const [hypo, confirmed] = await Promise.all([
      this.pool.query(
        `SELECT created_at, severity, confidence, root_cause
           FROM incidents
          WHERE alertname = $1 AND ($2::text IS NULL OR namespace = $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [alertname, namespace, limit]
      ),
      this.pool.query(
        `SELECT f.created_at, f.confirmed_root_cause, f.action_taken, f.outcome
           FROM incident_feedback f
           JOIN incidents i ON i.id = f.incident_id
          WHERE i.alertname = $1 AND ($2::text IS NULL OR i.namespace = $2)
          ORDER BY f.created_at DESC
          LIMIT $3`,
        [alertname, namespace, limit]
      ),
    ]);

    const sections: string[] = [];

    if (confirmed.rows.length > 0) {
      const lines = confirmed.rows.map((r: any) => {
        const date = new Date(r.created_at).toISOString().slice(0, 10);
        const parts = [
          r.confirmed_root_cause ? `root cause: ${String(r.confirmed_root_cause).slice(0, 300)}` : null,
          r.action_taken ? `action: ${String(r.action_taken).slice(0, 300)}` : null,
          `outcome: ${r.outcome || "unknown"}`,
        ].filter(Boolean);
        return `- ${date} — ${parts.join("; ")}`;
      });
      sections.push(
        [
          `## Previously CONFIRMED by on-call — same alert${namespace ? ` in namespace ${namespace}` : ""}`,
          ...lines,
          `These were confirmed by a human. Treat them as a strong prior, but verify the current state still matches before reusing.`,
          `If fresh evidence confirms this is the same issue again, reply concisely: known recurrence + confirmed root cause + the evidence you verified + the concrete recommended fix (exact identifiers). No full RCA template needed.`,
        ].join("\n")
      );
    }

    if (hypo.rows.length > 0) {
      const lines = hypo.rows.map((r: any) => {
        const date = new Date(r.created_at).toISOString().slice(0, 10);
        const cause = (r.root_cause || "").slice(0, 300) || "(no root cause recorded)";
        return `- ${date} (severity ${r.severity || "?"}, confidence ${r.confidence || "?"}): ${cause}`;
      });
      sections.push(
        [
          `## Prior similar incidents — same alert${namespace ? ` in namespace ${namespace}` : ""}`,
          ...lines,
          `These are hypotheses from earlier investigations, NOT ground truth. Confirm with fresh evidence before reusing a root cause.`,
        ].join("\n")
      );
    }

    const similar = opts.queryText ? await this.recallSimilar(opts.queryText, alertname, namespace, limit) : [];
    if (similar.length > 0) {
      const lines = similar.map((r) => {
        const date = new Date(r.created_at).toISOString().slice(0, 10);
        const where = `${r.alertname}${r.namespace ? ` in ${r.namespace}` : ""}`;
        return `- ${date} — ${where} (${r.overlap} shared terms): ${(r.root_cause || "").slice(0, 300)}`;
      });
      sections.push(
        [
          `## Possibly related — matched on wording, not on alert identity`,
          ...lines,
          `These surfaced because their recorded root cause shares vocabulary with this alert — a lexical overlap, NOT a causal link, and a different alert entirely. Weakest tier: treat each as one lead worth checking, never as an explanation. Cite one only if your own evidence independently supports it.`,
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  // Weakest recall tier: incidents whose root_cause shares at least MIN_OVERLAP distinct
  // stemmed terms with the alert text. The GIN index on root_cause_tsv does the cheap
  // filtering (`@@`); the overlap count then ranks and thresholds the survivors, because
  // ts_rank on an OR query scores a two-term hit the same as a one-term hit — "how many
  // distinct terms do these share" is both a better signal and one a human can check.
  // Rows the exact-match tiers already cover are excluded here so nothing appears twice.
  private async recallSimilar(
    queryText: string,
    alertname: string,
    namespace: string | null,
    limit: number
  ): Promise<Array<{ created_at: string; alertname: string; namespace: string | null; root_cause: string | null; overlap: number }>> {
    const terms = queryTerms(queryText);
    if (terms.length < MIN_OVERLAP) return []; // can't clear the bar — don't bother the DB
    try {
      const { rows } = await this.pool!.query(
        `WITH q AS (
           SELECT to_tsquery('english', array_to_string($1::text[], ' | ')) AS tsq,
                  (SELECT array_agg(DISTINCT lexeme)
                     FROM unnest(to_tsvector('english', array_to_string($1::text[], ' ')))) AS lex
         ),
         cand AS (
           SELECT i.created_at, i.alertname, i.namespace, i.root_cause,
                  (SELECT count(*) FROM unnest(i.root_cause_tsv) u WHERE u.lexeme = ANY(q.lex))::int AS overlap
             FROM incidents i, q
            WHERE i.root_cause_tsv @@ q.tsq
              AND NOT (i.alertname = $2 AND ($3::text IS NULL OR i.namespace = $3))
         )
         SELECT * FROM cand WHERE overlap >= $4 ORDER BY overlap DESC, created_at DESC LIMIT $5`,
        [terms, alertname, namespace, MIN_OVERLAP, limit]
      );
      return rows;
    } catch (err) {
      // never let the weakest tier break a recall — the other two still stand on their own
      logger.error(`[incidents] recallSimilar failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // D. resolved-alert loop: mark the newest unresolved incident for this alert as
  // resolved and return its Slack thread so the app can post the ✅ update there.
  async markResolved(
    labels: Record<string, string>,
    by = "alertmanager"
  ): Promise<{ channel: string; threadTs: string } | null> {
    if (!this.pool) return null;
    const alertname = labels.alertname;
    if (!alertname) return null;
    try {
      const { rows } = await this.pool.query(
        `UPDATE incidents SET resolved_at = now(), resolved_by = $3, cleared_seen_at = NULL
          WHERE id = (
            SELECT id FROM incidents
             WHERE alertname = $1 AND namespace IS NOT DISTINCT FROM $2 AND resolved_at IS NULL
             ORDER BY created_at DESC LIMIT 1)
          RETURNING channel, thread_ts`,
        [alertname, labels.namespace ?? null, by]
      );
      if (rows.length === 0 || !rows[0].channel || !rows[0].thread_ts) return null;
      return { channel: rows[0].channel, threadTs: rows[0].thread_ts };
    } catch (err) {
      logger.error(`[incidents] markResolved failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Map a Slack thread back to its incident (threads are linked since migration 002).
  async findIncidentByThread(channel: string, threadTs: string): Promise<number | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT id FROM incidents WHERE channel = $1 AND thread_ts = $2 ORDER BY created_at DESC LIMIT 1`,
      [channel, threadTs]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  /**
   * What alert this thread is about. Separate from findIncidentByThread (which answers "which
   * row", for feedback and remediation) because this answers "what is this conversation
   * anchored to" — the mention path stamps it on every message.
   *
   * The anchor has to be durable and this is the only place that is: the alert text sits at
   * history[0] and is pinned, but by the third round it is one sentence at the far end of the
   * window against whatever the freshest tool result says, and that is how a question about
   * `sample-apps` ended up querying `default`.
   */
  async threadAlertIdentity(channel: string, threadTs: string): Promise<{ alertname: string; namespace: string | null } | null> {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      `SELECT alertname, namespace FROM incidents
         WHERE channel = $1 AND thread_ts = $2 ORDER BY created_at DESC LIMIT 1`,
      [channel, threadTs]
    );
    if (rows.length === 0) return null;
    return { alertname: String(rows[0].alertname), namespace: rows[0].namespace ?? null };
  }

  // Store human-confirmed feedback (the trusted tier). Idempotent per (incident_id,
  // trigger_key) via the unique index — a duplicate trigger is reported, not an error.
  async storeFeedback(
    incidentId: number,
    fb: {
      slackUser: string;
      triggerKey: string;
      rawExcerpt: string;
      confirmed_root_cause: string | null;
      action_taken: string | null;
      outcome: string;
    }
  ): Promise<"stored" | "duplicate" | "failed"> {
    if (!this.pool) return "failed";
    try {
      await this.pool.query(
        `INSERT INTO incident_feedback
           (incident_id, slack_user, confirmed_root_cause, action_taken, outcome, raw_excerpt, trigger_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [incidentId, fb.slackUser, fb.confirmed_root_cause, fb.action_taken, fb.outcome, fb.rawExcerpt, fb.triggerKey]
      );
      return "stored";
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return "duplicate"; // unique_violation
      logger.error(`[incidents] storeFeedback failed: ${err instanceof Error ? err.message : err}`);
      return "failed";
    }
  }

  // Store a completed RCA. Best-effort — a storage failure must never break the investigation.
  // Returns the new incidents.id so remediations/feedback can link to it (null when
  // disabled, unkeyed, or failed). channel/thread_ts let thread replies map back here.
  async store(
    labels: Record<string, string>,
    rca: string,
    slack?: { channel: string; threadTs: string }
  ): Promise<number | null> {
    if (!this.pool) return null;
    const alertname = labels.alertname;
    if (!alertname) return null;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO incidents (alertname, namespace, severity, confidence, root_cause, rca, channel, thread_ts, group_labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING id`,
        [
          alertname,
          labels.namespace ?? null,
          // conversational recurrence replies have no RCA labels — fall back to the
          // alert's own severity and the reply's opening as the recallable root cause
          parseSeverity(rca) ?? labels.severity?.toLowerCase() ?? null,
          parseConfidence(rca),
          extractRootCause(rca) ?? (rca.replace(/\s+/g, " ").trim().slice(0, 300) || null),
          rca,
          slack?.channel ?? null,
          slack?.threadTs ?? null,
          // the dedup claim was taken on THIS label set (Alertmanager commonLabels, usually
          // richer than group_by) — alertname+namespace hashes to a different fingerprint,
          // so without storing it nothing outside the webhook can release the claim
          JSON.stringify(labels),
        ]
      );
      const id = Number(rows[0].id);
      // fire-and-forget: links this investigation's llm_usage rows to the incident they
      // produced. Best-effort by contract — see UsageStore.
      if (slack?.threadTs) this.onStored?.(id, slack.threadTs);
      return id;
    } catch (err) {
      logger.error(`[incidents] store failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // --- Status reconciliation + on-call status feedback (migrations/007) ---------------
  //
  // The webhook is not a reliable channel for "this alert is over": it fires once, is never
  // repeated, and is acked before it is processed. Everything below is the second way to
  // reach the same state, driven either by Alertmanager's own current view (the sweeper) or
  // by the on-call engineer in the thread.

  // The sweeper's candidates. `minAgeSeconds` keeps freshly-opened incidents out of reach:
  // an alert needs resolve_timeout + group_interval (5m + 5m by default) before Alertmanager's
  // view of it is settled enough to read absence as recovery.
  async listUnresolved(minAgeSeconds: number, limit: number): Promise<UnresolvedIncident[]> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT id, alertname, namespace, channel, thread_ts, group_labels, cleared_seen_at
           FROM incidents
          WHERE resolved_at IS NULL
            AND alertname IS NOT NULL
            AND created_at < now() - ($1::int * interval '1 second')
          ORDER BY created_at
          LIMIT $2`,
        [minAgeSeconds, limit]
      );
      return rows.map((r: Record<string, any>) => ({
        id: Number(r.id),
        alertname: r.alertname,
        namespace: r.namespace ?? null,
        channel: r.channel ?? null,
        threadTs: r.thread_ts ?? null,
        groupLabels: r.group_labels ?? null,
        clearedSeenAt: r.cleared_seen_at ? new Date(r.cleared_seen_at).toISOString() : null,
      }));
    } catch (err) {
      logger.error(`[incidents] listUnresolved failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // First pass that saw the alert gone. Only ever sets the timestamp — the second pass reads
  // it to decide, so overwriting it here would restart the confirmation window forever.
  async noteClearedSeen(ids: number[]): Promise<void> {
    await this.updateCleared(
      ids,
      `UPDATE incidents SET cleared_seen_at = now() WHERE id = ANY($1::bigint[]) AND cleared_seen_at IS NULL`
    );
  }

  // The alert is back before the window elapsed — drop the sighting so it has to be seen
  // clear twice again from scratch.
  async resetClearedSeen(ids: number[]): Promise<void> {
    await this.updateCleared(ids, `UPDATE incidents SET cleared_seen_at = NULL WHERE id = ANY($1::bigint[])`);
  }

  private async updateCleared(ids: number[], sql: string): Promise<void> {
    if (!this.pool || ids.length === 0) return;
    try {
      await this.pool.query(sql, [ids]);
    } catch (err) {
      logger.error(`[incidents] cleared-sighting update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Close one incident by id. `resolved_at IS NULL` in the WHERE is the concurrency guard,
   * not decoration: with several replicas sweeping, exactly one UPDATE returns a row, so
   * exactly one pod posts the checkmark into the thread.
   *
   * Returns what the caller needs to finish the job — the thread to post in and the label set
   * to release the dedup claim under.
   */
  async markResolvedById(id: number, by: string): Promise<ResolvedIncident | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        `UPDATE incidents SET resolved_at = now(), resolved_by = $2, cleared_seen_at = NULL
          WHERE id = $1 AND resolved_at IS NULL
          RETURNING channel, thread_ts, alertname, namespace, group_labels`,
        [id, by]
      );
      return rows.length > 0 ? shapeResolved(rows[0]) : null;
    } catch (err) {
      logger.error(`[incidents] markResolvedById ${id} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // On-call says it is not over. Same guard in reverse: only a currently-resolved row flips,
  // so a second `reopen` is reported as "already firing" instead of silently doing nothing.
  // The cleared sighting goes too — the sweeper must re-earn its two passes.
  async reopenById(id: number, by: string): Promise<ResolvedIncident | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        `UPDATE incidents SET resolved_at = NULL, resolved_by = $2, cleared_seen_at = NULL
          WHERE id = $1 AND resolved_at IS NOT NULL
          RETURNING channel, thread_ts, alertname, namespace, group_labels`,
        [id, by]
      );
      return rows.length > 0 ? shapeResolved(rows[0]) : null;
    } catch (err) {
      logger.error(`[incidents] reopenById ${id} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Cheap reachability check for /health. true when disabled (nothing to be unhealthy about)
  // or when a SELECT 1 succeeds.
  async ping(): Promise<boolean> {
    if (!this.pool) return true;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

// matches the RCA format: "*🔴 Severity:* `critical`" style label
export function parseSeverity(rca: string): string | null {
  const m = rca.match(/\*[^*]*Severity[^*]*\*[^`]*`\[?([^\]`]+)\]?`/i);
  return m ? m[1].trim().toLowerCase() : null;
}

// pull the "📍 Root Cause" section up to the next emoji section header
export function extractRootCause(rca: string): string | null {
  const idx = rca.search(/Root Cause/i);
  if (idx === -1) return null;
  let rest = rca.slice(idx).replace(/^Root Cause[*`:\s]*\n?/i, "");
  const next = rest.search(/[\n\r][^\n]*[📊🚫🔧⚠️📈]/u);
  if (next !== -1) rest = rest.slice(0, next);
  const cleaned = rest.replace(/\s+/g, " ").trim().slice(0, 1000);
  return cleaned || null;
}
