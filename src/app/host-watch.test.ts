import { test } from "node:test";
import assert from "node:assert/strict";
import { HostWatch } from "./host-watch.js";
import { config } from "../config/index.js";

const MASTER = { units: [{ unit: "etcd.service", memoryBytes: 1 }] };
const T0 = Date.parse("2026-11-20T21:00:00Z");

const harness = (opts: { postFails?: boolean } = {}) => {
  const posted: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let silentRows: any[] = [];
  let recoveredRows: any[] = [];
  const hosts = [
    { name: "master1-raspi", node: null, cluster: null, lastSeenSeconds: 20, snapshot: MASTER },
    { name: "master2-vm", node: null, cluster: null, lastSeenSeconds: 330, snapshot: MASTER },
    { name: "master3-vm", node: null, cluster: null, lastSeenSeconds: 330, snapshot: MASTER },
  ];
  const store = {
    hosts: async () => hosts,
    claimSilent: async (m: number) => (calls.push(`claimSilent:${m}`), silentRows.splice(0)),
    unclaimSilent: async (n: string[]) => void calls.push(`unclaim:${n.join(",")}`),
    silenceAnnounced: async (n: string[], c: string, ts: string) => void calls.push(`announced:${n.join(",")}@${c}/${ts}`),
    claimRecovered: async () => recoveredRows.splice(0),
  };
  const host = {
    stopping: false,
    agent: { vmStore: store },
    app: {
      client: {
        chat: {
          postMessage: async (m: Record<string, unknown>) => {
            if (opts.postFails) throw new Error("ratelimited");
            posted.push(m);
            return { ts: "171.9" };
          },
        },
      },
    },
  };
  return {
    posted,
    calls,
    setSilent: (r: any[]) => (silentRows = r),
    setRecovered: (r: any[]) => (recoveredRows = r),
    watch: new HostWatch(host as never, () => T0),
  };
};

const withConfig = async (fn: () => Promise<void>) => {
  const saved = { hw: { ...config.hostWatch }, ch: config.slack.alertChannel };
  Object.assign(config.hostWatch, { silentMinutes: 5 });
  config.slack.alertChannel = "C-ALERTS";
  try {
    await fn();
  } finally {
    Object.assign(config.hostWatch, saved.hw);
    config.slack.alertChannel = saved.ch;
  }
};

test("nothing is called silent while this process is younger than the threshold plus a minute", () =>
  withConfig(async () => {
    const h = harness();
    h.setSilent([{ name: "master2-vm", node: null, cluster: null, lastSeen: new Date(T0 - 330_000), snapshot: MASTER }]);
    assert.deepEqual(await h.watch.tick(new Date(T0 + 5 * 60_000)), { silent: [], recovered: [] });
    assert.ok(!h.calls.some((c) => c.startsWith("claimSilent")), "no claim taken during the grace");
  }));

test("silent hosts are claimed, announced once in the alert channel, and the thread is recorded", () =>
  withConfig(async () => {
    const h = harness();
    h.setSilent([
      { name: "master2-vm", node: null, cluster: null, lastSeen: new Date(T0 - 330_000), snapshot: MASTER },
      { name: "master3-vm", node: null, cluster: null, lastSeen: new Date(T0 - 330_000), snapshot: MASTER },
    ]);
    const out = await h.watch.tick(new Date(T0 + 7 * 60_000));
    assert.deepEqual(out.silent, ["master2-vm", "master3-vm"]);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]!.channel, "C-ALERTS");
    assert.match(String(h.posted[0]!.text), /etcd has lost quorum/);
    assert.ok(h.calls.includes("claimSilent:5"));
    assert.ok(h.calls.includes("announced:master2-vm,master3-vm@C-ALERTS/171.9"));
  }));

test("an announcement Slack refused gives the claims back for the next minute", () =>
  withConfig(async () => {
    const h = harness({ postFails: true });
    h.setSilent([{ name: "master2-vm", node: null, cluster: null, lastSeen: new Date(T0 - 330_000), snapshot: MASTER }]);
    const out = await h.watch.tick(new Date(T0 + 7 * 60_000));
    assert.deepEqual(out.silent, []);
    assert.ok(h.calls.includes("unclaim:master2-vm"));
  }));

test("a host back is posted in its announcement's thread — even during the start-up grace", () =>
  withConfig(async () => {
    const h = harness();
    h.setRecovered([{ name: "master2-vm", node: null, cluster: null, silentSince: new Date(T0 - 66 * 3_600_000), channel: "C-ALERTS", ts: "170.1" }]);
    const out = await h.watch.tick(new Date(T0 + 60_000));
    assert.deepEqual(out.recovered, ["master2-vm"]);
    assert.equal(h.posted[0]!.thread_ts, "170.1");
    assert.match(String(h.posted[0]!.text), /reporting again after 66 h/);
  }));
