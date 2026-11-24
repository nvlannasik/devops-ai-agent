// Host snapshot history (B1, migrations/021): a compact point per host every 5 minutes, kept 7 days,
// and the summary the model reads from it. The numbers an RCA needs from a series — what grew, by
// how much, since when, how close the disk is to full — are computed here, never left to the model:
// a small model reads `total` as usage and adds a column of Mi wrong (2026-11-17, same reason
// shapeSnapshot states `used`).

/** One stored point. Bytes, not Mi strings: the summary does arithmetic on them. */
export interface HistoryPoint {
  memTotal?: number;
  memAvailable?: number;
  anon?: number;
  cache?: number;
  /** The kubepods cgroup — all pods together (includes their page cache). */
  pods?: number;
  /** cgroup memory per systemd unit. */
  units?: Record<string, number>;
  /** RSS per `name@where` (where = a .service unit, or `pod`), summed over the snapshot's processes of that name. */
  procs?: Record<string, number>;
  diskTotal?: number;
  diskAvailable?: number;
  load1?: number;
}

export interface StoredPoint {
  at: Date;
  point: HistoryPoint;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The point a heartbeat's snapshot (vm-agent snapshot(), version 3+) is stored as. Null when it holds nothing worth a row. */
export function historyPoint(snap: Record<string, unknown> | null): HistoryPoint | null {
  if (!snap || typeof snap !== "object") return null;
  const mem = (snap.memory ?? {}) as Record<string, unknown>;
  const disk = (snap.rootDisk ?? {}) as Record<string, unknown>;
  const p: HistoryPoint = {};
  const set = <K extends keyof HistoryPoint>(k: K, v: HistoryPoint[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set("memTotal", num(mem.totalBytes));
  set("memAvailable", num(mem.availableBytes));
  set("anon", num(mem.anonBytes));
  set("cache", num(mem.cachedBytes));
  set("pods", num(snap.kubepodsMemoryBytes));
  if (Array.isArray(snap.units)) {
    const units: Record<string, number> = {};
    for (const u of snap.units as Array<Record<string, unknown>>) {
      const b = num(u?.memoryBytes);
      if (typeof u?.unit === "string" && b !== undefined) units[u.unit] = b;
    }
    if (Object.keys(units).length) p.units = units;
  }
  if (Array.isArray(snap.processes)) {
    const procs: Record<string, number> = {};
    for (const x of snap.processes as Array<Record<string, unknown>>) {
      const b = num(x?.rssBytes);
      if (typeof x?.name !== "string" || b === undefined) continue;
      const key = `${x.name}@${x.unit === "kubepods" ? "pod" : typeof x.unit === "string" ? x.unit : "unknown"}`;
      procs[key] = (procs[key] ?? 0) + b;
    }
    if (Object.keys(procs).length) p.procs = procs;
  }
  set("diskTotal", num(disk.totalBytes));
  set("diskAvailable", num(disk.availableBytes));
  if (Array.isArray(snap.load)) set("load1", num(snap.load[0]));
  return Object.keys(p).length ? p : null;
}

const MI = 1048576;
const mi = (b: number): string => `${Math.round(b / MI)}Mi`;
const signedMi = (b: number): string => `${b >= 0 ? "+" : "-"}${Math.round(Math.abs(b) / MI)}Mi`;
/** A change smaller than this is noise for a memory series (page cache alone moves more). */
const MIN_GROWTH_BYTES = 10 * MI;
/** Points averaged at each end of the window, so one spiky sample is not the "start" or the "end". */
const EDGE = 3;
/** Samples of the headline series the model gets — enough to see a shape, few enough to read. */
const SAMPLES = 12;
/** A gap between points longer than this means the host or its agent stopped reporting. */
const GAP_SECONDS = 15 * 60;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const edges = (xs: number[]): { first: number; last: number } => {
  const k = Math.max(1, Math.min(EDGE, Math.floor(xs.length / 3)));
  return { first: mean(xs.slice(0, k)), last: mean(xs.slice(-k)) };
};

export interface Growth {
  name: string;
  where?: string;
  start: string;
  end: string;
  peak: string;
  change: string;
  changePercent: number | null;
  seenInPoints: string;
}

/** Start/end/peak/change for every key of a per-unit or per-process map, the movers only, largest change first. */
export function movers(points: StoredPoint[], pick: (p: HistoryPoint) => Record<string, number> | undefined, split: boolean, limit: number): Growth[] {
  const series = new Map<string, number[]>();
  for (const { point } of points) {
    for (const [k, v] of Object.entries(pick(point) ?? {})) {
      const s = series.get(k) ?? [];
      s.push(v);
      series.set(k, s);
    }
  }
  const out: Array<Growth & { abs: number }> = [];
  for (const [key, xs] of series) {
    if (xs.length < 2) continue;
    const { first, last } = edges(xs);
    const d = last - first;
    if (Math.abs(d) < MIN_GROWTH_BYTES) continue;
    const at = key.lastIndexOf("@");
    out.push({
      ...(split && at > 0 ? { name: key.slice(0, at), where: key.slice(at + 1) } : { name: key }),
      start: mi(first),
      end: mi(last),
      peak: mi(Math.max(...xs)),
      change: signedMi(d),
      changePercent: first > 0 ? Math.round((d / first) * 100) : null,
      seenInPoints: `${xs.length}/${points.length}`,
      abs: Math.abs(d),
    });
  }
  return out
    .sort((a, b) => b.abs - a.abs)
    .slice(0, limit)
    .map(({ abs: _abs, ...g }) => g);
}

/** Least-squares slope of y over time, per second; null with fewer than two distinct times. */
function slope(xs: Array<{ t: number; y: number }>): number | null {
  if (xs.length < 2) return null;
  const mt = mean(xs.map((x) => x.t));
  const my = mean(xs.map((x) => x.y));
  let num = 0;
  let den = 0;
  for (const x of xs) {
    num += (x.t - mt) * (x.y - my);
    den += (x.t - mt) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Root disk: usage now and, when it is growing, the days until full at the window's rate. */
export function diskTrend(points: StoredPoint[]): Record<string, unknown> | undefined {
  const xs = points
    .filter((p) => p.point.diskTotal && p.point.diskAvailable !== undefined)
    .map((p) => ({ t: p.at.getTime() / 1000, y: p.point.diskAvailable!, total: p.point.diskTotal! }));
  if (xs.length === 0) return undefined;
  const lastX = xs[xs.length - 1]!;
  const firstX = xs[0]!;
  const out: Record<string, unknown> = {
    usedPercentStart: Math.round((1 - firstX.y / firstX.total) * 100),
    usedPercentNow: Math.round((1 - lastX.y / lastX.total) * 100),
    availableNow: mi(lastX.y),
  };
  const spanSeconds = lastX.t - firstX.t;
  const s = slope(xs);
  // Under 6 h of points a slope is a guess (one log rotation moves it), so no forecast.
  if (s === null || spanSeconds < 6 * 3600) {
    out.forecast = "not enough history for a rate (under 6 h of points)";
  } else if (s >= 0 || -s * 86400 < 50 * MI) {
    out.forecast = "not filling — root disk usage is flat or falling over this window";
  } else {
    out.changePerDay = signedMi(s * 86400);
    out.daysToFull = Math.round((lastX.y / -s / 86400) * 10) / 10;
    // Raw numbers for a caller that projects to another threshold (the digest: a Kubernetes node's
    // DiskPressure at 90 %, not 100 %).
    out.bytesPerDay = s * 86400;
    out.availableBytes = lastX.y;
    out.totalBytes = lastX.total;
  }
  return out;
}

/** Evenly spaced indices over n points, always including the first and the last. */
const sampleIdx = (n: number, k: number): number[] => {
  if (n <= k) return [...Array(n).keys()];
  const out = new Set<number>();
  for (let i = 0; i < k; i++) out.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...out];
};

/** What the model reads from a host's history: shape, movers, disk forecast and the gaps in it. */
export function summarizeHistory(node: string, points: StoredPoint[], hours: number): Record<string, unknown> {
  const out: Record<string, unknown> = { node, windowHours: hours, points: points.length };
  if (points.length === 0) {
    out.note = `no history in the last ${hours} h — the host's agent reported nothing, or history began after that (points are kept 7 days from the B1 rollout on)`;
    return out;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  out.from = first.at.toISOString();
  out.to = last.at.toISOString();
  const coverHours = (last.at.getTime() - first.at.getTime()) / 3600_000;
  if (coverHours < hours * 0.9) out.coverage = `history covers only the last ${Math.round(coverHours * 10) / 10} h of the ${hours} h asked`;

  const used = (p: HistoryPoint) => (p.memTotal !== undefined && p.memAvailable !== undefined ? p.memTotal - p.memAvailable : undefined);
  const series = (f: (p: HistoryPoint) => number | undefined) => points.map((p) => f(p.point)).filter((v): v is number => v !== undefined);
  const headline: Record<string, unknown> = {};
  for (const [label, f] of [
    ["used", used],
    ["available", (p: HistoryPoint) => p.memAvailable],
    ["anonymous", (p: HistoryPoint) => p.anon],
    ["allPods", (p: HistoryPoint) => p.pods],
    ["systemdServicesTotal", (p: HistoryPoint) => (p.units ? Object.values(p.units).reduce((a, b) => a + b, 0) : undefined)],
  ] as const) {
    const xs = series(f);
    if (xs.length < 2) continue;
    const { first: a, last: b } = edges(xs);
    headline[label] = { start: mi(a), end: mi(b), min: mi(Math.min(...xs)), max: mi(Math.max(...xs)), change: signedMi(b - a) };
  }
  if (Object.keys(headline).length) out.memory = headline;
  const minAvail = points.reduce<StoredPoint | null>((m, p) => (p.point.memAvailable !== undefined && (m === null || p.point.memAvailable < m.point.memAvailable!) ? p : m), null);
  if (minAvail) out.lowestAvailable = { at: minAvail.at.toISOString(), available: mi(minAvail.point.memAvailable!) };

  out.samples = sampleIdx(points.length, SAMPLES).map((i) => {
    const p = points[i]!;
    const u = used(p.point);
    return {
      at: p.at.toISOString(),
      ...(u !== undefined ? { used: mi(u) } : {}),
      ...(p.point.memAvailable !== undefined ? { available: mi(p.point.memAvailable) } : {}),
      ...(p.point.pods !== undefined ? { allPods: mi(p.point.pods) } : {}),
    };
  });

  const units = movers(points, (p) => p.units, false, 8);
  out.systemdServicesThatMoved = units.length ? units : "none moved by 10Mi or more";
  const procs = movers(points, (p) => p.procs, true, 10);
  out.processesThatMoved = procs.length ? procs : "none moved by 10Mi or more";

  const disk = diskTrend(points);
  if (disk) out.rootDisk = disk;

  const gaps: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const s = (points[i]!.at.getTime() - points[i - 1]!.at.getTime()) / 1000;
    if (s > GAP_SECONDS) gaps.push(`${points[i - 1]!.at.toISOString()} → ${points[i]!.at.toISOString()} (${Math.round(s / 60)} min)`);
  }
  if (gaps.length) out.gaps = gaps.slice(-5);

  out.notes = [
    "start/end average the first and last three points; change = end - start. A mover is a unit or process whose change is 10Mi or more",
    "processes are only the largest by RSS in each snapshot: seenInPoints below the total means it was outside that list in the other points — not that it was not running",
    "systemd service memory and allPods are cgroup memory and include page cache; anonymous is what cannot be reclaimed",
    "a gap means the host or its devops-vm-agent stopped reporting for that long",
  ];
  return out;
}
