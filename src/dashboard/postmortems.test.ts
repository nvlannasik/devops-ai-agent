import test from "node:test";
import assert from "node:assert/strict";
import { DashboardQueries } from "./queries.js";
import { matchRoute, METHODS } from "./server.js";
import { layout, postmortemPage, postmortemsPage } from "./views.js";

// /postmortems (2026-10-22): the drafts get their own rail item, instead of being reachable only
// from the incident page that has one.

type Call = { sql: string; params: unknown[] };
const stub = (calls: Call[], rowsFor: (sql: string) => unknown[] = () => []) =>
  ({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
    end: async () => {},
    on: () => {},
  }) as never;

const at = new Date("2026-10-14T10:20:00Z");
const ROW = {
  incidentId: 7, alertname: "KubePodCrashLooping", namespace: "sample-apps", severity: "critical",
  createdAt: at, requestedBy: "U1", backend: "claude", revisions: 2,
};

test("postmortems lists the newest draft per incident, with its revision count, never the markdown", async () => {
  const calls: Call[] = [];
  const q = new DashboardQueries(stub(calls, () => [{
    incident_id: "7", alertname: "KubePodCrashLooping", namespace: "sample-apps", severity: "critical",
    created_at: at, requested_by: "U1", backend: "claude", revisions: "2",
  }]));
  assert.deepEqual(await q.postmortems(), [ROW]);
  const sql = calls[0]!.sql;
  assert.match(sql, /FROM postmortems/);
  assert.match(sql, /JOIN incidents/);
  assert.match(sql, /count\(\*\)/i);
  assert.match(sql, /ORDER BY .*created_at DESC/s);
  assert.match(sql, /\bLIMIT 100\b/);
  assert.doesNotMatch(sql, /markdown/, "a list has no use for the draft bodies");
});

test("postmortems is empty with no database", async () => {
  assert.deepEqual(await new DashboardQueries(null).postmortems(), []);
});

test("matchRoute knows /postmortems, GET-only", () => {
  assert.deepEqual(matchRoute("/postmortems"), { kind: "postmortems" });
  assert.deepEqual(matchRoute("/postmortems/"), { kind: "postmortems" });
  assert.equal("postmortems" in METHODS, false);
});

const current = (html: string) => [...html.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]);

test("the rail has Postmortems under Monitor, right after Incidents", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /<span class="lbl">Postmortems<\/span>/);
  const order = [...html.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.equal(order[order.indexOf("/incidents") + 1], "/postmortems");
});

test("postmortemsPage links each row to its draft and its incident, escaped, and is the current rail item", () => {
  const html = postmortemsPage([{ ...ROW, alertname: "<b>x</b>" }], new Date("2026-10-14T11:00:00Z"));
  assert.deepEqual(current(html), ["/postmortems"]);
  assert.match(html, /href="\/incidents\/7\/postmortem"/);
  assert.match(html, /href="\/incidents\/7"/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /data-label="Revisions">2</);
  assert.match(html, /U1/);
  assert.match(html, /claude/);
});

test("postmortemsPage with no drafts says how one is made", () => {
  const html = postmortemsPage([]);
  assert.match(html, /No postmortem drafts yet/);
  assert.match(html, /@agent postmortem/);
});

test("a draft page marks Postmortems current and links back to the list", () => {
  const html = postmortemPage(7, { id: 3, createdAt: at, requestedBy: "U1", backend: "claude", markdown: "# D" });
  assert.deepEqual(current(html), ["/postmortems"]);
  assert.match(html, /href="\/postmortems"[^>]*>← All postmortems/);
  assert.match(html, /href="\/incidents\/7"/);
});
