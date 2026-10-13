import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";
import { resetServiceGraphCache } from "../agent/correlation/topology.js";

// Cross-group correlation (agent/correlation/topology.ts, spec 2026-10-13). A related alert
// merges into an open incident's thread instead of opening its own — see correlate() in
// app/index.ts. Follows the fake-`this` harness pattern from resolved-early.test.ts.

const NOW = Date.parse("2026-10-13T10:10:00Z");
const PARENT_STARTED_AT = NOW - 5 * 60_000; // 5 min before the new alert fires

// Task 1's fixture shape: prometheus_query's REAL result is top-level {resultType, result},
// no envelope. service=checkout-gateway, peer=orders-api so describeVia renders in that order.
const VECTOR = JSON.stringify({
  resultType: "vector",
  result: [{ metric: { namespace: "sample-apps", service: "checkout-gateway", peer: "orders-api" }, value: [NOW / 1000, "0.1"] }],
});

function firingAlert(labelOverrides: Record<string, string> = {}): any[] {
  return [
    {
      status: "firing",
      labels: { alertname: "SampleAppHighErrorRate", namespace: "sample-apps", service: "checkout-gateway", ...labelOverrides },
      annotations: {},
      startsAt: new Date(NOW).toISOString(),
    },
  ];
}

function harness(opts: {
  callTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  postMessage?: (m: any) => Promise<any>;
  openRelatable?: () => Promise<any[]>;
  investigate?: () => Promise<string>;
} = {}) {
  const posted: any[] = [];
  const stored: any[] = [];
  const threadQueueCalls: string[] = [];
  let pending: Promise<unknown> | null = null;
  const self: any = {
    unstored: new Map(),
    agent: {
      callTool: opts.callTool ?? (async () => VECTOR),
      openRelatable: opts.openRelatable ?? (async () => []),
      storeIncident: async (...a: any[]) => {
        stored.push(a);
        return 9;
      },
      investigate: opts.investigate ?? (async () => "fits: orders-api latency is the cause"),
      reformatToConversation: async (t: string) => t,
    },
    app: { client: { chat: { postMessage: opts.postMessage ?? (async (m: any) => { posted.push(m); return {}; }) } } },
    threadQueue: {
      run: (threadId: string, fn: () => Promise<unknown>) => {
        threadQueueCalls.push(threadId);
        pending = fn();
        return pending;
      },
    },
  };
  // correlate()'s follow-up calls this.conversationReply(...) — not an instance, so wire it in.
  self.conversationReply = (SlackApp.prototype as any).conversationReply;
  const correlate = (channel: string, groupLabels: Record<string, string>, firing: any[], issueText: string, alertSeverity: string | null) =>
    (SlackApp.prototype as any).correlate.call(self, channel, groupLabels, firing, issueText, alertSeverity);
  return { self, posted, stored, threadQueueCalls, correlate, waitFollowUp: () => pending };
}

const PARENT = {
  key: "SampleAppHighLatency\u0000sample-apps",
  channel: "C1",
  namespace: "sample-apps",
  subjects: ["orders-api"],
  startedAt: PARENT_STARTED_AT,
  alertname: "SampleAppHighLatency",
};

test("a related alert merges into the open incident's thread", async () => {
  resetServiceGraphCache();
  const h = harness();
  h.self.unstored.set("100.1", { ...PARENT });

  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue text body", "warning");
  // The follow-up is fire-and-forget (`void this.threadQueue.run(...)`) but every step in these
  // fakes resolves with no real I/O, so it is already done by the time correlate()'s own await
  // chain unwinds. Wait on it explicitly rather than relying on that timing accident.
  await h.waitFollowUp();

  assert.equal(result, true);
  assert.equal(h.posted[0].thread_ts, "100.1");
  assert.match(h.posted[0].text, /Related alert\* — SampleAppHighErrorRate .*checkout-gateway → orders-api/);

  assert.equal(h.stored.length, 1);
  const [, rca, , threadTs, , , storeOpts] = h.stored[0];
  assert.equal(threadTs, "100.1");
  assert.match(rca, /^Merged into the incident in this thread/);
  assert.deepEqual(storeOpts, { subjects: ["checkout-gateway"], child: true });

  assert.deepEqual(h.threadQueueCalls, ["100.1"]);
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].thread_ts, "100.1");
  assert.ok(h.posted.every((p) => !!p.thread_ts), "no post lacks thread_ts");
});

