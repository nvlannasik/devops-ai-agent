import test from "node:test";
import assert from "node:assert/strict";
import { ThreadLock, REDIS_KEYS } from "./index.js";
import { fakeRedis } from "../inflight/fake-redis.test.js";

// One turn per Slack thread across replicas (2026-10-23). ThreadQueue serialises a thread inside
// one pod; with two pods, Socket Mode hands consecutive events to either, and two turns of one
// conversation ran at once — interleaving its memory and answering out of order.

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Leases far longer than the test's own waits: under a full parallel `npm test` the event loop can
// stall for tens of ms, and a 60ms lease then expired mid-turn and failed "B must not start" (the
// code was right; the margin was not). Only the tests ABOUT expiry use short leases, explicitly.
const fast = { pollMs: 5, leaseMs: 2_000, renewMs: 500, maxWaitMs: 5_000 };

test("a second pod waits for the first pod's turn on the same thread", async () => {
  const redis = fakeRedis();
  const a = new ThreadLock(() => redis, fast);
  const b = new ThreadLock(() => redis, fast);
  const releaseA = await a.acquire("T1");
  let bGot = false;
  const bTurn = b.acquire("T1").then((rel) => { bGot = true; return rel; });
  await tick(30);
  assert.equal(bGot, false, "B must not start while A holds the thread");
  await releaseA();
  await (await bTurn)();
  assert.equal(bGot, true);
});

test("other threads are not blocked", async () => {
  const redis = fakeRedis();
  const a = new ThreadLock(() => redis, fast);
  await a.acquire("T1");
  const rel = await new ThreadLock(() => redis, fast).acquire("T2");
  await rel();
});

test("the lease is renewed while the turn runs, so a long turn keeps the thread", async () => {
  const redis = fakeRedis();
  const a = new ThreadLock(() => redis, { ...fast, leaseMs: 300, renewMs: 50 });
  const release = await a.acquire("T1");
  await tick(900); // three leases' worth: only renewal keeps it
  assert.equal(await new ThreadLock(() => redis, fast).held("T1"), true);
  await release();
  assert.equal(await a.held("T1"), false);
});

test("a pod that dies without releasing frees the thread once its lease runs out", async () => {
  const redis = fakeRedis();
  await redis.set(`${REDIS_KEYS.threadlock.prefix}:T1`, "dead-pod", "PX", 40);
  const started = Date.now();
  await (await new ThreadLock(() => redis, fast).acquire("T1"))();
  assert.ok(Date.now() - started >= 30, "waited for the dead lease");
});

test("a release never deletes a lock another pod now holds", async () => {
  const redis = fakeRedis();
  const a = new ThreadLock(() => redis, { ...fast, leaseMs: 60, renewMs: 10_000 });
  const releaseA = await a.acquire("T1");
  await tick(120); // A's 60ms lease expired (no renewal in time)…
  const releaseB = await new ThreadLock(() => redis, fast).acquire("T1"); // …and B took the thread
  await releaseA(); // A's late release must not free B's turn
  assert.equal(await a.held("T1"), true);
  await releaseB();
});

test("no Redis, a Redis error, or waiting past maxWaitMs all let the turn run", async () => {
  await (await new ThreadLock(() => null, fast).acquire("T1"))();
  const broken = new Proxy({}, { get: () => async () => { throw new Error("ECONNREFUSED"); } }) as never;
  await (await new ThreadLock(() => broken, fast).acquire("T1"))();
  assert.equal(await new ThreadLock(() => broken, fast).held("T1"), false);
  const redis = fakeRedis();
  await redis.set(`${REDIS_KEYS.threadlock.prefix}:T1`, "stuck", "PX", 10_000);
  await (await new ThreadLock(() => redis, { ...fast, maxWaitMs: 30 }).acquire("T1"))();
});
