import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, resolveSkillsDir, SKILL_MAX_CHARS } from "./index.js";
import { buildStaticSystemPrompt } from "../prompts/system.js";
import { parseSeverity } from "../incidents/index.js";
import { parseConfidence } from "../confidence/index.js";

// The shipped directory, not a fixture. loadSkills throws at boot on any malformation, so this
// test is what turns "the pod refuses to start" into "npm test fails" — the whole reason
// fail-fast is safe to choose.
test("every shipped skill file loads", () => {
  const skills = loadSkills(resolveSkillsDir()).all();
  assert.ok(skills.length >= 14, `expected at least 14 skills, got ${skills.length}`);
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

// The template is the one prompt every RCA is generated against, and it is read literally:
// it says "Output EXACTLY this structure". It used to print `*🔴 Severity:* \`Critical\`` and
// `*📈 Confidence:* \`High\`` as finished values while every other field was a [bracketed]
// placeholder, so models copied them straight through — a `warning` alert was recorded, and
// recalled, as `critical`. parseSeverity/parseConfidence are the exact readers that ran on
// that output, so pointing them at the shipped template is the check: a template that still
// parses as a real level is a template a model can copy into a real incident row.
test("the RCA template offers no severity or confidence value that can be copied through", () => {
  const body = loadSkills(resolveSkillsDir()).all().find((s) => s.name === "rca-format")!.body;
  // Only the block the model is told to reproduce. The prose above it is free to name the
  // levels — it has to — and running the parsers over the whole file lets a match up there
  // mask the template line, which is the one thing this test exists to check.
  const marker = "Output EXACTLY this structure";
  const idx = body.indexOf(marker);
  assert.notEqual(idx, -1, "rca-format no longer says 'Output EXACTLY this structure'");
  const template = body.slice(idx);

  assert.equal(parseSeverity(template), null, "rca-format still names a literal severity level");
  assert.equal(parseConfidence(template), "unknown", "rca-format still names a literal confidence level");
  // and the labels the renderer keys on survive — buildRcaBlocks/isRcaResponse need both
  assert.match(template, /\*[^*]*Severity[^*]*\*/);
  assert.match(template, /\*[^*]*Confidence[^*]*\*/);
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
    // Verbatim from the Loki Ruler rules in gitops-devops-ai-manifest
    // (apps/base/systems/loki/rules.yaml), rendered the way buildGroupAlertText renders them.
    // Both alertnames are log vocabulary, not metric vocabulary: before log-alert existed they
    // matched NO playbook at all and arrived with only the always-on rca-format.
    ["log-alert", ":alert: *AppErrorLogSpike*\n*Summary:* Error log spike in `settlement-worker`\n*Labels:* `source=loki`"],
  ];
  for (const [name, alert] of cases) {
    const { selected } = r.select(alert, new Set());
    assert.ok(selected.some((s) => s.name === name), `"${alert}" did not select ${name}`);
  }
});

// imagepullbackoff points AT gitops-drift instead of repeating the "compare declared against
// running" procedure. That only works if both arrive in the same message — otherwise the
// cross-reference is a dangling pointer and the playbook silently loses its first step.
test("an image-pull alert selects gitops-drift alongside imagepullbackoff", () => {
  const alert =
    'KubePodImagePullBackOff: pod api-7f9 in dev — Failed to pull image "ghcr.io/acme/api:v9.9.9": manifest unknown';
  const names = loadSkills(resolveSkillsDir()).select(alert, new Set()).selected.map((s) => s.name);
  assert.ok(names.includes("imagepullbackoff"), `selected: ${names.join(", ")}`);
  assert.ok(names.includes("gitops-drift"), `selected: ${names.join(", ")}`);
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

// `source=loki` is set by the rules themselves and reaches the model on buildGroupAlertText's
// *Labels:* line (it is not in OWN_FIELD_LABELS), which makes it an exact, author-controlled
// trigger — no guessing at whatever a future rule gets named. If a rule ever drops the label the
// vocabulary alternatives in `when` are the fallback, but this is the one that should fire.
test("the source=loki label alone selects the log-alert playbook", () => {
  const names = loadSkills(resolveSkillsDir())
    .select(":alert: *SomethingNobodyNamedYet*\n*Labels:* `source=loki`", new Set())
    .selected.map((s) => s.name);
  assert.ok(names.includes("log-alert"), `selected: ${names.join(", ")}`);
});

// A log alert must not drag the metric playbooks in with it, and the metric alerts must not pull
// log-alert: they are different first tool calls, and the matched-skill cap means a wrong match
// can evict a right one.
test("log-alert and the metric playbooks do not cross-trigger", () => {
  const r = loadSkills(resolveSkillsDir());
  const logNames = r.select(":alert: *AppUnhandledRouteError*\n*Labels:* `source=loki`", new Set())
    .selected.map((s) => s.name);
  assert.ok(!logNames.includes("high-error-rate"), `log alert pulled a metric playbook: ${logNames.join(", ")}`);

  for (const metric of [
    "HighErrorRate: 5xx rate is 12% for checkout",
    "HighLatency: p99 latency is 2.3s",
    "KubePodOOMKilled: container api exceeded its memory limit",
  ]) {
    const names = r.select(metric, new Set()).selected.map((s) => s.name);
    assert.ok(!names.includes("log-alert"), `"${metric}" pulled log-alert: ${names.join(", ")}`);
  }
});

// This prompt and gitops-devops-ai-manifest/apps/base/systems/fluentbit/release.yaml are two
// halves of one contract, in different repos, with nothing but this test between them. fluentbit's
// `Labels` line plus identity.lua decide which labels exist; the prompt decides what the model asks
// for. A selector naming a label the shipper does not set is the worst failure shape available
// here — it does not error, it returns empty, and an empty Loki result is indistinguishable from
// "no logs exist", so the model states evidence of absence and nothing in any log says the query
// was wrong. The prompt shipped `{namespace="X", app="Y"}` for months while `app` did not exist.
// It exists now (identity.lua: app.kubernetes.io/name -> app -> k8s-app -> instance ->
// container_name); `service` still does not — the apps log it as a JSON field, so it belongs
// after a `| json` stage and matches nothing inside `{...}`.
const STREAM_LABELS = ["namespace", "app", "pod", "container", "job", "stream"];

test("the Loki patterns only select on labels fluentbit actually sets", () => {
  const prompt = buildStaticSystemPrompt();
  assert.match(
    prompt,
    /`namespace`, `app`, `pod`, `container`, `job`, `stream`/,
    "the stream label list must stay stated in the prompt"
  );

  // Scoped to the Loki section: `service="X"` is a perfectly valid PromQL matcher, so checking
  // every fenced block in the prompt would fail the day someone writes a correct Prometheus query.
  const loki = prompt.slice(prompt.indexOf("### Loki"));
  const section = loki.slice(0, loki.indexOf("\n### ", 1));
  assert.ok(section.length > 0 && section.length < loki.length, "the Loki section lost its boundaries");
  const queries = [...section.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");
  const selectors = [...queries.matchAll(/\{[^{}\n]*\}/g)].map((m) => m[0]);
  assert.ok(selectors.length > 0, "no stream selectors found — did the Loki section move?");

  for (const sel of selectors) {
    for (const [, key] of sel.matchAll(/([a-zA-Z_][a-zA-Z0-9_.\/-]*)\s*=~?\s*"/g)) {
      assert.ok(
        STREAM_LABELS.includes(key!),
        `selector filters on \`${key}\`, which fluentbit does not set as a stream label — it ` +
          `matches nothing and reads back as "no logs": ${sel}`
      );
    }
  }
});

// The same contract as STREAM_LABELS, one repo further out: these names are defined in
// devops-sample-app/packages/platform/src/metrics.ts (and pinned by its own metrics.test.ts),
// scraped into Prometheus, and then referenced from this prompt by hand. Nothing but this test
// connects the two — and PromQL, exactly like LogQL, answers an unknown metric with an EMPTY
// RESULT rather than an error. The prompt shipped `http_requests_total` while the apps expose
// `http_server_requests_total`, so the agent investigating a HighErrorRate alert could not read
// the very metric that fired it: observed live on 2026-08-31 as
// `← tool: prometheus_query ok (1004ms, 35 chars)` — a successful call returning nothing, and an
// RCA written from Loki alone.
const APP_METRICS = [
  "http_server_requests_total", "http_server_request_duration_seconds",
  "http_client_requests_total", "http_client_request_duration_seconds",
  "db_pool_connections", "db_query_duration_seconds", "cache_requests_total",
  "queue_depth", "queue_oldest_job_age_seconds",
  "settlement_jobs_total", "settlement_batch_size", "build_info",
];
// cAdvisor + kube-state-metrics: not ours, but equally real and equally silent when misspelled.
const INFRA_METRICS = [
  "container_memory_working_set_bytes", "container_spec_memory_limit_bytes",
  "container_cpu_usage_seconds_total", "container_spec_cpu_quota", "container_spec_cpu_period",
  "kube_pod_container_status_restarts_total",
];
const HISTOGRAM_SUFFIXES = ["", "_bucket", "_count", "_sum"];

test("the PromQL patterns only name metrics that exist in this cluster", () => {
  const prompt = buildStaticSystemPrompt();
  const known = new Set([
    ...INFRA_METRICS,
    ...APP_METRICS.flatMap((m) => HISTOGRAM_SUFFIXES.map((s) => m + s)),
  ]);

  // The prose above the fence restates this list for the model. Only the fenced queries are
  // parsed below, so without this the two could drift and the model would be told a wrong name
  // in the sentence that exists precisely to stop it inventing one. (Found by a negative control
  // that broke the prose and stayed green.)
  for (const m of APP_METRICS) {
    assert.ok(prompt.includes(m), `the prompt's metric contract no longer names \`${m}\``);
  }

  const prom = prompt.slice(prompt.indexOf("### Prometheus"));
  const section = prom.slice(0, prom.indexOf("\n### ", 1));
  assert.ok(section.length > 0 && section.length < prom.length, "the Prometheus section lost its boundaries");
  const queries = [...section.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");

  // A metric is an identifier immediately followed by a selector. PromQL functions are followed
  // by `(`, never `{`, so this needs no keyword list. ponytail: it does not see a bare metric
  // written without a selector (`up`); every pattern here uses one, and a keyword denylist would
  // rot faster than it would catch anything.
  const named = [...queries.matchAll(/([a-z_][a-z0-9_]*)\{/g)].map((m) => m[1]!);
  assert.ok(named.length > 0, "no metric selectors found — did the Prometheus section move?");
  for (const metric of named) {
    assert.ok(
      known.has(metric),
      `PromQL names \`${metric}\`, which nothing in this cluster exposes — it returns empty, ` +
        `not an error, and reads back as "no data"`
    );
  }
});
