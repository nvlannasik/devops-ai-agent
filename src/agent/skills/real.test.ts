import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, resolveSkillsDir, SKILL_MAX_CHARS } from "./index.js";
import { buildStaticSystemPrompt } from "../prompts/system.js";

// The shipped directory, not a fixture. loadSkills throws at boot on any malformation, so this
// test is what turns "the pod refuses to start" into "npm test fails" — the whole reason
// fail-fast is safe to choose.
test("every shipped skill file loads", () => {
  const skills = loadSkills(resolveSkillsDir()).all();
  assert.ok(skills.length >= 13, `expected at least 13 skills, got ${skills.length}`);
  for (const s of skills) {
    assert.ok(s.chars <= SKILL_MAX_CHARS, `${s.name} is ${s.chars} chars`);
    assert.ok(s.description.length > 0 && !s.description.includes("\n"), `${s.name} needs a one-line description`);
    assert.ok(s.body.length > 0, `${s.name} has an empty body`);
  }
});

test("exactly one skill is always-on, and it is the RCA format", () => {
  const always = loadSkills(resolveSkillsDir()).all().filter((s) => s.when === "always");
  assert.deepEqual(always.map((s) => s.name), ["rca-format"]);
});

// One representative alert per playbook. A trigger that selects nothing is a playbook that
// will never fire in production, which no amount of unit testing of the matcher would catch.
test("each playbook is reachable from a realistic alert line", () => {
  const r = loadSkills(resolveSkillsDir());
  const cases: [string, string][] = [
    ["crashloopbackoff", "KubePodCrashLooping: pod api-7f is restarting 12 times"],
    ["oomkilled", "container api exceeded its memory limit and was OOMKilled"],
    ["imagepullbackoff", "Failed to pull image: ImagePullBackOff"],
    ["high-error-rate", "HighErrorRate: 5xx rate is 12% for checkout"],
    ["high-latency", "HighLatency: p99 latency is 2.3s"],
    ["pod-not-ready", "Readiness probe failed: pod is not ready"],
    ["pod-pending", "Pod is Pending: 0/6 nodes available, insufficient cpu"],
    ["service-unavailable", "503 Service Unavailable from the ingress"],
    ["rollout-stuck", "KubeDeploymentReplicasMismatch: rollout has not progressed"],
    ["pvc-pending", "PersistentVolumeClaim data-0 is Pending"],
    ["forbidden", "Error: pods is forbidden — RBAC denied"],
    ["gitops-drift", "the running image does not match what the HelmRelease declares"],
  ];
  for (const [name, alert] of cases) {
    const { selected } = r.select(alert, new Set());
    assert.ok(selected.some((s) => s.name === name), `"${alert}" did not select ${name}`);
  }
});

// The content moved; it must not also stay. A section present in both places is sent twice and
// drifts the moment one copy is edited.
test("the moved sections are gone from the system prompt and live only in skills", () => {
  const prompt = buildStaticSystemPrompt();
  assert.doesNotMatch(prompt, /## Failure Mode Playbooks/);
  // NOT the heading: Step 3 deliberately leaves a `## RCA Output Format` pointer behind, so
  // asserting the heading is absent would make this task fail its own test. What must be gone is
  // the template — the worked example the skill now carries.
  assert.doesNotMatch(prompt, /\*📈 Confidence:\*/);
  assert.match(prompt, /arrive as a skill in the first user message/, "the pointer was deleted too");
  assert.doesNotMatch(prompt, /### CrashLoopBackOff/);

  const bodies = loadSkills(resolveSkillsDir()).all().map((s) => s.body).join("\n");
  assert.match(bodies, /Terminated: OOMKilled \(exit 137\)/);
  assert.match(bodies, /\*🔧 Recommended Actions\*/);
});

// The cookbook stays: a trigger built from alert text cannot know whether a PromQL query is
// coming, and a wrong guess removes the query patterns exactly when they are needed.
test("the tool usage reference stays in the core prompt", () => {
  assert.match(buildStaticSystemPrompt(), /## Tool Usage Reference/);
});
