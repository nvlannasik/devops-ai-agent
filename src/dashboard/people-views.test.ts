import { test } from "node:test";
import assert from "node:assert/strict";
import { accessPolicy, initials, peoplePage, type PeopleView } from "./people-views.js";
import { matchRoute } from "./server.js";

const view = (o: Partial<PeopleView> = {}): PeopleView => ({
  oncall: [],
  approvers: [],
  allowed: [],
  activity: [],
  profiles: new Map(),
  profilesError: null,
  ...o,
});
const NOW = new Date("2026-10-26T12:00:00Z");
const open = (v: PeopleView) => accessPolicy(v).filter((r) => r.open).map((r) => r.fix);

test("/people is routed", () => {
  assert.deepEqual(matchRoute("/people"), { kind: "people" });
});

test("the policy mirrors what the agent enforces", () => {
  assert.deepEqual(open(view()), ["SLACK_APPROVER_USERS", "SLACK_ALLOWED_USERS", "SLACK_ONCALL_USERS"]);
  // approvers fall back to on-call, exactly as app/remediation.ts does — on-call alone closes approval
  assert.deepEqual(open(view({ oncall: ["U1"], allowed: ["U2"] })), []);
  // slackUserAllowed admits allowed ∪ on-call ∪ approvers once the allowlist is set
  const mention = accessPolicy(view({ oncall: ["U1"], approvers: ["U3"], allowed: ["U2", "U1"] }))[1]!;
  assert.match(mention.who, /^3 people/);
});

test("initials: first and last word, '?' without a name", () => {
  assert.equal(initials("Noval Annasik"), "NA");
  assert.equal(initials("Dina Ayu Pratiwi"), "DP");
  assert.equal(initials("cher"), "CH");
  assert.equal(initials(undefined), "?");
});

test("members: name, title, roles, activity, the not-listed decider and a deactivated account", () => {
  const html = peoplePage(
    view({
      oncall: ["UONCALL", "UGONE"],
      allowed: ["UALLOWED"],
      activity: [
        { user: "UONCALL", approved: 3, rejected: 1, lastApproval: new Date("2026-10-26T11:00:00Z") },
        { user: "UGHOST", approved: 1, rejected: 0, lastApproval: null },
      ],
      profiles: new Map([
        ["UONCALL", { name: "Dina <ops>", title: "SRE", handle: "dina" }],
        ["UGONE", { name: "Former Person", deleted: true }],
      ]),
    }),
    NOW,
    2
  );
  assert.match(html, /approver · via on-call/);
  assert.match(html, /Dina &lt;ops&gt;/, "a Slack name is escaped");
  assert.match(html, /SRE · @dina · <code translate="no">UONCALL<\/code>/);
  assert.match(html, /<code translate="no">UALLOWED<\/code><\/strong><span class="meta">No Slack profile/);
  assert.match(html, /not listed/, "a decider on no list is flagged");
  assert.match(html, /deactivated/);
  assert.match(html, /style="--a:75"/, "3 of 4 decisions approved");
  assert.match(html, /<span class="rail-count">2/);
  // the decider on no list sorts last
  assert.ok(html.indexOf("UGHOST") > html.indexOf("Former Person"));
});

test("a failed profile lookup says why", () => {
  const html = peoplePage(view({ oncall: ["U1"], profilesError: "missing_scope" }), NOW);
  assert.match(html, /missing_scope/);
  assert.match(html, /users:read/);
});

test("nobody configured: the policy is all open and the members section is an empty state", () => {
  const html = peoplePage(view(), NOW);
  assert.match(html, /No one is configured/);
  assert.equal([...html.matchAll(/>open</g)].length, 3);
});
