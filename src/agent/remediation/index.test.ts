import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseProposal, buildProposalPrompt, worthProposing, declaredAction, retryNotice, proposeWithRetry, PROPOSABLE_ACTIONS, parseOffer, stripOffer, dropCardPromises, explainGate, answerAsksForInput } from "./proposal.js";
import { RemediationStore } from "./index.js";
import { quarantineRefusal, orphanDeleteRefusal, backupFrom } from "../index.js";
import { compactToolResult, MAX_TOOL_RESULT_CHARS } from "../context/compact.js";

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

test("scale parses; daemonset is rejected", () => {
  const p = parseProposal('{"action":"k8s_scale","namespace":"payment","workload":"api","kind":"deployment","replicas":4}');
  assert.deepEqual(p?.toolParams, { namespace: "payment", name: "api", kind: "deployment", replicas: 4 });
  assert.match(p!.summary, /scale deployment `payment\/api` → 4 replicas/);
  assert.equal(p!.quarantine, undefined, "an ordinary scale must not be marked a quarantine");
  assert.equal(parseProposal('{"action":"k8s_scale","namespace":"a","workload":"b","kind":"daemonset","replicas":2}'), null);
});

// Zero used to be rejected here. It is now parsed as an explicit QUARANTINE and refused later,
// by DevOpsAgent.quarantineRefusalFor, which requires a k8s_recommend_resources run in the same
// thread to have measured this workload idle. Rejecting it at parse time meant the only answer
// to "this workload looks unused" was an irreversible delete — against a cluster with no
// backups. Scaling to zero is the same decision with an undo.
test("zero replicas parses as a quarantine, flagged and worded as reversible", () => {
  const p = parseProposal('{"action":"k8s_scale","namespace":"payment","workload":"api","kind":"deployment","replicas":0}');
  assert.equal(p?.quarantine, true);
  assert.deepEqual(p?.toolParams, {
    namespace: "payment", name: "api", kind: "deployment", replicas: 0, quarantine: true,
  });
  assert.match(p!.summary, /quarantine deployment `payment\/api` → 0 replicas/);
  assert.match(p!.summary, /reversible/, "the card must say how to undo it");
});

