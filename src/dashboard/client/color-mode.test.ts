import { test } from "node:test";
import assert from "node:assert/strict";
import { mapColorMode } from "./color-mode.js";

const root = (theme?: string) => ({ dataset: theme === undefined ? {} : { theme } });

test("the map draws in the scheme the reader chose", () => {
  assert.equal(mapColorMode(root("light")), "light");
  assert.equal(mapColorMode(root("dark")), "dark");
});

// No attribute is "no choice", and so is anything this page never writes: React Flow then reads
// prefers-color-scheme itself, which is the signal the stylesheet falls back to as well.
test("with no choice — or an unknown one — the map follows the system", () => {
  assert.equal(mapColorMode(root()), "system");
  assert.equal(mapColorMode(root("auto")), "system");
  assert.equal(mapColorMode(root("sepia")), "system");
});
