import { test } from "node:test";
import assert from "node:assert/strict";
import { hostDigest, renderDigest, firingFrom, fluxFrom, digestDue, localClock, type DigestData } from "./build.js";
import { collectDigest } from "./collect.js";
import type { StoredPoint } from "../vm/history.js";

const MI = 1048576;
const NOW = new Date("2026-11-21T01:00:00.000Z"); // 08:00 in Asia/Jakarta

/** 7 days back from NOW, one point per 5 min. */
const week = (f: (hoursAgo: number) => Partial<StoredPoint["point"]>): StoredPoint[] => {
  const out: StoredPoint[] = [];
  for (let m = 7 * 24 * 60; m >= 0; m -= 5) {
    const h = m / 60;
    out.push({ at: new Date(NOW.getTime() - m * 60_000), point: { memTotal: 2000 * MI, memAvailable: 800 * MI, diskTotal: 20000 * MI, diskAvailable: 8000 * MI, ...f(h) } });
  }
  return out;
};

test("hostDigest: shrinking headroom, a filling disk and the day's biggest mover are named with numbers", () => {
  const pts = week((h) => ({
    // the daily low falls 100Mi a day: 700 → 100Mi
    memAvailable: (100 + (h / 24) * 100) * MI,
    diskAvailable: (3000 + (h / 24) * 300) * MI, // falls 300Mi/day; 3000Mi left now → 10 days
    units: { "etcd.service": (360 - (h / 24) * 20) * MI, "kubelet.service": 75 * MI },
  }));
  const d = hostDigest("master3-vm", pts, NOW);
  assert.equal(d.coverHours, 168);
  assert.equal(d.lowest24h!.available, 100 * MI);
  assert.equal(d.dailyLowest.length, 7);
  assert.ok(d.dailyLowest[0]! > d.dailyLowest.at(-1)!);
  assert.deepEqual(d.topMover && [d.topMover.name, d.topMover.change], ["etcd.service", "+20Mi"]);
  assert.equal(d.disk!.daysToFull, 10);
  assert.equal(d.disk!.changePerDay, "-300Mi");
  const all = d.attention.join(" | ");
  assert.match(all, /only 100Mi available now \(5% of 2000Mi\)/);
  assert.match(all, /headroom shrinking — daily lowest available \d+Mi → .* → 100Mi/);
  assert.match(all, /root disk full in ~10 days at -300Mi\/day/);
});

test("hostDigest: a quiet host needs nothing; a silent one says how long; none has no history", () => {
  assert.deepEqual(hostDigest("w2", week(() => ({})), NOW).attention, []);
  const silent = week(() => ({})).filter((p) => p.at.getTime() < NOW.getTime() - 3600_000);
  assert.match(hostDigest("w3", silent, NOW).attention.join(), /no report for 6\d min/);
  assert.deepEqual(hostDigest("w4", [], NOW), { name: "w4", coverHours: 0, dailyLowest: [], attention: [] });
});

const DATA: DigestData = {
  day: "2026-11-21",
  now: NOW,
  hosts: [hostDigest("worker2-raspi", week(() => ({})), NOW), hostDigest("master3-vm", week(() => ({ memAvailable: 90 * MI })), NOW), hostDigest("new-vm", [], NOW)],
  incidents24h: [{ alertname: "KubernetesNodeMemoryPressure", namespace: null, cluster: "dev", count: 3, open: 1 }],
  repeat7d: [{ alertname: "KubernetesNodeMemoryPressure", namespace: null, cluster: "dev", count: 9, open: 1 }],
  openTotal: 2,
  firing: [{ name: "KubernetesNodeMemoryPressure", count: 1, severity: "warning" }],
  gitops: { notReady: [], helmReleases: 20, kustomizations: 4, suspended: 0 },
  unread: [],
};

