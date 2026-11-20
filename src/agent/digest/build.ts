import { diskTrend, movers, type StoredPoint } from "../vm/history.js";

// The daily health digest (C1 + C2, 2026-11-20): what on-call should look at before anything pages.
// Built by code from data — host history (vm_host_history), incident memory and Alertmanager — with
// no LLM in it: every number is computed, and a source that could not be read is said to be unread,
// never shown as fine (the `AlertState unknown ≠ none` rule).

const MI = 1048576;
const mi = (b: number): string => `${Math.round(b / MI)}Mi`;
const DAY_MS = 86_400_000;

/** Below this share of total memory, available-now is low enough to name. */
const LOW_AVAILABLE_RATIO = 0.1;
/** A root disk this full, or this close to full at the window's rate, needs a look. */
const DISK_FULL_PERCENT = 85;
const DISK_DAYS_WARN = 14;
/** The daily lowest available falling by this much across the week = headroom shrinking. */
const SHRINK_BYTES = 50 * MI;

export interface HostDigest {
  name: string;
  /** Hours of history behind the numbers (0 = none yet). */
  coverHours: number;
  total?: number;
  availableNow?: number;
  lowest24h?: { at: Date; available: number };
  /** The lowest available in each 24 h back from now, oldest first (up to 7). */
  dailyLowest: number[];
  /** The largest memory mover over 24 h (a systemd service or a process), if one moved ≥10Mi. */
  topMover?: { name: string; where?: string; change: string; end: string };
  disk?: { usedPercentNow: number; daysToFull?: number; changePerDay?: string };
  attention: string[];
}

/** One host's digest from its last 7 days of points (oldest first). */
export function hostDigest(name: string, points: StoredPoint[], now: Date): HostDigest {
  const out: HostDigest = { name, coverHours: 0, dailyLowest: [], attention: [] };
  if (points.length === 0) return out;
  const last = points[points.length - 1]!;
  out.coverHours = Math.round(((last.at.getTime() - points[0]!.at.getTime()) / 3600_000) * 10) / 10;
  out.total = last.point.memTotal;
  out.availableNow = last.point.memAvailable;

  const day = points.filter((p) => p.at.getTime() > now.getTime() - DAY_MS);
  for (const p of day) {
    const a = p.point.memAvailable;
    if (a !== undefined && (!out.lowest24h || a < out.lowest24h.available)) out.lowest24h = { at: p.at, available: a };
  }
  // Daily lowest, by 24 h buckets counted back from now — a calendar day would cut the newest short.
  const buckets = new Map<number, number>();
  for (const p of points) {
    const a = p.point.memAvailable;
    if (a === undefined) continue;
    const k = Math.floor((now.getTime() - p.at.getTime()) / DAY_MS);
    if (k < 0 || k > 6) continue;
    buckets.set(k, Math.min(buckets.get(k) ?? Infinity, a));
  }
  out.dailyLowest = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);

  const top = [...movers(day, (p) => p.units, false, 1), ...movers(day, (p) => p.procs, true, 1)].sort(
    (a, b) => Math.abs(parseInt(b.change)) - Math.abs(parseInt(a.change))
  )[0];
  if (top) out.topMover = { name: top.name, ...(top.where ? { where: top.where } : {}), change: top.change, end: top.end };

  const d = diskTrend(points);
  if (d) {
    out.disk = {
      usedPercentNow: Number(d.usedPercentNow),
      ...(typeof d.daysToFull === "number" ? { daysToFull: d.daysToFull } : {}),
      ...(typeof d.changePerDay === "string" ? { changePerDay: d.changePerDay } : {}),
    };
  }

  if (out.total && out.availableNow !== undefined && out.availableNow < out.total * LOW_AVAILABLE_RATIO) {
    out.attention.push(`only ${mi(out.availableNow)} available now (${Math.round((out.availableNow / out.total) * 100)}% of ${mi(out.total)})`);
  }
  if (out.dailyLowest.length >= 3) {
    const first = out.dailyLowest[0]!;
    const lastLow = out.dailyLowest[out.dailyLowest.length - 1]!;
    if (first - lastLow >= SHRINK_BYTES) out.attention.push(`headroom shrinking — daily lowest available ${out.dailyLowest.map(mi).join(" → ")}`);
  }
  if (out.disk && out.disk.usedPercentNow >= DISK_FULL_PERCENT) out.attention.push(`root disk ${out.disk.usedPercentNow}% used`);
  if (out.disk?.daysToFull !== undefined && out.disk.daysToFull <= DISK_DAYS_WARN) {
    out.attention.push(`root disk full in ~${out.disk.daysToFull} days at ${out.disk.changePerDay}/day`);
  }
  if (now.getTime() - last.at.getTime() > 15 * 60_000) out.attention.push(`no report for ${Math.round((now.getTime() - last.at.getTime()) / 60_000)} min`);
  return out;
}

