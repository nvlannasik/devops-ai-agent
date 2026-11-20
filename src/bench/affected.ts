// Which bench cases a change can move (2026-11-20, ideation E2).
//
// A full run is ~30 cases × minutes of a live cluster and a private LLM, so it is not what a prompt
// tweak should cost — and a filtered run picked by hand tends to pick the case the author was
// already thinking about. This picks from the diff instead, and says WHY each case is in:
//
//   - a case's own directory                         → that case
//   - `prompts/skills/<name>.md`                     → every case whose trigger SELECTS that skill,
//     computed with the agent's own registry (`loadSkills(...).select`) over the same text the
//     runner builds — `[mode:<m>]` + the group alert text or the message — so the mapping is
//     derived, never a hand-kept list that drifts when a `when:` regex changes
//   - node code (`agent/vm/`, the node gate, unsafe-advice) → every case about a node
//   - tour/onboarding code                           → tier D
//   - prompt injection                               → C08
//   - anything every run passes through (system prompt, loop, LLM, context, remediation, the
//     bench itself) or a skill that rides every run of a mode → the SMOKE set, one case per family
//
// A file no rule names is reported as unmapped rather than silently ignored. The output is a
// `--filter` regex for `npm run bench`; it never runs the full suite, and `--run` runs only the
// selection, once.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGroupAlertText } from "../agent/correlation/index.js";
import { loadSkills, type SkillRegistry } from "../agent/skills/index.js";
import { loadCases, type Case } from "./case.js";

/** One case per family: crash, OOM, scheduling, rollout, a quiet flap, scope, injection, approval, node, tour. */
export const SMOKE = ["A01", "A02", "A05", "A09", "C01", "C05", "C08", "C11", "C15", "D01"];

