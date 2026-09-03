import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentMemory, parseSeverity, extractRootCause, queryTerms } from "./index.js";

const SAMPLE_RCA = [
  "🔴 *Critical Severity Incident*",
  "",
  "*📍 Root Cause*",
  "Pod payment-api-xxx OOMKilled — memory leak in connection pool.",
  "",
  "*📊 Evidence*",
  "• Pod restarted 15x in 30min",
  "",
  "*📈 Confidence:* `High`",
].join("\n");

test("parseSeverity reads the severity label", () => {
  assert.equal(parseSeverity("*🔴 Severity:* `critical`"), "critical");
  assert.equal(parseSeverity("no severity here"), null);
});

// parseSeverity feeds `assessed_severity`, which is the agent's OWN impact scale. A value
// outside it is the model failing to fill the template in, and null ("not assessed") is the
// honest reading — a stray string would be stored and recalled as if it were a judgement.
test("parseSeverity rejects anything outside the agent's own scale", () => {
  for (const level of ["critical", "High", "MEDIUM", "low"]) {
    assert.equal(parseSeverity(`*🔴 Severity:* \`${level}\``), level.toLowerCase());
  }
  // the template's placeholder, emitted verbatim
  assert.equal(parseSeverity("*[emoji] Severity:* `[Critical|High|Medium|Low]`"), null);
  // Alertmanager's vocabulary, which is the other column's job
  assert.equal(parseSeverity("*🟡 Severity:* `warning`"), null);
  assert.equal(parseSeverity("*🔵 Severity:* `info`"), null);
  assert.equal(parseSeverity("*🔴 Severity:* `it depends`"), null);
});

test("extractRootCause pulls only the Root Cause section", () => {
  const cause = extractRootCause(SAMPLE_RCA);
  assert.equal(cause, "Pod payment-api-xxx OOMKilled — memory leak in connection pool.");
});

test("extractRootCause returns null when absent", () => {
  assert.equal(extractRootCause("just some text"), null);
});

test("recall/store are safe no-ops when Postgres is disabled (pool=null)", async () => {
  const mem = new IncidentMemory(null);
  assert.equal(await mem.recall({ alertname: "X", namespace: "ns" }), "");
  assert.equal(await mem.store({ alertname: "X" }, SAMPLE_RCA), null); // no id when disabled
  await mem.close(); // must not throw
});

test("store returns the inserted id and persists the Slack thread link", async () => {
  let captured: { sql: string; params: unknown[] } | null = null;
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return { rows: [{ id: "42" }] }; // pg returns BIGSERIAL as string
    },
  } as any;
  const mem = new IncidentMemory(fakePool);

  const id = await mem.store({ alertname: "X", namespace: "ns" }, SAMPLE_RCA, { channel: "C123", threadTs: "1720.99" });
  assert.equal(id, 42);
  assert.match(captured!.sql, /RETURNING id/);
  // channel, thread_ts, and the group identity the dedup claim was taken under — without
  // that last one nothing outside the resolved webhook can release the claim
  assert.deepEqual(captured!.params.slice(-3), ["C123", "1720.99", '{"alertname":"X","namespace":"ns"}']);
});

test("store fires onStored with the inserted id and thread ts (the usage backfill link)", async () => {
  const fakePool = { query: async () => ({ rows: [{ id: "42" }] }) } as any;
  const calls: Array<[number, string]> = [];
  const mem = new IncidentMemory(fakePool, (id, ts) => calls.push([id, ts]));

  const id = await mem.store({ alertname: "X" }, SAMPLE_RCA, { channel: "C123", threadTs: "1720.99" });

  assert.equal(id, 42);
  assert.deepEqual(calls, [[42, "1720.99"]]);
});

test("store does NOT fire onStored without a Slack thread — nothing to link", async () => {
  const fakePool = { query: async () => ({ rows: [{ id: "42" }] }) } as any;
  const calls: Array<[number, string]> = [];
  const mem = new IncidentMemory(fakePool, (id, ts) => calls.push([id, ts]));

  const id = await mem.store({ alertname: "X" }, SAMPLE_RCA); // no slack argument

  assert.equal(id, 42);
  assert.deepEqual(calls, []);
});

test("recall returns '' without an alertname to key on", async () => {
  // a fake pool would never be hit because the alertname guard returns first
  const mem = new IncidentMemory({ query: async () => assert.fail("should not query") } as any);
  assert.equal(await mem.recall({ namespace: "ns" }), "");
});