export interface IncidentCount {
  alertname: string;
  namespace: string | null;
  cluster: string | null;
  count: number;
  open: number;
}

export interface DigestData {
  /** The local day the digest is for, YYYY-MM-DD. */
  day: string;
  now: Date;
  hosts: HostDigest[] | null;
  /** Investigations started in the last 24 h, by alert group. */
  incidents24h: IncidentCount[] | null;
  /** Alert groups investigated 3+ times in 7 days — the noisy ones (C3's first cut). */
  repeat7d: IncidentCount[] | null;
  /** Incidents still open, any age. */
  openTotal: number | null;
  /** Alertmanager, now: alert name -> count and the highest severity seen. */
  firing: Array<{ name: string; count: number; severity: string | null }> | null;
  /** What could not be read, with why. */
  unread: string[];
}

const where = (c: IncidentCount): string => [c.cluster, c.namespace].filter(Boolean).join("/") || "cluster-wide";

/** The digest as Slack mrkdwn — single-asterisk bold, `•` bullets, no `#` headings (the RCA's dialect). */
export function renderDigest(d: DigestData): string {
  const lines: string[] = [`*🩺 Daily health — ${d.day}*`];
  const attention = (d.hosts ?? []).filter((h) => h.attention.length);
  const summary: string[] = [];
  if (d.hosts) summary.push(attention.length ? `${attention.length} of ${d.hosts.length} hosts need a look` : `${d.hosts.length} hosts, none need a look`);
  if (d.firing) summary.push(d.firing.length ? `${d.firing.reduce((a, f) => a + f.count, 0)} alerts firing` : "nothing firing");
  if (d.incidents24h) summary.push(`${d.incidents24h.reduce((a, c) => a + c.count, 0)} investigations in 24 h`);
  if (d.openTotal !== null) summary.push(`${d.openTotal} incidents open`);
  if (summary.length) lines.push(summary.join(" · "));

  if (d.hosts) {
    lines.push("", "*🖥️ Hosts* _(lowest available in 24 h · biggest memory change in 24 h · root disk)_");
    const order = [...d.hosts].sort(
      (a, b) => b.attention.length - a.attention.length || ratio(a) - ratio(b) || a.name.localeCompare(b.name)
    );
    for (const h of order) {
      if (h.coverHours === 0 && h.availableNow === undefined) {
        lines.push(`• \`${h.name}\` — no history yet`);
        continue;
      }
      const parts: string[] = [];
      if (h.lowest24h) parts.push(`low ${mi(h.lowest24h.available)}${h.total ? ` of ${mi(h.total)}` : ""}`);
      if (h.topMover) parts.push(`${h.topMover.name}${h.topMover.where && h.topMover.where !== h.topMover.name ? ` (${h.topMover.where})` : ""} ${h.topMover.change} → ${h.topMover.end}`);
      if (h.disk) parts.push(`disk ${h.disk.usedPercentNow}%${h.disk.daysToFull !== undefined ? `, full in ~${h.disk.daysToFull} d` : ""}`);
      if (h.coverHours < 24) parts.push(`_${h.coverHours} h of history_`);
      lines.push(`• ${h.attention.length ? "⚠️ " : ""}\`${h.name}\` — ${parts.join(" · ")}`);
      for (const a of h.attention) lines.push(`    ↳ ${a}`);
    }
  }

  if (d.firing) {
    lines.push("", "*🔥 Firing now*");
    if (d.firing.length === 0) lines.push("• nothing");
    for (const f of d.firing.slice(0, 10)) lines.push(`• \`${f.name}\` × ${f.count}${f.severity ? ` _(${f.severity})_` : ""}`);
    if (d.firing.length > 10) lines.push(`• … and ${d.firing.length - 10} more`);
  }

  if (d.incidents24h) {
    lines.push("", "*📟 Last 24 h*");
    if (d.incidents24h.length === 0) lines.push("• no investigations");
    for (const c of d.incidents24h.slice(0, 8)) {
      lines.push(`• \`${c.alertname}\` in ${where(c)} — ${c.count}×${c.open ? `, ${c.open} still open` : ""}`);
    }
  }

  if (d.repeat7d && d.repeat7d.length) {
    lines.push("", "*🔁 Noisy this week* _(investigated 3+ times in 7 days — a rule to tune, or a cause still there)_");
    for (const c of d.repeat7d.slice(0, 5)) lines.push(`• \`${c.alertname}\` in ${where(c)} — ${c.count}×`);
  }

  if (d.unread.length) lines.push("", `❔ *Not read:* ${d.unread.join("; ")} — those sections are missing, not empty.`);
  return lines.join("\n");
}

