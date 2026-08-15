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
