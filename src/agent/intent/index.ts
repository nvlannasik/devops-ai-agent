// Detects an explicit investigation request in a human mention. Decides the tool budget:
// plain data questions get a small deterministic budget (the model kept wandering into
// other namespaces no matter what the prompt said); explicit requests get the full one.
// ponytail: keyword regex, not an LLM classifier — misses exotic phrasing, but the
// failure mode is graceful: the capped answer ends with an offer to investigate.
const INVESTIGATE_RE = /\b(investigat\w*|investigasi|selidiki|usut|diagnos\w*|root\s?cause|rca|kenapa|why\b)/i;

export function wantsInvestigation(text: string): boolean {
  return INVESTIGATE_RE.test(text);
}
