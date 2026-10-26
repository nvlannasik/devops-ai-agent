import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { STYLES } from "./styles.js";

// 2026-10-21 split: STYLES is seven ordered chunks. Order is the cascade, so the bytes are pinned —
// a chunk moved or a line lost changes which rule wins with no error anywhere. A NEW rule re-pins
// both numbers on purpose (2026-10-26: /people, then the harness bars and the bench folds).
test("STYLES bytes are pinned", () => {
  assert.equal(STYLES.length, 151928);
  assert.equal(createHash("sha256").update(STYLES).digest("hex"), "c79152952ffb7d091a3ac37d809fdae1cfcb1650e7c846e723e25ea415c9a062");
});

test("no stylesheet chunk interpolates", () => {
  for (const f of readdirSync(new URL("./styles/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8"), /\$\{/, f);
  }
});
