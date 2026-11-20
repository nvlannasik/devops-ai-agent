import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { caseNameOf, existingThreads, rank, type Candidate } from "./candidates.js";

const c = (o: Partial<Candidate>): Candidate => ({
  incidentId: 1, threadTs: "1.1", alertname: "KubePodCrashLooping", namespace: "apps", createdAt: "2026-11-20T00:00:00.000Z",
  confirmed: false, rejected: false, notFixed: false, gates: [], ...o,
});

test("a human answer key ranks first; equals are newest first; no signal is left out unless --all", () => {
  const r = rank(
    [
      c({ incidentId: 1, threadTs: "1", gates: ["deadline"] }),
      c({ incidentId: 2, threadTs: "2", confirmed: true }),
      c({ incidentId: 3, threadTs: "3" }),
      c({ incidentId: 4, threadTs: "4", gates: ["unsafe-advice"], createdAt: "2026-11-21T00:00:00.000Z" }),
    ],
    new Set()
  );
  assert.deepEqual(r.map((x) => x.incidentId), [2, 4, 1]);
  assert.deepEqual(r[0]!.why, ["confirmed"]);
  assert.equal(rank([c({ threadTs: "3" })], new Set(), true).length, 1);
});

test("a thread already exported is not offered again", () => {
  assert.equal(rank([c({ threadTs: "9.9", confirmed: true })], new Set(["9.9"])).length, 0);
});

test("the case name is one export accepts", () => {
  const n = caseNameOf(c({ alertname: "KubernetesNodeMemoryPressure" }), "confirmed");
  assert.equal(n, "alert-kubernetes-node-memory-pressure-confirmed");
  assert.match(caseNameOf(c({ alertname: "X".repeat(90) }), "rejected"), /^[a-z0-9][a-z0-9-]{0,60}$/);
});

test("existing threads are read from the shipped cases", () => {
  const t = existingThreads(join(process.cwd(), "replay", "cases"));
  assert.ok(t.has("1790880602.248989"));
  assert.equal(existingThreads("/nonexistent").size, 0);
});
