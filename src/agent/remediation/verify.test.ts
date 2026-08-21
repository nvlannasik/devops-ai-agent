import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizePods,
  alertState,
  decideVerdict,
  verdictMessage,
  maxAttemptsReached,
  RemediationCheckStore,
  type PodHealth,
} from "./verify.js";

const pods = (...items: Array<{ name: string; status?: string; ready?: boolean; restarts?: number }>) =>
  JSON.stringify(items.map((p) => ({ status: "Running", ready: true, restarts: 0, namespace: "payments", ...p })));

// ---- summarizePods ----

test("summarizePods counts only the target workload's pods", () => {
  const raw = pods(
    { name: "payments-api-7d9f-aaaa" },
    { name: "payments-api-7d9f-bbbb" },
    { name: "payments-worker-1", restarts: 99 } // different workload, must not be counted
  );
  assert.deepEqual(summarizePods(raw, "payments-api"), { total: 2, ready: 2, notReady: 0, restarts: 0 });
});

test("summarizePods reads readiness from the container flag, not the phase", () => {
  // a CrashLoopBackOff pod reports phase "Running" with ready=false — counting phases alone
  // would score a crash loop as healthy
  const raw = pods(
    { name: "payments-api-1", ready: false, restarts: 12 },
    { name: "payments-api-2", ready: true }
  );
  assert.deepEqual(summarizePods(raw, "payments-api"), { total: 2, ready: 1, notReady: 1, restarts: 12 });
});

test("summarizePods returns null for unreadable output — never a healthy zero", () => {
  assert.equal(summarizePods("Error: connection refused", "payments-api"), null);
  assert.equal(summarizePods('{"not":"an array"}', "payments-api"), null);
});

test("summarizePods distinguishes 'no pods matched' from 'could not read'", () => {
  assert.deepEqual(summarizePods(pods({ name: "other-app-1" }), "payments-api"), {
    total: 0,
    ready: 0,
    notReady: 0,
    restarts: 0,
  });
});

// ---- alertState ----

// the alertmanager_get_alerts shape: groups of alerts, each labelled with its status
const alerts = (...items: Array<{ name: string; status?: string; namespace?: string }>) =>
  JSON.stringify({
    summary: { groups: items.length, alerts: items.length, byStatus: {}, bySeverity: {} },
    groups: items.map((a) => ({
      groupLabels: { alertname: a.name },
      alerts: [{ name: a.name, status: a.status ?? "active", labels: a.namespace ? { namespace: a.namespace } : {} }],
    })),
  });
const noAlerts = JSON.stringify({ summary: { groups: 0, alerts: 0, byStatus: {}, bySeverity: {} }, groups: [] });

test("alertState is 'firing' when the same alert is active in the same namespace", () => {
  const raw = alerts({ name: "KubePodCrashLooping", namespace: "payments" });
  assert.equal(alertState(raw, "KubePodCrashLooping", "payments"), "firing");
});

// Every status Alertmanager still holds means the problem is still there. Silencing mutes the
// notification, not the alert — reading a silenced alert as recovered would let someone close
// an incident by muting it.
test("alertState treats a silenced or inhibited alert as still firing", () => {
  for (const status of ["silenced", "inhibited", "unprocessed", "suppressed"]) {
    const raw = alerts({ name: "KubePodCrashLooping", status, namespace: "payments" });
    assert.equal(alertState(raw, "KubePodCrashLooping", "payments"), "firing", `status ${status} read as recovery`);
  }
});

test("alertState ignores the same alert in a different namespace", () => {
  const raw = alerts({ name: "KubePodCrashLooping", namespace: "checkout" });
  assert.equal(alertState(raw, "KubePodCrashLooping", "payments"), "cleared");
});

test("alertState keeps a namespace-less alert (node-level rule) for its incident's namespace", () => {
  const raw = alerts({ name: "NodeMemoryPressure" });
  assert.equal(alertState(raw, "NodeMemoryPressure", "payments"), "firing");
});

test("alertState finds the alert wherever in the groups it sits", () => {
  const raw = alerts(
    { name: "SomethingElse", namespace: "payments" },
    { name: "KubePodCrashLooping", namespace: "payments" }
  );
  assert.equal(alertState(raw, "KubePodCrashLooping", "payments"), "firing");
});

test("alertState is 'cleared' when the alert is gone, 'none' without an alertname", () => {
  assert.equal(alertState(alerts({ name: "SomethingElse" }), "KubePodCrashLooping", "payments"), "cleared");
  assert.equal(alertState(noAlerts, "KubePodCrashLooping", "payments"), "cleared");
  assert.equal(alertState(noAlerts, null, null), "none");
});

test("alertState is 'unknown' on unreadable output — not 'cleared'", () => {
  // collapsing these would let a broken Alertmanager call read as recovery
  assert.equal(alertState("Error: upstream timeout", "KubePodCrashLooping", "payments"), "unknown");
  // valid JSON, wrong shape (e.g. the old flat array, or an error object) is still unreadable
  assert.equal(alertState("[]", "KubePodCrashLooping", "payments"), "unknown");
  assert.equal(alertState('{"error":"forbidden"}', "KubePodCrashLooping", "payments"), "unknown");
});

// ---- decideVerdict ----

const health = (ready: number, total: number, restarts = 0): PodHealth => ({
  total,
  ready,
  notReady: total - ready,
  restarts,
});
const ctx = { alertname: "KubePodCrashLooping" };

