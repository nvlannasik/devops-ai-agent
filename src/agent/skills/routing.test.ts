import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, resolveSkillsDir } from "./index.js";
import { buildGroupAlertText } from "../correlation/index.js";

// Which playbooks a trigger selects — overflow included: a skill that matched and lost to
// MAX_MATCHED_SKILLS still matched, and "matched" is what these tests are about.
const reg = loadSkills(resolveSkillsDir());
const picks = (trigger: string) => {
  const s = reg.select(trigger, new Set());
  return [...s.selected.map((x) => x.name), ...s.overflow];
};
const forAlert = (text: string) => picks(`[mode:alert]\n${text}`);

// The dev cluster's own alert rules, copied from gitops-devops-ai-manifest (alertname, summary,
// description, templates filled). A rule edited there does not fail here — this pins what the
// triggers do with the text as it stood on 2026-09-28, which is when every route below was
// measured wrong: the node alert got pod-not-ready, "no rollout in progress" and "rollout
// restart ds/fluentbit" got rollout-stuck, a volume filling up got the binding playbook, and
// "the database is unreachable" got node-pressure.
const RULES: Record<string, string> = {
  WorkerNodeIsNotReady:
    "Kubernetes Node `k3s-worker-1` is not ready. Kubernetes Node `k3s-worker-1` is not ready for more than 3 minutes.",
  KubernetesStatefulSetDown:
    "Kubernetes StatefulSet `db/postgres` is down. StatefulSet `db/postgres` has unready replicas and no rollout in progress.",
  LogShipperStalled:
    "No logs have reached Loki from `fluentbit-x2x9k` for 15m. fluentbit has shipped zero records to Loki for 15 minutes. " +
    "Its pod is almost certainly still Running and Ready — the health check cannot see this failure. " +
    "Remediation is `kubectl -n monitoring rollout restart ds/fluentbit`.",
  KubernetesPersistentVolumeFillingUp:
    "PVC `db/data-postgres-0` is 12% free. Less than 25% of the volume remains. A database that fills its volume stops accepting writes.",
  AppQueueClaimFailing:
    "`settlement-worker` cannot claim work from the queue. Pod `settlement-worker-7f9c-x2x9k` is failing to claim settlement batches — " +
    "the database is unreachable, or the claim query is erroring. Orders keep being accepted; none of them settle.",
  PostgresIdleInTransaction:
    "A transaction has been idle in `orders` for 12m. An open transaction is doing nothing while holding its locks and blocking vacuum.",
  CertManagerSyncErrors: "cert-manager is failing to sync certificates.",
  CertificateNotReady: "Certificate `web/tls` is not ready.",
  ClusterIssuerNotReady: "ClusterIssuer `letsencrypt` is not ready.",
  RedisDown: "Redis exporter cannot reach Redis. The agent's conversation cache is gone.",
  PostgresDown: "Postgres exporter cannot reach Postgres.",
  RedisRejectingConnections: "Redis is rejecting connections at maxclients.",
  KubernetesDeploymentRolloutStuck: "Deployment `sample-apps/orders-api` rollout is stuck.",
};
const rule = (name: string) => forAlert(`${name} ${RULES[name]}`);

test("each cluster alert reaches the playbook for its failure", () => {
  const want: Array<[string, string]> = [
    ["WorkerNodeIsNotReady", "node-pressure"],
    ["KubernetesStatefulSetDown", "pod-not-ready"],
    ["LogShipperStalled", "healthy-but-failing"],
    ["KubernetesPersistentVolumeFillingUp", "volume-filling-up"],
    ["AppQueueClaimFailing", "healthy-but-failing"],
    ["AppQueueClaimFailing", "datastore-down"],
    ["PostgresIdleInTransaction", "datastore-down"],
    ["CertManagerSyncErrors", "cert-expiry"],
    ["CertificateNotReady", "cert-expiry"],
    ["ClusterIssuerNotReady", "cert-expiry"],
    ["RedisDown", "datastore-down"],
    ["PostgresDown", "datastore-down"],
    ["RedisRejectingConnections", "datastore-down"],
    ["KubernetesDeploymentRolloutStuck", "rollout-stuck"],
  ];
  for (const [alert, skill] of want) assert.ok(rule(alert).includes(skill), `${alert} → ${rule(alert).join(", ")}; missing ${skill}`);
});

