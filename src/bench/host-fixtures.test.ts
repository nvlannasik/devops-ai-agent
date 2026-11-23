import { test } from "node:test";
import assert from "node:assert/strict";
import { withHostFixtures, fixturePoints, fixtureSnapshot } from "./host-fixtures.js";
import { HostFixture } from "./case.js";

const H = HostFixture.parse({ name: "bench-vm-01", totalMi: 4096, availableMi: [2400, 900], units: { "a.service": [100, 500] }, processes: [{ name: "a", unit: "a.service", rssMi: [90, 480] }] });

test("fixture points: every 5 min over the hours, ramping start → end; the snapshot is the last point", () => {
  const pts = fixturePoints(H, Date.parse("2026-11-24T00:00:00Z"));
  assert.equal(pts.length, 24 * 12 + 1);
  assert.equal(pts.at(-1)!.at.toISOString(), "2026-11-24T00:00:00.000Z");
  assert.equal(pts[0]!.point.units!["a.service"], 100 * 1048576);
  assert.equal(pts.at(-1)!.point.units!["a.service"], 500 * 1048576);
  assert.equal(pts.at(-1)!.point.procs!["a@a.service"], 480 * 1048576);
  assert.equal((fixtureSnapshot(H, 1).memory as Record<string, number>).availableBytes, 900 * 1048576);
});

test("the fixture store answers for its hosts and hands every other one to the base; it never registers a host", async () => {
  const s = withHostFixtures([H], { snapshotCandidates: async (n) => [{ name: n, cluster: "dev", node: n, snapshot: null, ageSeconds: 1, version: "3" }] });
  assert.equal((await s.snapshotCandidates("bench-vm-01"))[0]!.cluster, null);
  assert.equal((await s.snapshotCandidates("master3-vm"))[0]!.cluster, "dev");
  assert.equal((await s.history("bench-vm-01", 6)).length, 6 * 12);
  assert.deepEqual(await s.history("master3-vm", 6), []);
  assert.equal(await s.registered(), null);
  assert.equal((await s.hosts()).length, 1);
});
