import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as views from "./views.js";

// 2026-10-21 split: views.ts is a barrel over one module per page. server.ts and views.test.ts
// import from it, so it must keep exporting every page; and no page module may import it back,
// or ESM evaluates a half-initialised cycle.
const PAGES = ["layout", "loginPage", "errorPage", "overviewPage", "listPage", "detailPage", "postmortemPage", "postmortemsPage",
  "harnessPage", "harnessGatePage", "topologyPage", "promptPage", "skillPage", "contextPage", "benchPage",
  "clusterPage", "pager", "pageWindow", "section", "empty", "ICON", "REFRESH_SECONDS"];

test("the views barrel still exports every page and shared part", () => {
  for (const name of PAGES) assert.ok(name in views, name);
});

test("no dashboard module imports the views barrel back", () => {
  const dir = new URL("./", import.meta.url);
  // server.ts is the barrel's consumer, not a page module — it keeps importing views.js.
  const own = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "views.ts" && f !== "server.ts";
  for (const f of readdirSync(dir).filter(own)) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /from "\.\/views\.js"/, f);
  }
});

test("views.ts holds no page bodies any more", () => {
  const src = readFileSync(new URL("./views.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /export function /);
});
