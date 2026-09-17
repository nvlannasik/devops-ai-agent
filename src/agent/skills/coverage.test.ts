import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSkills, resolveSkillsDir } from "./index.js";
import { buildGroupAlertText } from "../correlation/index.js";

/**
 * Every alert rule deployed to the cluster must select at least one playbook.
 *
 * A `when` that matches nothing does not error — the investigation runs, with no playbook, and
 * nothing anywhere says so. That already happened: `AppUnhandledRouteError` and `AppErrorLogSpike`
 * selected NOTHING for as long as they existed, because `high-error-rate` keys on metric
 * vocabulary (`5xx`, `error rate` with a space) and a log alertname contains neither. It was found
 * by reading a transcript, not by a test.
 *
 * The rules live in gitops-devops-ai-manifest, so this is a committed snapshot rather than a live
 * read: the repo may not be checked out beside this one, and a test that silently skips is worth
 * nothing. Refresh it deliberately when the rules change — the extraction is in the commit that
 * added this file.
 *
 * The trigger text is built by `buildGroupAlertText`, the same function the webhook path uses, so
 * this measures what selection will actually see and not an approximation of it.
 *
 * **This measures selection from the ALERT TEXT only, and that is stricter than production
 * needs.** `runInvestigation` re-runs selection against each tool result as it arrives, so a rule
 * that matches nothing here is not unguided — `pod-pending` is reached when the events say
 * `FailedScheduling`, and `forbidden` when a log line says so. Read a failure here as "this alert
 * starts its investigation with no playbook", which is worth fixing on its own (advice on round
 * one beats advice on round three), and NOT as "this fault has no playbook". The distinction was
 * missed once already: three playbooks were briefly called dead because nothing selected them at
 * alert time, and widening their triggers to fix that would have loaded Pending advice onto every
 * OOMKill that fires the same catch-all rule.
 *
 * **Second ceiling: this asserts that A playbook was selected, not that the RIGHT one was.** Found
 * while writing it — `KubernetesServiceHasNoReadyEndpoints` was matching `multi-pod-one-cause` by
 * accident while `service-unavailable`, written for exactly that alert, missed it: its pattern
 * said `no endpoints` and the rule says "no **ready** endpoints". The regex is fixed, but the hole
 * in this test is not: an accidental match still reads as coverage. Closing it needs a per-rule
 * expected-playbook map in the fixture, which is a judgement call for 37 rules and has not been
 * made yet.
 */
interface Rule {
  alertname: string;
  labels: Record<string, string>;
  summary: string;
  description: string;
}

const RULES: Rule[] = JSON.parse(readFileSync(new URL("./alert-rules.json", import.meta.url), "utf8"));

const triggerFor = (r: Rule): string =>
  buildGroupAlertText({ alertname: r.alertname, ...r.labels }, [
    { labels: { alertname: r.alertname, ...r.labels }, annotations: { summary: r.summary, description: r.description } },
  ]);

test("the snapshot still looks like the deployed rule set", () => {
  assert.ok(RULES.length >= 30, `expected the whole rule set, got ${RULES.length}`);
  for (const r of RULES) assert.ok(r.summary || r.description, `${r.alertname} has no annotations to select on`);
});

test("every deployed alert rule selects at least one playbook", () => {
  const registry = loadSkills(resolveSkillsDir());
  const naked = RULES.filter((r) => registry.select(triggerFor(r), new Set()).selected.every((s) => s.when === "always"));
  assert.deepEqual(
    naked.map((r) => r.alertname),
    [],
    `these alerts would be investigated with no playbook:\n  ${naked.map((r) => `${r.alertname} — ${r.summary}`).join("\n  ")}`
  );
});
