import { test } from "node:test";
import assert from "node:assert/strict";
import { DigestSchedule } from "./digest.js";
import { config } from "../config/index.js";
import { digestTime, digestTimeZone } from "../config/index.js";

const at = (iso: string) => new Date(iso);

const hostWith = (claimWins: boolean) => {
  const posted: Array<Record<string, unknown>> = [];
  const claims: string[] = [];
  const recorded: string[] = [];
  return {
    posted,
    claims,
    recorded,
    stopping: false,
    agent: {
      claimDigest: async (day: string) => (claims.push(day), claimWins),
      healthDigest: async () => ({ day: "x", text: "*🩺 Daily health*" }),
      digestPosted: async (day: string, ts: string, text: string) => void recorded.push(`${day}@${ts}:${text.length}`),
    },
    app: { client: { chat: { postMessage: async (m: Record<string, unknown>) => (posted.push(m), { ts: "171.1" }) } } },
  };
};

test("one claim per local day: the winner posts once, a second tick that day does nothing; the loser never posts", async () => {
  const saved = { ...config.digest };
  Object.assign(config.digest, { channel: "C123", time: "08:00", timeZone: "Asia/Jakarta" });
  try {
    const h = hostWith(true);
    const s = new DigestSchedule(h as never);
    assert.equal(await s.runIfDue(at("2026-11-21T00:59:00Z")), "not-due");
    assert.equal(await s.runIfDue(at("2026-11-21T01:00:00Z")), "posted");
    assert.equal(await s.runIfDue(at("2026-11-21T01:05:00Z")), "settled");
    assert.deepEqual(h.claims, ["2026-11-21"]);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]!.channel, "C123");
    assert.deepEqual(h.recorded, ["2026-11-21@171.1:17"], "the text is kept for the dashboard's archive");
    assert.equal(await s.runIfDue(at("2026-11-22T01:00:00Z")), "posted", "the next day is a new claim");

    const l = hostWith(false);
    const ls = new DigestSchedule(l as never);
    assert.equal(await ls.runIfDue(at("2026-11-21T01:00:00Z")), "lost");
    assert.equal(await ls.runIfDue(at("2026-11-21T01:05:00Z")), "settled");
    assert.equal(l.posted.length, 0);
  } finally {
    Object.assign(config.digest, saved);
  }
});

test("DIGEST_TIME and DIGEST_TIMEZONE: defaults, normalised, malformed fails boot", () => {
  assert.equal(digestTime(undefined), "08:00");
  assert.equal(digestTime("7:30"), "07:30");
  assert.throws(() => digestTime("24:00"), /not HH:MM/);
  assert.throws(() => digestTime("8am"), /not HH:MM/);
  assert.equal(digestTimeZone(undefined), "UTC");
  assert.equal(digestTimeZone("Asia/Jakarta"), "Asia/Jakarta");
  assert.throws(() => digestTimeZone("Mars/Base"), /not a time zone/);
});
