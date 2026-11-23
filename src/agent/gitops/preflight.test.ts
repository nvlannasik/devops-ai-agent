import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsCheck, historyCheck, podsCheck, preflightChecks, preflightNote, fluxReleaseCheck } from "./preflight.js";

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
