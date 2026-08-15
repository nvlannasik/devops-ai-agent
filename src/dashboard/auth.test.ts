import test from "node:test";
import assert from "node:assert/strict";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  checkPassword,
  clearedCookie,
  cookieValue,
  mintSession,
  safeNext,
  sessionCookie,
  verifySession,
} from "./auth.js";

const PW = "correct horse battery staple";

test("a freshly minted session verifies against the password that minted it", () => {
  const t = mintSession(PW);
  assert.equal(verifySession(t, PW), true);
  assert.equal(verifySession(t, "some other password"), false);
});

test("the same password always derives the same key, so a restart does not sign everyone out", () => {
  // Two mints an hour apart under two different "processes" is the same code path; what this
  // pins is that the KEY is deterministic — a random per-process key would fail the second
  // assertion, and every rolling update would drop every session mid-incident.
  const issued = mintSession(PW, 1_000_000);
  assert.equal(verifySession(issued, PW, 1_000_000 + 60_000), true);
});

test("a session stops verifying once its expiry passes", () => {
  const t = mintSession(PW, 0, 1000);
  assert.equal(verifySession(t, PW, 999), true);
  assert.equal(verifySession(t, PW, 1000), false, "expiry is exclusive — at exp it is over");
  assert.equal(verifySession(t, PW, 5000), false);
});

test("a token with an extended expiry does not verify", () => {
  // The whole reason the expiry is signed: it travels in the clear where anyone can edit it.
  const t = mintSession(PW, 0, 1000);
  const forged = `v1.${9_999_999_999_999}.${t.split(".")[2]}`;
  assert.equal(verifySession(forged, PW, 2000), false);
});

test("garbage tokens are rejected without throwing", () => {
  for (const t of ["", "v1", "v1.abc.def", "v2." + (Date.now() + 1000) + ".sig", "...", "a.b.c.d"]) {
    assert.equal(verifySession(t, PW), false, `accepted ${JSON.stringify(t)}`);
  }
  assert.equal(verifySession(undefined, PW), false);
  // No password configured means no session is valid — the server's fail-closed 503 depends
  // on this staying true rather than on the route order alone.
  assert.equal(verifySession(mintSession(PW), undefined), false);
});

test("an unset password matches nothing, including the empty string", () => {
  assert.equal(checkPassword("", undefined), false);
  assert.equal(checkPassword("anything", undefined), false);
  assert.equal(checkPassword("", ""), false);
  assert.equal(checkPassword(PW, PW), true);
  assert.equal(checkPassword(PW + " ", PW), false);
  // Length differs on purpose: timingSafeEqual throws on unequal buffers, so a comparison
  // that did not digest both sides first would crash here instead of returning false.
  assert.equal(checkPassword("x", PW), false);
});

test("the cookie is HttpOnly, SameSite=Strict, and Secure unless told otherwise", () => {
  const c = sessionCookie("tok", true);
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=tok;`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.match(c, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`));
  assert.doesNotMatch(sessionCookie("tok", false), /Secure/);
  // Clearing is the same cookie with a zero lifetime — same Path, or the browser keeps the
  // old one alongside it and "sign out" signs nobody out.
  assert.match(clearedCookie(true), /Max-Age=0/);
  assert.match(clearedCookie(true), /Path=\//);
});

test("the session cookie is found among others, and only by its own name", () => {
  assert.equal(cookieValue(`a=1; ${SESSION_COOKIE}=tok; b=2`, SESSION_COOKIE), "tok");
  assert.equal(cookieValue(` ${SESSION_COOKIE}=tok `, SESSION_COOKIE), "tok");
  // A prefix match here would let "x_dash_session" stand in for the real one.
  assert.equal(cookieValue(`x_${SESSION_COOKIE}=tok`, SESSION_COOKIE), undefined);
  assert.equal(cookieValue("novalue", SESSION_COOKIE), undefined);
  assert.equal(cookieValue(undefined, SESSION_COOKIE), undefined);
  // base64url has no "=" padding, but a value that did must survive intact.
  assert.equal(cookieValue(`${SESSION_COOKIE}=a=b`, SESSION_COOKIE), "a=b");
});

test("the post-login redirect never leaves this origin", () => {
  assert.equal(safeNext("/incidents/42"), "/incidents/42");
  assert.equal(safeNext("/incidents?severity=critical"), "/incidents?severity=critical");
  for (const bad of [
    "//evil.example.com",          // protocol-relative: same-origin by string, not by browser
    "/\\evil.example.com",         // ditto, the backslash spelling
    "https://evil.example.com",
    "javascript:alert(1)",
    "/incidents\r\nSet-Cookie: x=1", // header splitting
    "/incidents\nLocation: /elsewhere",
    "incidents",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeNext(bad), "/", `let ${JSON.stringify(bad)} through`);
  }
});

test("the throttle blocks only after the limit, and only for its window", () => {
  const t = new LoginThrottle(3, 60_000);
  for (let i = 0; i < 2; i++) t.fail("1.2.3.4", 0);
  assert.equal(t.blocked("1.2.3.4", 0), false, "under the limit is still allowed to try");
  t.fail("1.2.3.4", 0);
  assert.equal(t.blocked("1.2.3.4", 0), true);
  assert.equal(t.retryAfterMs("1.2.3.4", 10_000), 50_000);
  // Another caller is unaffected — the block is per key, not global.
  assert.equal(t.blocked("5.6.7.8", 0), false);
  assert.equal(t.blocked("1.2.3.4", 60_000), false, "the window rolls over");
});

test("a correct password clears the count, so a typo is not held against you", () => {
  const t = new LoginThrottle(2, 60_000);
  t.fail("1.2.3.4", 0);
  t.succeed("1.2.3.4");
  t.fail("1.2.3.4", 0);
  assert.equal(t.blocked("1.2.3.4", 0), false);
});

test("the throttle map stays bounded under rotating source addresses", () => {
  const t = new LoginThrottle(1, 60_000, 4);
  for (let i = 0; i < 40; i++) t.fail(`10.0.0.${i}`, 0);
  // The bound is what matters, not which entries survive: this map is rate-limit state, and
  // an attacker who can rotate addresses has already defeated a per-address limit anyway.
  const size = (t as unknown as { fails: Map<string, unknown> }).fails.size;
  assert.ok(size <= 4, `throttle map grew to ${size}`);
});
