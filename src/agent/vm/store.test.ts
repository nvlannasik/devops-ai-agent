import { test } from "node:test";
import assert from "node:assert/strict";
import { VmStore } from "./store.js";
import { parseVmTokens } from "../../config/index.js";

// A fake pg pool: records every query, answers from a queue.
const fakePool = (answers: Array<{ rows: unknown[] }> = []) => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  return { seen, query: async (text: string, values: unknown[] = []) => (seen.push({ text, values }), answers.shift() ?? { rows: [] }) };
};

test("claim expires stale actions, then takes one pending action of THIS host atomically", async () => {
  const pool = fakePool([{ rows: [] }, { rows: [{ id: 7, unit: "nginx.service", action: "restart" }] }]);
  const got = await new VmStore(pool as never).claim("vm-a");
  assert.deepEqual(got, { id: 7, unit: "nginx.service", action: "restart" });
  assert.match(pool.seen[0]!.text, /status = 'expired'[\s\S]*host = \$1[\s\S]*15 minutes/);
  assert.match(pool.seen[1]!.text, /UPDATE vm_actions[\s\S]*status = 'claimed'[\s\S]*host = \$1[\s\S]*status = 'pending'[\s\S]*15 minutes[\s\S]*RETURNING/);
  assert.deepEqual(pool.seen[1]!.values, ["vm-a"]);
});

test("finish is scoped to the caller's host and a claimed action", async () => {
  const pool = fakePool([{ rows: [{ remediation_id: 12 }] }]);
  assert.deepEqual(await new VmStore(pool as never).finish(7, "vm-a", "succeeded", { exitCode: 0 }), { remediationId: 12 });
  assert.match(pool.seen[0]!.text, /WHERE id = \$1 AND host = \$2 AND status = 'claimed'/);
});

test("registered means a heartbeat within 5 minutes; no pool means nothing", async () => {
  const pool = fakePool([{ rows: [{ units: ["nginx.service"] }] }]);
  assert.deepEqual(await new VmStore(pool as never).registered("vm-a"), { units: ["nginx.service"] });
  assert.match(pool.seen[0]!.text, /5 minutes/);
  assert.equal(await new VmStore(null).registered("vm-a"), null);
  assert.equal(await new VmStore(null).claim("vm-a"), null);
});

test("heartbeat stores the snapshot and the place; one without a snapshot keeps the last", async () => {
  const pool = fakePool();
  await new VmStore(pool as never).heartbeat("stg.worker1", [], "4", { memory: { totalBytes: 1 } }, { cluster: "stg", node: "worker1" });
  await new VmStore(pool as never).heartbeat("vm-a", [], "2");
  assert.match(pool.seen[0]!.text, /COALESCE\(EXCLUDED\.snapshot, vm_hosts\.snapshot\)[\s\S]*cluster = EXCLUDED\.cluster, node = EXCLUDED\.node/);
  assert.deepEqual(pool.seen[0]!.values, ["stg.worker1", [], "4", '{"memory":{"totalBytes":1}}', "stg", "worker1"]);
  assert.deepEqual(pool.seen.at(-1)!.values, ["vm-a", [], "2", null, null, null]);
});

test("a heartbeat with a snapshot writes a history point at most every 5 minutes and prunes past 7 days; one without writes none", async () => {
  const pool = fakePool([{ rows: [] }, { rows: [], rowCount: 1 } as never, { rows: [] }]);
  await new VmStore(pool as never).heartbeat("master3-vm", [], "3", { memory: { totalBytes: 10, availableBytes: 4 }, load: [1.5] });
  assert.equal(pool.seen.length, 3);
  assert.match(pool.seen[1]!.text, /INSERT INTO vm_host_history[\s\S]*NOT EXISTS[\s\S]*host = \$1 AND at > now\(\) - interval '290 seconds'/);
  assert.deepEqual(pool.seen[1]!.values, ["master3-vm", '{"memTotal":10,"memAvailable":4,"load1":1.5}']);
  assert.match(pool.seen[2]!.text, /DELETE FROM vm_host_history WHERE host = \$1 AND at < now\(\) - interval '7 days'/);

  const skipped = fakePool([{ rows: [] }, { rows: [], rowCount: 0 } as never]);
  await new VmStore(skipped as never).heartbeat("master3-vm", [], "3", { load: [1] });
  assert.equal(skipped.seen.length, 2, "a point inside 5 minutes: no insert, no prune");

  const old = fakePool();
  await new VmStore(old as never).heartbeat("vm-a", [], "2");
  assert.equal(old.seen.length, 1, "no snapshot, no history");
});

