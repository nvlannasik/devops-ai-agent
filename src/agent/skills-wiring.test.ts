import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForThread, MAX_TRACKED_THREADS, type ThreadSkills } from "./index.js";
import { loadSkills, resolveSkillsDir } from "./skills/index.js";

const registry = loadSkills(resolveSkillsDir());

test("a thread accumulates skills and never re-adds one", () => {
  const tracked: ThreadSkills = new Map();
  const first = selectForThread(registry, tracked, "T1", "pod api-7f is OOMKilled");
  assert.ok(first.map((s) => s.name).includes("oomkilled"));
  assert.ok(first.map((s) => s.name).includes("rca-format"));

  const second = selectForThread(registry, tracked, "T1", "still OOMKilled, and now CrashLoopBackOff");
  const names = second.map((s) => s.name);
  assert.equal(names.filter((n) => n === "oomkilled").length, 1, "a skill was added twice");
  assert.ok(names.includes("crashloopbackoff"), "a follow-up symptom did not add its playbook");
});

test("threads are tracked independently", () => {
  const tracked: ThreadSkills = new Map();
  selectForThread(registry, tracked, "T1", "OOMKilled");
  const other = selectForThread(registry, tracked, "T2", "PersistentVolumeClaim is Pending");
  assert.ok(other.map((s) => s.name).includes("pvc-pending"));
  assert.ok(!other.map((s) => s.name).includes("oomkilled"));
});

// A Map keyed by threadId grows for the lifetime of the pod otherwise.
test("the thread map is bounded and evicts the oldest", () => {
  const tracked: ThreadSkills = new Map();
  for (let i = 0; i < MAX_TRACKED_THREADS + 5; i++) selectForThread(registry, tracked, `T${i}`, "OOMKilled");
  assert.equal(tracked.size, MAX_TRACKED_THREADS);
  assert.equal(tracked.has("T0"), false);
  assert.equal(tracked.has(`T${MAX_TRACKED_THREADS + 4}`), true);
});