test("recall renders the CONFIRMED tier above the hypothesis tier", async () => {
  const fakePool = {
    query: async (sql: string) =>
      sql.includes("incident_feedback")
        ? { rows: [{ created_at: "2026-07-01", confirmed_root_cause: "pool exhausted", action_taken: "scaled to 4", outcome: "resolved" }] }
        : { rows: [{ created_at: "2026-06-19", severity: "critical", confidence: "High", root_cause: "OOM leak" }] },
  } as any;
  const out = await new IncidentMemory(fakePool).recall({ alertname: "X", namespace: "payment" });
  assert.match(out, /Previously CONFIRMED by on-call/);
  assert.match(out, /pool exhausted; action: scaled to 4; outcome: resolved/);
  assert.match(out, /Prior similar incidents/);
  assert.ok(out.indexOf("CONFIRMED") < out.indexOf("Prior similar"), "confirmed tier must come first");
});

// ---- similarity tier (migrations/005) ----

test("queryTerms splits CamelCase — an alert name is one token to a tokenizer", () => {
  const terms = queryTerms("KubePodCrashLooping OOMKilled");
  assert.deepEqual(terms, ["kube", "crash", "looping", "killed"]);
  // "pod" and "oom" are dropped by the 4-char floor, not by the envelope list
});

test("queryTerms drops the envelope vocabulary every alert carries", () => {
  // these would manufacture overlap between two incidents that have nothing in common
  assert.deepEqual(queryTerms("alertname severity critical namespace payments firing"), ["payments"]);
});

test("queryTerms drops bare numbers, short tokens, and duplicates", () => {
  assert.deepEqual(queryTerms("memory 8080 3 limit memory MEMORY exceeded"), ["memory", "limit", "exceeded"]);
});

test("queryTerms caps the term count — a whole RCA must not become one huge tsquery", () => {
  const long = Array.from({ length: 60 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
  assert.equal(queryTerms(long).length, 24);
});

test("recall skips the similarity tier entirely without queryText", async () => {
  const seen: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      seen.push(sql);
      return { rows: [] };
    },
  } as any;
  await new IncidentMemory(fakePool).recall({ alertname: "X", namespace: "payments" });
  assert.equal(seen.length, 2, "only the two exact-match tiers should be queried");
  assert.ok(!seen.some((s) => s.includes("root_cause_tsv")), "no similarity query without queryText");
});

test("recall renders the similarity tier last and labels it as the weakest", async () => {
  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("incident_feedback")) return { rows: [] };
      if (sql.includes("root_cause_tsv")) {
        return {
          rows: [
            { created_at: "2026-06-01T00:00:00Z", alertname: "NodeMemoryPressure", namespace: "payments", root_cause: "node ran out of memory", overlap: 3 },
          ],
        };
      }
      return { rows: [{ created_at: "2026-06-19", severity: "critical", confidence: "High", root_cause: "OOM leak" }] };
    },
  } as any;
  const out = await new IncidentMemory(fakePool).recall(
    { alertname: "KubePodCrashLooping", namespace: "payments" },
    { queryText: "KubePodCrashLooping container OOMKilled memory limit exceeded" }
  );
  assert.match(out, /Possibly related/);
  assert.match(out, /NodeMemoryPressure in payments \(3 shared terms\)/);
  assert.match(out, /NOT a causal link/);
  assert.ok(out.indexOf("Prior similar") < out.indexOf("Possibly related"), "weakest tier must come last");
});

test("a similarity-tier failure never breaks recall — the other two tiers stand alone", async () => {
  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("root_cause_tsv")) throw new Error("relation root_cause_tsv does not exist");
      if (sql.includes("incident_feedback")) return { rows: [] };
      return { rows: [{ created_at: "2026-06-19", severity: "critical", confidence: "High", root_cause: "OOM leak" }] };
    },
  } as any;
  const out = await new IncidentMemory(fakePool).recall({ alertname: "X" }, { queryText: "memory limit exceeded" });
  assert.match(out, /Prior similar incidents/);
  assert.doesNotMatch(out, /Possibly related/);
});

test("storeFeedback maps a unique violation to 'duplicate' and null pool to 'failed'", async () => {
  const fb = { slackUser: "U1", triggerKey: "123.45", rawExcerpt: "…", confirmed_root_cause: "x", action_taken: null, outcome: "resolved" };
  const dupPool = { query: async () => { const e: any = new Error("dup"); e.code = "23505"; throw e; } } as any;
  assert.equal(await new IncidentMemory(dupPool).storeFeedback(1, fb), "duplicate");
  assert.equal(await new IncidentMemory(null).storeFeedback(1, fb), "failed");
});

