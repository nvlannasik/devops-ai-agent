import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposal, buildProposalPrompt, worthProposing, declaredAction, retryNotice, proposeWithRetry } from "./proposal.js";
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

// ---- worthProposing (the mention-path cost gate) ----

// the actual shape of the reply that motivated this gate: a healthy cluster, reported with
// the same vocabulary a broken one uses ("no alerts firing", "0 restarts")
const ALL_GREEN = `*🟢 Cluster status: all green*

*Nodes* — 3/3 Ready
• \`master\`, \`worker1\`, \`worker2\` — all \`Ready\`, no pressure conditions
• Capacity: 12 vCPU total, ~12.5Gi allocatable memory

*Namespaces* — 20/20 Active
*Alerts* — none firing
*Pods* — no pods outside Running/Succeeded, 0 restarts in the last hour
*Scrape targets* — all up`;

test("a read-only status check on a healthy cluster spends no proposal call", () => {
  const gate = worthProposing("status check", ALL_GREEN, false);
  assert.equal(gate.propose, false);
  assert.match(gate.reason, /no fault evidence/);
});

test("negated health vocabulary does not read as fault evidence", () => {
  // without the negation strip, "none firing" / "0 restarts" match and the gate never skips
  assert.equal(worthProposing("cek pod di dev-auth", "All 3 pods Running and Ready, no restarts, no errors.", false).propose, false);
  assert.equal(worthProposing("apa ada masalah?", "No alerts are firing and nothing is pending.", false).propose, false);
});

test("an Indonesian negation reads as a negation, not as fault evidence", () => {
  // The agent answers in Indonesian and quotes the Kubernetes reasons in English, so a clean
  // bill of health is a mix: "tanpa kejadian `Pending`, `Failed`". This exact sentence opened
  // a proposal on a healthy namespace in production — an English-only negator list saw only
  // the word `Failed`, and the approval card arrived in Slack with nothing to explain it.
  const healthy =
    "Namespace `sample-apps` memiliki 5 pod aktif, semuanya dalam status `Running` dan `ready`, " +
    "tanpa kejadian `Pending`, `Failed`, atau `Unknown`. Tidak ditemukan event terkait dalam 3 jam terakhir.";
  assert.equal(worthProposing("check namespace sample-apps", healthy, false).propose, false);
  assert.equal(worthProposing("apa ada masalah?", "Tidak ada alert yang firing dan tidak ada pod pending.", false).propose, false);
  assert.equal(worthProposing("cek deployment", "Belum ada error dan tidak ada restart.", false).propose, false);
});

test("an Indonesian contrastive keeps the fault after it", () => {
  // "tapi" is the Indonesian "but": the clause after it is not what the negation covered, so
  // stripping through it would delete the only evidence in the sentence.
  const gate = worthProposing("cek log", "Tidak ada error di log, tapi pod-nya CrashLoopBackOff.", false);
  assert.equal(gate.propose, true);
  assert.match(gate.reason, /CrashLoopBackOff/);
});

test("an explicit change request survives the gate on a healthy cluster", () => {
  // buildProposalPrompt treats a user request as sufficient evidence on its own — the gate
  // must not overrule that, in either language
  for (const ask of [
    "restart deployment payments-api",
    "ganti image tag ke latest",
    "scale dev-auth-svc-be to 4 replicas",
    "tolong naikkan memory limit nya",
    "bisa diperbaiki?",
  ]) {
    const gate = worthProposing(ask, ALL_GREEN, false);
    assert.equal(gate.propose, true, `should propose for: ${ask}`);
    assert.match(gate.reason, /asked for a change/);
  }
});

test("fault evidence in the answer proposes even for a read-only question", () => {
  const gate = worthProposing(
    "cek kondisi namespace dev-auth",
    "`dev-auth-svc-be-84fcf9b4db-r2ddw` is in CrashLoopBackOff with 47 restarts.",
    false
  );
  assert.equal(gate.propose, true);
  assert.match(gate.reason, /CrashLoopBackOff/i); // the reason names the evidence, for the log
});

