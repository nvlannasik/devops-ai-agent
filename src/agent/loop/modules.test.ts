import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as barrel from "../index.js";
import * as logGap from "./log-gap.js";
import * as control from "./control.js";
import * as refusals from "../remediation/evidence-refusals.js";
import * as thread from "../skills/thread.js";

// Housekeeping 2026-10-20: the pure helpers left agent/index.ts; ~20 test files still import them
// from the barrel, so every one must still be there — as the same value, not a copy.
const MODULES = { "loop/log-gap.ts": logGap, "loop/control.ts": control, "remediation/evidence-refusals.ts": refusals, "skills/thread.ts": thread };

test("every moved helper is still exported from the agent barrel, as the same value", () => {
  for (const [file, mod] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(mod)) {
      assert.equal((barrel as Record<string, unknown>)[name], value, `${file}: ${name} not re-exported from agent/index.ts`);
    }
  }
});

test("no moved module imports the agent barrel (no cycle back into index.ts)", () => {
  for (const file of Object.keys(MODULES)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from "(\.\.?\/)+index\.js"/, `${file} imports the barrel`);
  }
});

test("agent/index.ts lost its top-level helpers", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^export function (logGapAction|unseenImageRefusal|toolCallKey|selectForThread)\b/m);
});
