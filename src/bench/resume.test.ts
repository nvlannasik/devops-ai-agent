import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeFrom, inTaskOrder } from "./resume.js";

const ok = { pass: true, reasons: [] };
const bad = { pass: false, reasons: ["x"] };

test("resume keeps the cases the partial finished with every attempt, and their transcript; a case cut short runs again", () => {
  const partial = {
    runs: [
      { task: "A01-a", attempts: [ok, ok, ok, ok, ok] },
      { task: "A14-b", attempts: [bad, ok, ok, ok, bad] },
      { task: "C12-c", attempts: [ok, ok] },
    ],
    detail: [
      { task: "A01-a", attempt: 1 },
      { task: "A14-b", attempt: 5 },
      { task: "C12-c", attempt: 2 },
      { task: "C13-d", attempt: 1 },
    ],
  };
  const r = resumeFrom(partial, 5);
  assert.deepEqual(r.runs.map((x) => x.task), ["A01-a", "A14-b"]);
  assert.deepEqual(r.detail.map((d) => d.task), ["A01-a", "A14-b"]);
  assert.deepEqual(resumeFrom(partial, 3).runs, [], "another --attempts: nothing is comparable, nothing kept");
  assert.deepEqual(resumeFrom({}, 5), { runs: [], detail: [] });
});

test("inTaskOrder puts runs back in the suite's order", () => {
  const runs = [{ task: "C13-d", attempts: [] }, { task: "A01-a", attempts: [] }];
  assert.deepEqual(inTaskOrder(runs, ["A01-a", "C13-d"]).map((r) => r.task), ["A01-a", "C13-d"]);
});
