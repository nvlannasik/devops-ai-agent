import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKILL_MAX_CHARS = 8000;
export const MAX_MATCHED_SKILLS = 3;
export const TRIGGER_MAX_CHARS = 4000;

const REQUIRED_KEYS = ["name", "description", "when"] as const;
const NAME_RE = /^[a-z0-9-]+$/;

export interface Skill {
  name: string;
  description: string;
  /** "always" or a case-insensitive, global regex over the trigger text. */
  when: "always" | RegExp;
  body: string;
  /** Size of the whole file, frontmatter included — what the dashboard reports. */
  chars: number;
}

export interface Selection {
  selected: Skill[];
  /** Names that matched but lost to MAX_MATCHED_SKILLS. The caller logs them. */
  overflow: string[];
}

export interface SkillRegistry {
  all(): readonly Skill[];
  select(trigger: string, already: ReadonlySet<string>): Selection;
}

// Same two-candidate walk as resolvePromptPath() in ../prompts/system.ts: dev runs from src/,
// the container runs from dist/src/, and prompts/ sits at the project root in both.
export function resolveSkillsDir(): string {
  const candidates = [
    join(__dirname, "../../../prompts/skills"),
    join(__dirname, "../../../../prompts/skills"),
  ];
  for (const p of candidates) {
    try {
      readdirSync(p);
      return p;
    } catch {
      continue;
    }
  }
  throw new Error(`skills directory could not be read — tried ${candidates.join(" and ")}`);
}

function parseSkill(file: string, text: string): Skill {
  if (text.length > SKILL_MAX_CHARS) {
    throw new Error(`${file}: ${text.length} chars exceeds SKILL_MAX_CHARS (${SKILL_MAX_CHARS})`);
  }
  const { keys, body } = parseFrontmatter(text, file);

  for (const k of REQUIRED_KEYS) {
    if (!keys[k]) throw new Error(`${file}: missing required key "${k}"`);
  }
  // Unknown keys are an error, not a shrug: a typo'd key is a skill that silently does something
  // other than what its author wrote.
  for (const k of Object.keys(keys)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(k)) {
      throw new Error(`${file}: unknown key "${k}" (allowed: ${REQUIRED_KEYS.join(", ")})`);
    }
  }

  const name = keys.name!;
  if (!NAME_RE.test(name)) {
    throw new Error(`${file}: name "${name}" must match ${NAME_RE.source}`);
  }
  if (!body) throw new Error(`${file}: body is empty`);

  let when: "always" | RegExp = "always";
  if (keys.when !== "always") {
    try {
      // `g` so distinct matches can be counted; `i` so a skill author never has to think
      // about the case an alert label happens to arrive in.
      when = new RegExp(keys.when!, "gi");
    } catch (err) {
      throw new Error(`${file}: when is not a valid regex — ${(err as Error).message}`);
    }
  }

  return { name, description: keys.description!, when, body, chars: text.length };
}

function selectFrom(skills: readonly Skill[], trigger: string, already: ReadonlySet<string>): Selection {
  const text = trigger.slice(0, TRIGGER_MAX_CHARS);

  const selected: Skill[] = [];
  const scored: { skill: Skill; hits: number }[] = [];

  for (const s of skills) {
    if (already.has(s.name)) continue;
    if (s.when === "always") {
      selected.push(s);
      continue;
    }
    // matchAll clones the regex, so the `g` flag's lastIndex is never shared between calls.
    // Distinct substrings, not raw count: a word repeated 40 times is one signal, not forty.
    const hits = new Set([...text.matchAll(s.when)].map((m) => m[0].toLowerCase())).size;
    if (hits > 0) scored.push({ skill: s, hits });
  }

  scored.sort((a, b) => b.hits - a.hits || a.skill.name.localeCompare(b.skill.name));
  return {
    selected: [...selected, ...scored.slice(0, MAX_MATCHED_SKILLS).map((x) => x.skill)],
    overflow: scored.slice(MAX_MATCHED_SKILLS).map((x) => x.skill.name),
  };
}

/**
 * Reads and validates a whole skills directory. Throws on the first problem — a malformed skill
 * must be a pod that refuses to start, not an agent that investigates correctly and then answers
 * in a shape nothing downstream can parse.
 */
export function loadSkills(dir: string): SkillRegistry {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    throw new Error(`skills directory ${dir} could not be read — ${(err as Error).message}`);
  }
  if (files.length === 0) {
    throw new Error(`skills directory ${dir} holds no .md files — an agent with no skills has no RCA output format`);
  }

  const skills: Skill[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const skill = parseSkill(f, readFileSync(join(dir, f), "utf-8"));
    const prev = seen.get(skill.name);
    if (prev) throw new Error(`duplicate skill name "${skill.name}" in ${prev} and ${f}`);
    seen.set(skill.name, f);
    skills.push(skill);
  }

  return {
    all: () => skills,
    select: (trigger, already) => selectFrom(skills, trigger, already),
  };
}
