import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { STYLES } from "./styles.js";

// 2026-10-21 split: STYLES is seven ordered chunks. Order is the cascade, so the bytes are pinned —
// a chunk moved or a line lost changes which rule wins with no error anywhere.
test("STYLES is byte-identical to the pre-split stylesheet", () => {
  assert.equal(STYLES.length, 146061);
  assert.equal(createHash("sha256").update(STYLES).digest("hex"), "30cfca021109126857608823b3d825909970803e1b265549eca4130529b39803");
});

test("no stylesheet chunk interpolates", () => {
  for (const f of readdirSync(new URL("./styles/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8"), /\$\{/, f);
  }
});
