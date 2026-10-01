/**
 * Secrets out of a trace before it leaves the cluster (spec §8.2). Free text, not one URL —
 * `dashboard/topology.ts redactUrl` parses a single HTTP(S) endpoint and cannot see a token inside
 * a log line, which is where a trace's secrets would be.
 *
 * ponytail: pattern matching, so it is evadable and incomplete by construction. It is why export
 * prints every hit and a human reviews the file before it is committed — the review is the
 * control, this is the first pass.
 */
const MASK = "[REDACTED]";

const PATTERNS: Array<{ name: string; re: RegExp; replace: (m: string, ...g: string[]) => string | null }> = [
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => MASK },
  { name: "bearer", re: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi, replace: (_m, kw) => `${kw} ${MASK}` },
  { name: "aws-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => MASK },
  {
    name: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi,
    replace: (_m, head) => `${head}:${MASK}@`,
  },
  {
    // A key named like a secret, then = or :, then a value. `\b` on both sides of the key keeps
    // `token_count` and `tokens` out; a short or purely numeric value is not a secret.
    name: "key-value",
    re: /\b(password|passwd|pwd|secret|client_secret|aws_secret_access_key|token|access_token|refresh_token|api[_-]?key|access[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi,
    replace: (_m, key, sep, value) => (value.length < 6 || /^\d+$/.test(value) ? null : `${key}${sep}${MASK}`),
  },
];

function redactString(s: string, hits: string[]): string {
  let out = s;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m: string, ...g: unknown[]) => {
      const r = p.replace(m, ...(g.filter((x) => typeof x === "string") as string[]));
      if (r === null) return m;
      // Name the pattern and the length, never the value: this list is printed to a terminal.
      hits.push(`${p.name} (${m.length} chars)`);
      return r;
    });
  }
  return out;
}

/** Walks every string in `value` and returns the redacted copy plus one line per replacement. */
export function redact<T>(value: T): { value: T; hits: string[] } {
  const hits: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactString(v, hits);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, hits };
}
