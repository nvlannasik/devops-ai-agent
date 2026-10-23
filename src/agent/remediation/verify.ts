import type { Pool } from "pg";
import logger from "../../utils/logger/index.js";
import { canonicalImage } from "./noop-guard.js";
import { parseQuantity } from "../../utils/quantity/index.js";

// Post-remediation verification (schema: migrations/006). The question here is "did the
// problem go away", not "what do the pods look like now" — the alert that paged is the
// primary signal, pod health is the corroborating detail, and the answer is a verdict with
// the evidence it was read from. Everything above the store is pure so the decision table
// can be tested without a cluster.

export type Verdict = "recovered" | "unchanged" | "worse" | "inconclusive";

// "none" = this remediation has no alert behind it (mention-driven, no incident labels);
// "unknown" = Alertmanager was asked and could not be read. Collapsing the two would let a
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
  target: { namespace: string; name: string; kind?: string };
  before: PodHealth | null;
  attempts: number;
  createdAt: string; // when the remediation ran — the verdict quotes the REAL wait, not the configured one
  /** `awaiting` = a GitOps PR whose change is not running yet (migrations/016); else pending/running. */
  status?: string;
  expect?: ApplyExpectation | null;
  applyBy?: string | null;
};

/**
 * What a GitOps PR set, as the values the live workload must show once Flux has applied it
 * (migrations/016). One vocabulary for every action — the change timeline's field names
 * (devops-mcp-server `diffPodTemplates`): `replicas`, `<container>.image`, `<container>.env.KEY`,
 * `<container>.resources.<requests|limits>.<cpu|memory>`, `<container>.command|args`,
 * `<container>.readinessProbe|livenessProbe`, `container <name>`. `*` for the container means any
 * container; `(none)` means absent, as the timeline writes it.
 */
export type ApplyExpectation = { fields: Array<{ field: string; value: string | number }> };

const ABSENT = "(none)";
const RESOURCE_CHANGE = /^(requests|limits)\.(cpu|memory)$/;

/**
 * The fields an open_pr writes (set_image, scale, set_resources), as their new values. Null when
 * the PR touches nothing of the kind, so no check waits for a value it could never read.
 */
export function expectFromChanges(changes: Array<{ field: string; to: string | number }>, container?: string): ApplyExpectation | null {
  const c = container || "*";
  const fields: ApplyExpectation["fields"] = [];
  for (const ch of changes) {
    if (ch.field === "image" && typeof ch.to === "string" && ch.to) fields.push({ field: `${c}.image`, value: ch.to });
    else if (ch.field === "replicas" && Number.isFinite(Number(ch.to))) fields.push({ field: "replicas", value: Number(ch.to) });
    else if (RESOURCE_CHANGE.test(ch.field)) fields.push({ field: `${c}.resources.${ch.field}`, value: String(ch.to) });
  }
  return fields.length > 0 ? { fields } : null;
}

/** A revert PR restores the broken rollout's pod template: every field it changed, back at `from`. */
export function expectFromRevert(diff: Array<{ field: string; from: string }> | undefined): ApplyExpectation | null {
  const fields = (diff ?? []).filter((d) => d.field).map((d) => ({ field: d.field, value: d.from }));
  return fields.length > 0 ? { fields } : null;
}

type LiveContainer = {
  name?: unknown; image?: unknown; command?: unknown; args?: unknown;
  env?: Array<{ name?: unknown; value?: unknown; valueFrom?: Record<string, any> }>;
  resources?: Record<string, Record<string, unknown> | undefined>;
  readinessProbe?: unknown; livenessProbe?: unknown;
};

// The same rendering as the timeline's envValue — a secret's value is never read, only its source.
function envValue(e: NonNullable<LiveContainer["env"]>[number]): string {
  if (e.value !== undefined) return String(e.value);
  const f = e.valueFrom;
  if (f?.secretKeyRef) return `secret:${f.secretKeyRef.name}/${f.secretKeyRef.key}`;
  if (f?.configMapKeyRef) return `configmap:${f.configMapKeyRef.name}/${f.configMapKeyRef.key}`;
  if (f?.fieldRef) return `field:${f.fieldRef.fieldPath}`;
  return "(from source)";
}

