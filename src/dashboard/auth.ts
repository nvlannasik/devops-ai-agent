import crypto from "node:crypto";

/**
 * Session auth for the dashboard.
 *
 * One shared password, no user accounts: every page here is read-only and shows the same
 * thing to everyone, so per-user identity would be state to store and rotate for no
 * question it could answer. Who did what is already recorded in Slack, where the approvals
 * happen. If this ever grows a mutating action, that reasoning expires with it.
 *
 * Sessions are SIGNED, not stored. A cookie carrying its own expiry plus an HMAC over that
 * expiry needs no server-side table, survives a pod restart, and is valid on every replica —
 * a Map of session ids would lose every login on each rolling update, which lands precisely
 * during an incident, which is when this page is open.
 */

export const SESSION_COOKIE = "dash_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Bumping this invalidates every token in circulation, which is the point of having it.
const VERSION = "v1";

// A fixed salt is what makes the key survive a restart. It is not a secret and does not need
// to be: scrypt's salt exists to stop one precomputed table from covering every deployment,
// and a per-install one would defeat the cross-replica property this whole design rests on.
const KEY_SALT = "devops-ai-agent/dashboard/session/v1";

// scrypt, not a bare HMAC over the password: a token is two thirds public (version and
// expiry), so its signature is an offline oracle for the key that produced it. Deriving with
// a memory-hard KDF means a guessable password costs ~100ms per guess to test instead of
// microseconds. Once per password, not per request — the result is memoised below.
let derived: { password: string; key: Buffer } | null = null;
function sessionKey(password: string): Buffer {
  if (derived && derived.password === password) return derived.key;
  const key = crypto.scryptSync(password, KEY_SALT, 32);
  derived = { password, key };
  return key;
}

// Digest both sides before comparing: timingSafeEqual throws on a length mismatch, and
// guarding that with a length check would leak the expected length through the fast path.
// Hashing makes every comparison the same 32 bytes whatever went in.
function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Whether the supplied password matches the configured one. An unset password matches nothing. */
export function checkPassword(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return sameSecret(supplied, expected);
}

function sign(password: string, exp: number): string {
  return crypto
    .createHmac("sha256", sessionKey(password))
    .update(`${VERSION}.${exp}`)
    .digest("base64url");
}

/** A token the browser can hold: version, expiry, and an HMAC binding the two. */
export function mintSession(password: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const exp = now + ttlMs;
  return `${VERSION}.${exp}.${sign(password, exp)}`;
}

export function verifySession(token: string | undefined, password: string | undefined, now = Date.now()): boolean {
  if (!token || !password) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const exp = Number(parts[1]);
  // The expiry is inside the signed payload, so checking it before the signature costs
  // nothing: a token whose expiry has been edited will not verify anyway.
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  return sameSecret(parts[2], sign(password, exp));
}

/** The one cookie this dashboard sets, read back off a raw Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    // Returned verbatim: the token is base64url plus dots, so it needs no encoding on the
    // way out and must not be decoded on the way in.
    return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * `secure` is configuration rather than a constant because the flag is silent when wrong:
 * a Secure cookie sent over plain HTTP is dropped by the browser without a word, and the
 * login form then just redisplays itself forever. Browsers treat localhost as secure, so
 * the default holds for a port-forward; only a plain-HTTP hostname needs the opt-out.
 */
export function sessionCookie(token: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    // HttpOnly is what keeps this out of reach of script, which is the whole reason the
    // CSP can be relaxed for the interactive map later.
    "HttpOnly",
    // Strict, not Lax: nothing on this dashboard is meant to be linked to from elsewhere,
    // and Strict is the version of SameSite that also covers top-level GET navigation.
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}

/**
 * Where to go after signing in. Attacker-controlled — it arrives in the query string of a
 * URL anyone can send an operator — so it is only ever a path on this origin: an absolute
 * URL here turns the login page into an open redirect, and a control character turns the
 * Location header into two headers.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw[0] !== "/") return "/";
  // "//host" and "/\host" are both protocol-relative to a browser — same-origin by string
  // inspection, another site once resolved.
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

/**
 * Failed-login throttle. One shared password is a guessable secret, and an unthrottled login
 * endpoint turns that into an offline-speed online attack.
 *
 * Keyed on the socket address, which behind a proxy is the proxy — every client then shares
 * one bucket. That is deliberate: a shared bucket still throttles the attack (the security
 * goal), and the cost is that a flood degrades access for everyone until the short window
 * rolls over. The alternative, trusting X-Forwarded-For, is a header anyone can write, which
 * would make the throttle decorative.
 */
export class LoginThrottle {
  private readonly fails = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 5 * 60_000,
    // Bounded so a rotating source address cannot grow this map without limit. Entries are
    // pure rate-limit state: dropping them costs an attacker nothing to trigger and the
    // legitimate user nothing to suffer.
    private readonly maxKeys = 1024
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.retryAfterMs(key, now) > 0;
  }

  /** Milliseconds until this caller may try again; 0 when it may try now. */
  retryAfterMs(key: string, now = Date.now()): number {
    const e = this.fails.get(key);
    if (!e || e.resetAt <= now) return 0;
    return e.n >= this.max ? e.resetAt - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const e = this.fails.get(key);
    if (!e || e.resetAt <= now) {
      if (this.fails.size >= this.maxKeys) this.fails.clear();
      this.fails.set(key, { n: 1, resetAt: now + this.windowMs });
      return;
    }
    e.n += 1;
  }

  /** A correct password clears the count — the throttle exists for guessing, not for typos. */
  succeed(key: string): void {
    this.fails.delete(key);
  }
}
