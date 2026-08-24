// Incident status reconciliation, and the on-call status command.
//
// The problem both halves solve: `resolved_at` used to have exactly one writer, the
// Alertmanager resolved webhook. That POST is never repeated — `repeat_interval` covers
// firing notifications only, and a group whose alerts all resolved is dropped once its
// resolved notification goes out — and `/alert` acks 200 BEFORE processing, so anything that
// fails after the ack (Slack down, Postgres down, pod killed mid-handler) loses the resolved
// event for good. The incident then reads as firing forever, and its dedup claim is never
// released, which silently suppresses the NEXT real firing of the same alert for the claim's
// full TTL. That second effect is the dangerous one.
//
// Everything here is pure so the decision table can be tested without Postgres, Alertmanager,
// or Slack — same split as remediation/verify.ts, whose `alertState` this reuses rather than
// re-deriving "is it still firing" a second way.

import type { AlertState } from "../remediation/verify.js";

export type UnresolvedIncident = {
  id: number;
  alertname: string;
  namespace: string | null;
  channel: string | null;
  threadTs: string | null;
  // the exact label set the alert was dedup-claimed under; null on rows stored before
  // migration 007, where alertname+namespace is the best key available
  groupLabels: Record<string, string> | null;
  clearedSeenAt: string | null;
};

/**
 * `alertmanager_get_alerts` caps its per-group detail (MAX_DETAIL_ALERTS on the MCP server)
 * and reports how many alerts it left out. Absence from `groups` is what this whole sweeper
 * reads as recovery, so a truncated response is not evidence of anything: during a storm the
 * alert that paged us could be missing purely because it did not fit.
 *
 * A tick that cannot trust the read does nothing at all and tries again on the next one —
 * closing incidents automatically is exactly the wrong thing to do while a storm is on.
 */
export function alertsReadable(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const p = parsed as { groups?: unknown; omitted?: unknown } | null;
  if (!Array.isArray(p?.groups)) return false;
  // ponytail: whole tick skipped on any truncation. If storms make that too coarse, re-ask
  // per incident with filter: ['alertname="X"'] — the response is then small enough to be complete.
  return !(typeof p?.omitted === "number" && p.omitted > 0);
}

export type ReconcileAction =
  | "resolve" // cleared, and confirmed cleared long enough — close it
  | "confirming" // first pass that saw it cleared; remember when, decide next pass
  | "reset" // firing again — forget any earlier cleared sighting
  | "skip"; // no usable evidence

/**
 * Two passes, not one. An alert re-firing inside its rule's `for:` window is still `pending`
 * in the evaluator and has not reached Alertmanager, so a single cleared reading is also what
 * a flapping alert looks like mid-flap. Requiring the same answer twice, `confirmMs` apart,
 * costs a delay and buys not closing an incident that is actively coming back.
 *
 * `unknown` (Alertmanager unreadable) and `none` (no alertname to ask about) are deliberately
 * inert: no evidence is not evidence of recovery. Only "we asked, and it is not there" counts.
 */
export function decideReconcile(
  state: AlertState,
  clearedSeenAt: string | null,
  confirmMs: number,
  now: number = Date.now()
): ReconcileAction {
  if (state === "firing") return clearedSeenAt ? "reset" : "skip";
  if (state !== "cleared") return "skip";
  if (!clearedSeenAt) return "confirming";
  const first = new Date(clearedSeenAt).getTime();
  if (!Number.isFinite(first)) return "confirming"; // unparseable timestamp restarts the clock
  return now - first >= confirmMs ? "resolve" : "confirming";
}

export type StatusCommand = "resolved" | "reopen";

// Checked before "resolved" so a negation wins: "belum selesai" and "unresolved" must never
// read as a close.
const REOPEN = /^(re-?opene?d?|firing|unresolved|not\s+resolved|still\s+firing|belum|masih|kambuh)\b/i;

// Narrow on purpose, in two ways. "ok", "done", "thanks" are how people talk in a thread, not
// how they change an incident's state. And the imperatives are out — "close"/"resolve" open
// far more requests ("close the PR", "resolve this by scaling up") than status reports, while
// "resolved"/"fixed" are statements about state and read the same way every time.
const RESOLVED = /^(sudah|udah)?\s*(resolved|fixed|selesai|beres|aman)\b/i;

/**
 * On-call's word on an incident's status, as a deterministic prefix command — same shape as
 * `@agent learn`, and deliberately NOT an LLM call: an operator correcting the agent's state
 * is the one message that must not be re-interpreted, and it costs nothing to be sure.
 *
 * Indonesian and English both, because that is how the thread actually reads.
 */
export function parseStatusCommand(text: string): StatusCommand | null {
  const t = text.trim();
  if (REOPEN.test(t)) return "reopen";
  if (RESOLVED.test(t)) return "resolved";
  return null;
}
