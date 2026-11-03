import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFlow } from "./alerts.js";
import { InFlightRegistry } from "../agent/inflight/index.js";
import { fakeRedis } from "../agent/inflight/fake-redis.test.js";
import { config } from "../config/index.js";

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

// Final review finding 1: Alertmanager groups by [alertname, namespace, cluster] — a resolve for
// one cluster's group must never match another cluster's in-flight entry of the same
// alertname+namespace (incidentKey now carries the cluster label too, when present). This goes
// through the real handleAlert()/handleResolvedAlert() pair rather than a hand-built unstored
// entry, so the in-flight key is whatever incidentKey() actually produces for each group — the
// exact value that collided before this fix (incidentKey ignored `cluster` entirely).
function minimalAlertHost(tsPrefix: string) {
  let ts = 0;
  return {
    unstored: new Map<string, { key: string; resolved?: unknown }>(),
    inflight: new InFlightRegistry(() => null),
    dedup: { shouldProcess: async () => true, clear: async () => {} },
    agent: { resolveIncident: async () => null },
    app: { client: { chat: { postMessage: async () => ({ ts: `${tsPrefix}${++ts}` }) } } },
    inFlight: { track: (_meta: unknown, p: Promise<unknown>) => p },
    threadQueue: { run: (_id: string, _fn: () => Promise<unknown>) => Promise.resolve() },
  };
}

test("a stg resolve does not match a dev in-flight entry of the same alertname+namespace", async () => {
  const previousChannel = config.slack.alertChannel;
  config.slack.alertChannel = "C-TEST-FINDING1";
  try {
    const self: any = minimalAlertHost("T");
    const devAlert = {
      status: "firing" as const,
      // No service-level subject label (just `pod`) — correlate() short-circuits on
      // distinctSubjects() before touching the agent, keeping this host minimal.
      labels: { alertname: "SampleAppHighErrorRate", namespace: "sample-apps", pod: "x-abc12", cluster: "dev" },
      annotations: {},
      startsAt: new Date().toISOString(),
    };
    await AlertFlow.prototype.handleAlert.call(viaAlerts(self), { alerts: [devAlert] });
    assert.equal(self.unstored.size, 1, "the dev alert opened one in-flight entry");
    const [threadId] = [...self.unstored.keys()];

    await AlertFlow.prototype.handleResolvedAlert.call(
      viaAlerts(self),
      { alertname: "SampleAppHighErrorRate", namespace: "sample-apps", cluster: "stg" },
      RESOLVED
    );

    assert.equal(self.unstored.get(threadId!)!.resolved, undefined, "a stg resolve must not mark a dev in-flight entry of the same alertname+namespace");
  } finally {
    config.slack.alertChannel = previousChannel;
  }
});

// Regression: with no cluster label anywhere (single-cluster mode, or an unlabelled alert in
// strict mode), the key must be exactly what it was before this fix — a same-cluster resolve
// still matches its own in-flight entry.
test("with no cluster label anywhere, a resolve still matches its own in-flight entry (key unchanged)", async () => {
  const previousChannel = config.slack.alertChannel;
  config.slack.alertChannel = "C-TEST-FINDING1B";
  try {
    const self: any = minimalAlertHost("U");
    const alert = {
      status: "firing" as const,
      labels: { alertname: "SampleAppHighErrorRate", namespace: "sample-apps", pod: "x-abc12" },
      annotations: {},
      startsAt: new Date().toISOString(),
    };
    await AlertFlow.prototype.handleAlert.call(viaAlerts(self), { alerts: [alert] });
    const [threadId] = [...self.unstored.keys()];

    await AlertFlow.prototype.handleResolvedAlert.call(viaAlerts(self), { alertname: "SampleAppHighErrorRate", namespace: "sample-apps" }, RESOLVED);

    assert.ok(self.unstored.get(threadId!)!.resolved, "no cluster anywhere: same alertname+namespace still matches, exactly as before this fix");
  } finally {
    config.slack.alertChannel = previousChannel;
  }
});