// The flag is the server's signal that the caller MEANT zero. Asserting it on every scale would
// make the assertion meaningless, so it rides only on the proposals that are actually one.
test("the quarantine flag is never sent on an ordinary scale", () => {
  const p = parseProposal('{"action":"k8s_scale","namespace":"a","workload":"b","kind":"statefulset","replicas":2}');
  assert.equal("quarantine" in (p?.toolParams ?? {}), false);
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

// Three C03 attempts wrote the same fallacy almost word for word — "memory limit not set ...
// adding limits aims to stabilize startup" — against a container running `sleep 3; exit 1`.
test("the proposal prompt refuses an absent limit as evidence of a resource fault", () => {
  const prompt = buildProposalPrompt({ alertname: "X" }, "an RCA");
  assert.match(prompt, /NO limit set is not evidence of a resource fault/);
  assert.match(prompt, /there is no denominator/);
  assert.match(prompt, /hardening opinion about the spec/);
});

// ── The quarantine evidence gate ─────────────────────────────────────────────
// The only thing standing between "this looks unused" and a workload taken offline. It fails
// CLOSED, unlike the replacement guard beside it: that guard's worst case is a restart that does
// not help, this one's is an outage.

const quarantine = (over: Record<string, unknown> = {}) =>
  parseProposal(
    JSON.stringify({
      action: "k8s_scale", namespace: "app", workload: "orders-api", kind: "deployment", replicas: 0, ...over,
    })
  )!;

// What the tool actually puts in the thread — IdleWorkload.key, lowercased by observedText.
const measured = (key = "app/deployment/orders-api") =>
  `{"idleworkloads":[{"key":"${key}","kind":"deployment","namespace":"app","workload":"orders-api","replicas":2,"cpup95below":"2m"}]}`;

test("a quarantine backed by an idle measurement in the thread is allowed", () => {
  assert.equal(quarantineRefusal(quarantine(), measured()), null);
});

test("a quarantine with no measurement anywhere in the thread is refused", () => {
  const refusal = quarantineRefusal(quarantine(), "some other tool output about app/orders-api");
  assert.match(refusal!, /refused/);
  assert.match(refusal!, /idleWorkloads/, "the refusal must name what would satisfy it");
  assert.match(refusal!, /window: "24h"/, "and how to produce it");
});

// The measurement is about ONE workload. A different one being idle says nothing about this one.
test("an idle measurement of a different workload does not carry over", () => {
  assert.ok(quarantineRefusal(quarantine(), measured("app/deployment/checkout-gateway")));
  assert.ok(quarantineRefusal(quarantine(), measured("other-ns/deployment/orders-api")));
  assert.ok(quarantineRefusal(quarantine({ kind: "statefulset" }), measured("app/deployment/orders-api")));
});

// A tool result the context compactor cut in half must fail, not pass.
test("a truncated tool result fails the match rather than half-passing it", () => {
  const cut = measured().slice(0, 30);
  assert.ok(quarantineRefusal(quarantine(), cut), `a truncated result was accepted: ${cut}`);
});

test("no conversation at all means no card, and the message says why", () => {
  assert.match(quarantineRefusal(quarantine(), null)!, /no conversation to read one from/);
});

// The gate must be invisible to everything that is not a quarantine.
test("an ordinary scale, a restart and an image change are never gated", () => {
  const plain = parseProposal('{"action":"k8s_scale","namespace":"app","workload":"orders-api","kind":"deployment","replicas":3}')!;
  assert.equal(quarantineRefusal(plain, null), null);
  const restart = parseProposal('{"action":"k8s_rollout_restart","namespace":"app","workload":"orders-api"}')!;
  assert.equal(quarantineRefusal(restart, null), null);
});

// The gate fails closed, so anything that removes `idleWorkloads` from the stored tool result
// turns the quarantine into a feature that silently never fires. The rightsizing response is
// over MAX_TOOL_RESULT_CHARS on any real cluster (40 recommendations), and compactToolResult
// keeps the head and the tail and drops the middle — which is where idleWorkloads used to sit.
test("an idle measurement survives the compaction a real-sized response goes through", () => {
  const recommendation = (i: number) => ({
    kind: "Deployment", namespace: "app", workload: `svc-${i}`, container: "api", replicas: 2,
    flags: ["over_provisioned"],
    current: { cpuRequest: "500m", memoryRequest: "512Mi", cpuLimit: "1000m", memoryLimit: "512Mi" },
    observed: { cpuP95: "12m", memoryPeak: "120Mi", cpuThrottlePct: 0 },
    recommended: { cpuRequest: "14m", memoryRequest: "144Mi", memoryLimit: "180Mi", cpuLimit: "1000m" },
    savings: { cpuCores: 0.486, memoryBytes: 385875968 },
  });
  // Key order mirrors the server's return object: idleWorkloads LAST.
  const raw = JSON.stringify({
    window: "24h",
    scanned: { containers: 120, withMetrics: 118 },
    potentialRequestSavings: { cpu: "48000m", memory: "46080Mi" },
    recommendationsTotal: 120,
    recommendations: Array.from({ length: 40 }, (_, i) => recommendation(i)),
    idleWorkloads: [
      { key: "app/Deployment/orders-api", kind: "Deployment", namespace: "app", workload: "orders-api", replicas: 2, cpuP95Below: "2m" },
    ],
  });
  assert.ok(raw.length > MAX_TOOL_RESULT_CHARS, `fixture is only ${raw.length} chars — it must exceed the cap to prove anything`);

  const stored = compactToolResult(raw).toLowerCase();
  assert.ok(stored.includes("app/deployment/orders-api"), "the idle key did not survive compaction");
  assert.equal(quarantineRefusal(quarantine(), stored), null);
});

// ── delete_orphan: shape + grounding gate ────────────────────────────────────
// The MCP server re-reads the live object and refuses on provenance, ownership, replicas and age
// — that is the safety check. THIS gate is about grounding: stopping the model naming an object
// no scan ever flagged, which no server-side check can catch because an invented name can still
// resolve to a real object. Same fail-closed rule as the quarantine.

const orphanProposal = (over: Record<string, unknown> = {}) =>
  parseProposal(
    JSON.stringify({
      action: "k8s_delete_orphan", namespace: "sample-apps", name: "leftover-config", kind: "configmap", ...over,
    })
  )!;

// What the scan puts in the thread: orphanKeys, lowercased by observedText.
const scanned = (...keys: string[]) => `{"orphankeys":[${keys.map((k) => `"${k}"`).join(",")}]}`;

test("delete_orphan parses, and its summary names the undo rather than promising one", () => {
  const p = orphanProposal();
  assert.equal(p.action, "k8s_delete_orphan");
  assert.deepEqual(p.toolParams, { namespace: "sample-apps", name: "leftover-config", kind: "configmap" });
  assert.match(p.summary, /delete abandoned configmap `sample-apps\/leftover-config`/);
  assert.match(p.summary, /manifest is backed up first/);
});

test("secret and persistentvolumeclaim are not proposable kinds at all", () => {
  for (const kind of ["secret", "persistentvolumeclaim", "pvc", "namespace", "pod"]) {
    assert.equal(parseProposal(JSON.stringify({
      action: "k8s_delete_orphan", namespace: "a", name: "b", kind,
    })), null, `${kind} was accepted`);
  }
});

test("a delete the scan flagged as an orphan is allowed", () => {
  assert.equal(orphanDeleteRefusal(orphanProposal(), scanned("sample-apps/configmap/leftover-config")), null);
});

test("a delete of something no scan flagged is refused, and told to run the scan", () => {
  const refusal = orphanDeleteRefusal(orphanProposal(), scanned("sample-apps/configmap/something-else"));
  assert.match(refusal!, /refused/);
  assert.match(refusal!, /orphanKeys/);
  assert.match(refusal!, /Run the scan on that namespace first/);
  // and it explains the OTHER reason a key can be absent — something declares it
  assert.match(refusal!, /Flux or Helm/);
});

// orphanKeys holds only findings nothing declares, so appearing in `findings` is not enough.
test("appearing in the findings is not the same as appearing in orphanKeys", () => {
  const declaredFinding = '{"findings":[{"kind":"ConfigMap","namespace":"sample-apps","name":"leftover-config","managedby":"flux"}],"orphankeys":[]}';
  assert.ok(orphanDeleteRefusal(orphanProposal(), declaredFinding));
});

test("kind and namespace both have to match the key", () => {
  assert.ok(orphanDeleteRefusal(orphanProposal(), scanned("sample-apps/service/leftover-config")));
  assert.ok(orphanDeleteRefusal(orphanProposal(), scanned("other-ns/configmap/leftover-config")));
});

test("no conversation means no delete", () => {
  assert.match(orphanDeleteRefusal(orphanProposal(), null)!, /no conversation to read one from/);
});

test("the orphan gate is invisible to every other action", () => {
  const restart = parseProposal('{"action":"k8s_rollout_restart","namespace":"app","workload":"api"}')!;
  assert.equal(orphanDeleteRefusal(restart, null), null);
});

// ── The backup extraction ────────────────────────────────────────────────────
// Runs AFTER the object is already gone, so it must never throw: a parse failure costs the
// backup, and turning that into a failed remediation would compound it.

test("the backup manifest is lifted out of a successful delete result", () => {
  const result = JSON.stringify({
    action: "delete_orphan", target: "configmap/sample-apps/leftover-config",
    backupManifest: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "leftover-config" } },
  });
  assert.deepEqual(backupFrom(result), { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "leftover-config" } });
});

