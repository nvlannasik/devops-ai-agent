// Case loading for docs/BENCHMARK_agent_stack.md — the id, the tier and the bench-<id>
// namespace convention are that document's, and the catalog there is what a case is ported
// FROM. This file implements one axis of the six that document scores: the proposal.
//
// The directory SHAPE (setup / cleanup / a declaration of what solved means) is k8s-ai-bench's
// and worth borrowing. Two things are ours. The trigger is a real Alertmanager group rather
// than a chat prompt, so a case enters through the door production uses. And the expectation
// is DATA, not a bash script: k8s-ai-bench needs a verifier per task because it diffs cluster
// state, and we do not, because the artefact being judged is already structured JSON.
//
// JSON rather than YAML for one boring reason: no YAML parser is a dependency here and this
// did not justify adding one. zod already validates the other structured input in this repo.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { wantsInvestigation } from "../agent/intent/index.js";

const Expectation = z.object({
  action: z.string().nullable(),
  namespace: z.string().optional(),
  target: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  changed: z.record(z.string(), z.string()).optional(),
  greaterThan: z.record(z.string(), z.string()).optional(),
  rca: z
    .object({ must: z.array(z.string()).optional(), mustNot: z.array(z.string()).optional() })
    // Compiled at load, not at scoring time: a bad pattern in a case file should stop the run
    // before the first namespace is created, not three hours in on the attempt that hits it.
    .refine(
      (v) => [...(v.must ?? []), ...(v.mustNot ?? [])].every((src) => {
        try { new RegExp(src, "i"); return true; } catch { return false; }
      }),
      "rca patterns must be valid regular expressions"
    )
    .optional(),
});

const Alert = z.object({
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).optional(),
  startsAt: z.string().optional(),
});

/**
 * Which door the case enters through. The benchmark measured only `alert` for its first sixteen
 * cases, while production has three — and two of the three had bugs land in one week that nothing
 * here could see: a log-gap nudge overwriting a correct conversation answer, and conversation mode
 * losing its mrkdwn rules. A run mode nothing exercises is a run mode nobody measures.
 */
const Mode = z.enum(["alert", "investigation", "conversation"]);

export const CaseFile = z.object({
  /** The catalog id from docs/BENCHMARK_agent_stack.md — A02, C01, E04. Also the directory name. */
  id: z.string().regex(/^[A-F]\d{2}-[a-z0-9-]+$/, "id must look like A02-oomkilled-at-limit"),
  tier: z.enum(["A", "B", "C", "D", "E", "F"]),
  title: z.string().min(1),
  /** Skipped unless --all, for a scenario that is not stable yet. */
  disabled: z.boolean().optional(),
  /** How long to wait after setup.sh before investigating — a CrashLoop needs restarts to accumulate. */
  settleSeconds: z.number().int().min(0).max(600).optional(),
  /** Defaults to `alert`, which is what every case written before this field assumed. */
  mode: Mode.default("alert"),
  /** The Slack text, for a case that enters as a mention rather than as an Alertmanager group. */
  message: z.string().min(1).optional(),
  /**
   * A SECOND mention in the same thread, scored instead of the first.
   *
   * The gate's approval branch — "the agent put a change on the table, the human said ya" — lives
   * across two turns, and the runner passed `previousReply: ""` to `worthProposing`, so it was the
   * one path production has that the benchmark could not reach. It broke twice in a week
   * (fb2ea94, c44f704) and both times the tests were green.
   */
  followUp: z.string().min(1).optional(),
  groupLabels: z.record(z.string(), z.string()).optional(),
  alerts: z.array(Alert).min(1).optional(),
  commonAnnotations: z.record(z.string(), z.string()).optional(),
  expect: Expectation,
})
  // An alert case needs an alert group; a mention case needs something for the human to have
  // said. Enforced here rather than in the runner so a half-written case file fails at load,
  // before the first namespace is created — the same reason the rca patterns compile here.
  .refine(
    (c) => (c.mode === "alert" ? !!c.alerts && !!c.groupLabels : !!c.message),
    "an alert case needs groupLabels + alerts; an investigation or conversation case needs message"
  )
  .refine((c) => !c.followUp || c.mode !== "alert", "followUp is a second mention; an alert group has no second turn");

export type Case = z.infer<typeof CaseFile> & { dir: string };

export function loadCases(root: string, opts: { filter?: RegExp; all?: boolean } = {}): Case[] {
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const cases: Case[] = [];
  for (const d of dirs) {
    const dir = join(root, d.name);
    // Parsed strictly and thrown on, not skipped: a case file with a typo'd expectation would
    // otherwise vanish from the run and take its failures with it, and the score would improve.
    const parsed = CaseFile.parse(JSON.parse(readFileSync(join(dir, "case.json"), "utf8")));
    // Production does not take the mode from a file — it asks `wantsInvestigation()` about the
    // text. A case that declares one mode while that classifier picks the other is testing a path
    // Slack would never route it down, and it would go on saying so silently after any change to
    // the classifier. Cheap to check, and it makes the case file pin that behaviour too.
    if (parsed.mode !== "alert") {
      const production = wantsInvestigation(parsed.message!) ? "investigation" : "conversation";
      if (production !== parsed.mode) {
        throw new Error(
          `bench case ${parsed.id} declares mode ${JSON.stringify(parsed.mode)} but wantsInvestigation() ` +
          `routes its message to ${JSON.stringify(production)} — production would not run it the way this case asserts`
        );
      }
    }
    if (parsed.id !== d.name) {
      throw new Error(`bench case in ${dir} calls itself ${JSON.stringify(parsed.id)} — id must match the directory`);
    }
    if (parsed.tier !== parsed.id[0]) {
      throw new Error(`bench case ${parsed.id} declares tier ${parsed.tier}; the id says tier ${parsed.id[0]}`);
    }
    if (parsed.disabled && !opts.all) continue;
    if (opts.filter && !opts.filter.test(parsed.id)) continue;
    cases.push({ ...parsed, dir });
  }
  return cases.sort((a, b) => (a.id < b.id ? -1 : 1));
}
