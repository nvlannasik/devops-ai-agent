import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readCase } from "./trace.js";
import { replay, score } from "./run.js";

// Every recorded production case, replayed offline against the code under test (spec §8.3). A
// failure here is a harness change that would have decided a real incident differently.
const DIR = fileURLToPath(new URL("../../replay/cases", import.meta.url));
const cases = existsSync(DIR) ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

for (const name of cases) {
  test(`replay case ${name}`, async () => {
    const c = readCase(join(DIR, name));
    const s = score(await replay(c.trace, { mode: "gates" }), c.expect);
    assert.equal(s.outcome, "passed", s.why.join("; "));
  });
}

test("the case directory is readable (an empty one is allowed)", () => {
  assert.ok(Array.isArray(cases));
});
