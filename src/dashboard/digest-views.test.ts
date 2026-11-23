import { test } from "node:test";
import assert from "node:assert/strict";
import { digestHtml, digestsPage } from "./digest-views.js";
import { matchRoute } from "./server.js";

const TEXT = [
  "*🩺 Daily health — 2026-11-24*",
  "2 of 6 hosts need a look · nothing firing",
  "",
  "*🖥️ Hosts* _(lowest available in 24 h)_",
  "• ⚠️ `worker1-raspi` — low 2033Mi of 3784Mi · disk 81%, full in ~13.1 d",
  "    ↳ root disk full in ~13.1 days at -209Mi/day",
  "• `master2-vm` — low 516Mi, last heard <!date^1795223038^{date_short_pretty} {time}|2026-11-20 21:29 UTC>",
  "<script>alert(1)</script>",
].join("\n");

test("digestHtml: the digest's mrkdwn as HTML — bold, italic, code, bullets with their ↳ lines, date tokens — escaped first", () => {
  const h = digestHtml(TEXT);
  assert.match(h, /^<p><strong>🩺 Daily health — 2026-11-24<\/strong><\/p>/);
  assert.match(h, /<p><strong>🖥️ Hosts<\/strong> <em>\(lowest available in 24 h\)<\/em><\/p>/);
  assert.match(h, /<li>⚠️ <code translate="no">worker1-raspi<\/code> — low 2033Mi of 3784Mi · disk 81%, full in ~13\.1 d<p class="meta">↳ root disk full in ~13\.1 days at -209Mi\/day<\/p><\/li>/);
  assert.match(h, /last heard 2026-11-20 21:29 UTC<\/li>/);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
});

test("digestsPage: one panel per day, newest first; none yet is a panel that says when the first comes", () => {
  const page = digestsPage([{ day: "2026-11-24", text: TEXT }, { day: "2026-11-23", text: "*x*" }]);
  assert.ok(page.indexOf('id="digest-2026-11-24"') < page.indexOf('id="digest-2026-11-23"'));
  assert.match(page, /<h1>Daily digests<\/h1>/);
  assert.match(page, /2 days ·/);
  assert.match(page, /aria-current="page"[^>]*>[\s\S]*?Daily digests|href="\/digests"[^>]*aria-current="page"/);
  assert.match(digestsPage([]), /No digest yet\./);
  assert.deepEqual(matchRoute("/digests"), { kind: "digests" });
});