/** Paths every run goes through: a change here can move any case, so it costs the smoke set. */
const WIDE = [
  /^prompts\/system\.md$/,
  /^src\/agent\/(loop|llm|context|remediation|grounding|confidence|rca-completeness|runbook|subagent|mcp|cluster|scope|intent|changes)\//,
  /^src\/agent\/index\.ts$/,
  /^src\/bench\/(run|case|score)/,
  /^src\/utils\/slack\/blocks\.ts$/,
];
const NODE_CODE = [/^src\/agent\/vm\//, /^src\/agent\/remediation\/(node-gate|unsafe-advice)\.ts$/];
const TOUR_CODE = [/^src\/agent\/(onboarding|tour)/, /^src\/utils\/slack\/tour-tables\.ts$/];
const INJECTION_CODE = [/^src\/agent\/injection\//];
/** Not behaviour the bench exercises: tests, docs, the Slack app layer (the bench calls the agent, not
 *  SlackApp), the dashboard, replay, tracing, the VM-side agent, the daily digest (no run reads it). */
const IGNORED = [/\.test\.ts$/, /\.md$/, /^docs\//, /^src\/(app|dashboard|replay|tracing)\//, /^src\/agent\/digest\//, /^vm-agent\//, /^bench\/results\//, /^replay\//, /^migrations\//];

export interface Selection {
  cases: Map<string, Map<string, string[]>>; // case id → rule → the files that triggered it
  wide: string[]; // the files that cost the smoke set
  unmapped: string[];
}

/** The text the runner hands the skill selector for a case (bench/run.ts, minus the change timeline). */
export function triggerOf(c: Case): string {
  const body = c.mode === "alert" ? buildGroupAlertText(c.groupLabels!, c.alerts!, c.commonAnnotations) : [c.message, c.followUp].filter(Boolean).join("\n");
  return `[mode:${c.mode}]\n${body}`;
}

const isNodeCase = (c: Case): boolean =>
  /node/i.test(c.groupLabels?.alertname ?? "") || (c.alerts ?? []).some((a) => "node" in a.labels) || /\bnode\b/i.test(c.message ?? "");

export function selectCases(files: string[], cases: Case[], registry: SkillRegistry): Selection {
  const sel: Selection = { cases: new Map(), wide: [], unmapped: [] };
  const add = (id: string, rule: string, file = "") => {
    const r = sel.cases.get(id) ?? new Map<string, string[]>();
    const fs = r.get(rule) ?? [];
    if (file && !fs.includes(file)) fs.push(file);
    r.set(rule, fs);
    sel.cases.set(id, r);
  };
  const byPrefix = (p: string) => cases.find((c) => c.id.startsWith(`${p}-`));
  const selects = new Map(cases.map((c) => [c.id, new Set(registry.select(triggerOf(c), new Set()).selected.map((s) => s.name))]));
  const skills = registry.all();

  for (const f of files) {
    if (IGNORED.some((r) => r.test(f)) && !f.startsWith("prompts/") && !f.startsWith("bench/cases/")) continue;
    const own = f.match(/^bench\/cases\/([^/]+)\//);
    if (own) {
      if (cases.some((c) => c.id === own[1])) add(own[1]!, "its own files", f.slice(own[0].length));
      continue;
    }
    const skill = f.match(/^prompts\/skills\/([^/]+)\.md$/);
    if (skill) {
      const s = skills.find((x) => x.name === skill[1]);
      // `always`, or a skill keyed on the mode tag, rides every run of its mode: that is a wide change.
      if (!s || s.when === "always" || /mode:/.test(String(s.when))) {
        sel.wide.push(f);
        continue;
      }
      const hit = cases.filter((c) => selects.get(c.id)!.has(s.name));
      for (const c of hit) add(c.id, `selects skill ${s.name}`);
      if (hit.length === 0) sel.unmapped.push(`${f} (no case selects it)`);
      continue;
    }
    if (NODE_CODE.some((r) => r.test(f))) {
      for (const c of cases.filter(isNodeCase)) add(c.id, "node code", f);
      continue;
    }
    if (TOUR_CODE.some((r) => r.test(f))) {
      for (const c of cases.filter((x) => x.tier === "D")) add(c.id, "tour code", f);
      continue;
    }
    if (INJECTION_CODE.some((r) => r.test(f))) {
      const c = byPrefix("C08");
      if (c) add(c.id, "injection code", f);
      continue;
    }
    if (WIDE.some((r) => r.test(f))) {
      sel.wide.push(f);
      continue;
    }
    sel.unmapped.push(f);
  }

  if (sel.wide.length > 0) {
    for (const p of SMOKE) {
      const c = byPrefix(p);
      if (c) add(c.id, "smoke set (a change every run passes through)");
    }
  }
  return sel;
}

/** The `--filter` for `npm run bench`: catalog numbers, anchored and dash-terminated, so `A0` never matches `A01`. */
export function filterOf(ids: string[]): string {
  return `^(${[...new Set(ids.map((id) => id.split("-")[0]!))].sort().join("|")})-`;
}

export const describe = (rules: Map<string, string[]>): string =>
  [...rules].map(([rule, fs]) => (fs.length ? `${rule}: ${fs.join(", ")}` : rule)).join("; ");

/** Changed files: the branch against `base` (merge-base), plus the working tree and untracked files. */
export function changedFiles(base: string, cwd: string): string[] {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
  const out = new Set<string>();
  try {
    for (const f of git("diff", "--name-only", `${base}...HEAD`)) out.add(f);
  } catch {
    // no such base (a fresh clone without the remote ref): the working tree alone
  }
  for (const f of git("diff", "--name-only", "HEAD")) out.add(f);
  for (const f of git("ls-files", "--others", "--exclude-standard")) out.add(f);
  return [...out].sort();
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = arg("files")?.split(",").map((s) => s.trim()).filter(Boolean) ?? changedFiles(arg("base") ?? "origin/main", root);
  const cases = loadCases(join(root, "bench", "cases"));
  const sel = selectCases(files, cases, loadSkills(join(root, "prompts", "skills")));

  console.log(`changed files: ${files.length}`);
  if (sel.wide.length) console.log(`wide (smoke set): ${sel.wide.join(", ")}`);
  if (sel.unmapped.length) console.log(`unmapped (no case covers these): ${sel.unmapped.join(", ")}`);
  if (sel.cases.size === 0) {
    console.log("no bench case is affected — nothing to run.");
    return;
  }
  console.log(`\naffected cases (${sel.cases.size} of ${cases.length}):`);
  for (const [id, why] of [...sel.cases].sort()) console.log(`  ${id}  — ${describe(why)}`);
  const filter = filterOf([...sel.cases.keys()]);
  console.log(`\nnpm run bench -- --filter '${filter}'`);

  if (process.argv.includes("--run")) {
    const extra = process.argv.slice(process.argv.indexOf("--run") + 1);
    const r = spawnSync("npm", ["run", "-s", "bench", "--", "--filter", filter, ...extra], { cwd: root, stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
