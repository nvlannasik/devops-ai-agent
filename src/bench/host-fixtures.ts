import type { HostFixture } from "./case.js";
import type { SnapshotCandidate, VmHostRow } from "../agent/vm/store.js";
import type { StoredPoint } from "../agent/vm/history.js";

// A case's invented hosts (case.json `hosts`), answered beside whatever host store the bench runs on
// (production's, read through the agent pod, or none). Built from start → end ramps, a point every 5
// minutes like vm_host_history, the last point doubling as the snapshot node_host_snapshot reads.

const MI = 1048576;
const STEP_MS = 5 * 60_000;
const at = (r: [number, number], f: number) => (r[0] + (r[1] - r[0]) * f) * MI;

/** The snapshot vm-agent would send at fraction `f` of the ramp (1 = now). */
export function fixtureSnapshot(h: HostFixture, f: number): Record<string, unknown> {
  const units = Object.entries(h.units).map(([unit, r]) => ({ unit, memoryBytes: Math.round(at(r, f)) }));
  const processes = (h.processes ?? []).map((p, i) => ({ name: p.name, pid: 1000 + i, unit: p.unit, rssBytes: Math.round(at(p.rssMi, f)) }));
  return {
    memory: { totalBytes: h.totalMi * MI, availableBytes: Math.round(at(h.availableMi, f)), swapTotalBytes: 0, swapFreeBytes: 0 },
    units: units.sort((a, b) => b.memoryBytes - a.memoryBytes),
    processes: processes.sort((a, b) => b.rssBytes - a.rssBytes),
    ...(h.diskTotalMi && h.diskAvailableMi ? { rootDisk: { totalBytes: h.diskTotalMi * MI, availableBytes: Math.round(at(h.diskAvailableMi, f)) } } : {}),
    load: [0.4, 0.4, 0.4],
  };
}

/** The fixture's points over its hours, oldest first, ending now. */
export function fixturePoints(h: HostFixture, now = Date.now()): StoredPoint[] {
  const n = Math.floor((h.hours * 3_600_000) / STEP_MS);
  const out: StoredPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const s = fixtureSnapshot(h, f);
    const mem = s.memory as Record<string, number>;
    const disk = s.rootDisk as { totalBytes: number; availableBytes: number } | undefined;
    out.push({
      at: new Date(now - (n - i) * STEP_MS),
      point: {
        memTotal: mem.totalBytes,
        memAvailable: mem.availableBytes,
        units: Object.fromEntries((s.units as Array<{ unit: string; memoryBytes: number }>).map((u) => [u.unit, u.memoryBytes])),
        procs: Object.fromEntries((s.processes as Array<{ name: string; unit: string; rssBytes: number }>).map((p) => [`${p.name}@${p.unit}`, p.rssBytes])),
        ...(disk ? { diskTotal: disk.totalBytes, diskAvailable: disk.availableBytes } : {}),
        load1: 0.4,
      },
    });
  }
  return out;
}

type Base = Partial<{
  snapshotCandidates(node: string): Promise<SnapshotCandidate[]>;
  history(host: string, hours: number): Promise<StoredPoint[]>;
  hosts(): Promise<VmHostRow[]>;
}>;

/** The VM store for one case: its fixtures first, everything else from `base`. Never queues an action. */
export function withHostFixtures(fixtures: HostFixture[], base: Base) {
  const byName = new Map(fixtures.map((h) => [h.name, h]));
  return {
    async snapshotCandidates(node: string): Promise<SnapshotCandidate[]> {
      const h = byName.get(node);
      if (h) return [{ name: h.name, cluster: null, node: null, snapshot: fixtureSnapshot(h, 1), ageSeconds: 30, version: "4" }];
      return base.snapshotCandidates ? base.snapshotCandidates(node) : [];
    },
    async history(host: string, hours: number): Promise<StoredPoint[]> {
      const h = byName.get(host);
      if (h) return fixturePoints(h).filter((p) => p.at.getTime() > Date.now() - hours * 3_600_000);
      return base.history ? base.history(host, hours) : [];
    },
    async hosts(): Promise<VmHostRow[]> {
      const rest = base.hosts ? await base.hosts().catch(() => []) : [];
      return [
        ...rest,
        ...fixtures.map((h) => ({ name: h.name, cluster: null, node: null, units: [], version: "4", lastSeenSeconds: 30, snapshot: fixtureSnapshot(h, 1), snapshotAgeSeconds: 30 })),
      ];
    },
    // Restarts: a fixture host is never registered, so a dry run refuses and nothing is queued.
    async registered(): Promise<null> {
      return null;
    },
    async registeredHosts(): Promise<Array<{ host: string; units: string[] }>> {
      return [];
    },
    async enqueue(): Promise<null> {
      return null;
    },
  };
}
