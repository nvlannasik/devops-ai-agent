import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";

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
    dedup: { clear: async () => {} },
    agent: { resolveIncident: async () => (stored() ? { channel: "C1", threadTs: "111.1" } : null) },
    app: { client: { chat: { postMessage: async (m: any) => void posted.push(m) } } },
  };
  const proto = SlackApp.prototype as any;
  self.postResolved = proto.postResolved;
  const resolve = () => proto.handleResolvedAlert.call(self, LABELS, RESOLVED);
  const store = () => proto.closeIfResolvedEarly.call(self, "111.1", LABELS);
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
  await (SlackApp.prototype as any).closeIfResolvedEarly.call(h.self, "222.2", { alertname: "OtherAlert", namespace: "sample-apps" });
  assert.equal(h.posted.length, 0, "the other investigation closes nothing on store");
});

test("the ordinary order still posts straight away", async () => {
  const h = harness(() => true);
  await h.resolve();
  assert.equal(h.posted.length, 1);
});
