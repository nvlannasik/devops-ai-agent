import test from "node:test";
import assert from "node:assert/strict";
import { InFlightRegistry, REDIS_KEYS } from "./index.js";
import { fakeRedis } from "./fake-redis.test.js";

// Cross-replica in-flight alerts (2026-10-22). The investigating pod keeps its own `unstored`
// map; this mirrors each entry to Redis so a DIFFERENT pod can correlate against it, and can
// hand it a resolve that arrived before the incident row was stored.

const ENTRY = { key: "A\u0000ns", channel: "C1", namespace: "ns", subjects: ["svc"], startedAt: 1, alertname: "A" };

test("a published entry is visible to another replica, and gone once removed", async () => {
  const redis = fakeRedis();
  const a = new InFlightRegistry(() => redis);
  const b = new InFlightRegistry(() => redis);
  await a.publish("111.1", ENTRY);
  assert.deepEqual(await b.remote(), new Map([["111.1", ENTRY]]));
  await a.remove("111.1");
  assert.deepEqual(await b.remote(), new Map());
});

test("entries expire: the TTL outlives the investigation budget", async () => {
  const redis = fakeRedis();
  await new InFlightRegistry(() => redis).publish("111.1", ENTRY);
  const ttl = redis.ttlOf(`${REDIS_KEYS.inflight.prefix}:111.1`);
  assert.ok(ttl !== undefined && ttl >= 600, `ttl ${ttl}s must outlive a 300s investigation`);
});

test("markResolved hands the resolve to the entry with the same alert key, and only that one", async () => {
  const redis = fakeRedis();
  const a = new InFlightRegistry(() => redis);
  await a.publish("111.1", ENTRY);
  await a.publish("222.2", { ...ENTRY, key: "B\u0000ns" });
  const b = new InFlightRegistry(() => redis);
  assert.equal(await b.markResolved("A\u0000ns", [{ endsAt: "x" }]), "111.1");
  assert.deepEqual(await a.resolvedFor("111.1"), [{ endsAt: "x" }]);
  assert.equal(await a.resolvedFor("222.2"), undefined);
  assert.equal(await b.markResolved("C\u0000ns", []), null, "nobody is investigating C");
});

test("without Redis every call is a no-op: the local map is the whole story, as before", async () => {
  const r = new InFlightRegistry(() => null);
  await r.publish("111.1", ENTRY);
  assert.deepEqual(await r.remote(), new Map());
  assert.equal(await r.markResolved("A\u0000ns", []), null);
  assert.equal(await r.resolvedFor("111.1"), undefined);
  await r.remove("111.1");
});

test("a failing Redis fails open: nothing throws, nothing is found", async () => {
  const broken = new Proxy({}, { get: () => async () => { throw new Error("ECONNREFUSED"); } }) as never;
  const r = new InFlightRegistry(() => broken);
  await r.publish("111.1", ENTRY);
  assert.deepEqual(await r.remote(), new Map());
  assert.equal(await r.markResolved("A\u0000ns", []), null);
  assert.equal(await r.resolvedFor("111.1"), undefined);
  await r.remove("111.1");
});