test("renderDigest: Slack mrkdwn, attention first, every section from the data", () => {
  const t = renderDigest(DATA);
  assert.match(t, /^\*🩺 Daily health — 2026-11-21\*/);
  assert.match(t, /1 of 3 hosts need a look · 1 alerts firing · 3 investigations in 24 h · 2 incidents open/);
  const hosts = t.split("\n").filter((l) => l.startsWith("• ") && l.includes("`"));
  assert.match(hosts[0]!, /^• ⚠️ `master3-vm`/, "the host that needs a look comes first");
  assert.match(t, /↳ only 90Mi available now/);
  assert.match(t, /• `new-vm` — no history yet/);
  assert.match(t, /• `KubernetesNodeMemoryPressure` in dev — 3×, 1 still open/);
  assert.match(t, /\*🔁 Noisy this week\*[\s\S]*9×/);
  assert.doesNotMatch(t, /^#/m, "no markdown headings");
  assert.doesNotMatch(t, /Not read/);
});

test("renderDigest: an unread source is named and its section is absent, never shown as empty", () => {
  const t = renderDigest({ ...DATA, firing: null, hosts: null, unread: ["Alertmanager (timed out after 20s)"] });
  assert.doesNotMatch(t, /Firing now|nothing firing|Hosts/);
  assert.match(t, /❔ \*Not read:\* Alertmanager \(timed out after 20s\) — those sections are missing, not empty\./);
});

test("firingFrom: counts by name, keeps the highest severity, drops the heartbeat rules, refuses another shape", () => {
  const raw = JSON.stringify({
    groups: [
      { alerts: [{ name: "Watchdog", labels: { severity: "none" } }, { name: "HighErrorRate", labels: { severity: "warning" } }] },
      { alerts: [{ name: "HighErrorRate", labels: { severity: "critical" } }, { labels: { alertname: "PodCrashLooping", severity: "warning" } }] },
    ],
  });
  assert.deepEqual(firingFrom(raw), [
    { name: "HighErrorRate", count: 2, severity: "critical" },
    { name: "PodCrashLooping", count: 1, severity: "warning" },
  ]);
  assert.equal(firingFrom("[]"), null);
  assert.equal(firingFrom("Error: alertmanager unreachable"), null);
});

test("digestDue: from the local time until 3 h after, in the configured zone", () => {
  assert.deepEqual(localClock(NOW, "Asia/Jakarta"), { day: "2026-11-21", hhmm: "08:00" });
  assert.deepEqual(digestDue(NOW, "Asia/Jakarta", "08:00"), { due: true, day: "2026-11-21" });
  assert.equal(digestDue(new Date(NOW.getTime() - 60_000), "Asia/Jakarta", "08:00").due, false);
  assert.equal(digestDue(new Date(NOW.getTime() + 179 * 60_000), "Asia/Jakarta", "08:00").due, true);
  assert.equal(digestDue(new Date(NOW.getTime() + 180 * 60_000), "Asia/Jakarta", "08:00").due, false);
  assert.equal(digestDue(NOW, "UTC", "08:00").due, false, "01:00 UTC");
  assert.equal(digestDue(NOW, "UTC", "08:00").day, "2026-11-21");
});

test("collectDigest: a failing source is listed as unread and the others still arrive", async () => {
  const d = await collectDigest({
    vm: { hosts: async () => [{ name: "stg.worker1", node: "worker1" }] as never, history: async () => week(() => ({})) },
    store: { incidentCounts: async () => [], openTotal: async () => { throw new Error("connection refused"); } },
    callTool: async (name) => (name === "k8s_get_custom_resources" ? "[]" : JSON.stringify({ groups: [] })),
    timeZone: "Asia/Jakarta",
    now: NOW,
  });
  assert.equal(d.day, "2026-11-21");
  assert.equal(d.hosts![0]!.name, "worker1", "the node name, not the token's name");
  assert.deepEqual(d.firing, []);
  assert.equal(d.openTotal, null);
  assert.deepEqual(d.unread, ["open incidents (connection refused)"]);
  const bad = await collectDigest({ vm: { hosts: async () => [], history: async () => [] }, store: { incidentCounts: async () => null, openTotal: async () => null }, callTool: async () => "nope", timeZone: "UTC", now: NOW });
  assert.equal(bad.hosts, null, "no host agents: the section is absent");
  assert.deepEqual(bad.unread.sort(), ["Alertmanager (unexpected answer)", "Flux (unexpected answer)"]);
});

// 2026-11-09..23: six HelmReleases Stalled for two weeks and nothing anywhere said so.
const HR = JSON.stringify([
  { name: "checkout-gateway", namespace: "flux-app", ready: "False", message: "Failed to install after 4 attempt(s)", since: "2026-11-09T17:09:18Z" },
  { name: "devops-ai-stack", namespace: "flux-app", ready: "True", since: "2026-11-20T17:40:00Z" },
  { name: "paused", namespace: "flux-app", ready: "False", suspended: true },
]);
const KS = JSON.stringify([{ name: "apps", namespace: "flux-app", ready: "True" }]);

test("fluxFrom: what is not Ready, oldest first; suspended counted apart; another shape is unread", () => {
  const g = fluxFrom(HR, KS)!;
  assert.equal(g.helmReleases, 3);
  assert.equal(g.kustomizations, 1);
  assert.equal(g.suspended, 1);
  assert.deepEqual(g.notReady.map((o) => [o.kind, o.namespace, o.name, o.ready]), [["HelmRelease", "flux-app", "checkout-gateway", "False"]]);
  assert.equal(g.notReady[0]!.since!.toISOString(), "2026-11-09T17:09:18.000Z");
  assert.equal(fluxFrom("Error: forbidden", KS), null);
});

test("renderDigest: a stalled release is named with since when and why; all Ready is one line", () => {
  const t = renderDigest({ ...DATA, gitops: fluxFrom(HR, KS) });
  assert.match(t, /1 Flux object not Ready/);
  assert.match(t, /\*🔄 GitOps \(Flux\)\*\n• ⚠️ HelmRelease `flux-app\/checkout-gateway` — Ready=False since 2026-11-09 \(11 d\): Failed to install after 4 attempt\(s\)/);
  assert.match(t, /a Git change to these is not applied until they are Ready again/);
  assert.match(renderDigest(DATA), /• all 20 HelmReleases and 4 Kustomizations Ready/);
});

test("a shrinking low with plenty left is not flagged; one heading for zero soon is", () => {
  // worker2-raspi, 2026-11-24: 5446 → 5476 → 5653 → 5110Mi of 7802Mi — 336Mi in 3 days, 45 days of it left.
  const lows = [5446, 5476, 5653, 5110];
  const pts = week((h) => ({ memTotal: 7802 * MI, memAvailable: lows[Math.min(3, Math.floor((72 - Math.min(h, 72)) / 24))]! * MI }));
  assert.deepEqual(hostDigest("worker2-raspi", pts, NOW).attention, []);
  // 900 → 300Mi of 2000Mi over the week: 100Mi/day, 3 days left — flagged, with the rate
  const falling = week((h) => ({ memAvailable: (300 + (h / 24) * 100) * MI }));
  assert.match(hostDigest("m", falling, NOW).attention.join(" | "), /headroom shrinking — .* \(~3 d to none at 100Mi\/day\)/);
});

test("renderDigest: the control plane section — a row per master, the findings under it, flagged in the summary", () => {
  const t = renderDigest({
    ...DATA,
    controlPlane: {
      rows: [
        { node: "master2-vm", roles: ["scheduler"], watches: 188, apiserverMemory: "501Mi", lowest24h: "516Mi", total: "1968Mi" },
        { node: "master3-vm", roles: ["controller-manager", "API VIP (kube-vip)"], watches: 328, apiserverMemory: "554Mi", lowest24h: "300Mi", total: "1967Mi" },
      ],
      findings: ["`master3-vm` holds 2 of 3 leader roles", "⚠️ and `master3-vm` has the least memory of the control planes (300Mi)"],
      unread: [],
    },
  });
  assert.match(t, /control plane unbalanced/);
  assert.match(t, /\*🎛️ Control plane\*[\s\S]*• `master3-vm` — controller-manager, API VIP \(kube-vip\) · 328 watches · apiserver 554Mi · low 300Mi of 1967Mi/);
  assert.match(t, /↳ ⚠️ and `master3-vm` has the least memory/);
  assert.doesNotMatch(renderDigest(DATA), /Control plane/, "absent when not read");
});

// The week to 2026-11-24, as production's incidents read it.
test("tuningHint: clears by itself → the rule; stays open → the cause; fixed and back → the fix; unclear → nothing", async () => {
  const { tuningHint } = await import("./build.js");
  const base = { namespace: null, cluster: "dev", open: 0 };
  assert.match(
    tuningHint({ ...base, alertname: "KubernetesNodeMemoryPressure", count: 30, resolved: 30, quick: 22, medianMinutes: 11, acted: 0 })!,
    /^22 of 30 cleared within 30 min on their own \(median 11 min\) and none led to a fix — lengthen the rule's `for:`/
  );
  assert.match(tuningHint({ ...base, alertname: "FluxControllerDown", count: 7, resolved: 7, quick: 0, medianMinutes: 3952, acted: 0 })!, /^median 65\.9 h from firing to resolved — a cause still there/);
  assert.match(tuningHint({ ...base, alertname: "X", count: 4, resolved: 4, quick: 1, medianMinutes: 40, acted: 3 })!, /3 of them ended in an applied fix and it came back/);
  assert.equal(tuningHint({ ...base, alertname: "KubernetesPodNotHealthy", count: 22, resolved: 22, quick: 12, medianMinutes: 27, acted: 0 }), null);
  const t = renderDigest({ ...DATA, repeat7d: [{ ...base, alertname: "KubernetesPodCrashLooping", namespace: "kube-system", count: 11, resolved: 11, quick: 11, medianMinutes: 6, acted: 0 }] });
  assert.match(t, /• `KubernetesPodCrashLooping` in dev\/kube-system — 11×\n    ↳ 11 of 11 cleared within 30 min/);
});

test("a Kubernetes node's disk is projected to DiskPressure (90 %), and the line says image growth stops at 85 %", () => {
  // worker1-raspi-like: 14336Mi root, 2660Mi left now, falling 209Mi/day over the week.
  const pts = week((h) => ({ diskTotal: 14336 * MI, diskAvailable: (2660 + (h / 24) * 209) * MI }));
  const k8s = hostDigest("worker1-raspi", pts, NOW, { kubernetes: true });
  // room to 90 %: 2660 - 1433.6 = 1226.4Mi at 209Mi/day ≈ 5.9 d
  assert.equal(k8s.disk!.daysToPressure, 5.9);
  assert.match(k8s.attention.join(" | "), /reaches DiskPressure \(90 %\) in ~5\.9 days — if it is image pulls, the kubelet deletes unused images from 85 % and it stops there/);
  assert.doesNotMatch(k8s.attention.join(" | "), /full in/);
  const vm = hostDigest("bench-vm-01", pts, NOW);
  assert.match(vm.attention.join(" | "), /root disk full in ~12\.7 days/, "a host the kubelet does not manage still fills at 100 %");
  assert.match(renderDigest({ ...DATA, hosts: [k8s] }), /disk 81%, DiskPressure in ~5\.9 d/);
});
