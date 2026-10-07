// Detects an explicit investigation request in a human mention. Decides the tool budget:
// plain data questions get a small deterministic budget (the model kept wandering into
// other namespaces no matter what the prompt said); explicit requests get the full one.
// ponytail: keyword regex, not an LLM classifier — misses exotic phrasing, but the
// failure mode is graceful: the capped answer ends with an offer to investigate.
const INVESTIGATE_RE = /\b(investigat\w*|investigasi|selidiki|usut|diagnos\w*|root\s?cause|rca|kenapa|why\b)/i;

export function wantsInvestigation(text: string): boolean {
  return INVESTIGATE_RE.test(text);
}

// A newcomer's "what runs here" (spec 2026-10-07-cluster-tour). Explain vocabulary AND a subject —
// "jelasin dong" alone is a reply to the last turn, not a tour. An investigation wins: "jelasin
// kenapa X crash" asks why, and why is an investigation.
const TOUR_VERB = /\b(jelas\w*|explain\w*|describe|overview|gambaran|onboard\w*|walk ?me ?through|apa aja yang (jalan|ada)|what (runs|is running|'s running)|workload apa)\b/i;
const TOUR_SUBJECT = /\b(cluster|klaster|namespace\w*|workload\w*|deploy\w*|service\w*|apa aja|what runs|onboard\w*)\b/i;

export function wantsTour(text: string): boolean {
  return !wantsInvestigation(text) && TOUR_VERB.test(text) && TOUR_SUBJECT.test(text);
}

/** The tool budget for one mention — the app and the bench both call this, so they cannot drift. */
export function mentionBudget(text: string, rounds: { mention: number; tour: number }): { maxToolRounds?: number } {
  if (wantsInvestigation(text)) return {};
  return { maxToolRounds: wantsTour(text) ? rounds.tour : rounds.mention };
}
