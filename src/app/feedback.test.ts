import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedbackFlow, RCA_CONFIRM, RCA_CORRECT, answeredBlocks, resolvedBlocks } from "./feedback.js";

test("the resolve message offers the buttons only with an incident id and a stored root cause", () => {
  assert.equal(resolvedBlocks("t", undefined, true), undefined);
  assert.equal(resolvedBlocks("t", 7, false), undefined);
  const b = resolvedBlocks("✅ *Alert resolved*", 7, true) as any[];
  assert.equal(b[0].text.text, "✅ *Alert resolved*");
  assert.deepEqual(b[1].elements.map((e: any) => [e.action_id, e.value]), [[RCA_CONFIRM, "7"], [RCA_CORRECT, "7"]]);
});

test("after a click the buttons are gone and the line names who answered", () => {
  const b = answeredBlocks("text", "confirmed", "U1") as any[];
  assert.equal(b.length, 2);
  assert.ok(!b.some((x) => x.type === "actions"));
  assert.match(b[1].elements[0].text, /<@U1> confirmed/);
});

function harness(opts: { allowed?: boolean; rootCause?: string | null; store?: "stored" | "duplicate" | "failed" } = {}) {
  const calls: Record<string, any[]> = { store: [], post: [], ephemeral: [], update: [] };
  const host: any = {
    mayUseAgent: () => opts.allowed ?? true,
    agent: {
      rootCauseOf: async () => (opts.rootCause === undefined ? { alertname: "A", rootCause: "pool exhausted" } : { alertname: "A", rootCause: opts.rootCause }),
      storeFeedback: async (id: number, fb: any) => {
        calls.store.push([id, fb]);
        return opts.store ?? "stored";
      },
    },
  };
  const client: any = {
    chat: {
      postMessage: async (m: any) => calls.post.push(m),
      postEphemeral: async (m: any) => calls.ephemeral.push(m),
      update: async (m: any) => calls.update.push(m),
    },
  };
  const body = { user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9", thread_ts: "1.1", text: "resolved" } };
  return { flow: new FeedbackFlow(host), client, body, calls };
}

test("confirm stores the incident's own root cause as human feedback, keyed once per incident, and updates the message", async () => {
  const h = harness();
  await h.flow.handle("confirmed", h.body, "42", h.client);
  assert.equal(h.calls.store.length, 1);
  const [id, fb] = h.calls.store[0]!;
  assert.equal(id, 42);
  assert.equal(fb.confirmed_root_cause, "pool exhausted");
  assert.equal(fb.slackUser, "U1");
  assert.equal(fb.triggerKey, "button:rca-confirm");
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.update[0].ts, "9.9");
});

test("a person without standing stores nothing", async () => {
  const h = harness({ allowed: false });
  await h.flow.handle("confirmed", h.body, "42", h.client);
  assert.equal(h.calls.store.length, 0);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.calls.ephemeral.length, 1);
});

test("no stored root cause, or a failed store, leaves the buttons in place", async () => {
  for (const o of [{ rootCause: null }, { store: "failed" as const }]) {
    const h = harness(o);
    await h.flow.handle("confirmed", h.body, "42", h.client);
    assert.equal(h.calls.update.length, 0);
    assert.equal(h.calls.ephemeral.length, 1);
  }
});

test("'something else' stores nothing and asks for the real cause in the thread", async () => {
  const h = harness();
  await h.flow.handle("corrected", h.body, "42", h.client);
  assert.equal(h.calls.store.length, 0);
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.post[0].thread_ts, "1.1");
  assert.match(h.calls.post[0].text, /learn/);
  assert.equal(h.calls.update.length, 1);
});

test("a malformed value does nothing", async () => {
  const h = harness();
  await h.flow.handle("confirmed", h.body, "abc", h.client);
  assert.equal(h.calls.store.length + h.calls.update.length + h.calls.ephemeral.length, 0);
});

test("postResolved drafts a postmortem only for an assessed severity on the list", async () => {
  const { AlertFlow } = await import("./alerts.js");
  const auto: any[] = [];
  const self: any = {
    host: {
      app: { client: { chat: { postMessage: async () => ({}) } } },
      autoPostmortem: async (...a: any[]) => void auto.push(a),
    },
  };
  const post = (AlertFlow.prototype as any).postResolved;
  await post.call(self, { channel: "C", threadTs: "1.1", id: 3, assessedSeverity: "Critical", hasRootCause: true }, { alertname: "A" }, []);
  await post.call(self, { channel: "C", threadTs: "1.1", id: 4, assessedSeverity: "high", hasRootCause: true }, { alertname: "A" }, []);
  await post.call(self, { channel: "C", threadTs: "1.1", assessedSeverity: "critical" }, { alertname: "A" }, []);
  assert.deepEqual(auto, [["C", "1.1", 3, "critical"]]);
});
