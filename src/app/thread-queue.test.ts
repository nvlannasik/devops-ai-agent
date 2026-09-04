import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadQueue } from "./index.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("turns in one thread run in order, however slow the first is", async () => {
  const q = new ThreadQueue();
  const order: string[] = [];
  const a = q.run("T1", async () => { await tick(30); order.push("a"); });
  const b = q.run("T1", async () => { order.push("b"); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a", "b"], "b must not overtake a — that is the whole point");
});

test("different threads still run in parallel", async () => {
  const q = new ThreadQueue();
  const order: string[] = [];
  const slow = q.run("T1", async () => { await tick(30); order.push("slow"); });
  const fast = q.run("T2", async () => { order.push("fast"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["fast", "slow"], "a busy thread must not stall an unrelated one");
});

test("a failed turn releases the next one instead of wedging the thread", async () => {
  const q = new ThreadQueue();
  const boom = q.run("T1", async () => { throw new Error("boom"); });
  await assert.rejects(boom, /boom/, "the caller still sees its own failure");
  assert.equal(await q.run("T1", async () => "next ran"), "next ran");
});

test("the map does not grow one entry per thread forever", async () => {
  const q = new ThreadQueue();
  const size = () => (q as unknown as { tails: Map<string, unknown> }).tails.size;
  await q.run("T1", async () => {});
  await tick(0); // the cleanup is a .then on the settled tail
  assert.equal(size(), 0, "a settled tail must clear its entry");

  // ...but only the CURRENT tail clears it: a slow turn settling late must not unlink a
  // newer one, or the thread silently unserialises.
  const slow = q.run("T2", async () => { await tick(20); });
  const after = q.run("T2", async () => { await tick(40); }); // still running when we look
  await slow;
  await tick(0);
  assert.equal(size(), 1, "the newer turn's link must survive the older one settling");
  await after;
  await tick(0);
  assert.equal(size(), 0);
});
