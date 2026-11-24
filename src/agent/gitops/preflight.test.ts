import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsCheck, historyCheck, podsCheck, preflightChecks, preflightNote, fluxReleaseCheck, memoryCheck, imageCheck, peakQuery } from "./preflight.js";

const pods = JSON.stringify([
  { name: "api-7d9-abc", status: "Running", ready: true, restarts: 0 },
  { name: "api-7d9-def", status: "Running", ready: false, restarts: 4 },
  { name: "api-gateway-1", status: "Running", ready: false, restarts: 9 }, // another workload
]);

test("the workload's pods are counted by name prefix; not-ready on a fix is info, not a warning", () => {
  assert.deepEqual(podsCheck(pods, "api-7d9"), { name: "Workload now", status: "info", detail: "1/2 pods ready, 4 restarts" });
  assert.equal(podsCheck("not json", "api").status, "unknown");
  assert.equal(podsCheck("[]", "api").status, "warn");
});

// the real shape alertmanager_get_alerts returns (verify.ts alertState reads the same)
const alerts = JSON.stringify({
  summary: {},
  groups: [
    { groupLabels: {}, alerts: [
      { name: "KubePodCrashLooping", status: "active", labels: { namespace: "apps", pod: "api-7d9-def" } },
      { name: "HighErrorRate", status: "suppressed", labels: { namespace: "apps", service: "api" } },
      { name: "KubePodCrashLooping", status: "active", labels: { namespace: "other", pod: "api-1" } },
      { name: "Unrelated", status: "active", labels: { namespace: "apps", pod: "web-1" } },
    ] },
  ],
});

test("firing alerts on the workload: its namespace, its name in a label, the status when not plain active", () => {
  assert.deepEqual(alertsCheck(alerts, "apps", "api"), { name: "Firing alerts", status: "info", detail: "HighErrorRate (suppressed), KubePodCrashLooping" });
  assert.equal(alertsCheck(alerts, "apps", "billing").status, "ok");
  assert.equal(alertsCheck("{}", "apps", "api").status, "unknown");
});

test("another commit to the HelmRelease in the window is the warning a reviewer needs", () => {
  assert.equal(historyCheck({ ok: true, op: "history", commits: [] }).status, "ok");
  const c = historyCheck({ ok: true, op: "history", commits: [{ sha: "abcdef1234", at: "2026-11-20T01:00:00Z", author: "dev1", message: "bump api\n\nbody", url: "", paths: [] }] as never });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /abcdef1 by dev1: bump api/);
  assert.equal(historyCheck({ ok: false, reason: "timeout" }).status, "unknown");
});

test("a source that throws or hangs is unknown, never ok, and nothing throws", async () => {
  const checks = await preflightChecks(
    {
      callTool: async (name) => (name === "k8s_list_pods" ? new Promise<string>(() => {}) : Promise.reject(new Error("down"))),
      history: async () => ({ ok: true, op: "history", commits: [] }),
      timeoutMs: 20,
    },
    { namespace: "apps", name: "api" },
    { name: "api", namespace: "flux-system" }
  );
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [["Workload now", "unknown"], ["Firing alerts", "unknown"], ["Flux release", "unknown"], ["Git changes (24 h)", "ok"]]);
});

// 2026-11-09..23: six HelmReleases Stalled after four failed installs — a merged PR to any of them
// would have changed nothing in the cluster, and nothing said so.
test("a Stalled, not-Ready or suspended HelmRelease is the warning that the merge will not land", () => {
  const hr = { name: "checkout-gateway", namespace: "flux-app" };
  const obj = (spec: object, conditions: object[]) => JSON.stringify({ spec, status: { conditions } });
  const stalled = fluxReleaseCheck(
    obj({}, [
      { type: "Ready", status: "False", message: "Helm install failed", lastTransitionTime: "2026-11-09T17:09:18Z" },
      { type: "Stalled", status: "True", message: "Failed to install after 4 attempt(s)", lastTransitionTime: "2026-11-09T17:09:18Z" },
    ]),
    hr
  );
  assert.equal(stalled.status, "warn");
  assert.match(stalled.detail, /`flux-app\/checkout-gateway` is Stalled since 2026-11-09: Failed to install after 4 attempt\(s\) — Flux has stopped retrying it/);
  assert.match(fluxReleaseCheck(obj({}, [{ type: "Ready", status: "False", message: "upgrade retries exhausted" }]), hr).detail, /is not Ready: upgrade retries exhausted/);
  assert.match(fluxReleaseCheck(obj({ suspend: true }, [{ type: "Ready", status: "True" }]), hr).detail, /is suspended — Flux will not apply this merge/);
  assert.deepEqual(fluxReleaseCheck(obj({}, [{ type: "Ready", status: "True" }]), hr), { name: "Flux release", status: "ok", detail: "`flux-app/checkout-gateway` is Ready — Flux applies the merge" });
  assert.equal(fluxReleaseCheck("Error: helmreleases not found", hr).status, "unknown");
  assert.equal(fluxReleaseCheck("{}", hr).status, "unknown");
});

