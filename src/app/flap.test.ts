import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFlow, FLAP_WINDOW_MINUTES } from "./alerts.js";

// Production 2026-11-14/15: KubernetesNodeMemoryPressure on master3-vm fired, resolved and fired again
// six times in three hours — six investigations, six threads, the same root cause each time.
const LABELS = { alertname: "KubernetesNodeMemoryPressure", cluster: "dev", node: "master3-vm", severity: "critical" };
const viaAlerts = (fake: object) => Object.assign(Object.create(AlertFlow.prototype), fake, { host: fake });

const harness = (prior: { id: number; channel: string; threadTs: string; resolvedAt: Date } | null, reopens = true) => {
  const posted: any[] = [];
  const asked: Array<[Record<string, string>, number]> = [];
  const reopened: number[] = [];
  const self: any = {
    agent: {
      recentlyResolvedIncident: async (labels: Record<string, string>, mins: number) => (asked.push([labels, mins]), prior),
      reopenIncident: async (id: number) => (reopens ? (reopened.push(id), { channel: "C1", threadTs: "111.1" }) : null),
    },
    app: { client: { chat: { postMessage: async (m: any) => void posted.push(m) } } },
  };
  const run = () => AlertFlow.prototype.reopenFlap.call(viaAlerts(self), LABELS, LABELS.alertname);
  return { posted, asked, reopened, run };
};

test("an alert that fires again soon after resolving is reopened in its own thread, not re-investigated", async () => {
  const h = harness({ id: 42, channel: "C1", threadTs: "111.1", resolvedAt: new Date(Date.now() - 7 * 60_000) });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.asked, [[LABELS, FLAP_WINDOW_MINUTES]], "matched on the whole group, node and cluster included");
  assert.deepEqual(h.reopened, [42]);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].thread_ts, "111.1");
  assert.match(h.posted[0].text, /Fired again\* — KubernetesNodeMemoryPressure, 7 min after it resolved/);
});

test("no recent resolve, or a reopen that did not happen, takes the normal path", async () => {
  const none = harness(null);
  assert.equal(await none.run(), false);
  assert.equal(none.posted.length, 0);
  // another replica reopened it first, or it is open already — never two messages, never a lost alert
  const raced = harness({ id: 42, channel: "C1", threadTs: "111.1", resolvedAt: new Date() }, false);
  assert.equal(await raced.run(), false);
  assert.equal(raced.posted.length, 0);
});

// 2026-11-21..23: FluxControllerDown on worker1-raspi fired through a 66 h control-plane outage; every
// ~13 h (12 h dedup claim + 1 h repeat) a new full investigation opened while the first was still open.
const FLUX = { alertname: "FluxControllerDown", cluster: "dev", namespace: "flux-system", pod: "helm-controller-64746695c6-rht57" };

const openHarness = (open: { id: number; channel: string; threadTs: string; createdAt: Date } | null) => {
  const posted: any[] = [];
  const asked: Array<Record<string, string>> = [];
  const self: any = {
    agent: { openIncidentFor: async (labels: Record<string, string>) => (asked.push(labels), open) },
    app: { client: { chat: { postMessage: async (m: any) => void posted.push(m) } } },
  };
  const run = () => AlertFlow.prototype.continueOpen.call(viaAlerts(self), FLUX, FLUX.alertname);
  return { posted, asked, run };
};

test("a group still firing with its incident open gets a line in that thread, not a new investigation", async () => {
  const h = openHarness({ id: 107, channel: "C1", threadTs: "107.1", createdAt: new Date(Date.now() - 13 * 3_600_000) });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.asked, [FLUX], "matched on the whole group");
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].thread_ts, "107.1");
  assert.match(h.posted[0].text, /Still firing\* — FluxControllerDown, 13 h since this incident opened/);
});

test("no open incident for the group takes the normal path", async () => {
  const h = openHarness(null);
  assert.equal(await h.run(), false);
  assert.equal(h.posted.length, 0);
});
