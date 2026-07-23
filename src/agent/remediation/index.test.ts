import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposal, buildProposalPrompt } from "./proposal.js";
import { RemediationStore } from "./index.js";

test("proposal prompt keeps the tail of a long RCA (Recommended Actions live there)", () => {
  const rca = "HEAD-MARKER " + "x".repeat(6000) + " TAIL-MARKER: change image to repo/app:1.2.3";
  const prompt = buildProposalPrompt({}, rca);
  assert.ok(prompt.includes("HEAD-MARKER"));
  assert.ok(prompt.includes("TAIL-MARKER: change image to repo/app:1.2.3"));
});

// ---- parseProposal (the agent-side whitelist gate) ----

test("rollout restart parses (kind defaults to deployment)", () => {
  const p = parseProposal('{"action":"k8s_rollout_restart","namespace":"payment","workload":"payment-api","reason":"OOM loop"}');
  assert.equal(p?.action, "k8s_rollout_restart");
  assert.deepEqual(p?.toolParams, { namespace: "payment", name: "payment-api", kind: "deployment" });
  assert.match(p!.summary, /rolling restart of deployment `payment\/payment-api`/);
});

test("set_image parses with full params", () => {
  const p = parseProposal(
    '{"action":"k8s_set_image","namespace":"dev-auth","workload":"auth-api","kind":"deployment","container":"auth-api","image":"repo/auth:1.2.3","reason":"tag not on registry"}'
  );
  assert.deepEqual(p?.toolParams, {
    namespace: "dev-auth",
    name: "auth-api",
    kind: "deployment",
    container: "auth-api",
    image: "repo/auth:1.2.3",
  });
  assert.match(p!.summary, /set image .* → `repo\/auth:1\.2\.3`/);
});

test("capitalized kind (K8s convention) is normalized, not dropped", () => {
  const p = parseProposal(
    '{"action":"k8s_set_image","namespace":"nginx-ingress","workload":"nginx-ingress-ingress-nginx-controller","kind":"Deployment","container":"controller","image":"registry.k8s.io/ingress-nginx/controller:latest","reason":"user request"}'
  );
  assert.equal(p?.action, "k8s_set_image");
  assert.equal(p?.toolParams.kind, "deployment");
});

test("set_image without container parses and omits the key (server auto-resolves)", () => {
  const p = parseProposal(
    '{"action":"k8s_set_image","namespace":"dev-auth","workload":"dev-auth-svc-be","kind":"deployment","image":"nvlannasik/fe-ml:latest","reason":"user requested tag"}'
  );
  assert.deepEqual(p?.toolParams, {
    namespace: "dev-auth",
    name: "dev-auth-svc-be",
    kind: "deployment",
    image: "nvlannasik/fe-ml:latest",
  });
  assert.match(p!.summary, /set image of deployment `dev-auth\/dev-auth-svc-be` → `nvlannasik\/fe-ml:latest`/);
});

test("set_resources requires at least one value and keeps only provided fields", () => {
  assert.equal(
    parseProposal('{"action":"k8s_set_resources","namespace":"a","workload":"b","kind":"statefulset","container":"c"}'),
    null // no resource values
  );
  const p = parseProposal(
    '{"action":"k8s_set_resources","namespace":"a","workload":"b","kind":"statefulset","container":"c","memory_limit":"1Gi"}'
  );
  assert.deepEqual(p?.toolParams, { namespace: "a", name: "b", kind: "statefulset", container: "c", memory_limit: "1Gi" });
  assert.match(p!.summary, /memory_limit=1Gi/);
});

test("scale parses; zero replicas and daemonset are rejected", () => {
  const p = parseProposal('{"action":"k8s_scale","namespace":"payment","workload":"api","kind":"deployment","replicas":4}');
  assert.deepEqual(p?.toolParams, { namespace: "payment", name: "api", kind: "deployment", replicas: 4 });
  assert.match(p!.summary, /scale deployment `payment\/api` → 4 replicas/);
  assert.equal(parseProposal('{"action":"k8s_scale","namespace":"a","workload":"b","kind":"deployment","replicas":0}'), null);
  assert.equal(parseProposal('{"action":"k8s_scale","namespace":"a","workload":"b","kind":"daemonset","replicas":2}'), null);
});

