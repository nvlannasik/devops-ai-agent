import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFlow } from "./alerts.js";
import { InFlightRegistry } from "../agent/inflight/index.js";
import { fakeRedis } from "../agent/inflight/fake-redis.test.js";

const viaAlerts = (fake: object) => Object.assign(Object.create(AlertFlow.prototype), fake, { host: fake });

// Live 2026-09-29: SampleAppHighErrorRate and AppErrorLogSpike resolved at 14:05, while both
// investigations were still running. The incident row is written with the RCA, so the resolve found
// nothing to mark, and both sat open until the reconciler closed them at 14:18/14:19. A resolve for
// an investigation still in flight is now held and applied once the incident is stored.

const LABELS = { alertname: "SampleAppHighErrorRate", namespace: "sample-apps" };
const RESOLVED = [{ labels: LABELS, annotations: {}, endsAt: "2026-09-29T14:05:00Z" }];

const harness = (stored: () => boolean) => {
  const posted: any[] = [];
  const self: any = {
    unstored: new Map<string, { key: string; resolved?: unknown }>(),
    inflight: new InFlightRegistry(() => null),
    dedup: { clear: async () => {} },
    agent: { resolveIncident: async () => (stored() ? { channel: "C1", threadTs: "111.1" } : null) },
    app: { client: { chat: { postMessage: async (m: any) => void posted.push(m) } } },
  };
  self.postResolved = (AlertFlow.prototype as any).postResolved;
  const resolve = () => AlertFlow.prototype.handleResolvedAlert.call(viaAlerts(self), LABELS, RESOLVED);
  const store = () => AlertFlow.prototype.closeIfResolvedEarly.call(viaAlerts(self), "111.1", LABELS);
  return { self, posted, resolve, store };
};

test("a resolve that beats the incident row is applied the moment the row exists", async () => {
  let stored = false;
  const h = harness(() => stored);
  h.self.unstored.set("111.1", { key: `${LABELS.alertname}\u0000${LABELS.namespace}` });
  await h.resolve();
  assert.equal(h.posted.length, 0, "nothing to post into yet");
  stored = true;
  await h.store();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].thread_ts, "111.1");
  assert.match(h.posted[0].text, /Alert resolved\* — SampleAppHighErrorRate in `sample-apps` at `2026-09-29T14:05:00/);
});

test("a resolve for an alert nobody is investigating is not held for a later firing", async () => {
  const h = harness(() => true);
  // Another group in flight — must not catch this one's resolve.
  h.self.unstored.set("222.2", { key: `OtherAlert\u0000sample-apps` });
  h.self.agent.resolveIncident = async () => null;
  await h.resolve();
  assert.equal(h.self.unstored.get("222.2").resolved, undefined);
  h.self.agent.resolveIncident = async () => ({ channel: "C1", threadTs: "222.2" });
  await AlertFlow.prototype.closeIfResolvedEarly.call(viaAlerts(h.self), "222.2", { alertname: "OtherAlert", namespace: "sample-apps" });
  assert.equal(h.posted.length, 0, "the other investigation closes nothing on store");
});

test("the ordinary order still posts straight away", async () => {
  const h = harness(() => true);
  await h.resolve();
  assert.equal(h.posted.length, 1);
});

// 2026-10-22: the resolve lands on a DIFFERENT replica from the one investigating. Before, that
// replica found no row and no local entry, and the incident waited for the reconciler.
const KEY = `${LABELS.alertname}\u0000${LABELS.namespace}`;

test("a resolve on another replica is held in Redis and applied when the investigating pod stores", async () => {
  const redis = fakeRedis();
  let stored = false;
  const a = harness(() => stored);
  a.self.inflight = new InFlightRegistry(() => redis);
  a.self.unstored.set("111.1", { key: KEY });
  await a.self.inflight.publish("111.1", { key: KEY });

  const b = harness(() => stored);
  b.self.inflight = new InFlightRegistry(() => redis);
  await b.resolve();
  assert.equal(b.posted.length + a.posted.length, 0, "nothing to post into yet");

  stored = true;
  await a.store();
  assert.equal(a.posted.length, 1);
  assert.equal(a.posted[0].thread_ts, "111.1");
  assert.match(a.posted[0].text, /Alert resolved\* — SampleAppHighErrorRate/);
});

test("if the row lands while the resolve is being handed over, the receiving replica closes it itself", async () => {
  const redis = fakeRedis();
  await new InFlightRegistry(() => redis).publish("111.1", { key: KEY });
  let calls = 0;
  const b = harness(() => ++calls > 1); // no row on the first look, the row on the retry
  b.self.inflight = new InFlightRegistry(() => redis);
  await b.resolve();
  assert.equal(b.posted.length, 1);
  assert.equal(b.posted[0].thread_ts, "111.1");
});