test("anything unparseable or wrongly shaped yields null instead of throwing", () => {
  for (const bad of ["", "not json", "{}", '{"backupManifest":null}', '{"backupManifest":"a string"}', '{"backupManifest":[]}']) {
    assert.equal(backupFrom(bad), null, `threw or accepted: ${bad}`);
  }
});

// ── The prompt and the parser must offer the same actions ────────────────────
// 2026-09-16: k8s_delete_orphan reached the parser, the MCP server, the RBAC and
// prompts/system.md, but not buildProposalPrompt — a SEPARATE structured-output call with its
// own action list. The model was asked to choose from five actions, none of which was the one
// it needed, and answered {"action": null}. Nothing errored. The card just never appeared and
// every log line read healthy. This test is the only cheap thing that catches that shape.

test("the proposal prompt offers every action the parser accepts", () => {
  const prompt = buildProposalPrompt({}, "some RCA text");
  for (const action of PROPOSABLE_ACTIONS) {
    assert.ok(prompt.includes(`"action":"${action}"`), `the prompt never offers ${action}`);
  }
});

test("every action the prompt offers is one the parser accepts", () => {
  const prompt = buildProposalPrompt({}, "some RCA text");
  const offered = new Set([...prompt.matchAll(/"action":"([a-z0-9_]+)"/g)].map((m) => m[1]));
  for (const action of offered) {
    assert.ok(
      (PROPOSABLE_ACTIONS as readonly string[]).includes(action),
      `the prompt offers ${action}, which parseProposal rejects — a card the model can never get`
    );
  }
  assert.equal(offered.size, PROPOSABLE_ACTIONS.length);
});