test("graph unavailable takes the normal path", async () => {
  resetServiceGraphCache();
  const h = harness({ callTool: async () => { throw new Error("mcp down"); } });
  h.self.unstored.set("100.1", { ...PARENT });

  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue", "warning");

  assert.equal(result, false);
  assert.equal(h.posted.length, 0);
});

test("no related incident in that namespace takes the normal path", async () => {
  resetServiceGraphCache();
  const h = harness();
  h.self.unstored.set("100.1", { ...PARENT });

  const firing = firingAlert({ namespace: "other-ns" });
  const result = await h.correlate("C2", { namespace: "other-ns", alertname: "SampleAppHighErrorRate" }, firing, "issue", "warning");

  assert.equal(result, false);
  assert.equal(h.posted.length, 0);
});

test("a failed post into the parent thread takes the normal path and skips the store", async () => {
  resetServiceGraphCache();
  const h = harness({ postMessage: async () => { throw new Error("channel_not_found"); } });
  h.self.unstored.set("100.1", { ...PARENT });

  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue", "warning");

  assert.equal(result, false);
  assert.equal(h.stored.length, 0);
});

test("no service-level subject skips correlation without calling MCP", async () => {
  resetServiceGraphCache();
  let called = false;
  const h = harness({ callTool: async () => { called = true; return VECTOR; } });

  const firing = [{ status: "firing", labels: { alertname: "SomeAlert", namespace: "sample-apps", pod: "foo-abc123" }, annotations: {}, startsAt: new Date(NOW).toISOString() }];
  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SomeAlert" }, firing, "issue", null);

  assert.equal(result, false);
  assert.equal(called, false);
});

// Fix round 1: the correlation follow-up never makes a card, so a sentence promising one is as
// false here as it would be on the mention path — conversationReply (shared with handleMention)
// must scrub it before the follow-up reply is posted. Sentence verbatim from dropCardPromises'
// own "a sentence promising a card is dropped" test.
test("a card-promise sentence is dropped from the correlation follow-up reply", async () => {
  resetServiceGraphCache();
  const cardPromiseReply =
    "The deletion of `devops-tools/devops-agent-redis` cannot be executed directly — it requires approval through the remediation workflow. " +
    "An action card to remove this orphaned Service will be posted for your approval shortly.";
  const h = harness({ investigate: async () => cardPromiseReply });
  h.self.unstored.set("100.1", { ...PARENT });

  await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue", "warning");
  await h.waitFollowUp();

  assert.equal(h.posted.length, 2);
  const followUp = h.posted[1].text;
  assert.doesNotMatch(followUp, /shortly/);
  assert.match(followUp, /cannot be executed directly/);
});

// Review Focus 4: a resolve of the CHILD group (the merged alert's own alertname+namespace,
// not the parent incident's) still resolves against its own labels — handleResolvedAlert is
// unmodified by correlation, it only ever reads the labels it's given.
test("a resolve of the merged child group still resolves by its own labels", async () => {
  const CHILD_LABELS = { alertname: "SampleAppHighErrorRate", namespace: "sample-apps" };
  const resolvedCalls: any[] = [];
  const self: any = {
    unstored: new Map(),
    dedup: { clear: async () => {} },
    agent: {
      resolveIncident: async (labels: any) => {
        resolvedCalls.push(labels);
        return { channel: "C1", threadTs: "100.1" };
      },
    },
    app: { client: { chat: { postMessage: async () => ({}) } } },
  };
  self.postResolved = (SlackApp.prototype as any).postResolved;

  await (SlackApp.prototype as any).handleResolvedAlert.call(self, CHILD_LABELS, [
    { labels: CHILD_LABELS, annotations: {}, endsAt: new Date(NOW).toISOString() },
  ]);

  assert.equal(resolvedCalls.length, 1);
  assert.deepEqual(resolvedCalls[0], CHILD_LABELS);
});
