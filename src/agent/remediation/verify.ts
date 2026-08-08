import type { Pool } from "pg";
import logger from "../../utils/logger/index.js";

// Post-remediation verification (schema: migrations/006). The question here is "did the
// problem go away", not "what do the pods look like now" — the alert that paged is the
// primary signal, pod health is the corroborating detail, and the answer is a verdict with
// the evidence it was read from. Everything above the store is pure so the decision table
// can be tested without a cluster.

export type Verdict = "recovered" | "unchanged" | "worse" | "inconclusive";

// "none" = this remediation has no alert behind it (mention-driven, no incident labels);
// "unknown" = Prometheus was asked and could not be read. Collapsing the two would let a
// broken tool call read as "there is no alert", i.e. as success.
export type AlertState = "firing" | "cleared" | "unknown" | "none";

export type PodHealth = {
  total: number;
  ready: number;
  notReady: number;
  restarts: number;
};

export type RemediationCheck = {
  id: number;
  remediationId: number;
  channel: string;
  threadTs: string;
  alertname: string | null;
  namespace: string | null;
  target: { namespace: string; name: string };
  before: PodHealth | null;
  attempts: number;
  createdAt: string; // when the remediation ran — the verdict quotes the REAL wait, not the configured one
};

const LEASE_SECONDS = 180; // how long a claimed check is invisible to other pods
const MAX_ATTEMPTS = 3; // after this many claims a check is abandoned as inconclusive
const CLAIM_BATCH = 5;

type PodRecord = { name?: unknown; status?: unknown; ready?: unknown; restarts?: unknown };

// k8s_list_pods returns a JSON array of {name, status, ready, restarts, ...}. The workload's
// pods carry its name as a prefix (ReplicaSet / StatefulSet naming), which is the same
// matching the old status check did — but on parsed records instead of substrings.
//
// null means "could not read", and callers must keep it distinct from a healthy zero: an
// unparseable tool result is not evidence that anything recovered.
export function summarizePods(raw: string, namePrefix: string): PodHealth | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const pods = (parsed as PodRecord[]).filter(
    (p) => !!p && typeof p === "object" && typeof p.name === "string" && (!namePrefix || p.name.startsWith(namePrefix))
  );
  // Ready is the container-level truth: a CrashLoopBackOff pod reports phase "Running" with
  // ready=false, so counting phases alone would score a crash loop as healthy.
  const ready = pods.filter((p) => p.ready === true && p.status === "Running").length;
  return {
    total: pods.length,
    ready,
    notReady: pods.length - ready,
    restarts: pods.reduce((n, p) => n + (typeof p.restarts === "number" ? p.restarts : 0), 0),
  };
}

// Is the alert that paged us still active? "pending" counts as firing: the rule's condition
// is true again and only the `for:` window hasn't elapsed — that is the problem coming back,
// not a recovery.
export function alertState(raw: string, alertname: string | null, namespace: string | null): AlertState {
  if (!alertname) return "none";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(parsed)) return "unknown";

  const active = parsed.some((a) => {
    if (!a || typeof a !== "object") return false;
    const rec = a as { name?: unknown; state?: unknown; labels?: Record<string, unknown> };
    if (rec.name !== alertname) return false;
    // Only reject on a namespace we can actually compare — an alert without the label
    // (node-level rules) still counts for the namespace it was investigated under.
    const ns = rec.labels?.namespace;
    if (namespace && typeof ns === "string" && ns !== namespace) return false;
    return rec.state === "firing" || rec.state === "pending";
  });
  return active ? "firing" : "cleared";
}

// The decision table. `before` is the pod snapshot taken at approval time, so "worse" means
// the workload regressed WHILE we were waiting — pods that fell out of Ready, or containers
// that started restarting again — rather than the pre-existing damage we were fixing.
export function decideVerdict(
  alert: AlertState,
  before: PodHealth | null,
  after: PodHealth | null,
  ctx: { alertname: string | null }
): { verdict: Verdict; detail: string } {
  const parts: string[] = [];
  if (alert === "firing") parts.push(`\`${ctx.alertname}\` is still firing`);
  if (alert === "cleared") parts.push(`\`${ctx.alertname}\` is no longer firing`);
  if (alert === "unknown") parts.push(`could not read alert state from Prometheus`);
  parts.push(after ? `${after.ready}/${after.total} pods ready, ${after.restarts} restart(s)` : "pod state unreadable");

  // "worse" is readiness falling, and only that. A rollout replaces the pod set, so a
  // restart delta compares different pods — the old crashing pod's counter is still in the
  // baseline while the new pods start at zero, which would score a half-finished rollout as
  // a regression. Restart counts stay in the detail as evidence, not as a trigger.
  if (before && after && after.notReady > before.notReady) {
    parts.push(`readiness regressed since the remediation: not-ready ${before.notReady}→${after.notReady}`);
    return { verdict: "worse", detail: parts.join("; ") };
  }

  if (alert === "firing") return { verdict: "unchanged", detail: parts.join("; ") };
  if (alert === "unknown") return { verdict: "inconclusive", detail: parts.join("; ") };
  if (!after) return { verdict: "inconclusive", detail: parts.join("; ") };

  if (alert === "cleared") {
    // The alert going quiet while pods are still down usually means the rule stopped
    // matching (pods deleted, series gone), not that anything got better.
    return after.notReady > 0
      ? { verdict: "inconclusive", detail: parts.join("; ") }
      : { verdict: "recovered", detail: parts.join("; ") };
  }

  // alert === "none": pods are the only evidence there is.
  if (after.total === 0) return { verdict: "inconclusive", detail: parts.join("; ") };
  return after.notReady === 0
    ? { verdict: "recovered", detail: parts.join("; ") }
    : { verdict: "unchanged", detail: parts.join("; ") };
}