// The list is only load-bearing if it matches the switch, so round-trip one minimal payload each.
test("each listed action actually parses", () => {
  const minimal: Record<string, Record<string, unknown>> = {
    k8s_rollout_restart: { namespace: "a", workload: "b" },
    k8s_set_image: { namespace: "a", workload: "b", kind: "deployment", image: "r/i:1" },
    k8s_set_resources: { namespace: "a", workload: "b", kind: "deployment", memory_limit: "1Gi" },
    k8s_scale: { namespace: "a", workload: "b", kind: "deployment", replicas: 2 },
    k8s_delete_pod: { namespace: "a", pod: "b-123" },
    k8s_delete_orphan: { namespace: "a", name: "b", kind: "configmap" },
  };
  for (const action of PROPOSABLE_ACTIONS) {
    assert.ok(parseProposal(JSON.stringify({ action, ...minimal[action] })), `${action} did not parse`);
  }
});

// The clause that blocked the quarantine: action 4 used to end "never zero", full stop.
test("the prompt permits zero for the quarantine and names what it requires", () => {
  const prompt = buildProposalPrompt({}, "rca");
  assert.ok(prompt.includes('"replicas":0'), "zero is not offered at all");
  assert.match(prompt, /idleWorkloads/, "the quarantine's evidence is not named");
  assert.match(prompt, /orphanKeys/, "the delete's evidence is not named");
  assert.doesNotMatch(prompt, /never zero/, "the old blanket ban is still in the prompt");
});

// A bare request is enough for a restart or an image bump. It is never enough for these two.
test("the prompt says a user request alone cannot justify a quarantine or a delete", () => {
  const prompt = buildProposalPrompt({}, "rca");
  assert.match(prompt, /a request is never enough for them/);
  assert.match(prompt, /asking BECAUSE they are unsure/);
});

test("the prompt refuses secrets and PVCs by name, with the reason", () => {
  const prompt = buildProposalPrompt({}, "rca");
  assert.match(prompt, /NO delete for a secret or a persistentvolumeclaim/);
  assert.match(prompt, /backup is its credentials/);
  assert.match(prompt, /manifest is not its data/);
});

