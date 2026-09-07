// Task loading. The scenario SHAPE is k8s-ai-bench's — a directory holding setup, cleanup and
// a declaration of what "solved" means — because that shape is right and worth borrowing.
//
// Two things are ours. The alert is a real Alertmanager group rather than a chat prompt, so a
// task enters the agent through the door production uses. And the expectation is DATA, not a
// bash script: k8s-ai-bench needs a verifier per task because it diffs cluster state, and we
// do not, because the thing being judged is already structured JSON.
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
});

const Alert = z.object({
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).optional(),
  startsAt: z.string().optional(),
});

export const TaskFile = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  /** Skipped unless --all. Mirrors k8s-ai-bench's `disabled`, for a scenario that is not stable yet. */
  disabled: z.boolean().optional(),
  /** How long to wait after setup.sh before investigating — a CrashLoop needs restarts to accumulate. */
  settleSeconds: z.number().int().min(0).max(600).optional(),
  groupLabels: z.record(z.string(), z.string()),
  alerts: z.array(Alert).min(1),
  commonAnnotations: z.record(z.string(), z.string()).optional(),
  expect: Expectation,
});

export type Task = z.infer<typeof TaskFile> & { dir: string };

export function loadTasks(root: string, opts: { filter?: RegExp; all?: boolean } = {}): Task[] {
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const tasks: Task[] = [];
  for (const d of dirs) {
    const dir = join(root, d.name);
    // Parsed strictly and thrown on, not skipped: a task file with a typo'd expectation would
    // otherwise vanish from the run and take its failures with it, and the score would improve.
    const parsed = TaskFile.parse(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")));
    if (parsed.name !== d.name) {
      throw new Error(`bench task in ${dir} calls itself ${JSON.stringify(parsed.name)} — name must match the directory`);
    }
    if (parsed.disabled && !opts.all) continue;
    if (opts.filter && !opts.filter.test(parsed.name)) continue;
    tasks.push({ ...parsed, dir });
  }
  return tasks.sort((a, b) => (a.name < b.name ? -1 : 1));
}