const ratio = (h: HostDigest): number => (h.lowest24h && h.total ? h.lowest24h.available / h.total : 1);

/** Alertmanager's `alertmanager_get_alerts` answer → firing alerts by name. Null when it is not that shape. */
export function firingFrom(raw: string): DigestData["firing"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const groups = (parsed as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return null;
  const rank = ["critical", "high", "warning", "medium", "low", "info", "none"];
  const by = new Map<string, { count: number; severity: string | null }>();
  for (const g of groups) {
    const list = (g as { alerts?: unknown })?.alerts;
    if (!Array.isArray(list)) continue;
    for (const a of list as Array<{ name?: unknown; labels?: Record<string, unknown> }>) {
      const name = typeof a?.name === "string" ? a.name : typeof a?.labels?.alertname === "string" ? (a.labels.alertname as string) : null;
      // The always-firing heartbeat rules say the pipeline works, not that something is wrong.
      if (!name || name === "Watchdog" || name === "InfoInhibitor") continue;
      const sev = typeof a.labels?.severity === "string" ? (a.labels.severity as string).toLowerCase() : null;
      const cur = by.get(name) ?? { count: 0, severity: null };
      cur.count++;
      if (sev && (cur.severity === null || idx(rank, sev) < idx(rank, cur.severity))) cur.severity = sev;
      by.set(name, cur);
    }
  }
  return [...by.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => idx(rank, a.severity ?? "none") - idx(rank, b.severity ?? "none") || b.count - a.count);
}

const idx = (rank: string[], s: string): number => {
  const i = rank.indexOf(s);
  return i < 0 ? rank.length : i;
};

/** The local date and HH:MM in `timeZone` (an IANA name). */
export function localClock(now: Date, timeZone: string): { day: string; hhmm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

/** Is the digest due now? From `time` until 3 h after it, local — a pod that was down at 08:00 still posts at 09:30, not at 23:00. */
export function digestDue(now: Date, timeZone: string, time: string): { due: boolean; day: string } {
  const { day, hhmm } = localClock(now, timeZone);
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const d = toMin(hhmm) - toMin(time);
  return { due: d >= 0 && d < 180, day };
}
