/**
 * The names and error terms in an on-call engineer's confirmed root cause — what a replayed answer
 * must contain to agree with the human (fed by the learn feature's incident_feedback, see export.ts).
 *
 * A sentence is never the test: "misconfiguration of image tag/registry/secret" and the agent's
 * "the image reference is wrong" agree and share no words. The workload, the env var, the error
 * state and the quantity are what both of them have to name. `agent/grounding/` is not reused: it
 * reads backticked names out of the AGENT's answer, and a person writing in Slack rarely backticks.
 *
 * ponytail: lexical rules, so they miss a cause stated only in prose ("the DB was down"). Export
 * writes the human's sentence beside the terms; the reviewer adds what the rules could not see.
 */
export interface KeyTerm {
  term: string;
  /** The term as a case-insensitive regex that matches it literally — the `answer.must` form. */
  pattern: string;
}

const MAX_TERMS = 6;

const RULES: Array<{ re: RegExp; group?: number; keep?: (t: string) => boolean }> = [
  // Whatever the human chose to backtick is a name by their own say-so.
  { re: /`([^`\n]{2,80})`/g, group: 1 },
  // k8s-shaped names: lowercase segments joined by - . / — and holding a dash or a digit, which
  // keeps "tag/registry/secret" and "and/or" out and "bench-probe/p1" in. A bare date or version
  // number is not a name.
  { re: /\b[a-z0-9]+(?:[-./][a-z0-9]+)+\b/g, keep: (t) => /[-\d]/.test(t) && !/^[\d\-./:]+$/.test(t) },
  // ENV_VAR names.
  { re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g },
  // Pod and container states: CrashLoopBackOff, ImagePullBackOff, OOMKilled.
  { re: /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/g },
  { re: /\b[A-Z]{2,}[a-z]+[A-Za-z]*\b/g, keep: (t) => t.length >= 6 },
  // Resource quantities: the limit a fix raised is often the whole finding.
  { re: /\b\d+(?:Ki|Mi|Gi|Ti)\b/g },
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function keyTerms(text: string): KeyTerm[] {
  const found: Array<{ at: number; term: string }> = [];
  for (const { re, group, keep } of RULES) {
    for (const m of text.matchAll(re)) {
      const term = (group ? m[group] : m[0])!.trim();
      if (!term || (keep && !keep(term))) continue;
      found.push({ at: m.index! + (group ? m[0].indexOf(term) : 0), term });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .filter(({ term }) => !seen.has(term) && seen.add(term))
    .slice(0, MAX_TERMS)
    .map(({ term }) => ({ term, pattern: escape(term) }));
}