test("and not the playbook a stray word points at", () => {
  const not: Array<[string, string]> = [
    ["KubernetesStatefulSetDown", "rollout-stuck"],
    ["LogShipperStalled", "rollout-stuck"],
    ["KubernetesPersistentVolumeFillingUp", "pvc-pending"],
    ["AppQueueClaimFailing", "node-pressure"],
    ["PostgresIdleInTransaction", "resource-rightsizing"],
  ];
  for (const [alert, skill] of not) assert.ok(!rule(alert).includes(skill), `${alert} → ${rule(alert).join(", ")}; should not load ${skill}`);
});

// The bench fixtures enter through buildGroupAlertText, the function the webhook calls. B04 is
// the case multi-pod-one-cause was written for, and its text says "Affected pods (8)" — which
// `[0-9]+ pods` never matched; the skill only ever arrived via the word "group" in tool output.
test("the bench alerts select their playbooks from the alert text", () => {
  const dir = join(resolveSkillsDir(), "..", "..", "bench", "cases");
  const byCase = (prefix: string) => {
    const id = readdirSync(dir).find((d) => d.startsWith(prefix))!;
    const c = JSON.parse(readFileSync(join(dir, id, "case.json"), "utf8"));
    return forAlert(buildGroupAlertText(c.groupLabels, c.alerts));
  };
  assert.ok(byCase("B04").includes("multi-pod-one-cause"), byCase("B04").join(", "));
  assert.ok(byCase("A09").includes("rollout-stuck"), byCase("A09").join(", "));
  assert.ok(byCase("A07").includes("pod-pending"), byCase("A07").join(", "));
  assert.ok(byCase("A03").includes("imagepullbackoff") && byCase("A03").includes("gitops-drift"), byCase("A03").join(", "));
});

// Selection also runs on every tool result, and a slot is spent for the rest of the thread. These
// are the words that spent them on 2026-09-28, measured over 126 real tool results: `group` 11×
// (`"group":"apps"` on every resource), `redis` 7× and `cert-manager` 4× (cluster-wide listings
// name those namespaces). The cap of five was hit in 13 of 22 threads.
test("a word every listing contains does not load a playbook", () => {
  const noise: Array<[string, string]> = [
    ['{"name":"payments-api","group":"apps","version":"v1","kind":"Deployment"}', "multi-pod-one-cause"],
    ["cert-manager   cert-manager-webhook-7d9f8b6c5-x2x9k   1/1   Running   0   3d", "cert-expiry"],
    ["redis          redis-master-0                        1/1   Running   0   3d", "datastore-down"],
    ['"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"data-postgres-0"}}]', "pvc-pending"],
    ["Failed to pull image \"ghcr.io/acme/web:v2\": unauthorized: authentication required", "forbidden"],
  ];
  for (const [text, skill] of noise) assert.ok(!picks(text).includes(skill), `${skill} loaded from: ${text}`);
});

test("while the evidence that names the fault still does", () => {
  const signal: Array<[string, string]> = [
    ["Error: connect ECONNREFUSED 10.43.137.110:6379", "datastore-down"],
    ["FATAL: could not connect to server postgres:5432: Connection refused", "datastore-down"],
    ["0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.", "pvc-pending"],
    ['pods is forbidden: User "system:serviceaccount:bench-a13:reporter" cannot list resource "pods"', "forbidden"],
    ["write /var/lib/postgresql/data/base/1/2608: no space left on device", "volume-filling-up"],
    ["Warning  ProgressDeadlineExceeded  deployment/web has timed out progressing", "rollout-stuck"],
  ];
  for (const [text, skill] of signal) assert.ok(picks(text).includes(skill), `${skill} not loaded from: ${text}`);
});
