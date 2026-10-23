import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";
import { AlertFlow } from "./alerts.js";

const viaAlerts = (fake: object) => Object.assign(Object.create(AlertFlow.prototype), fake, { host: fake });
import { resetServiceGraphCache } from "../agent/correlation/topology.js";
import { config } from "../config/index.js";
import { InFlightRegistry } from "../agent/inflight/index.js";
import { fakeRedis } from "../agent/inflight/fake-redis.test.js";

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
  const investigateCalls: Array<{ threadId: string; question: string; opts: any }> = [];
  const warnIfUngroundedCalls: Array<{ channel: string; threadId: string; answer: string; trigger: string }> = [];
  const semaphoreCalls = { acquire: 0, release: 0 };
  const inFlightTracked: any[] = [];
  let pending: Promise<unknown> | null = null;
  const self: any = {
    unstored: new Map(),
    inflight: new InFlightRegistry(() => null),
    agent: {
      callTool: opts.callTool ?? (async () => VECTOR),
      openRelatable: opts.openRelatable ?? (async () => []),
      storeIncident: async (...a: any[]) => {
        stored.push(a);
        return 9;
      },
      investigate: async (threadId: string, question: string, invOpts: any) => {
        investigateCalls.push({ threadId, question, opts: invOpts });
        return opts.investigate ? await opts.investigate() : "fits: orders-api latency is the cause";
      },
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
    // Finding 1 (final review): correlate()'s follow-up now takes the same semaphore and
    // inFlight tracking every other investigation goes through.
    semaphore: {
      acquire: async () => { semaphoreCalls.acquire++; },
      release: () => { semaphoreCalls.release++; },
    },
    inFlight: {
      track: (meta: any, p: Promise<unknown>) => { inFlightTracked.push(meta); return p; },
    },
  };
  // correlate()'s follow-up calls this.conversationReply(...) and this.warnIfUngrounded(...) —
  // not an instance, so wire the real one in and spy on the other.
  self.conversationReply = (SlackApp.prototype as any).conversationReply;
  self.warnIfUngrounded = async (channel: string, threadId: string, answer: string, trigger = "") => {
    warnIfUngroundedCalls.push({ channel, threadId, answer, trigger });
  };
  const correlate = (channel: string, groupLabels: Record<string, string>, firing: any[], issueText: string, alertSeverity: string | null) =>
    AlertFlow.prototype.correlate.call(viaAlerts(self), channel, groupLabels, firing, issueText, alertSeverity);
  return {
    self,
    posted,
    stored,
    threadQueueCalls,
    investigateCalls,
    warnIfUngroundedCalls,
    semaphoreCalls,
    inFlightTracked,
    correlate,
    waitFollowUp: () => pending,
  };
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
  // Finding 4 (final review): the child's alertStartedAt is the GROUP's own start (its
  // firing alert's startsAt), not when the parent incident started.
  assert.deepEqual(storeOpts, { subjects: ["checkout-gateway"], child: true, alertStartedAt: new Date(NOW) });

  assert.deepEqual(h.threadQueueCalls, ["100.1"]);
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].thread_ts, "100.1");
  assert.ok(h.posted.every((p) => !!p.thread_ts), "no post lacks thread_ts");

  // Finding 1 (final review): the follow-up is capped at config.mentionToolRounds (not an
  // unbounded investigation — the question's "root cause" wording would otherwise trip
  // INVESTIGATE_RE via mentionBudget), and takes the same semaphore + inFlight tracking every
  // other investigation goes through.
  assert.equal(h.investigateCalls.length, 1);
  assert.equal(h.investigateCalls[0]!.opts.maxToolRounds, config.mentionToolRounds);
  assert.equal(h.investigateCalls[0]!.opts.mode, "conversation");
  assert.deepEqual(h.inFlightTracked, [{ channel: "C1", threadTs: "100.1", kind: "mention" }]);
  assert.deepEqual(h.semaphoreCalls, { acquire: 1, release: 1 });

  // Finding 2 (final review): the follow-up question carries the group's own alert text as
  // data, and finding 1(d)'s grounding check sees the same text as its trigger.
  assert.match(h.investigateCalls[0]!.question, /issue text body/);
  assert.equal(h.warnIfUngroundedCalls.length, 1);
  assert.equal(h.warnIfUngroundedCalls[0]!.channel, "C1");
  assert.equal(h.warnIfUngroundedCalls[0]!.threadId, "100.1");
  assert.match(h.warnIfUngroundedCalls[0]!.trigger, /issue text body/);
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

// Finding 5 (final review): a re-sent group with changed labels (e.g. a new pod name after a
// restart) can still match the SAME incident it already opened — same alertname, same
// namespace, same subject, inside the window. Merging it into itself would store a child whose
// resolve closes the child row and leaves the parent open forever (the webhook's resolve
// carries only the group's own labels — see "a resolve of the merged child group" below).
test("the same alertname re-matching its own open incident takes the normal path, not a self-merge", async () => {
  resetServiceGraphCache();
  const h = harness();
  // Same alertname as the incoming group, same subject as the firing alert's service label —
  // relatedIncident would otherwise match this via same-service.
  h.self.unstored.set("100.1", { ...PARENT, alertname: "SampleAppHighErrorRate", subjects: ["checkout-gateway"] });

  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue text body", "warning");

  assert.equal(result, false);
  assert.equal(h.posted.length, 0, "no self-merge post");
  assert.equal(h.stored.length, 0, "no self-merge child row");
});

