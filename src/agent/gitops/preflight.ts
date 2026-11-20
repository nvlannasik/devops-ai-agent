// Pre-merge checks on a GitOps PR (2026-11-20, ideation D3).
//
// A PR the agent opens is merged by a person, sometimes hours after the card was approved, and the
// PR said nothing about the state it was opened into. Three facts a reviewer would otherwise have to
// go and look up are read at the moment the PR is opened and written into its body:
//
//   - the workload now: pods ready / total and restarts (k8s_list_pods, the verification's parser);
//   - what is firing on it: Alertmanager, unfiltered, matched on namespace + the workload's name;
//   - recent Git changes to the HelmRelease (the worker's `history` op, last 24 h): someone else
//     changing the same file is the conflict a merge would walk into.
//
// INFORMATIVE ONLY — nothing here blocks the PR. The card was approved by a human against the
// evidence of the incident; a check that could refuse it now would be a second approval gate
// with no human in it. Each read has its own timeout and a failure is `unknown`, never `ok`: an
// unread source must not read as a clean one.

import type { HistoryPayload } from "../changes/index.js";
import { summarizePods } from "../remediation/verify.js";

export type CheckStatus = "ok" | "warn" | "info" | "unknown";
export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightDeps {
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  history?: (hr: { name: string; namespace: string }, since: string) => Promise<HistoryPayload>;
  timeoutMs?: number;
  now?: () => number;
}

const TIMEOUT_MS = 10_000;
const HISTORY_HOURS = 24;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`no answer in ${ms / 1000}s`)), ms)))]).finally(() => clearTimeout(t));
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export function podsCheck(raw: string, name: string): PreflightCheck {
  const h = summarizePods(raw, `${name}-`);
  if (!h) return { name: "Workload now", status: "unknown", detail: "the pod listing could not be read" };
  if (h.total === 0) return { name: "Workload now", status: "warn", detail: `no pods named \`${name}-*\` are running` };
  const detail = `${h.ready}/${h.total} pods ready, ${h.restarts} restart${h.restarts === 1 ? "" : "s"}`;
  // Not ready is expected on a fix — it is what the PR is for — so it is stated, not alarmed.
  return { name: "Workload now", status: h.notReady === 0 ? "ok" : "info", detail };
}

type Held = { name?: unknown; status?: unknown; labels?: Record<string, unknown> };

export function alertsCheck(raw: string, namespace: string, name: string): PreflightCheck {
  let groups: unknown;
  try {
    groups = (JSON.parse(raw) as { groups?: unknown } | null)?.groups;
  } catch {
    groups = undefined;
  }
  if (!Array.isArray(groups)) return { name: "Firing alerts", status: "unknown", detail: "Alertmanager's answer could not be read" };
  const names = new Set<string>();
  for (const g of groups) {
    for (const a of ((g as { alerts?: unknown })?.alerts ?? []) as Held[]) {
      if (!a || typeof a !== "object" || typeof a.name !== "string") continue;
      const labels = a.labels ?? {};
      if (labels.namespace !== namespace) continue;
      // The workload's name in any label value: deployment, pod (name-<hash>), service, app.
      const onIt = Object.values(labels).some((v) => typeof v === "string" && (v === name || v.startsWith(`${name}-`)));
      if (onIt) names.add(String(a.status && a.status !== "active" ? `${a.name} (${a.status})` : a.name));
    }
  }
  return names.size === 0
    ? { name: "Firing alerts", status: "ok", detail: `none on \`${namespace}/${name}\`` }
    : { name: "Firing alerts", status: "info", detail: [...names].sort().join(", ") };
}

export function historyCheck(p: HistoryPayload): PreflightCheck {
  if (!p.ok) return { name: `Git changes (${HISTORY_HOURS} h)`, status: "unknown", detail: `history not read: ${p.reason.slice(0, 120)}` };
  if (p.commits.length === 0) return { name: `Git changes (${HISTORY_HOURS} h)`, status: "ok", detail: "nobody else changed this HelmRelease" };
  const list = p.commits
    .slice(0, 3)
    .map((c) => `${c.sha.slice(0, 7)} by ${c.author}: ${c.message.split("\n")[0]!.slice(0, 60)}`)
    .join("; ");
  const more = p.commits.length > 3 ? ` (+${p.commits.length - 3} more)` : "";
  return { name: `Git changes (${HISTORY_HOURS} h)`, status: "warn", detail: `${p.commits.length} commit${p.commits.length === 1 ? "" : "s"} — check it does not conflict: ${list}${more}` };
}

/** All three, in parallel, each bounded; never throws. */
export async function preflightChecks(
  deps: PreflightDeps,
  workload: { namespace: string; name: string } | null,
  helmRelease: { name: string; namespace: string }
): Promise<PreflightCheck[]> {
  const ms = deps.timeoutMs ?? TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const jobs: Promise<PreflightCheck>[] = [];
  if (workload) {
    jobs.push(
      within(ms, deps.callTool("k8s_list_pods", { namespace: workload.namespace }))
        .then((raw) => podsCheck(raw, workload.name))
        .catch((e) => ({ name: "Workload now", status: "unknown" as const, detail: `not read: ${why(e)}` }))
    );
    jobs.push(
      within(ms, deps.callTool("alertmanager_get_alerts", {}))
        .then((raw) => alertsCheck(raw, workload.namespace, workload.name))
        .catch((e) => ({ name: "Firing alerts", status: "unknown" as const, detail: `not read: ${why(e)}` }))
    );
  }
  if (deps.history) {
    const since = new Date(now() - HISTORY_HOURS * 3_600_000).toISOString();
    jobs.push(
      within(ms, deps.history(helmRelease, since))
        .then(historyCheck)
        .catch((e) => ({ name: `Git changes (${HISTORY_HOURS} h)`, status: "unknown" as const, detail: `not read: ${why(e)}` }))
    );
  }
  return Promise.all(jobs);
}

/** One Slack line under "PR opened": only what needs a look, so a clean PR adds nothing. */
export function preflightNote(checks: PreflightCheck[]): string {
  const warn = checks.filter((c) => c.status === "warn");
  const unknown = checks.filter((c) => c.status === "unknown");
  const parts = [
    ...warn.map((c) => `⚠️ ${c.name}: ${c.detail}`),
    ...(unknown.length ? [`❔ not checked: ${unknown.map((c) => c.name).join(", ")}`] : []),
  ];
  return parts.length ? `\n${parts.join("\n")}` : "";
}
