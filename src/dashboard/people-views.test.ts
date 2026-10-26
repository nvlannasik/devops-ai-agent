import { test } from "node:test";
import assert from "node:assert/strict";
import { accessWarnings, peoplePage, type PeopleView } from "./people-views.js";
import { matchRoute } from "./server.js";

const view = (o: Partial<PeopleView> = {}): PeopleView => ({
  oncall: [],
  approvers: [],
  allowed: [],
  activity: [],
  names: new Map(),
  namesError: null,
  ...o,
});
const NOW = new Date("2026-10-26T12:00:00Z");

test("/people is routed", () => {
  assert.deepEqual(matchRoute("/people"), { kind: "people" });
});

test("every open list is a warning, and closing them all clears the section", () => {
  assert.equal(accessWarnings(view()).length, 3);
  // approvers fall back to on-call, exactly as app/remediation.ts does — on-call alone closes approval
  assert.equal(accessWarnings(view({ oncall: ["U1"], allowed: ["U2"] })).length, 0);
  assert.doesNotMatch(peoplePage(view({ oncall: ["U1"], allowed: ["U2"] }), NOW), /Open access/);
});

test("roles, the on-call fallback, activity and the not-listed decider", () => {
  const html = peoplePage(
    view({
      oncall: ["UONCALL"],
      allowed: ["UALLOWED"],
      activity: [
        { user: "UONCALL", approved: 3, rejected: 1, lastApproval: new Date("2026-10-26T11:00:00Z") },
        { user: "UGHOST", approved: 1, rejected: 0, lastApproval: null },
      ],
      names: new Map([["UONCALL", "Dina <ops>"]]),
    }),
    NOW,
    2
  );
  assert.match(html, /approver \(via on-call\)/);
  assert.match(html, /Dina &lt;ops&gt;/, "a Slack name is escaped");
  assert.match(html, /<code translate="no">UALLOWED<\/code>/, "no name falls back to the id");
  assert.match(html, /not listed/, "a decider on no list is flagged");
  assert.match(html, /data-label="Approved \(30d\)">3</);
  assert.match(html, /<span class="rail-count">2/);
});

test("a failed name lookup says why", () => {
  const html = peoplePage(view({ oncall: ["U1"], namesError: "missing_scope" }), NOW);
  assert.match(html, /missing_scope/);
  assert.match(html, /users:read/);
});

test("nobody configured is an empty state, not an empty table", () => {
  const html = peoplePage(view(), NOW);
  assert.match(html, /No one is configured/);
  assert.doesNotMatch(html, /<table/);
});