// ── A cleanup question is not a fault report ─────────────────────────────────
// Live 2026-09-16: "ada resource yang ga kepake ga?" was answered with the unused scan plus the
// rightsizing table. The answer carried fault vocabulary — a Service with no endpoints reads
// "unavailable", a rightsizing row reads "throttled" — the fault-evidence branch fired, and a
// GitOps PR approval card appeared for a workload in a namespace the user had never mentioned.

const unusedReport =
  "*Unused Resources (tidak memiliki referensi aktif):*\n" +
  "• `Service/headlamp/headlamp-svc` — tidak ada endpoint, unavailable\n" +
  "• `ConfigMap/default/order-configmap` — tidak ada yang merujuk\n" +
  "Beberapa workload juga throttled dan over-provisioned.";

test("a cleanup question does not propose, however much fault vocabulary the report carries", () => {
  for (const q of [
    "ada resource yang ga kepake ga?",
    "ada resource yang bisa kita clean up ga?",
    "what's unused in this cluster?",
    "anything we can optimize?",
    "resource apa aja yang tidak terpakai?",
    "ada yang nganggur ga?",
    "workload mana yang over-provisioned?",
  ]) {
    const gate = worthProposing(q, unusedReport, false);
    assert.equal(gate.propose, false, `proposed for: ${q} (${gate.reason})`);
    assert.match(gate.reason, /review finding, not a fault to repair/);
  }
});

// The whole point is that it narrows ONE inference. Everything else still proposes.
test("an explicit request still proposes, even when it uses cleanup words", () => {
  for (const q of ["order-configmap bisa dihapus", "hapus configmap yang ga kepake", "delete the unused service"]) {
    const gate = worthProposing(q, unusedReport, false);
    assert.equal(gate.propose, true, `refused an explicit request: ${q}`);
    assert.equal(gate.byUser, true, "an explicit request must be marked as the user's");
  }
});

test("an RCA still proposes, and a real fault question still proposes", () => {
  assert.equal(worthProposing("ada resource yang ga kepake ga?", unusedReport, true).propose, true, "an RCA was blocked");
  const real = worthProposing("kenapa storefront lambat?", "Pod `storefront-7t6mn` is in CrashLoopBackOff.", false);
  assert.equal(real.propose, true);
  assert.match(real.reason, /fault evidence/);
});

// The fault words that also appear in capacity vocabulary must keep their meaning when the
// question was not a cleanup one.
test("oomkilled and evicted are faults, not cleanup findings", () => {
  const gate = worthProposing("kenapa pod ini mati?", "Container was OOMKilled (exit code 137).", false);
  assert.equal(gate.propose, true);
});

