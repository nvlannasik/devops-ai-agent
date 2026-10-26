import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { STYLES } from "./styles.js";

// 2026-10-21 split: STYLES is seven ordered chunks. Order is the cascade, so the bytes are pinned —
// a chunk moved or a line lost changes which rule wins with no error anywhere. A NEW rule re-pins
// both numbers on purpose (2026-10-26: /people, the harness bars and bench folds, then the incident header and params).
test("STYLES bytes are pinned", () => {
  assert.equal(STYLES.length, 155368);
  assert.equal(createHash("sha256").update(STYLES).digest("hex"), "e6ac1a0aa0f6ca8b8b8f9a120438b9546247b3c4271638e14ee82b98fce36a07");
});

test("no stylesheet chunk interpolates", () => {
  for (const f of readdirSync(new URL("./styles/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8"), /\$\{/, f);
  }
});