test("the Flux check reads the card's own HelmRelease object", async () => {
  const asked: unknown[] = [];
  const checks = await preflightChecks(
    { callTool: async (name, input) => (asked.push([name, input]), name === "k8s_get_custom_resources" ? JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } }) : "[]") },
    null,
    { name: "orders-api", namespace: "flux-app" }
  );
  assert.deepEqual(asked, [["k8s_get_custom_resources", { group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases", namespace: "flux-app", name: "orders-api" }]]);
  assert.deepEqual(checks.map((c) => c.status), ["ok"]);
});

test("the Slack note names only what needs a look", () => {
  assert.equal(preflightNote([{ name: "Workload now", status: "info", detail: "x" }, { name: "Firing alerts", status: "ok", detail: "none" }]), "");
  const n = preflightNote([{ name: "Git changes (24 h)", status: "warn", detail: "1 commit" }, { name: "Workload now", status: "unknown", detail: "x" }]);
  assert.match(n, /⚠️ Git changes \(24 h\): 1 commit/);
  assert.match(n, /not checked: Workload now/);
});

// D3 for the agent's own PRs (2026-11-24): what the PR's change would do once Flux applies it.
const vec = (bytes: number | null) => JSON.stringify({ resultType: "vector", result: bytes === null ? [] : [{ metric: {}, value: [0, String(bytes)] }] });

test("memoryCheck: below the 7-day peak is the next OOMKill; just above it is no room; well above is fine; no data is unknown", () => {
  const ch = (to: string) => ({ field: "limits.memory", from: "256Mi", to });
  assert.match(memoryCheck(vec(160 * 1048576), ch("128Mi"), "api").detail, /128Mi is BELOW `api`'s 7-day peak working set 160Mi — it would be OOMKilled at its next peak/);
  assert.equal(memoryCheck(vec(160 * 1048576), ch("128Mi"), "api").status, "warn");
  assert.match(memoryCheck(vec(120 * 1048576), ch("128Mi"), "api").detail, /only 7% above `api`'s 7-day peak 120Mi/);
  assert.deepEqual(memoryCheck(vec(90 * 1048576), ch("192Mi"), "api"), { name: "Memory limit vs peak", status: "ok", detail: "192Mi vs `api`'s 7-day peak 90Mi (+113%)" });
  assert.equal(memoryCheck(vec(null), ch("128Mi"), "api").status, "unknown");
  assert.equal(memoryCheck("Error: prometheus down", ch("128Mi"), "api").status, "unknown");
  assert.equal(peakQuery("sample-apps", "orders-api", "orders-api"), 'max(max_over_time(container_memory_working_set_bytes{namespace="sample-apps", pod=~"orders-api-.*", container="orders-api"}[7d]))');
});

test("imageCheck: a tag nobody pushed is the warning; an unanswered registry is not checked, never fine", () => {
  assert.equal(imageCheck({ exists: false }, "nvlannasik/orders-api:9.9.9").status, "warn");
  assert.match(imageCheck({ exists: false }, "nvlannasik/orders-api:9.9.9").detail, /does NOT exist in its registry \(manifest 404\) — the rollout would fail with ImagePullBackOff/);
  assert.equal(imageCheck({ exists: true }, "x:1").status, "ok");
  assert.equal(imageCheck({ unknown: "the registry answered 401" }, "x:1").status, "unknown");
});

test("the PR's own changes add their checks: a memory limit with its container reads the peak, an image asks the registry", async () => {
  const asked: unknown[] = [];
  const checks = await preflightChecks(
    {
      callTool: async (name, input) => (asked.push([name, input]), name === "prometheus_query" ? vec(200 * 1048576) : name === "k8s_get_custom_resources" ? JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } }) : "[]"),
      imageExists: async (image) => (asked.push(["registry", image]), { exists: false }),
    },
    { namespace: "sample-apps", name: "orders-api" },
    { name: "orders-api", namespace: "flux-app" },
    { container: "orders-api", changes: [{ field: "limits.memory", from: "256Mi", to: "128Mi" }, { field: "image", from: "a:1", to: "nvlannasik/orders-api:9.9.9" }] }
  );
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
  assert.equal(byName["Memory limit vs peak"], "warn");
  assert.equal(byName["Image exists"], "warn");
  assert.ok(asked.some((a) => Array.isArray(a) && a[0] === "registry" && a[1] === "nvlannasik/orders-api:9.9.9"));
  // a memory change without a container: no guess at which container's peak
  const noContainer = await preflightChecks({ callTool: async () => "[]", imageExists: async () => ({ exists: true }) }, { namespace: "n", name: "w" }, { name: "w", namespace: "f" }, { changes: [{ field: "limits.memory", from: "1Gi", to: "512Mi" }] });
  assert.equal(noContainer.some((c) => c.name === "Memory limit vs peak"), false);
});
