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

export const CaseFile = z.object({
  /** The catalog id from docs/BENCHMARK_agent_stack.md — A02, C01, E04. Also the directory name. */
  id: z.string().regex(/^[A-F]\d{2}-[a-z0-9-]+$/, "id must look like A02-oomkilled-at-limit"),
  tier: z.enum(["A", "B", "C", "D", "E", "F"]),
  title: z.string().min(1),
  /** Skipped unless --all, for a scenario that is not stable yet. */
  disabled: z.boolean().optional(),
  /** How long to wait after setup.sh before investigating — a CrashLoop needs restarts to accumulate. */
  settleSeconds: z.number().int().min(0).max(600).optional(),
  groupLabels: z.record(z.string(), z.string()),
  alerts: z.array(Alert).min(1),
  commonAnnotations: z.record(z.string(), z.string()).optional(),
  expect: Expectation,
});

export type Case = z.infer<typeof CaseFile> & { dir: string };

export function loadCases(root: string, opts: { filter?: RegExp; all?: boolean } = {}): Case[] {
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const cases: Case[] = [];
  for (const d of dirs) {
    const dir = join(root, d.name);
    // Parsed strictly and thrown on, not skipped: a case file with a typo'd expectation would
    // otherwise vanish from the run and take its failures with it, and the score would improve.
    const parsed = CaseFile.parse(JSON.parse(readFileSync(join(dir, "case.json"), "utf8")));
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
