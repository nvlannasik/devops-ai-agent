import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForThread, evidenceTexts, resolveSkillNames, MAX_TRACKED_THREADS, MAX_THREAD_SKILLS, type ThreadSkills } from "./index.js";
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

// The production failure this exists for: KubernetesPodNotHealthy fires for an OOMKill, a
// failed probe and an unpullable image alike, so the alert text selects no playbook at all and
// the investigation runs on the output format alone. The events name the failure — that is
// where the playbook has to come from.
test("a generic alert name selects no playbook, and the tool evidence supplies it", () => {
  const tracked: ThreadSkills = new Map();
  const alert =
    "🚨 KubernetesPodNotHealthy\n*Severity:* `critical`\n*Summary:* Pod has been in a non-ready state for longer than 15 minutes\n*Namespace:* `sarang-tani`";
  const fromAlert = selectForThread(registry, tracked, "T1", alert).map((s) => s.name);
  assert.deepEqual(fromAlert, ["rca-format"], "the alert text should match no failure-mode playbook");

  const events =
    'Warning  Failed  kubelet  Failed to pull image "ghcr.io/acme/web:v9": manifest unknown\n' +
    "Warning  Failed  kubelet  Error: ImagePullBackOff";
  const afterEvidence = selectForThread(registry, tracked, "T1", events).map((s) => s.name);
  assert.ok(afterEvidence.includes("imagepullbackoff"), afterEvidence.join(", "));
  assert.ok(afterEvidence.includes("gitops-drift"), afterEvidence.join(", "));
  assert.ok(afterEvidence.includes("rca-format"), "the always-on skill was lost");
});

// Selection now runs on every tool round, so without a ceiling a long investigation ends up
// carrying the whole directory.
test("the per-thread skill set is capped, earliest wins", () => {
  const tracked: ThreadSkills = new Map();
  const first = selectForThread(registry, tracked, "T1", "OOMKilled").map((s) => s.name);
  for (const t of ["ImagePullBackOff", "PersistentVolumeClaim is Pending", "503 service unavailable", "p99 latency", "rollout not progressing"]) {
    selectForThread(registry, tracked, "T1", t);
  }
  const final = tracked.get("T1")!.map((s) => s.name);
  assert.equal(final.length, MAX_THREAD_SKILLS);
  assert.deepEqual(final.slice(0, first.length), first, "the alert's own playbooks were evicted by later ones");
});

test("evidenceTexts reads tool results and skips everything else", () => {
  const blocks = [
    { type: "tool_result" as const, tool_use_id: "1", content: "Error: ImagePullBackOff" },
    { type: "tool_result" as const, tool_use_id: "2", content: "   " }, // whitespace only
    { type: "text" as const, text: "tool budget exhausted" },
    { type: "tool_use" as const, id: "3", name: "k8s_list_pods", input: {} },
  ];
  assert.deepEqual(evidenceTexts(blocks), ["Error: ImagePullBackOff", "tool budget exhausted"]);
});

// ---- Rehydrating a thread's playbooks after a restart ----
//
// threadSkills is an in-process Map while the conversation is in Redis, so a rollout used to
// leave a live thread with its history and none of its playbooks. Names are stored; they are
// resolved back against the LIVE registry, because prompts/skills/ is editable between two
// turns of the same thread and a thread must never re-inject a skill the directory has lost.
test("stored playbook names resolve back to skills, in stored order", () => {
  const resolved = resolveSkillNames(registry, ["rca-format", "oomkilled"]);
  assert.deepEqual(resolved.map((s) => s.name), ["rca-format", "oomkilled"]);
  assert.ok(resolved.every((s) => s.body.length > 0), "bodies come from the registry, never from storage");
});

test("a name the registry no longer has is dropped, not carried as a dangling entry", () => {
  assert.deepEqual(
    resolveSkillNames(registry, ["rca-format", "playbook-deleted-last-week"]).map((s) => s.name),
    ["rca-format"]
  );
  assert.deepEqual(resolveSkillNames(registry, ["playbook-deleted-last-week"]), []);
  assert.deepEqual(resolveSkillNames(registry, []), []);
});

// What a restarted pod does: rehydrate the stored set, then keep accumulating on top of it
// instead of starting the thread's playbooks over from the new message alone.
test("a rehydrated thread keeps its playbooks and still adds new ones", () => {
  const tracked: ThreadSkills = new Map();
  tracked.set("T-restart", resolveSkillNames(registry, ["rca-format", "high-latency"]));

  const after = selectForThread(registry, tracked, "T-restart", "now the pod is OOMKilled too");
  const names = after.map((s) => s.name);
  assert.ok(names.includes("high-latency"), "the pre-restart playbook was lost");
  assert.ok(names.includes("oomkilled"), "the new symptom's playbook was not added");
  assert.equal(names.filter((n) => n === "rca-format").length, 1, "a rehydrated skill was added twice");
});
