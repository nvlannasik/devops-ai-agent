// The journal read (B2, vm-agent 5, 2026-11-24): the last lines of one systemd unit on a host,
// pulled by the host's agent like a restart (no inbound port), redacted on the host — and again
// here, because an agent built from another commit may not, and the text goes to an LLM next.

/** A systemd unit name; a bare name gets `.service`. Null for anything else (no paths, no options). */
export function unitName(raw: string): string | null {
  const u = raw.trim();
  if (!/^[A-Za-z0-9@._:-]{1,120}$/.test(u) || u.startsWith("-")) return null;
  return /\.(service|socket|timer|mount|scope|target|path)$/.test(u) ? u : `${u}.service`;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED JWT]"],
  [/\b([a-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)s?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1$2[REDACTED]"],
  [/(:\/\/[^:/\s@]+:)[^@/\s]+@/g, "$1[REDACTED]@"],
];

/** The same patterns devops-vm-agent applies before the journal leaves the host. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}
