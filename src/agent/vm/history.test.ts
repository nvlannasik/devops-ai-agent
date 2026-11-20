import { test } from "node:test";
import assert from "node:assert/strict";
import { historyPoint, summarizeHistory, diskTrend, type StoredPoint, type HistoryPoint } from "./history.js";

const MI = 1048576;

// The shape vm-agent version 3 really sends (read from production's vm_hosts, master3-vm, 2026-11-20).
const SNAPSHOT = {
  load: [0.83, 0.8, 0.99],
  units: [
    { unit: "etcd.service", memoryBytes: 415543296 },
    { unit: "containerd.service", memoryBytes: 125153280 },
  ],
  memory: { anonBytes: 1461895168, totalBytes: 2062929920, cachedBytes: 314241024, swapFreeBytes: 0, availableBytes: 266813440, swapTotalBytes: 0 },
  rootDisk: { totalBytes: 24191102976, availableBytes: 12587913216 },
  processes: [
    { pid: 3761482, name: "kube-apiserver", unit: "kubepods", rssBytes: 647315456 },
    { pid: 719, name: "etcd", unit: "etcd.service", rssBytes: 410419200 },
    { pid: 11, name: "containerd-shim", unit: "kubepods", rssBytes: 10 * MI },
    { pid: 12, name: "containerd-shim", unit: "kubepods", rssBytes: 12 * MI },
  ],
  kubepodsMemoryBytes: 900 * MI,
};

test("historyPoint keeps bytes, sums processes of one name and place, and drops command lines by never reading them", () => {
  const p = historyPoint(SNAPSHOT)!;
  assert.equal(p.memTotal, 2062929920);
  assert.equal(p.memAvailable, 266813440);
  assert.equal(p.pods, 900 * MI);
  assert.deepEqual(p.units, { "etcd.service": 415543296, "containerd.service": 125153280 });
  assert.deepEqual(p.procs, { "kube-apiserver@pod": 647315456, "etcd@etcd.service": 410419200, "containerd-shim@pod": 22 * MI });
  assert.equal(p.diskAvailable, 12587913216);
  assert.equal(p.load1, 0.83);
  assert.equal(historyPoint(null), null);
  assert.equal(historyPoint({}), null);
});

const at = (h: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + h * 3600_000);
/** n points, one every 5 minutes, etcd growing linearly from 250 to 360Mi, kubelet flat. */
const series = (n: number, f: (i: number) => Partial<HistoryPoint> = () => ({})): StoredPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    at: at((i * 5) / 60),
    point: {
      memTotal: 2000 * MI,
      memAvailable: (600 - (i * 300) / (n - 1)) * MI,
      units: { "etcd.service": (250 + (i * 110) / (n - 1)) * MI, "kubelet.service": 75 * MI },
      procs: { "etcd@etcd.service": (240 + (i * 110) / (n - 1)) * MI },
      diskTotal: 20000 * MI,
      diskAvailable: 10000 * MI,
      ...f(i),
    },
  }));

test("summarizeHistory names what grew, with numbers computed in code, and leaves the flat ones out", () => {
  const s = summarizeHistory("master3-vm", series(289), 24) as Record<string, any>;
  assert.equal(s.points, 289);
  const units = s.systemdServicesThatMoved as Array<Record<string, unknown>>;
  assert.equal(units.length, 1, "kubelet did not move");
  assert.equal(units[0]!.name, "etcd.service");
  assert.match(String(units[0]!.start), /^25\dMi$/);
  assert.match(String(units[0]!.end), /^3[56]\dMi$/);
  assert.match(String(units[0]!.change), /^\+1\d\dMi$/);
  assert.equal(units[0]!.seenInPoints, "289/289");
  const procs = s.processesThatMoved as Array<Record<string, unknown>>;
  assert.deepEqual([procs[0]!.name, procs[0]!.where], ["etcd", "etcd.service"]);
  assert.match(String(s.memory.available.change), /^-\d+Mi$/);
  assert.equal(s.lowestAvailable.available, "300Mi");
  assert.equal(s.samples.length, 12);
  assert.equal(s.samples[0].at, at(0).toISOString());
  assert.equal(s.samples.at(-1).at, s.to);
  assert.equal(s.coverage, undefined, "24 h asked, 24 h held");
});

test("summarizeHistory: nothing moved says so; a short history and a gap are stated, never hidden", () => {
  const flat = series(30, () => ({ units: { "kubelet.service": 75 * MI }, procs: {}, memAvailable: 500 * MI }));
  flat[15] = { ...flat[15]!, at: at(5) }; // a 4h jump inside a 2.5h series
  for (let i = 16; i < flat.length; i++) flat[i] = { ...flat[i]!, at: at(5 + ((i - 15) * 5) / 60) };
  const s = summarizeHistory("w1", flat, 24) as Record<string, any>;
  assert.equal(s.systemdServicesThatMoved, "none moved by 10Mi or more");
  assert.match(s.coverage, /covers only the last/);
  assert.equal(s.gaps.length, 1);
  assert.match(s.gaps[0], /min\)$/);
  const empty = summarizeHistory("w1", [], 6) as Record<string, any>;
  assert.equal(empty.points, 0);
  assert.match(empty.note, /no history in the last 6 h/);
});

test("diskTrend forecasts days to full only from a falling availability over 6 h or more", () => {
  // 24 h, available falls 1000Mi per day from 5000Mi: ~4 days left at the end.
  const filling = Array.from({ length: 289 }, (_, i) => ({ at: at((i * 5) / 60), point: { diskTotal: 20000 * MI, diskAvailable: (5000 - (i * 1000) / 288) * MI } }));
  const d = diskTrend(filling)!;
  assert.equal(d.changePerDay, "-1000Mi");
  assert.equal(d.daysToFull, 4);
  assert.equal(d.usedPercentNow, 80);
  const flat = diskTrend(series(289))!;
  assert.match(String(flat.forecast), /not filling/);
  const short = diskTrend(series(10))!;
  assert.match(String(short.forecast), /under 6 h/);
  assert.equal(diskTrend([{ at: at(0), point: {} }]), undefined);
});
