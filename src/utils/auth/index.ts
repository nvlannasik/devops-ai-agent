import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time string equality. Hashing both sides to a fixed 32-byte digest first
 * means the comparison never leaks the secret's length and `timingSafeEqual` never
 * throws on a length mismatch. Mirrors the MCP server's `timingSafeEqualStr`.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Pull the token out of an `Authorization: Bearer <token>` header, or null if absent/malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Who may talk to the agent in Slack (mentions and the ✅ learn reaction). Empty `allowed`
 * = everyone, as before the allowlist existed. Once set, on-call and approvers are admitted
 * too, so the people the agent pages are never locked out of answering it.
 */
export function slackUserAllowed(
  user: string | undefined,
  lists: { allowed: string[]; oncall: string[]; approvers: string[] }
): boolean {
  if (lists.allowed.length === 0) return true;
  if (!user) return false;
  return lists.allowed.includes(user) || lists.oncall.includes(user) || lists.approvers.includes(user);
}