// Finding 6(a) (final review): a candidate from Postgres (openRelatable), not the in-flight
// map, must merge exactly the same way — the in-flight map being empty (e.g. a fresh replica,
// or the parent's investigation already finished and stored) must not be the only path in.
test("a STORED candidate (no in-flight entry) is still merged into", async () => {
  resetServiceGraphCache();
  const storedCandidate = {
    threadTs: "200.1",
    channel: "C9",
    alertname: "SampleAppHighLatency",
    namespace: "sample-apps",
    subjects: ["orders-api"],
    startedAt: PARENT_STARTED_AT,
    resolved: false,
  };
  const h = harness({ openRelatable: async () => [storedCandidate] });
  // h.self.unstored is left empty — the in-flight map has nothing in it.

  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue text body", "warning");
  await h.waitFollowUp();

  assert.equal(result, true);
  assert.equal(h.posted[0].thread_ts, "200.1");
  assert.equal(h.posted[0].channel, "C9");
  assert.equal(h.stored.length, 1);
});

// Finding 6(b) (final review): handleAlert must never reach the top-level post once correlate()
// has already handled the alert — the new thread's "firing" + "Auto-investigating" messages
// have no thread_ts (they open a fresh thread), so any post reaching Slack on this path would be
// exactly that pair, landing twice.
test("handleAlert returns before the top-level post when correlate() has already merged the alert", async () => {
  const previousChannel = config.slack.alertChannel;
  config.slack.alertChannel = "C-TEST-ALERT-CHANNEL"; // handleAlert reads the module-level config directly
  try {
    const posted: any[] = [];
    let correlateCalled = false;
    const self: any = {
      dedup: { shouldProcess: async () => true },
      correlate: async () => { correlateCalled = true; return true; },
      app: { client: { chat: { postMessage: async (m: any) => { posted.push(m); return {}; } } } },
    };
    const payload = {
      commonAnnotations: {},
      alerts: [
        {
          status: "firing",
          labels: { alertname: "SampleAppHighErrorRate", namespace: "sample-apps", service: "checkout-gateway" },
          annotations: {},
          startsAt: new Date(NOW).toISOString(),
        },
      ],
    };

    await AlertFlow.prototype.handleAlert.call(viaAlerts(self), payload);

    assert.equal(correlateCalled, true, "correlate() should have been reached and asked to decide");
    assert.equal(posted.length, 0, "no message is posted once correlate() has already handled the alert");
  } finally {
    config.slack.alertChannel = previousChannel;
  }
});

// Review Focus 4: a resolve of the CHILD group (the merged alert's own alertname+namespace,
// not the parent incident's) still resolves against its own labels — handleResolvedAlert is
// unmodified by correlation, it only ever reads the labels it's given.
test("a resolve of the merged child group still resolves by its own labels", async () => {
  const CHILD_LABELS = { alertname: "SampleAppHighErrorRate", namespace: "sample-apps" };
  const resolvedCalls: any[] = [];
  const self: any = {
    unstored: new Map(),
    inflight: new InFlightRegistry(() => null),
    dedup: { clear: async () => {} },
    agent: {
      resolveIncident: async (labels: any) => {
        resolvedCalls.push(labels);
        return { channel: "C1", threadTs: "100.1" };
      },
    },
    app: { client: { chat: { postMessage: async () => ({}) } } },
  };
  self.postResolved = (AlertFlow.prototype as any).postResolved;

  await AlertFlow.prototype.handleResolvedAlert.call(viaAlerts(self), CHILD_LABELS, [
    { labels: CHILD_LABELS, annotations: {}, endsAt: new Date(NOW).toISOString() },
  ]);

  assert.equal(resolvedCalls.length, 1);
  assert.deepEqual(resolvedCalls[0], CHILD_LABELS);
});

// 2026-10-22: the parent's investigation runs on ANOTHER replica — not in this pod's `unstored`,
// not yet a stored row. Its Redis mirror is what lets the related alert find it.
test("a related alert merges into an investigation still running on another replica", async () => {
  resetServiceGraphCache();
  const redis = fakeRedis();
  await new InFlightRegistry(() => redis).publish("100.1", { ...PARENT });
  const h = harness();
  h.self.inflight = new InFlightRegistry(() => redis);
  const result = await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "issue text body", "warning");
  await h.waitFollowUp();
  assert.equal(result, true);
  assert.equal(h.posted[0].thread_ts, "100.1");
  assert.equal(h.posted[0].channel, "C1");
});

test("another replica's entry in another namespace is not a candidate", async () => {
  resetServiceGraphCache();
  const redis = fakeRedis();
  await new InFlightRegistry(() => redis).publish("100.1", { ...PARENT, namespace: "other" });
  const h = harness();
  h.self.inflight = new InFlightRegistry(() => redis);
  assert.equal(await h.correlate("C2", { namespace: "sample-apps", alertname: "SampleAppHighErrorRate" }, firingAlert(), "t", "warning"), false);
});

