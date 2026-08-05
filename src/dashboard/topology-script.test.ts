import { test } from "node:test";
import assert from "node:assert/strict";
import { TOPO_SCRIPT } from "./topology-script.js";
import { STYLES } from "./styles.js";
import { topologyPage } from "./views.js";
import type { Topology } from "./topology.js";

const t: Topology = {
  inbound: [{ label: "Slack", detail: "channel C1", meta: "bot token set", configured: true }],
  outbound: [{ id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "stdio", configured: true }],
  provider: "router",
  backends: [{ name: "b1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false }],
  capabilities: [{ name: "k8s", tools: [{ name: "k8s_list_pods", write: false }] }],
  registryError: null,
};
const html = topologyPage(t, "test-nonce");

// The script is inlined into the document, so the HTML parser — not the JavaScript parser —
// sees it first. Either of these ends the <script> element early and spills the rest of the
// file onto the page as text.
test("nothing in the script can close the element that holds it", () => {
  assert.doesNotMatch(TOPO_SCRIPT, /<\/script/i);
  assert.doesNotMatch(TOPO_SCRIPT, /<!--/);
});

// The nonce buys ONE trusted block; it says nothing about what that block then does. A script
// that wrote markup would reopen the whole injection surface from inside the exemption, which
// is the one thing the CSP could no longer catch.
test("the script builds no markup and evaluates no strings", () => {
  assert.doesNotMatch(TOPO_SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(TOPO_SCRIPT, /\beval\(|new Function\b/);
});

// The coupling this file cannot see and views.ts cannot either: the script reaches into the
// rendered page by selector, and a class renamed on one side fails silently on the other —
// the map simply stops being interactive, with no error anywhere. Derived from the script's
// own query calls rather than a hand-kept list, so a query added later is checked too.
test("every element the script reaches for is one the page actually renders", () => {
  const queries = [...TOPO_SCRIPT.matchAll(/(?:querySelector(?:All)?|closest)\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(queries.length >= 6, "the script should still be querying the page");

  const tokens = new Set(
    queries.flatMap((q) => q.split(/[\s,]+/)).flatMap((part) => part.match(/[a-z]+|\.[\w-]+|\[[^\]]+\]/g) ?? [])
  );
  for (const tok of tokens) {
    if (tok.startsWith(".")) {
      assert.match(html, new RegExp(`class="[^"]*\\b${tok.slice(1)}\\b`), `no element carries class ${tok}`);
    } else if (tok.startsWith("[")) {
      const [name, value] = tok.slice(1, -1).split("=");
      assert.match(html, new RegExp(value ? `${name}="${value}"` : `${name}=`), `no element carries ${tok}`);
    } else {
      assert.match(html, new RegExp(`<${tok}\\b`), `the page renders no <${tok}>`);
    }
  }
});

// The other half of the same coupling, in the other direction: the script's only way to show
// the toolbar and hide the fallback is these two attributes, and styles.ts is the only thing
// that acts on them. Nothing would throw if one side were renamed — the controls would just
// both be on screen, or neither.
test("the state attributes the script sets are the ones the stylesheet reacts to", () => {
  for (const attr of ["data-live", "data-drag"]) {
    assert.match(TOPO_SCRIPT, new RegExp(`"${attr}"`), `the script never sets ${attr}`);
    assert.match(STYLES, new RegExp(`\\[${attr}="on"\\]`), `no rule keys off ${attr}`);
  }
  // and the fallback the script removes is still styled, because it is what a browser with
  // no JavaScript is left holding
  assert.match(STYLES, /\.topo-z \{/);
  assert.match(TOPO_SCRIPT, /\.topo-z, \.topo-bar/);
});