/** One field of a live container, rendered as the timeline renders it; `(none)` when absent. */
function containerField(c: LiveContainer | undefined, rest: string): unknown {
  if (!c) return ABSENT;
  if (rest === "image") return c.image ?? ABSENT;
  if (rest === "command" || rest === "args" || rest === "readinessProbe" || rest === "livenessProbe") return c[rest] ?? ABSENT;
  if (rest.startsWith("env.")) {
    const e = (c.env ?? []).find((x) => x.name === rest.slice(4));
    return e ? envValue(e) : ABSENT;
  }
  const r = /^resources\.(requests|limits)\.(.+)$/.exec(rest);
  if (r) return c.resources?.[r[1]!]?.[r[2]!] ?? ABSENT;
  return undefined; // a field this side cannot read
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;

/** Equal as the runtime would read them: canonical images, quantities by value, JSON regardless of key order. */
function sameValue(field: string, live: unknown, want: string | number): boolean {
  if (typeof live === "object" && live !== null) {
    try {
      return JSON.stringify(sortKeys(live)) === JSON.stringify(sortKeys(JSON.parse(String(want))));
    } catch {
      return false;
    }
  }
  const a = String(live);
  const b = String(want);
  if (a === b) return true;
  if (field.endsWith(".image") && a !== ABSENT && b !== ABSENT) return canonicalImage(a) === canonicalImage(b);
  if (/\.resources\./.test(field)) {
    const qa = parseQuantity(a);
    const qb = parseQuantity(b);
    return qa !== null && qb !== null && Math.abs(qa - qb) < 1e-9 * Math.max(1, Math.abs(qb));
  }
  return false;
}

/**
 * Whether a workload's live object shows every value the PR set — the merge AND the Flux sync,
 * which is what "applied" has to mean before a verdict can be about the change. `unknown` when the
 * object cannot be read, or a field is one this side cannot read: a wait, never a verdict.
 */
export function applyState(expect: ApplyExpectation, raw: string): "applied" | "not-yet" | "unknown" {
  let obj: { spec?: { replicas?: unknown; template?: { spec?: { containers?: LiveContainer[] } } } };
  try {
    obj = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  const spec = obj?.spec;
  const fields = expect?.fields;
  if (!spec || typeof spec !== "object" || !Array.isArray(fields) || fields.length === 0) return "unknown";
  const containers = Array.isArray(spec.template?.spec?.containers) ? spec.template!.spec!.containers! : null;
  for (const { field, value } of fields) {
    if (field === "replicas") {
      if (spec.replicas !== Number(value)) return "not-yet";
      continue;
    }
    if (!containers) return "unknown";
    const presence = /^container (.+)$/.exec(field);
    if (presence) {
      if ((containers.some((c) => c.name === presence[1]) ? "present" : ABSENT) !== value) return "not-yet";
      continue;
    }
    const dot = field.indexOf(".");
    if (dot < 0) return "unknown";
    const name = field.slice(0, dot);
    const rest = field.slice(dot + 1);
    const candidates = name === "*" ? containers : [containers.find((c) => c.name === name)];
    const reads = candidates.map((c) => containerField(c, rest));
    if (reads.some((r) => r === undefined)) return "unknown";
    if (!reads.some((r) => sameValue(field, r, value))) return "not-yet";
  }
  return "applied";
}

const LEASE_SECONDS = 180; // how long a claimed check is invisible to other pods
const MAX_ATTEMPTS = 3; // after this many claims a check is abandoned as inconclusive
const CLAIM_BATCH = 5;
/** How often an `awaiting` GitOps check looks at the live object, and how long it waits for the merge. */
export const AWAIT_POLL_SECONDS = 60;
export const AWAIT_APPLY_SECONDS = 24 * 60 * 60;

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

type HeldAlert = { name?: unknown; status?: unknown; labels?: Record<string, unknown> };

// alertmanager_get_alerts returns { summary, groups: [{ groupLabels, alerts: [...] }] }.
const alertsIn = (g: unknown): HeldAlert[] => {
  const list = (g as { alerts?: unknown } | null)?.alerts;
  return Array.isArray(list) ? (list.filter((a) => !!a && typeof a === "object") as HeldAlert[]) : [];
};

/**
 * Is the alert that paged us still active? Asked of Alertmanager, not Prometheus: Alertmanager
 * is the fan-in point for every evaluator, so a log-based alert (Loki Ruler, Kibana) is visible
 * here and invisible to `/api/v1/alerts`. Asking the partial source would score a still-paging
 * incident as recovered.
 *
 * Every status Alertmanager hands back means STILL FIRING — `silenced` most of all, because a
 * human muted the notification, not the problem, and `inhibited` means a bigger alert is
 * covering this one. Alertmanager drops resolved alerts from its response, so presence is the
 * signal and absence is the recovery.
 *
 * The trade against the old Prometheus read: an alert re-firing inside its `for:` window is
 * still `pending` in the evaluator and has not reached Alertmanager, so it reads as cleared
 * here. That is deliberate — Alertmanager is the source of truth — and `decideVerdict` still
 * refuses to call it recovered while any pod is unready.
 */
export function alertState(raw: string, alertname: string | null, namespace: string | null): AlertState {
  if (!alertname) return "none";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  const groups = (parsed as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return "unknown";

  const held = groups.some((g) =>
    alertsIn(g).some((rec) => {
      if (rec.name !== alertname) return false;
      // Only reject on a namespace we can actually compare — an alert without the label
      // (node-level rules) still counts for the namespace it was investigated under.
      const ns = rec.labels?.namespace;
      if (namespace && typeof ns === "string" && ns !== namespace) return false;
      return true;
    })
  );
  return held ? "firing" : "cleared";
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
  if (alert === "unknown") parts.push(`could not read alert state from Alertmanager`);
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

  // A GitOps PR's check (migrations/016): `awaiting` until the workload runs what the PR set, polled
  // every `pollSeconds`, and given up at `apply_by`. No baseline yet — the "before" of a change that
  // has not landed is taken when it lands (markApplied), or "worse" would compare against a pod that
  // predates the fault the PR is for.
  async scheduleAwaiting(
    remediationId: number,
    channel: string,
    threadTs: string,
    target: { namespace: string; name: string; kind: string },
    expect: ApplyExpectation,
    pollSeconds: number,
    waitSeconds: number
  ): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO remediation_checks
           (remediation_id, incident_id, channel, thread_ts, alertname, namespace, target, status, expect, due_at, apply_by)
         SELECT r.id, r.incident_id, $2, $3, i.alertname, i.namespace, $4::jsonb, 'awaiting', $5::jsonb,
                now() + ($6::int * interval '1 second'), now() + ($7::int * interval '1 second')
           FROM remediations r LEFT JOIN incidents i ON i.id = r.incident_id
          WHERE r.id = $1
         ON CONFLICT (remediation_id) DO NOTHING
         RETURNING id`,
        [remediationId, channel, threadTs, JSON.stringify(target), JSON.stringify(expect), pollSeconds, waitSeconds]
      );
      return rows.length > 0;
    } catch (err) {
      logger.error(`[remediation] scheduling the GitOps apply-watch for ${remediationId} failed: ${errText(err)}`);
      return false;
    }
  }

  /** The PR's change is running: take the baseline now and start the ordinary verification. */
  async markApplied(id: number, before: PodHealth | null, delaySeconds: number): Promise<void> {
    await this.update(
      `UPDATE remediation_checks SET status = 'pending', attempts = 0, before_state = $2::jsonb,
              due_at = now() + ($3::int * interval '1 second')
        WHERE id = $1 AND status = 'awaiting'`,
      [id, before ? JSON.stringify(before) : null, delaySeconds]
    );
  }

  /** Not applied yet: look again after `seconds`. */
  async waitMore(id: number, seconds = AWAIT_POLL_SECONDS): Promise<void> {
    await this.update(
      `UPDATE remediation_checks SET due_at = now() + ($2::int * interval '1 second') WHERE id = $1 AND status = 'awaiting'`,
      [id, seconds]
    );
  }

  /** Never applied: closed with NO verdict — recall must not read an unmerged PR as a fix that failed. */
  async expire(id: number, detail: string): Promise<void> {
    await this.update(`UPDATE remediation_checks SET status = 'expired', detail = $2, checked_at = now() WHERE id = $1`, [id, detail.slice(0, 2000)]);
  }

  private async update(sql: string, params: unknown[]): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(sql, params).catch((err) => logger.error(`[remediation] updating a check failed: ${errText(err)}`));
  }

  // Claim what's due, for this pod only. FOR UPDATE SKIP LOCKED makes concurrent pollers
  // take disjoint rows; pushing due_at forward is the lease, so a pod that dies mid-check
  // hands the row back after LEASE_SECONDS instead of stranding it in 'running'.
  async claimDue(limit = CLAIM_BATCH): Promise<RemediationCheck[]> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `UPDATE remediation_checks c
            SET status = CASE WHEN c.status = 'awaiting' THEN 'awaiting' ELSE 'running' END,
                attempts = CASE WHEN c.status = 'awaiting' THEN c.attempts ELSE c.attempts + 1 END,
                due_at = now() + ($2::int * interval '1 second')
          WHERE c.id IN (
            SELECT id FROM remediation_checks
             WHERE status IN ('pending', 'running', 'awaiting') AND due_at <= now()
             ORDER BY due_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
        RETURNING c.id, c.remediation_id, c.channel, c.thread_ts, c.alertname, c.namespace,
                  c.target, c.before_state, c.attempts, c.created_at, c.status, c.expect, c.apply_by`,
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
        status: r.status,
        expect: r.expect ?? null,
        applyBy: r.apply_by ? new Date(r.apply_by).toISOString() : null,
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
