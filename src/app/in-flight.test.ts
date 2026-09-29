import { test } from "node:test";
import assert from "node:assert/strict";
import { InFlightWork, SlackApp } from "./index.js";

// Live, 2026-09-29 07:00:44: a rollout sent SIGTERM while "unused resources for mongodb" was
// running; the process closed MCP and exited, and the user heard nothing until they typed "try
// again" 13 minutes later. Shutdown now waits for tracked work, and reports what never finished.

const never = () => new Promise<void>(() => {});
const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("nothing in flight drains at once", async () => {
  const w = new InFlightWork<string>();
  const t0 = Date.now();
  assert.deepEqual(await w.drain(5_000), []);
  assert.ok(Date.now() - t0 < 100);
});

test("work that finishes inside the budget is not reported; work still running is", async () => {
  const w = new InFlightWork<string>();
  void w.track("fast", after(10));
  void w.track("stuck", never());
  assert.deepEqual(await w.drain(80), ["stuck"]);
});

test("a turn that failed is finished, not in flight", async () => {
  const w = new InFlightWork<string>();
  w.track("failed", Promise.reject(new Error("boom"))).catch(() => {});
  assert.deepEqual(await w.drain(50), []);
});

test("drain returns as soon as everything settles, not at the end of the budget", async () => {
  const w = new InFlightWork<string>();
  void w.track("a", after(20));
  void w.track("b", after(30));
  const t0 = Date.now();
  assert.deepEqual(await w.drain(5_000), []);
  assert.ok(Date.now() - t0 < 1_000, `waited ${Date.now() - t0}ms`);
});

test("track hands the caller its own promise back", async () => {
  const w = new InFlightWork<string>();
  assert.equal(await w.track("x", Promise.resolve(42)), 42);
});

// The half that talks to Slack, driven through the prototype with a stub client — the class
// itself connects to Slack in its constructor.
const drainWith = async (track: (w: InFlightWork<any>) => void) => {
  const posted: Array<{ channel: string; thread_ts: string; text: string }> = [];
  const inFlight = new InFlightWork<any>();
  track(inFlight);
  const self = { inFlight, app: { client: { chat: { postMessage: async (m: any) => void posted.push(m) } } } };
  await (SlackApp.prototype as any).drain.call(self, 50);
  return posted;
};

test("every thread left waiting is told, once, in words that fit what it was waiting for", async () => {
  const posted = await drainWith((w) => {
    void w.track({ channel: "C1", threadTs: "111.1", kind: "mention" }, never());
    void w.track({ channel: "C1", threadTs: "111.1", kind: "mention" }, never()); // queued behind it
    void w.track({ channel: "C1", threadTs: "222.2", kind: "alert" }, never());
  });
  assert.equal(posted.length, 2, "one notice per thread");
  assert.match(posted.find((m) => m.thread_ts === "111.1")!.text, /Mention me again/);
  assert.match(posted.find((m) => m.thread_ts === "222.2")!.text, /no RCA was posted/);
});

test("a shutdown with everything finished posts nothing", async () => {
  assert.deepEqual(await drainWith((w) => void w.track({ channel: "C1", threadTs: "1.1", kind: "alert" }, after(5))), []);
});