test("a negation does not swallow the evidence in the clause after it", () => {
  // "no logs" is a real negation; "but ... CrashLoopBackOff" is not part of it
  const gate = worthProposing("cek dev-auth", "There are no logs yet, but the pod is in CrashLoopBackOff.", false);
  assert.equal(gate.propose, true);
});

test("an RCA always proposes — the template means a fault was diagnosed", () => {
  // no action verb, no fault keyword in this stub: isRca alone has to carry it
  assert.equal(worthProposing("what happened", "Severity: ...", true).propose, true);
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
  // a remediation with no check row reads as "never verified", never as a silent success
  assert.deepEqual(rows[0], { summary: "set image → repo:v2", status: "succeeded", result: "https://ghe/pr/1", createdAt: "2026-07-23T10:00:00Z", verdict: null, detail: null });
  assert.deepEqual(await new RemediationStore(null).recallForAlert("X", "y"), []); // no pool → []
});

test("recallForAlert carries the verification verdict — 'succeeded' alone doesn't mean it worked", async () => {
  let sql = "";
  const pool = {
    query: async (q: string) => {
      sql = q;
      return {
        rows: [
          {
            summary: "rolling restart of deployment `payments/payments-api`",
            status: "succeeded",
            result: "restarted",
            created_at: "2026-07-23T10:00:00Z",
            verdict: "unchanged",
            detail: "`KubePodCrashLooping` is still firing; 1/3 pods ready, 51 restart(s)",
          },
        ],
      };
    },
  } as any;
  const rows = await new RemediationStore(pool).recallForAlert("KubePodCrashLooping", "payments");
  // one_check_per_remediation makes this 1:1 — the join must not fan the row set out
  assert.match(sql, /LEFT JOIN remediation_checks c ON c.remediation_id = r.id/);
  assert.equal(rows[0].verdict, "unchanged");
  assert.match(rows[0].detail!, /still firing/);
});

// ---- worthProposing: approval carried across two turns ----
//
// The production thread this comes from: the agent proposed an image change in prose, the
// operator answered "oke", and no card was ever posted — "oke" names no action, and the
// agent's own confirmation carried no fault vocabulary either. The intent lived across two
// turns and the gate only ever looked at one, so the agent promised a card it never created.

const PROPOSED_A_CHANGE =
  "Perubahan image yang saya identifikasi:\n• Target: Deployment `sarang-tani/sarang-tani-web`\n" +
  "• Image saat ini: `docker.io/nvlannasik/sarang-tani-web:weqeq` → usul ganti ke `...:b684919`";

test("a bare approval proposes, when the previous turn put a change on the table", () => {
  for (const answer of ["oke", "ya", "iya", "lanjut", "gas", "go ahead", "yes"]) {
    const gate = worthProposing(answer, "Siap, saya siapkan.", false, PROPOSED_A_CHANGE);
    assert.equal(gate.propose, true, answer);
    assert.match(gate.reason, /approved the change proposed in the previous turn/);
  }
});

test("a bare approval proposes nothing when nothing was proposed", () => {
  const gate = worthProposing("oke", "Siap.", false, ALL_GREEN);
  assert.equal(gate.propose, false);
  assert.match(gate.reason, /no fault evidence/);
});

test("agreeing with the diagnosis is not agreeing to the action", () => {
  for (const answer of ["ya tapi jangan sekarang", "oke, tunggu dulu", "ya nanti saja", "yes but hold"]) {
    assert.equal(worthProposing(answer, "Siap.", false, PROPOSED_A_CHANGE).propose, false, answer);
  }
});

// The word has to be the point of the message, not buried in it — otherwise "kenapa ya pod ini
// restart terus" reads as approval of whatever came before.
test("an affirmative word inside a question is not an approval", () => {
  const gate = worthProposing("kenapa ya image nya salah", "Karena tag-nya tidak ada.", false, PROPOSED_A_CHANGE);
  assert.match(gate.reason, /fault evidence|no fault evidence/);
  assert.equal(gate.reason.includes("approved the change"), false);
});