test("a failed history write never fails the heartbeat", async () => {
  let n = 0;
  const pool = { query: async () => (n++ === 1 ? Promise.reject(new Error('relation "vm_host_history" does not exist')) : { rows: [] }) };
  await new VmStore(pool as never).heartbeat("master3-vm", [], "3", { load: [1] });
  assert.equal(n, 2);
});

test("history reads one host's points in the window, oldest first", async () => {
  const pool = fakePool([{ rows: [{ at: "2026-11-20T00:00:00.000Z", point: { load1: 1 } }] }]);
  assert.deepEqual(await new VmStore(pool as never).history("master3-vm", 24), [{ at: new Date("2026-11-20T00:00:00.000Z"), point: { load1: 1 } }]);
  assert.match(pool.seen[0]!.text, /FROM vm_host_history WHERE host = \$1 AND at > now\(\) - make_interval\(hours => \$2\) ORDER BY at/);
  assert.deepEqual(pool.seen[0]!.values, ["master3-vm", 24]);
  assert.deepEqual(await new VmStore(null).history("x", 1), []);
});

test("snapshotCandidates matches the node name, or the host name for a host without one", async () => {
  const pool = fakePool([{ rows: [{ name: "stg.worker1", cluster: "stg", node: "worker1", snapshot: { load: [1] }, version: "4", age: 42 }] }]);
  const store = new VmStore(pool as never);
  assert.deepEqual(await store.snapshotCandidates("worker1"), [{ name: "stg.worker1", cluster: "stg", node: "worker1", snapshot: { load: [1] }, ageSeconds: 42, version: "4" }]);
  assert.match(pool.seen[0]!.text, /COALESCE\(node, name\) = \$1 OR name = \$1/);
  assert.deepEqual(await new VmStore(null).snapshotCandidates("x"), []);
});

test("parseVmTokens: name=token pairs; unset is none; malformed fails boot", () => {
  assert.equal(parseVmTokens(undefined).size, 0);
  assert.deepEqual([...parseVmTokens("vm-web-01=abc123,vm-db-01=def456")], [["vm-web-01", "abc123"], ["vm-db-01", "def456"]]);
  assert.throws(() => parseVmTokens("vm-web-01"), /name=token/);
  assert.throws(() => parseVmTokens("VM=x"), /bad VM name/);
  assert.throws(() => parseVmTokens("a=x,a=y"), /duplicate/);
});

test("host silence: setting silent_since is the claim; recovery clears it and hands back where it was announced", async () => {
  const pool = fakePool([
    { rows: [{ name: "master2-vm", node: null, cluster: null, last_seen: "2026-11-20T21:29:37.940Z", snapshot: { load: [1] } }] },
    { rows: [] },
    { rows: [{ name: "master2-vm", node: null, cluster: null, silent_since: "2026-11-20T21:29:37.940Z", silent_channel: "C1", silent_ts: "170.1" }] },
    { rows: [] },
  ]);
  const store = new VmStore(pool as never);
  assert.deepEqual(await store.claimSilent(5), [{ name: "master2-vm", node: null, cluster: null, lastSeen: new Date("2026-11-20T21:29:37.940Z"), snapshot: { load: [1] } }]);
  assert.match(pool.seen[0]!.text, /SET silent_since = last_seen[\s\S]*WHERE silent_since IS NULL AND last_seen < now\(\) - make_interval\(mins => \$1\)/);
  await store.silenceAnnounced(["master2-vm"], "C1", "170.1");
  assert.deepEqual(pool.seen[1]!.values, [["master2-vm"], "C1", "170.1"]);
  assert.deepEqual(await store.claimRecovered(), [{ name: "master2-vm", node: null, cluster: null, silentSince: new Date("2026-11-20T21:29:37.940Z"), channel: "C1", ts: "170.1" }]);
  assert.match(pool.seen[2]!.text, /silent_since IS NOT NULL AND last_seen > silent_since FOR UPDATE SKIP LOCKED[\s\S]*SET silent_since = NULL/);
  await store.unclaimSilent(["master2-vm"]);
  assert.match(pool.seen[3]!.text, /SET silent_since = NULL WHERE name = ANY\(\$1\) AND silent_ts IS NULL/);
  assert.deepEqual(await new VmStore(null).claimSilent(5), []);
  assert.deepEqual(await new VmStore(null).claimRecovered(), []);
});