test("alert cleared + all pods ready = recovered", () => {
  const { verdict, detail } = decideVerdict("cleared", health(1, 3, 47), health(3, 3, 0), ctx);
  assert.equal(verdict, "recovered");
  assert.match(detail, /no longer firing/);
  assert.match(detail, /3\/3 pods ready/);
});

test("alert still firing = unchanged, whatever the pods look like", () => {
  assert.equal(decideVerdict("firing", health(1, 3), health(3, 3), ctx).verdict, "unchanged");
});

test("readiness falling since the remediation outranks a cleared alert = worse", () => {
  // the alert going quiet while the workload falls apart is the case a pod dump would miss
  const { verdict, detail } = decideVerdict("cleared", health(3, 3, 0), health(1, 3, 5), ctx);
  assert.equal(verdict, "worse");
  assert.match(detail, /not-ready 0→2/);
});

test("a climbing restart counter is evidence, not a regression trigger", () => {
  // a rollout replaces the pod set: the old crashing pod's 47 is in the baseline while the
  // new pods start at 0, so restart deltas compare different pods. Still firing = unchanged.
  assert.equal(decideVerdict("firing", health(2, 3, 47), health(2, 3, 51), ctx).verdict, "unchanged");
});

test("pre-existing damage is not a regression — that is what the baseline is for", () => {
  // 47 restarts is why we remediated; the fresh pods start at 0 and must not read as "worse"
  assert.equal(decideVerdict("cleared", health(1, 3, 47), health(3, 3, 0), ctx).verdict, "recovered");
});

test("alert cleared but pods still down = inconclusive, not recovered", () => {
  // the rule usually stops matching because the series went away, not because anything healed
  assert.equal(decideVerdict("cleared", health(1, 3), health(1, 3), ctx).verdict, "inconclusive");
});

test("unreadable alert state = inconclusive even with healthy pods", () => {
  const { verdict, detail } = decideVerdict("unknown", health(1, 3), health(3, 3), ctx);
  assert.equal(verdict, "inconclusive");
  assert.match(detail, /could not read alert state/);
});

test("unreadable pod state = inconclusive when there is no alert to fall back on", () => {
  assert.equal(decideVerdict("none", null, null, { alertname: null }).verdict, "inconclusive");
});

test("no alert behind the remediation: pods are the only evidence", () => {
  const noAlert = { alertname: null };
  assert.equal(decideVerdict("none", null, health(2, 2), noAlert).verdict, "recovered");
  assert.equal(decideVerdict("none", null, health(1, 2), noAlert).verdict, "unchanged");
  assert.equal(decideVerdict("none", null, health(0, 0), noAlert).verdict, "inconclusive"); // nothing to look at
});

// ---- verdictMessage ----

test("verdictMessage names the workload, the wait, and the consequence", () => {
  // the wait is measured from the row, not from the configured delay — a retried check
  // waited longer than the setting says, and quoting the setting would be a lie
  const check = {
    target: { namespace: "payments", name: "payments-api" },
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
  const msg = verdictMessage(check, "unchanged", "`KubePodCrashLooping` is still firing; 1/3 pods ready, 12 restart(s)");
  assert.match(msg, /Verified — not fixed/);
  assert.match(msg, /`payments\/payments-api`, 5m after the remediation/);
  assert.match(msg, /did not resolve the alert/);

  // a recovered verdict says its piece and stops — no advice to act on
  assert.doesNotMatch(verdictMessage(check, "recovered", "all clear"), /recommended|did not/);
});

test("verdictMessage degrades to 'shortly' rather than NaN when the timestamp is unusable", () => {
  const check = { target: { namespace: "ns", name: "app" }, createdAt: "not-a-date" };
  assert.match(verdictMessage(check, "inconclusive", "nothing to read"), /shortly after the remediation/);
});

// ---- store guards ----

test("the store is a no-op without Postgres — verification is part of incident memory", async () => {
  const store = new RemediationCheckStore(null);
  assert.equal(store.enabled, false);
  assert.equal(await store.schedule(1, "C1", "1.2", { namespace: "ns", name: "app" }, null, 300), false);
  assert.deepEqual(await store.claimDue(), []);
  await store.complete(1, "recovered", "x"); // must not throw
  await store.abandon(1, "x");
});

test("a store failure never propagates — a lost verdict must not break the poller", async () => {
  const brokenPool = { query: async () => { throw new Error("connection terminated"); } } as any;
  const store = new RemediationCheckStore(brokenPool);
  assert.equal(await store.schedule(1, "C1", "1.2", { namespace: "ns", name: "app" }, null, 300), false);
  assert.deepEqual(await store.claimDue(), []);
  await store.complete(1, "recovered", "x");
});

test("claimDue maps the row shape the poller expects", async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          id: "9", // pg returns BIGSERIAL as string
          remediation_id: "4",
          channel: "C1",
          thread_ts: "1720.99",
          alertname: "KubePodCrashLooping",
          namespace: "payments",
          target: { namespace: "payments", name: "payments-api" },
          before_state: { total: 3, ready: 1, notReady: 2, restarts: 47 },
          attempts: 2,
        },
      ],
    }),
  } as any;
  const [check] = await new RemediationCheckStore(pool).claimDue();
  assert.equal(check.id, 9);
  assert.equal(check.remediationId, 4);
  assert.equal(check.threadTs, "1720.99");
  assert.deepEqual(check.target, { namespace: "payments", name: "payments-api" });
  assert.equal(check.before?.restarts, 47);
  assert.equal(maxAttemptsReached(check), false);
  assert.equal(maxAttemptsReached({ ...check, attempts: 4 }), true);
});