test("the previous turn is optional — the old three-argument calls still gate the same way", () => {
  assert.equal(worthProposing("status check", ALL_GREEN, false).propose, false);
  assert.equal(worthProposing("restart the deployment", "ok", false).propose, true);
});

// Both strings below are verbatim model output from a benchmark run, not invented: two of
// seven failures were this, and every other field in them was correct.
test("a field the model explicitly declined to set does not void the proposal", () => {
  const a02 =
    '{"action":"k8s_set_resources","namespace":"bench-a02","workload":"backend-api","kind":"deployment",' +
    '"container":"api-server","cpu_request":null,"memory_request":"128Mi","cpu_limit":null,' +
    '"memory_limit":"256Mi","reason":"OOMKilled on api-server due to memory limit (128Mi)."}';
  const p = parseProposal(a02);
  assert.ok(p, "an explicit null in cpu_request rejected the whole object");
  assert.equal(p!.action, "k8s_set_resources");
  assert.equal(p!.name, "backend-api");
  assert.equal(p!.toolParams.memory_limit, "256Mi");
  // toolParams goes straight to the MCP server — a null forwarded as a value is the same bug
  // one layer down.
  assert.ok(!("cpu_request" in p!.toolParams) && !("cpu_limit" in p!.toolParams));
});

test("null does not rescue a proposal that had nothing else", () => {
  // .refine() still requires at least one resource field; nulls must not count as set.
  assert.equal(
    parseProposal('{"action":"k8s_set_resources","namespace":"n","workload":"w","kind":"deployment","cpu_limit":null,"memory_limit":null}'),
    null
  );
});

test("null is stripped for every action, not only set_resources", () => {
  const p = parseProposal('{"action":"k8s_rollout_restart","namespace":"n","workload":"w","kind":null}');
  assert.ok(p, "a null kind on a field that is optional anyway must not void the restart");
  assert.equal(p!.toolParams.kind, "deployment", "and the default still applies");
});

// Prompt-as-contract. These two rules are the whole fix for the failure mode the first
// six-case benchmark run found — restart proposed on a missing config key, a nonexistent image
// tag, an OOM at the limit, and a healthy namespace — and prompt text is deleted by accident
// far more easily than code is.
test("the proposal prompt tests a restart against the spec, and legitimises proposing nothing", () => {
  const prompt = buildProposalPrompt({ alertname: "X" }, "an RCA");
  assert.match(prompt, /replaces a pod with an IDENTICAL one, built from the same spec/);
  assert.match(prompt, /the replacement has it too/);
  assert.match(prompt, /CORRECT and common answer, not a failure/);
  // restart must not be the only action whose condition is soft
  assert.doesNotMatch(prompt, /for transient faults where a clean rolling restart plausibly fixes it now/);
});

// Round two of the same failure, from the re-run: restart stopped being the generic gesture and
// k8s_delete_pod took over, because action 5 read "while its siblings are healthy" and a
// single-replica workload has no unhealthy sibling to contradict it. And null, newly legitimate,
// started coming back for faults the context could fix.
test("the proposal prompt closes the single-replica delete_pod loophole and counterweights null", () => {
  const prompt = buildProposalPrompt({ alertname: "X" }, "an RCA");
  assert.match(prompt, /a single-replica workload has no healthy sibling/);
  assert.match(prompt, /evidence about the SPEC, not about that pod/);
  assert.match(prompt, /Null is NOT a way out of a decision the context lets you make/);
});