const VERDICT_HEADING: Record<Verdict, string> = {
  recovered: "✅ *Verified — recovered*",
  unchanged: "⚠️ *Verified — not fixed*",
  worse: "🔴 *Verified — worse after remediation*",
  inconclusive: "❔ *Could not verify*",
};

const VERDICT_FOOTER: Record<Verdict, string> = {
  recovered: "",
  unchanged: "This action did not resolve the alert — it is recorded so the same fix isn't proposed again unchanged.",
  worse: "The workload is in a worse state than right after the remediation. Human review recommended.",
  inconclusive: "Treat this as no evidence either way, not as success.",
};

// The thread message. Deliberately says how long it waited, measured from when the check was
// scheduled rather than from the configured delay — a retried check waited longer than the
// setting says, and a verdict with no elapsed time invites "maybe it just needed longer",
// which is the whole argument this check exists to settle.
export function verdictMessage(check: Pick<RemediationCheck, "target" | "createdAt">, verdict: Verdict, detail: string): string {
  const where = `\`${check.target.namespace}/${check.target.name}\``;
  const footer = VERDICT_FOOTER[verdict];
  return (
    `${VERDICT_HEADING[verdict]} · ${where}, ${waitedLabel(check.createdAt)} after the remediation\n` +
    `${detail}.${footer ? `\n${footer}` : ""}`
  );
}

function waitedLabel(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "shortly";
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${minutes}m`;
}

// Durable schedule + claim. No-op (and never throws) when Postgres isn't configured — the
// agent runs without incident memory, and verification is part of that memory.
export class RemediationCheckStore {
  constructor(private readonly pool: Pool | null) {}

  get enabled(): boolean {
    return this.pool !== null;
  }

  // alertname/namespace come from the incident row rather than the caller: the remediation
  // already knows which incident it belongs to, and a mention-driven one has none — which is
  // exactly the "none" alert state, recorded as NULL.
  async schedule(
    remediationId: number,
    channel: string,
    threadTs: string,
    target: { namespace: string; name: string },
    before: PodHealth | null,
    delaySeconds: number
  ): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO remediation_checks
           (remediation_id, incident_id, channel, thread_ts, alertname, namespace, target, before_state, due_at)
         SELECT r.id, r.incident_id, $2, $3, i.alertname, i.namespace, $4::jsonb, $5::jsonb,
                now() + ($6::int * interval '1 second')
           FROM remediations r LEFT JOIN incidents i ON i.id = r.incident_id
          WHERE r.id = $1
         ON CONFLICT (remediation_id) DO NOTHING
         RETURNING id`,
        [remediationId, channel, threadTs, JSON.stringify(target), before ? JSON.stringify(before) : null, delaySeconds]
      );
      return rows.length > 0;
    } catch (err) {
      logger.error(`[remediation] scheduling verification for ${remediationId} failed: ${errText(err)}`);
      return false;
    }
  }

  // Claim what's due, for this pod only. FOR UPDATE SKIP LOCKED makes concurrent pollers
  // take disjoint rows; pushing due_at forward is the lease, so a pod that dies mid-check
  // hands the row back after LEASE_SECONDS instead of stranding it in 'running'.
  async claimDue(limit = CLAIM_BATCH): Promise<RemediationCheck[]> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `UPDATE remediation_checks c
            SET status = 'running',
                attempts = c.attempts + 1,
                due_at = now() + ($2::int * interval '1 second')
          WHERE c.id IN (
            SELECT id FROM remediation_checks
             WHERE status IN ('pending', 'running') AND due_at <= now()
             ORDER BY due_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
        RETURNING c.id, c.remediation_id, c.channel, c.thread_ts, c.alertname, c.namespace,
                  c.target, c.before_state, c.attempts, c.created_at`,
        [limit, LEASE_SECONDS]
      );
      return rows.map((r: Record<string, any>) => ({
        id: Number(r.id),
        remediationId: Number(r.remediation_id),
        channel: r.channel,
        threadTs: r.thread_ts,
        alertname: r.alertname,
        namespace: r.namespace,
        target: r.target,
        before: r.before_state ?? null,
        attempts: Number(r.attempts),
        createdAt: r.created_at,
      }));
    } catch (err) {
      logger.error(`[remediation] claiming due verifications failed: ${errText(err)}`);
      return [];
    }
  }

  async complete(id: number, verdict: Verdict, detail: string): Promise<void> {
    await this.finish(id, "done", verdict, detail);
  }

  // Out of attempts. Still gets a verdict row so recall sees "we tried and couldn't tell"
  // rather than nothing at all.
  async abandon(id: number, detail: string): Promise<void> {
    await this.finish(id, "abandoned", "inconclusive", detail);
  }

  private async finish(id: number, status: string, verdict: Verdict, detail: string): Promise<void> {
    if (!this.pool) return;
    await this.pool
      .query(
        `UPDATE remediation_checks SET status = $2, verdict = $3, detail = $4, checked_at = now() WHERE id = $1`,
        [id, status, verdict, detail.slice(0, 2000)]
      )
      .catch((err) => logger.error(`[remediation] recording verdict for check ${id} failed: ${errText(err)}`));
  }
}

export const maxAttemptsReached = (check: RemediationCheck): boolean => check.attempts > MAX_ATTEMPTS;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
