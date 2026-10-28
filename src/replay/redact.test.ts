import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.js";

// A trace leaves the cluster only through export, and only redacted (spec §8.2). One positive and
// one negative fixture per pattern: a redactor that eats ordinary log text makes cases unreadable.

const one = (s: string) => redact(s).value as string;

test("bearer tokens, AWS keys and JWTs are replaced", () => {
  assert.equal(one("Authorization: Bearer abcDEF123456ghiJKL789"), "Authorization: Bearer [REDACTED]");
  assert.equal(one("key AKIAIOSFODNN7EXAMPLE used"), "key [REDACTED] used");
  assert.equal(one("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "[REDACTED]");
  assert.equal(one("the bearer of bad news"), "the bearer of bad news");
  assert.equal(one("AKIA is a prefix, not a key"), "AKIA is a prefix, not a key");
});

test("key=value secrets are replaced, in logs and in JSON, but not their near misses", () => {
  assert.equal(one("connecting with password=hunter22 to db"), "connecting with password=[REDACTED] to db");
  assert.equal(one('{"api_key":"sk-live-0123456789"}'), '{"api_key":"[REDACTED]"}');
  assert.equal(one("aws_secret_access_key: wJalrXUtnFEMI/K7MDENG"), "aws_secret_access_key: [REDACTED]");
  assert.equal(one("token_count=3 tokens=1200"), "token_count=3 tokens=1200");
  assert.equal(one("password=123456"), "password=123456", "a number is a value, not a secret");
  assert.equal(one("secret=abc"), "secret=abc", "too short to be one");
});

test("credentials in a URL are replaced and the URL survives", () => {
  assert.equal(one("postgres://agent:s3cr3tpass@postgresql:5432/devops"), "postgres://agent:[REDACTED]@postgresql:5432/devops");
  assert.equal(one("http://orders-api:8080/v1/orders"), "http://orders-api:8080/v1/orders");
});

test("every string in a nested trace is walked, and each hit is reported", () => {
  const { value, hits } = redact({ events: [{ payload: { result: "password=hunter22", input: { q: "Bearer abcDEF123456ghiJKL" } } }], n: 3 });
  assert.deepEqual(value, { events: [{ payload: { result: "password=[REDACTED]", input: { q: "Bearer [REDACTED]" } } }], n: 3 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => !h.includes("hunter22") && !h.includes("abcDEF")), "the report must not repeat the secret");
});

// Replay export, 2026-10-28: a cloudflared Deployment's `args` carried its tunnel token, and the
// trace of an alert on it held `"--token","eyJhIjoi…"` — no dots for the jwt pattern, no `:`/`=`
// for key-value. Both shapes, with a made-up value.
test("a base64 JSON blob and a secret passed as a CLI flag are redacted", () => {
  const blob = "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiZmFrZSJ9";
  assert.equal(one(`["tunnel","run","--token","${blob}"]`), `["tunnel","run","--token","[REDACTED]"]`);
  assert.equal(one("cloudflared tunnel run --token s3cr3tvalue123"), "cloudflared tunnel run --token [REDACTED]");
  assert.equal(one("--password=hunter2hunter2"), "--password=[REDACTED]");
  assert.equal(one("tokens used: 1200, see --help for flags"), "tokens used: 1200, see --help for flags");
});
