// Postmortem facts: the data a draft is built from, never invented by the model. Spec
// 2026-10-14-postmortem-draft-design. `renderFacts` is the one source of the Timeline and
// Numbers sections — the model never writes either (see draft.ts).
import type { ChangeTimeline } from "../changes/index.js";
import { formatDuration } from "../../utils/slack/blocks.js";

export interface PostmortemFacts {
  incident: {
    id: number;
    alertname: string;
    namespace: string | null;
    severity: string | null;
    assessedSeverity: string | null;
    alertStartedAt: string | null;
    createdAt: string;
    resolvedAt: string | null;
    resolvedBy: string | null;
    rootCause: string | null;
    rca: string;
  };
  changes: ChangeTimeline | null;
  remediations: Array<{ action: string; summary: string; status: string; approvedBy: string | null; createdAt: string; executedAt: string | null; verdict: string | null; result: string | null }>;
  related: Array<{ id: number; alertname: string; subjects: string[]; createdAt: string; resolvedAt: string | null }>;
  confirmed: Array<{ by: string | null; rootCause: string | null; action: string | null; outcome: string | null; at: string }>;
  humans: string[];
  investigation: { startedAt: string | null; endedAt: string | null } | null;
  unavailable: string[];
}

export interface TimelineEvent { at: string; event: string }

const alertAt = (f: PostmortemFacts): string => f.incident.alertStartedAt ?? f.incident.createdAt;

export function timelineOf(f: PostmortemFacts): TimelineEvent[] {
  const events: TimelineEvent[] = [{ at: alertAt(f), event: "alert fired" }];

  for (const c of f.changes?.changes ?? []) {
    const d = c.diff?.[0];
    const base = `${c.workload} ${c.kind}${c.revision ? ` rev ${c.revision}` : ""}`;
    events.push({ at: c.at, event: d ? `${base}: ${d.field} ${d.from} → ${d.to}` : base });
  }
  for (const c of f.changes?.commits ?? []) {
    events.push({ at: c.at, event: `commit ${c.sha.slice(0, 7)} "${c.message}" by ${c.author}` });
  }
  if (f.investigation?.startedAt) events.push({ at: f.investigation.startedAt, event: "investigation started" });
  if (f.investigation?.endedAt) events.push({ at: f.investigation.endedAt, event: "RCA posted" });
  for (const r of f.related) {
    events.push({ at: r.createdAt, event: `related alert ${r.alertname} on ${r.subjects.join(", ")} joined` });
  }
  for (const r of f.remediations) {
    events.push({ at: r.createdAt, event: `proposed: ${r.summary}` });
    if (r.executedAt) {
      const prSuffix = r.result?.startsWith("https://") ? ` · PR ${r.result}` : "";
      events.push({ at: r.executedAt, event: `executed (approved by ${r.approvedBy ?? "?"}) · ${r.status} · verdict ${r.verdict ?? "pending"}${prSuffix}` });
    }
  }
  if (f.incident.resolvedAt) events.push({ at: f.incident.resolvedAt, event: `resolved by ${f.incident.resolvedBy ?? "?"}` });

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function numbersOf(f: PostmortemFacts): { timeToRcaMs: number | null; timeToMitigationMs: number | null; durationMs: number | null; relatedAlerts: number; remediations: number } {
  const startMs = Date.parse(alertAt(f));
  const endedAt = f.investigation?.endedAt;
  const timeToRcaMs = endedAt ? Date.parse(endedAt) - startMs : null;

  const recoveredAt = f.remediations
    .filter((r) => r.verdict === "recovered" && r.executedAt)
    .map((r) => Date.parse(r.executedAt as string));
  const timeToMitigationMs = recoveredAt.length > 0 ? Math.min(...recoveredAt) - startMs : null;

  const durationMs = f.incident.resolvedAt ? Date.parse(f.incident.resolvedAt) - startMs : null;

  return { timeToRcaMs, timeToMitigationMs, durationMs, relatedAlerts: f.related.length, remediations: f.remediations.length };
}

const fmtTime = (iso: string): string => iso.slice(0, 16).replace("T", " ");
const escCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const fmtMs = (ms: number | null): string => (ms == null ? "—" : formatDuration(ms));

export function renderFacts(f: PostmortemFacts): string {
  const rows = timelineOf(f).map((e) => `| ${fmtTime(e.at)} | ${escCell(e.event)} |`).join("\n");
  const n = numbersOf(f);
  const numbers = [
    `- Time to RCA: ${fmtMs(n.timeToRcaMs)}`,
    `- Time to mitigation: ${fmtMs(n.timeToMitigationMs)}`,
    `- Duration: ${fmtMs(n.durationMs)}`,
    `- Related alerts: ${n.relatedAlerts}`,
    `- Remediations: ${n.remediations}`,
  ].join("\n");
  return `## Timeline\n\n| Time (UTC) | Event |\n|---|---|\n${rows}\n\n## Numbers\n\n${numbers}`;
}