test("findIncidentByThread maps the row id (pg returns BIGSERIAL as string)", async () => {
  const mem = new IncidentMemory({ query: async () => ({ rows: [{ id: "7" }] }) } as any);
  assert.equal(await mem.findIncidentByThread("C1", "111.22"), 7);
  const empty = new IncidentMemory({ query: async () => ({ rows: [] }) } as any);
  assert.equal(await empty.findIncidentByThread("C1", "111.22"), null);
});

test("markResolved flips the newest unresolved incident and returns its thread", async () => {
  let captured: { sql: string; params: unknown[] } | null = null;
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return { rows: [{ channel: "C123", thread_ts: "1720.99" }] };
    },
  } as any;
  const mem = new IncidentMemory(fakePool);
  const thread = await mem.markResolved({ alertname: "X", namespace: "ns" });
  assert.deepEqual(thread, { channel: "C123", threadTs: "1720.99" });
  assert.match(captured!.sql, /resolved_at IS NULL/);
  assert.match(captured!.sql, /ORDER BY created_at DESC LIMIT 1/);

  // no matching unresolved incident → null (and rows without a thread → null too)
  const empty = new IncidentMemory({ query: async () => ({ rows: [] }) } as any);
  assert.equal(await empty.markResolved({ alertname: "X" }), null);
});

// --- severity vs assessed_severity (migration 008) --------------------------------------
//
// The bug this pins: rca-format.md used to print `*🔴 Severity:* \`Critical\`` as a literal
// under "Output EXACTLY this structure", so models copied it through. store() then preferred
// the parsed RCA value over the alert's label, and an alert that fired as `warning` was
// recorded as `critical` — contradicting the Slack card, which renders the label.
const COPIED_TEMPLATE_RCA = [
  "*🔴 Severity:* `Critical`",
  "",
  "*📍 Root Cause*",
  "checkout-gateway times out at 50ms.",
].join("\n");

test("a warning alert whose RCA claims Critical stores BOTH, and severity stays the label", async () => {
  let captured: unknown[] = [];
  const fakePool = {
    query: async (_sql: string, params: unknown[]) => {
      captured = params;
      return { rows: [{ id: "7" }] };
    },
  } as any;
  const mem = new IncidentMemory(fakePool);

  await mem.store({ alertname: "HighLatency", namespace: "sample-apps", severity: "warning" }, COPIED_TEMPLATE_RCA);
  // INSERT (alertname, namespace, severity, assessed_severity, confidence, ...)
  assert.equal(captured[2], "warning", "severity must be the Alertmanager label Slack rendered");
  assert.equal(captured[3], "critical", "the RCA's judgement belongs in assessed_severity");
});

test("the caller's group-resolved severity wins over the label map", async () => {
  let captured: unknown[] = [];
  const fakePool = {
    query: async (_sql: string, params: unknown[]) => ((captured = params), { rows: [{ id: "8" }] }),
  } as any;
  const mem = new IncidentMemory(fakePool);

  // groupLabels carried no severity (a mixed-severity group drops it from commonLabels);
  // app/index.ts resolved it off the first firing alert and passes it in explicitly, because
  // writing it back into the label map would change the dedup fingerprint.
  await mem.store({ alertname: "X" }, COPIED_TEMPLATE_RCA, undefined, "Warning");
  assert.equal(captured[2], "warning");
});

test("an unassessed RCA leaves assessed_severity null without touching severity", async () => {
  let captured: unknown[] = [];
  const fakePool = {
    query: async (_sql: string, params: unknown[]) => ((captured = params), { rows: [{ id: "9" }] }),
  } as any;
  const mem = new IncidentMemory(fakePool);

  // the recurrence shortcut: a conversational reply, no RCA template at all
  await mem.store({ alertname: "X", severity: "info" }, "Known recurrence \u2014 same connection pool leak as last week.");
  assert.equal(captured[2], "info");
  assert.equal(captured[3], null);
});

test("recall reports the alert level and the assessed level separately", async () => {
  const fakePool = {
    query: async (sql: string) =>
      sql.includes("incident_feedback")
        ? { rows: [] }
        : {
            rows: [
              { created_at: "2026-08-30", severity: "warning", assessed_severity: "critical", confidence: "High", root_cause: "gateway timeout too low" },
              { created_at: "2026-08-29", severity: "critical", assessed_severity: null, confidence: null, root_cause: "node pressure" },
            ],
          },
  } as any;
  const out = await new IncidentMemory(fakePool).recall({ alertname: "HighLatency", namespace: "sample-apps" });
  assert.match(out, /alert warning, assessed critical, confidence High/);
  assert.match(out, /alert critical, not assessed, confidence \?/);
});