// ---- DNS-1123 normalization (benchmark A09) ----
//
// The model capitalised a Deployment name it had read correctly. Kubernetes has no object whose
// name contains an uppercase letter, so the case is never information — it is always damage.
test("a capitalised target is lowercased, because no Kubernetes name has uppercase in it", () => {
  const p = parseProposal(
    '{"action":"k8s_set_image","namespace":"Bench-A09","workload":"web-Frontend","kind":"Deployment","container":"Web","image":"ghcr.io/acme/web:v1.2-RC1","reason":"roll back"}'
  );
  assert.equal(p?.namespace, "bench-a09");
  assert.equal(p?.name, "web-frontend");
  assert.deepEqual(p?.toolParams, {
    namespace: "bench-a09",
    name: "web-frontend",
    kind: "deployment",
    container: "web",
    // the TAG is the one field that may legitimately carry uppercase — lowercasing it would
    // point the rollout at an image that does not exist
    image: "ghcr.io/acme/web:v1.2-RC1",
  });
});

test("a pod name is lowercased too", () => {
  const p = parseProposal('{"action":"k8s_delete_pod","namespace":"Shop","pod":"Api-84fcf9b4db-R2ddw","reason":"wedged"}');
  assert.deepEqual(p?.toolParams, { namespace: "shop", pod: "api-84fcf9b4db-r2ddw" });
});

// ---- the one re-ask (benchmark A03 / A05 / A09) ----

test("declaredAction reads the action the model named, even when the object is unusable", () => {
  assert.equal(declaredAction('{"action":"k8s_set_resources","namespace":"shop"}'), "k8s_set_resources");
  assert.equal(declaredAction('{"action": null}'), null);
  assert.equal(declaredAction('{"action":"kubectl_apply_everything"}'), null); // not whitelisted
  assert.equal(declaredAction("I could not determine an action."), null);
});

test("the retry notice names the fields of the action the model left empty", () => {
  const notice = retryNotice('{"action":"k8s_set_resources","namespace":"shop","workload":"orders-api","kind":"deployment","reason":"lower the orders-api CPU requests"}');
  assert.match(notice, /named `k8s_set_resources`/);
  assert.match(notice, /cpu_request \/ memory_request \/ cpu_limit \/ memory_limit/);
  assert.match(notice, /answer \{"action": null\} instead/); // the honest way out stays open
});

// The counterweight has to survive the notice: six of sixteen benchmark cases END in a correct
// null, and a re-ask that reads as a correction buys A03 by losing those.
test("the retry notice for a null answer offers null back as a correct outcome", () => {
  const notice = retryNotice('{"action": null}');
  assert.match(notice, /a check, not a correction/);
  assert.match(notice, /answering \{"action": null\} again is a correct outcome/);
  assert.match(notice, /never invent a value to have something to say/);
});

test("a first answer that parses is not re-asked", async () => {
  const prompts: string[] = [];
  const { proposal } = await proposeWithRetry({}, "an RCA", async (p) => {
    prompts.push(p);
    return '{"action":"k8s_scale","namespace":"shop","workload":"web","kind":"deployment","replicas":4,"reason":"saturated"}';
  });
  assert.equal(prompts.length, 1);
  assert.equal(proposal?.action, "k8s_scale");
});

test("a self-contradicting answer is re-asked once and the second answer wins", async () => {
  const answers = [
    '{"action":"k8s_set_resources","namespace":"shop","workload":"orders-api","kind":"deployment","reason":"lower the CPU requests"}',
    '{"action":"k8s_set_resources","namespace":"shop","workload":"orders-api","kind":"deployment","cpu_request":"250m","reason":"lower the CPU requests"}',
  ];
  const prompts: string[] = [];
  const { proposal, raw } = await proposeWithRetry({}, "an RCA", async (p) => {
    prompts.push(p);
    return answers[prompts.length - 1];
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /named `k8s_set_resources`/);
  assert.equal(proposal?.toolParams.cpu_request, "250m");
  assert.equal(raw, answers[1]); // the discarded first answer is not kept once one parses
});

test("two failures keep both texts — the pair is the diagnosis", async () => {
  let n = 0;
  const { proposal, raw } = await proposeWithRetry({}, "an RCA", async () => `{"action": null, "n": ${++n}}`);
  assert.equal(n, 2); // never a third
  assert.equal(proposal, null);
  assert.match(raw, /"n": 1[\s\S]*\[retry\][\s\S]*"n": 2/);
});
