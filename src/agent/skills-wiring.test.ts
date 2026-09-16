import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForThread, decayThreadSkills, evidenceTexts, resolveSkillNames, MAX_TRACKED_THREADS, MAX_THREAD_SKILLS, CARRIED_SKILLS, evidenceStamp, staleEvidenceNotice, type ThreadSkills } from "./index.js";
import { loadSkills, resolveSkillsDir } from "./skills/index.js";
import type { Message } from "./llm/types.js";

const registry = loadSkills(resolveSkillsDir());

// runInvestigation puts this at the head of the trigger; `rca-format` keys on it. Tests that
// assert the output format is loaded have to send it, the same as production does.
const ALERT = "[mode:alert]\n";

test("a thread accumulates skills and never re-adds one", () => {
  const tracked: ThreadSkills = new Map();
  const first = selectForThread(registry, tracked, "T1", `${ALERT}pod api-7f is OOMKilled`);
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
    `${ALERT}🚨 KubernetesPodNotHealthy\n*Severity:* \`critical\`\n*Summary:* Pod has been in a non-ready state for longer than 15 minutes\n*Namespace:* \`sarang-tani\``;
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

// ── Decay between turns ──────────────────────────────────────────────────────
// selectForThread only ever ADDS, so a thread that fills MAX_THREAD_SKILLS is frozen on whatever
// it happened to pick up and no later question can load its own playbook. Measured on thread
// 1789488072 (2026-09-15): turn 5 filled all five slots, and the seven turns after it — including
// "investigasi kenapa prometheus query nya kosong" — ran on that same set.
test("a new turn ages out all but the most recent playbooks", () => {
  const tracked: ThreadSkills = new Map();
  for (const t of ["OOMKilled", "ImagePullBackOff", "PersistentVolumeClaim is Pending", "p99 latency"]) {
    selectForThread(registry, tracked, "T1", `${ALERT}${t}`);
  }
  const before = tracked.get("T1")!.map((s) => s.name);
  assert.equal(before.length, MAX_THREAD_SKILLS, "the cap was not reached, so there is nothing to decay");

  const dropped = decayThreadSkills(tracked, "T1");
  const kept = tracked.get("T1")!.map((s) => s.name);
  assert.equal(kept.length, CARRIED_SKILLS);
  assert.deepEqual(kept, before.slice(-CARRIED_SKILLS), "the NEWEST playbooks are the ones that carry");
  assert.deepEqual(dropped, before.slice(0, -CARRIED_SKILLS));

  // and the freed slots are usable again — the whole point.
  const next = selectForThread(registry, tracked, "T1", `${ALERT}pod is stuck Terminating with a finalizer`);
  assert.ok(next.map((s) => s.name).includes("pod-terminating"), next.map((s) => s.name).join(", "));
});

test("decay is a no-op on a thread carrying no more than it may keep", () => {
  const tracked: ThreadSkills = new Map();
  selectForThread(registry, tracked, "T1", "[mode:conversation]\np99 latency is up");
  const before = tracked.get("T1")!.map((s) => s.name);
  assert.ok(before.length <= CARRIED_SKILLS, before.join(", "));
  assert.deepEqual(decayThreadSkills(tracked, "T1"), []);
  assert.deepEqual(tracked.get("T1")!.map((s) => s.name), before);
  assert.deepEqual(decayThreadSkills(new Map(), "never-seen"), []);
});

// rca-format IS droppable by decay, and that is correct rather than an oversight: the very next
// thing runInvestigation does is re-select against the mode tag, so an alert or an investigation
// gets it straight back, while a conversation turn — which is where it does damage — does not.
test("the output format comes back on the next alert turn after being aged out", () => {
  const tracked: ThreadSkills = new Map();
  for (const t of ["OOMKilled", "ImagePullBackOff", "PersistentVolumeClaim is Pending", "p99 latency"]) {
    selectForThread(registry, tracked, "T1", `${ALERT}${t}`);
  }
  assert.ok(decayThreadSkills(tracked, "T1").includes("rca-format"), "expected the fixture to age it out");
  const next = selectForThread(registry, tracked, "T1", `${ALERT}pod is not ready`).map((s) => s.name);
  assert.ok(next.includes("rca-format"), next.join(", "));

  const conv = new Map(tracked);
  decayThreadSkills(conv, "T1");
  const casual = selectForThread(registry, conv, "T1", "[mode:conversation]\nberapa pod yang jalan?").map((s) => s.name);
  assert.ok(!casual.includes("rca-format"), casual.join(", "));
});

// ── Evidence age ─────────────────────────────────────────────────────────────
// A tool_result carries no time of its own, so by turn 11 a 40-minute-old cluster scan is
// indistinguishable from one taken this second — and the model answers "saat ini" from it.
// Measured on thread 1789488072, 2026-09-15 16:44: "cluster resource saat ini gimana?" answered
// `59 pods in 14 namespaces` from a health scan run at 16:14, with zero tool calls that turn.
const MIN = 60_000;
const stamped = (at: number): Message[] => [
  { role: "user", content: "what is broken?" },
  { role: "assistant", content: [{ type: "tool_use", id: "1", name: "k8s_cluster_health", input: {} }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "1", content: "59 pods, 14 namespaces, all ready" },
      { type: "text", text: evidenceStamp(at) },
    ],
  },
];

test("a thread with no stamped evidence gets no staleness line", () => {
  assert.equal(staleEvidenceNotice([]), "");
  assert.equal(staleEvidenceNotice([{ role: "user", content: "hello" }]), "");
});

test("evidence read moments ago is not called stale", () => {
  const now = Date.now();
  assert.equal(staleEvidenceNotice(stamped(now), now), "");
  assert.equal(staleEvidenceNotice(stamped(now - MIN), now), "");
});

test("evidence from an earlier turn is named, with its age and its timestamp", () => {
  const now = Date.now();
  const at = now - 30 * MIN;
  const notice = staleEvidenceNotice(stamped(at), now);
  assert.match(notice, /read 30 minutes ago/);
  assert.ok(notice.includes(new Date(Math.floor(at / 1000) * 1000).toISOString()), notice);
  assert.match(notice, /AS IT WAS THEN/);
  assert.match(notice, /saat ini/, "the Indonesian present-tense phrasings are the ones that trip this");
});

// The age has to come from the FRESHEST stamp: "everything is at least this old" is the only
// claim that stays true, and a thread has one stamp per tool round.
test("the newest stamp wins when a thread has several", () => {
  const now = Date.now();
  const history = [...stamped(now - 50 * MIN), ...stamped(now - 10 * MIN)];
  assert.match(staleEvidenceNotice(history, now), /read 10 minutes ago/);
});

test("the stamp is bookkeeping, not evidence — no playbook may be selected from it", () => {
  assert.deepEqual(evidenceTexts([{ type: "text", text: evidenceStamp() }]), []);
});