// The drift that motivated merging the two lists: `k8s_delete_orphan` was added to the switch in
// parseProposal and to neither of them, so a malformed delete_orphan got the "you proposed
// nothing" retry notice instead of its own required fields. Nothing failed; it was simply wrong.
//
// Parsing the source is the only way to enumerate what the switch accepts without restating every
// action's shape here, which is the duplication that caused this. Same instrument as
// skills/real.test.ts, which loads the shipped playbooks rather than fixtures of them.
test("every action parseProposal accepts has retry-notice prose", () => {
  const src = readFileSync(new URL("./proposal.ts", import.meta.url), "utf8");
  const accepted = [...src.matchAll(/case "(k8s_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(accepted.length >= 6, `expected the switch to still be there, found ${accepted.length} cases`);
  for (const action of accepted) {
    assert.match(retryNotice(`{"action":"${action}"}`), /RETRY\. Your previous answer named/, action);
  }
});

test("delete_orphan's notice names its kinds and where the object has to come from", () => {
  const notice = retryNotice('{"action":"k8s_delete_orphan","namespace":"shop"}');
  assert.match(notice, /named `k8s_delete_orphan`/);
  assert.match(notice, /orphanKeys/);
  assert.match(notice, /no delete for a secret or a PVC/);
});

// Scale's prose said "an integer of at least 1" after the schema had moved to min(0) for the
// quarantine. A notice that contradicts the schema teaches the model the wrong shape.
test("scale's notice matches the schema it is describing", () => {
  const notice = retryNotice('{"action":"k8s_scale","namespace":"shop"}');
  assert.doesNotMatch(notice, /at least 1/);
  assert.match(notice, /idleWorkloads/);
});

// ── "clean up" is a request only when it names the object ────────────────────
// One thread, 2026-09-18, the same two words carrying both intents four minutes apart. The
// request got no card, because "clean up" is in neither verb list of ACTION_INTENT.

const REQUEST = "i want to clean up this `devops-tools/Service/devops-agent-redis` cause its not used";
const QUESTION = "is there any unused resource that we can clean up?";
const agentSaysSafe =
  "You're correct — `devops-tools/Service/devops-agent-redis` is unused and safe to remove:\n" +
  "• No endpoints (no pods selecting it)\n• Not managed by GitOps (`managedBy: none`)";

test("a cleanup request that names the object proposes", () => {
  const gate = worthProposing(REQUEST, agentSaysSafe, false);
  assert.equal(gate.propose, true, gate.reason);
  assert.equal(gate.byUser, true, "a named request is the user's, not the agent's inference");
  assert.match(gate.reason, /named object/);
});

// The regression this must not reintroduce: adding "clean up" to ACTION_INTENT would card this.
test("the same words without a named object stay a question", () => {
  assert.equal(worthProposing(QUESTION, agentSaysSafe, false).propose, false);
  for (const q of [
    "anything we can clean up?",
    "is there anything in `devops-tools` we can clean up?", // backticked, but a namespace
    "bisa dibersihkan ga resource yang nganggur?",
  ]) {
    assert.equal(worthProposing(q, agentSaysSafe, false).propose, false, `carded a question: ${q}`);
  }
});

test("the named-object form works in both languages and for the other cleanup verbs", () => {
  for (const q of [
    "please get rid of `sample-apps/Service/orders-svc`",
    "prune `default/ConfigMap/old-config`",
    "tolong bersihkan `devops-tools/Service/devops-agent-redis`",
    "singkirkan `default/ConfigMap/order-configmap` dong",
  ]) {
    assert.equal(worthProposing(q, agentSaysSafe, false).propose, true, `refused a named request: ${q}`);
  }
});

// The documented fallback for a bare name: the agent offers, the reply carries `remove`, and the
// approval branch picks it up. Worth pinning, because it is the reason the miss is acceptable.
test("a bare unbackticked name is picked up by the approval branch on the next turn", () => {
  assert.equal(worthProposing("clean up devops-agent-redis", agentSaysSafe, false).propose, false);
  const next = worthProposing("ya", "", false, agentSaysSafe);
  assert.equal(next.propose, true, "the follow-up approval did not reach the proposal");
  assert.match(next.reason, /approved the change proposed in the previous turn/);
});

// Verbatim from the live thread, 2026-09-22: the offer arrived as "removal" / "deletion", not
// "remove", and the fallback above silently never fired.
test("an offer phrased as a noun ('deletion proposal') still opens the approval branch", () => {
  const offer =
    "The `devops-tools/devops-agent-redis` Service is unused (no endpoints) and marked as externally " +
    "managed (`managedBy: none`), so it's safe to consider for removal. Since it's not declared by Helm " +
    "or Flux, deletion won't be reverted by GitOps.\n\nShall I prepare a deletion proposal?";
  assert.equal(worthProposing("yes please", "", false, offer).propose, true);
});

// --- [OFFER]: the agent's structured signal, so the gate stops guessing from prose ---

const offered =
  "The `devops-tools/devops-agent-redis` Service has no endpoints and is not managed by GitOps.\n\n" +
  "[OFFER] delete `devops-tools/Service/devops-agent-redis`";

test("an [OFFER] line is read, and stripped from what Slack sees", () => {
  assert.equal(parseOffer(offered), "delete `devops-tools/Service/devops-agent-redis`");
  assert.equal(stripOffer(offered), "The `devops-tools/devops-agent-redis` Service has no endpoints and is not managed by GitOps.");
  // Small models bold labels; the marker must survive that.
  assert.equal(parseOffer("ok\n**[OFFER]** restart `payments/Deployment/api`"), "restart `payments/Deployment/api`");
});

test("an [OFFER] that names no object is not an offer", () => {
  assert.equal(parseOffer("[OFFER] clean up the unused stuff"), null);
  assert.equal(parseOffer("[OFFER] delete `devops-agent-redis`"), null);
});

// Verbatim live reply, 2026-09-22: the marker was the whole answer, and it reached Slack raw.
test("a reply that is only the marker is restated, never posted raw or empty", () => {
  assert.equal(stripOffer("[OFFER] delete `default/Service/unsueddd`"), "Proposed: delete `default/Service/unsueddd`.");
});

// The case that took four regex patches: bare name, "clean up", no verb the gate knows.
test("an offer proposes on the same turn, whatever words the user used", () => {
  const g = worthProposing("i think we can clean up devops-agent-redis", stripOffer(offered), false, "", parseOffer(offered));
  assert.equal(g.propose, true);
  assert.equal(g.byUser, false, "the words are the model's, so the replacement guard must still apply");
  assert.match(g.reason, /agent offered a change: delete `devops-tools\/Service\/devops-agent-redis`/);
});

test("no offer and no other signal still skips — the offer is additive", () => {
  assert.equal(worthProposing("is there any unused resource that we can clean up?", "Found 37 candidates.", false, "", null).propose, false);
});

// --- card promises: verbatim from the live thread, 2026-09-22 ---

test("a sentence promising a card is dropped", () => {
  const live =
    "The deletion of `devops-tools/devops-agent-redis` cannot be executed directly — it requires approval through the remediation workflow. " +
    "An action card to remove this orphaned Service will be posted for your approval shortly.";
  const r = dropCardPromises(live);
  assert.equal(r.dropped, 1);
  assert.doesNotMatch(r.text, /shortly/);
  assert.match(r.text, /cannot be executed directly/);
});

test("an invented delay is dropped, the fact beside it is kept", () => {
  const live =
    "No approval card was posted for the deletion of `devops-tools/devops-agent-redis`. " +
    "This typically happens when the action requires manual initiation or there's a system delay.";
  const r = dropCardPromises(live);
  assert.equal(r.text, "No approval card was posted for the deletion of `devops-tools/devops-agent-redis`.");
  const r2 = dropCardPromises("The approval card should appear momentarily — sometimes there's a brief delay in rendering the card after the action is triggered.\n\nOk.");
  assert.equal(r2.text, "Ok.");
});

test("a reply with no card talk passes through untouched", () => {
  const plain = "• `payments/api` — 3/3 ready.\n• No restarts in the last hour.";
  assert.deepEqual(dropCardPromises(plain), { text: plain, dropped: 0 });
});

// --- the log line that would have saved the trip into Redis ---

test("explainGate shows which check failed and what the previous reply said", () => {
  const prev = "...safe to consider for removal. Shall I prepare a deletion proposal?";
  const line = explainGate("where the proposal?", "No card was posted.", prev, null);
  assert.match(line, /approval=0/);
  assert.match(line, /offer=0/);
  assert.match(line, /prev="\.\.\.safe to consider for removal\. Shall I prepare a deletion proposal\?"/);
});

// --- an answer that asks for input is not a conclusion (incident 143, 2026-09-22) ---

test("the verbatim question that became remediation 86 blocks the proposal", () => {
  const live =
    "Could you provide the real `namespace` and `service/app` names to replace the placeholders `X` and `Y` " +
    "so I can re-run the batch queries for 5xx inbound/outbound errors and Loki logs?";
  assert.match(answerAsksForInput(live) ?? "", /provide the real `namespace`/);
});

test("a real RCA still proposes, question mark or not", () => {
  const rca =
    "*📍 Root Cause*\n1. [Symptom] `sample-apps/checkout-gateway` p99 is 1.07s — _prometheus_query_.\n" +
    "2. ← [why] orders-api response shape changed.\n\nIs a contract test worth adding here?";
  assert.equal(answerAsksForInput(rca), null);
  assert.equal(answerAsksForInput("No question at all, just findings about the namespace sample-apps."), null);
});

// The clause that separates a duplicate guard from a deadlock: `status` only leaves 'proposed'
// when somebody clicks, so a card nobody touched stays 'proposed' for ever.
test("pendingFor only counts cards still inside the approval window", async () => {
  let sql = "";
  const pool = { query: async (q: string) => { sql = q; return { rows: [] }; } } as never;
  await new RemediationStore(pool).pendingFor("k8s_scale:sample-apps/orders-api");
  assert.match(sql, /status = 'proposed'/);
  assert.match(sql, /created_at > now\(\) - interval '15 minutes'/);
  assert.equal(await new RemediationStore(null).pendingFor("x"), null);
});

test("pendingFor returns the card id when one is waiting", async () => {
  const pool = { query: async () => ({ rows: [{ id: "88" }] }) } as never;
  assert.equal(await new RemediationStore(pool).pendingFor("k8s_scale:sample-apps/orders-api"), 88);
});

// A card nobody clicks never leaves 'proposed': claimForExecution only expires the card somebody
// finally pressed, which is the one a human is already looking at.
test("expireStale closes past-window cards and says where their messages are", async () => {
  let sql = "";
  const pool = {
    query: async (q: string) => {
      sql = q;
      return { rows: [{ id: "88", card_channel: "C09R0F6F891", card_ts: "1790138104.557769", card_thread_ts: "1790138100.111111", summary: "scale `sample-apps/orders-api` → 3 replicas" }] };
    },
  } as never;
  const rows = await new RemediationStore(pool).expireStale();
  assert.match(sql, /SET status = 'rejected'/);
  assert.match(sql, /WHERE status = 'proposed' AND created_at <= now\(\) - interval '15 minutes'/);
  assert.deepEqual(rows, [{
    id: 88, channel: "C09R0F6F891", ts: "1790138104.557769", threadTs: "1790138100.111111",
    summary: "scale `sample-apps/orders-api` → 3 replicas",
  }]);
});

test("expireStale survives a database that is down, and a card with no message recorded", async () => {
  const broken = { query: async () => { throw new Error("connection refused"); } } as never;
  assert.deepEqual(await new RemediationStore(broken).expireStale(), []);
  assert.deepEqual(await new RemediationStore(null).expireStale(), []);
  const noCard = { query: async () => ({ rows: [{ id: "7", card_channel: null, card_ts: null, card_thread_ts: null, summary: "restart `ns/w`" }] }) } as never;
  assert.deepEqual(await new RemediationStore(noCard).expireStale(), [{ id: 7, channel: null, ts: null, threadTs: null, summary: "restart `ns/w`" }]);
});

test("recordCard stores the thread as well as the message", async () => {
  let args: unknown[] = [];
  const pool = { query: async (_q: string, a: unknown[]) => { args = a; return { rows: [] }; } } as never;
  await new RemediationStore(pool).recordCard(88, "C09R0F6F891", "1790138104.557769", "1790138100.111111");
  assert.deepEqual(args, [88, "C09R0F6F891", "1790138104.557769", "1790138100.111111"]);
});
