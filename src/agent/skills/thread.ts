import { type Skill, type SkillRegistry } from "../skills/index.js";
import logger from "../../utils/logger/index.js";
import { isShapeSkill } from "../loop/log-gap.js";
import { MAX_TRACKED_THREADS, keysOnMode } from "../loop/control.js";

// Ceiling on the playbooks one investigation may accumulate. Selection runs again on every
// tool round (see runInvestigation), and each of those rounds may match up to
// MAX_MATCHED_SKILLS more — without a ceiling a long investigation ends up carrying the whole
// directory. Earliest wins: the alert's own playbook outranks one a later log line suggested.
export const MAX_THREAD_SKILLS = 5;

/**
 * How many matched playbooks a thread carries into its NEXT turn.
 *
 * MAX_THREAD_SKILLS alone is a one-way ratchet: `selectForThread` only ever adds, so a
 * conversation that reaches the cap is frozen on the playbooks it happened to pick up and no
 * later question can load its own. Measured on thread 1789488072 (2026-09-15): turn 5 filled all
 * five slots with `rca-format, pod-pending, pod-not-ready, multi-pod-one-cause,
 * resource-rightsizing`, and the seven turns after it — including "investigasi kenapa prometheus
 * query nya kosong" — ran on that same frozen set. Two of those turns also tripped the log-gap
 * gate, which reads `demandsLogs(skills)`: playbooks selected six questions ago were still
 * demanding container logs.
 *
 * Decay, not reset: a follow-up genuinely is about the turn before it ("and the logs?"), so the
 * most recent matches stay. Everything older is dropped and re-earned — a playbook that still
 * fits the new question matches again on the same text that matched it the first time.
 */
export const CARRIED_SKILLS = 2;

export type ThreadSkills = Map<string, Skill[]>;

/** What the dashboard renders. Strings only — no RegExp crosses this boundary. */
export interface SkillView {
  name: string;
  description: string;
  when: string;
  chars: number;
  body: string;
}

/**
 * Selects the skills for one incoming message and folds them into the thread's running set.
 * Exported for the wiring test — the class method is a thin caller.
 */
export function selectForThread(
  registry: SkillRegistry,
  tracked: ThreadSkills,
  threadId: string,
  trigger: string
): Skill[] {
  const known = tracked.get(threadId) ?? [];
  const { selected, overflow } = registry.select(trigger, new Set(known.map((s) => s.name)));
  if (overflow.length > 0) {
    logger.info(`[${threadId}] skills over the cap, not loaded: ${overflow.join(", ")}`);
  }
  // The cap counts PLAYBOOKS. A shape skill (rca-format) is the answer's format, not a failure mode
  // competing for a place — it used to take one of the five, and the cap was hit in 13 of 22
  // threads on 2026-09-28 with four playbooks loaded.
  const all = [...known, ...selected];
  let playbooks = 0;
  const merged = all.filter((s) => isShapeSkill(s) || ++playbooks <= MAX_THREAD_SKILLS);
  const capped = all.length - merged.length;
  if (capped > 0) {
    logger.info(`[${threadId}] ${capped} skill(s) past the per-thread cap of ${MAX_THREAD_SKILLS}, not loaded`);
  }

  tracked.delete(threadId); // re-insert so this thread becomes the most recent
  tracked.set(threadId, merged);
  while (tracked.size > MAX_TRACKED_THREADS) {
    const oldest = tracked.keys().next().value;
    if (oldest === undefined) break;
    tracked.delete(oldest);
  }
  return merged;
}

/**
 * Shrinks a thread's accumulated playbooks at the start of a NEW turn, and returns the names
 * dropped so the caller can log them — a playbook that vanishes silently is the bug this whole
 * mechanism was added to fix, one level up. See CARRIED_SKILLS for why.
 *
 * Only called between turns. Inside one investigation selection stays append-only: there the
 * alert's own playbook outranks one a later log line suggested, and decaying mid-loop would
 * throw away the playbook the run is actually following.
 *
 * Exported for the wiring test.
 */
export function decayThreadSkills(tracked: ThreadSkills, threadId: string, keep = CARRIED_SKILLS): string[] {
  const known = tracked.get(threadId);
  if (!known || known.length === 0) return [];
  // A mode-keyed skill is never inherited — it belongs to THIS turn's mode, and the caller
  // re-selects it from the tag on the very next line. Carried over, `rca-format` would follow an
  // alert thread into every follow-up mention it ever gets: the exact leak it was moved off
  // `when: always` to stop.
  // Insertion order is recency order — selectForThread appends — so the tail is the newest.
  const kept = known.filter((s) => !keysOnMode(s)).slice(-keep);
  if (kept.length === known.length) return [];
  tracked.set(threadId, kept);
  return known.filter((s) => !kept.includes(s)).map((s) => s.name);
}

/**
 * Resolves stored playbook names back to skills against the LIVE registry. A name that no longer
 * resolves is dropped rather than carried as a dangling string: `prompts/skills/` is editable
 * between two turns of the same thread, and a thread must never re-inject a skill the directory
 * no longer has. Order follows the stored list, so the alert's own playbook keeps its rank.
 *
 * Exported for the wiring test — the class method around it is a thin caller.
 */
export function resolveSkillNames(registry: SkillRegistry, names: readonly string[]): Skill[] {
  const byName = new Map(registry.all().map((s) => [s.name, s]));
  return names.map((n) => byName.get(n)).filter((s): s is Skill => s !== undefined);
}