test("delete_pod parses; pod name goes to toolParams.pod (not name)", () => {
  const p = parseProposal(
    '{"action":"k8s_delete_pod","namespace":"dev-auth","pod":"dev-auth-svc-be-84fcf9b4db-r2ddw","reason":"single pod wedged"}'
  );
  assert.equal(p?.action, "k8s_delete_pod");
  assert.deepEqual(p?.toolParams, { namespace: "dev-auth", pod: "dev-auth-svc-be-84fcf9b4db-r2ddw" });
  assert.match(p!.summary, /delete pod `dev-auth\/dev-auth-svc-be-84fcf9b4db-r2ddw`/);
  assert.equal(parseProposal('{"action":"k8s_delete_pod","namespace":"dev-auth"}'), null); // no pod name
});

test("action null / non-whitelisted / incomplete / garbage are dropped", () => {
  assert.equal(parseProposal('{"action": null}'), null);
  assert.equal(parseProposal('{"action":"k8s_delete_namespace","namespace":"x","workload":"y"}'), null);
  assert.equal(parseProposal('{"action":"k8s_set_image","namespace":"x","workload":"y","kind":"deployment"}'), null); // no image
  assert.equal(parseProposal('{"action":"k8s_rollout_restart","namespace":"payment"}'), null);
  assert.equal(parseProposal("no json"), null);
});

// ---- RemediationStore row-flip semantics (fake pool) ----

test("propose maps 23505 to 'duplicate' and null pool to null", async () => {
  const dup = new RemediationStore({ query: async () => { const e: any = new Error("dup"); e.code = "23505"; throw e; } } as any);
  assert.equal(await dup.propose(1, "k8s_rollout_restart", {}), "duplicate");
  assert.equal(await new RemediationStore(null).propose(1, "a", {}), null);
});

test("claimForExecution wins the flip and returns the action", async () => {
  const pool = { query: async () => ({ rows: [{ action: "k8s_rollout_restart", params: { namespace: "payment", name: "api" } }] }) } as any;
  const claim = await new RemediationStore(pool).claimForExecution(5, "U1");
  assert.deepEqual(claim, { action: "k8s_rollout_restart", params: { namespace: "payment", name: "api" } });
});

test("losing the flip distinguishes 'taken' from 'expired'", async () => {
  const taken = new RemediationStore({
    query: async (sql: string) => (sql.startsWith("UPDATE") ? { rows: [] } : { rows: [{ status: "executing" }] }),
  } as any);
  assert.equal(await taken.claimForExecution(5, "U1"), "taken");

  const calls: string[] = [];
  const expired = new RemediationStore({
    query: async (sql: string) => {
      calls.push(sql.trim().split(" ")[0]);
      if (sql.includes("SELECT")) return { rows: [{ status: "proposed" }] };
      return { rows: [] }; // both UPDATEs match nothing / return nothing
    },
  } as any);
  assert.equal(await expired.claimForExecution(5, "U1"), "expired");
  assert.deepEqual(calls, ["UPDATE", "SELECT", "UPDATE"]); // claim → inspect → close out as expired
});

test("recallForAlert joins remediations to incidents and maps rows", async () => {
  let sql = "";
  const pool = {
    query: async (q: string, params: unknown[]) => {
      sql = q;
      assert.deepEqual(params, ["KubernetesPodNotHealthy", "dev-auth", 3]);
      return { rows: [{ summary: "set image → repo:v2", status: "succeeded", result: "https://ghe/pr/1", created_at: "2026-07-23T10:00:00Z" }] };
    },
  } as any;
  const rows = await new RemediationStore(pool).recallForAlert("KubernetesPodNotHealthy", "dev-auth");
  assert.match(sql, /JOIN incidents i ON r.incident_id = i.id/);
  assert.match(sql, /status IN \('succeeded', 'failed'\)/);
  assert.deepEqual(rows[0], { summary: "set image → repo:v2", status: "succeeded", result: "https://ghe/pr/1", createdAt: "2026-07-23T10:00:00Z" });
  assert.deepEqual(await new RemediationStore(null).recallForAlert("X", "y"), []); // no pool → []
});
