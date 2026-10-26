import { cell, esc, fmtInt, headers, table } from "./html.js";
import { rowId } from "./topology.js";
import type { Assets } from "./assets.js";
import { renderMarkdown } from "./markdown.js";
import type { BackendNode, Capability, Node as TopoNode, Topology } from "./topology.js";
import type { ContextView } from "./context.js";
import { ICON, badge, empty, jsonBlock, section, statList } from "./parts.js";
import { layout } from "./layout.js";

// `group` is only ever the anchor prefix: each box in the diagram links to its own row here,
// and rowId() is the single definition both sides derive that id from. Optional because the
// activeClient table reuses this helper for a row the diagram never draws (non-router
// providers have no backend chips), and an anchor nothing can link to is just dead markup.
const nodeRows = (nodes: TopoNode[], group?: "in" | "out"): string =>
  nodes.length === 0
    ? empty("Nothing configured in this group.", "Set the matching environment variables to wire one up.", ICON.plug)
    : table(
        headers("Dependency", "Endpoint", "Notes"),
        nodes
          .map(
            (n, i) => `<tr role="row"${group ? ` id="${rowId(group, i)}"` : ""}${n.configured ? "" : ` data-tone="warning"`}>` +
              cell("Dependency", esc(n.label), "primary") +
              cell("Endpoint", `<span translate="no">${esc(n.detail)}</span>`, "mono") +
              cell(
                "Notes",
                `${esc(n.meta)}${n.configured ? "" : ` ${badge("not configured", "warning")}`}`,
                "meta"
              ) +
              `</tr>`
          )
          .join(""),
        // Stacked, not paired: every one of these three is a phrase rather than a value —
        // "Postgres (incident memory)", a queue pair with an arrow between them, "bot token
        // present, socket mode present". A caption beside them would leave each phrase a third
        // of the screen to wrap in.
        "stack"
      );

// Paired rather than stacked: a backend row is a spec sheet — a name, two identifiers, an enum
// and an endpoint. Only the endpoint is long, and it is the one field a reader scans down rather
// than reads, so it keeps the column the other four set.
const backendRows = (backends: BackendNode[]): string =>
  table(
    headers("Backend", "Kind", "Model", "Route", "Reached via"),
    backends
      .map(
        (b, i) => `<tr role="row" id="${rowId("backend", i)}">` +
          cell("Backend", esc(b.name), "primary") +
          cell("Kind", `<span translate="no">${esc(b.kind)}</span>`, "mono") +
          cell("Model", `<span translate="no">${esc(b.model)}</span>`, "mono") +
          cell("Route", badge(b.route, "")) +
          cell("Reached via", `<span translate="no">${esc(b.endpoint)}</span>`, "mono") +
          `</tr>`
      )
      .join(""),
    "pairs"
  );

// The one table on this page whose source is NOT config: these families are derived from the
// tool list devops-mcp-server returned when the agent connected. So the empty state is a real
// state, not a misconfiguration — the agent may simply not have connected yet — and it must not
// read like the "set the environment variable" copy the config tables use.
// A family can hold thirty tools, and thirty names per row would bury the four numbers that
// answer "what can this agent see". <details> gives the family line as the glance and the
// names on demand — native, keyboard-operable, and the only disclosure widget that works
// under a `default-src 'none'` CSP, which forbids the script every other one needs.
const capabilityRows = (caps: Capability[]): string =>
  caps.length === 0
    ? empty(
        "No tools discovered yet.",
        "The agent lists them when it connects to devops-mcp-server. If this persists, the server is unreachable.",
        ICON.plug
      )
    // The one table on this page that stays a table at every width, and deliberately. Two
    // columns — a family name and a count — fit 320px with room to spare, so there is nothing to
    // rescue; and stacking it would put the expanded tool list BETWEEN the family and its count,
    // which is the pair the row exists to show. A narrow layout is for columns that fall off the
    // edge, not for every table.
    : table(
        `<th>Family</th><th>Tools</th>`,
        caps
          .map(
            (c, i) => `<tr id="${rowId("cap", i)}"><td class="primary">` +
              // The name is wrapped rather than styled on the <summary> itself: the disclosure
              // triangle lives inside that box, and every property that would set it off from
              // the name (padding, indent) moves the triangle with it. A span is the one thing
              // the marker cannot follow.
              `<details><summary><span class="mono" translate="no">${esc(c.name)}</span></summary>` +
              `<ul class="toollist">${c.tools
                .map(
                  (t) => `<li class="mono" translate="no">${esc(t.name)}` +
                    // The most consequential fact on this page: which of these can change the
                    // cluster. It is marked, not filtered — a reader who sees no marks has
                    // been told something, and a reader who sees one knows to look.
                    `${t.write ? ` ${badge("write", "warning")}` : ""}</li>`
                )
                .join("")}</ul></details></td>` +
              `<td class="num">${fmtInt(c.tools.length)}</td></tr>`
          )
          .join(""),
        undefined,
        // The only table here with a <details> in a cell, and so the only one whose columns
        // would move when a reader opens one. See table.caps in styles.ts.
        "caps"
      );

/**
 * The map itself: a mount point, the data, and the bundle that joins them.
 *
 * The mount is NOT empty. It holds the one sentence a reader gets if the bundle never runs —
 * scripting off, the script blocked, a stale cached asset 404ing — and `client/topology.tsx`
 * clears it as its first act after a successful parse. This is a smaller promise than the SVG
 * it replaced, which drew the whole map with no script at all, and it is the trade this rewrite
 * makes: the map is script-only now, so the page SAYS so rather than showing an empty frame.
 * The four tables below are unaffected and still carry every fact the map draws.
 *
 * `defer` so the DOM the script queries is parsed before it runs — both the mount point and the
 * data block sit above it today, and defer is what keeps this true if either ever moves.
 */
function topoFrame(t: Topology, nonce: string, assets: Assets | null): string {
  // Not an error state. `npm run dev` runs tsx against the source and never bundles, so this is
  // what a developer who has not run `npm run build:client` sees — and what a broken image build
  // shows instead of a blank frame nobody can diagnose from the page itself.
  if (!assets) {
    return (
      `<div class="card topo-frame">` +
      empty(
        "The dependency map is not built.",
        "Run npm run build:client to bundle it. Every fact it draws is in the tables below.",
        ICON.plug
      ) +
      `</div>`
    );
  }
  return (
    `<div class="card flush topo-frame">` +
    `<div id="topo-root" data-fallback>` +
    `<p class="topo-fallback">The dependency map needs JavaScript. ` +
    `The tables below carry the same facts.</p>` +
    `</div>` +
    `</div>` +
    jsonBlock("topo-data", nonce, t) +
    `<script src="${esc(assets.js.path)}" nonce="${esc(nonce)}" defer></script>`
  );
}

/**
 * `nonce` is required, not optional: it is what the response's own `script-src 'nonce-…'`
 * names, and a page built without one would render a <script> that every browser then refuses
 * to run — an interactive map that silently is not one. It covers BOTH tags on this page: the
 * external bundle and the JSON data block. The only caller mints it per response (see csp()
 * in server.ts).
 *
 * `assets` is nullable because the bundle is a build artifact, and its absence is a state this
 * page renders rather than a crash — see topoFrame().
 */
export function topologyPage(
  t: Topology,
  nonce: string,
  assets: Assets | null,
  openIncidents?: number
): string {
  // The brief's original version rendered only the bare provider name for the three
  // non-router providers ("Provider claude — one client, no routing."). Task 1's review
  // added `activeClient` (populated for claude / openai-compatible / private-llm, undefined
  // for router — the router's answer is `backends[]` instead) precisely so this page could
  // show the one active client, not merely name it (design §4.2). Reusing nodeRows() here —
  // the same helper the inbound/outbound tables use — means this table and those tables
  // can never render a node's fields differently from one another.
  const router =
    t.provider !== "router"
      ? `<p class="meta">Provider <code translate="no">${esc(t.provider)}</code> — one client, no routing.</p>` +
        nodeRows(t.activeClient ? [t.activeClient] : [])
      : t.registryError
        ? empty("The backend registry could not be read.", t.registryError, ICON.chip)
        : backendRows(t.backends) +
          `<p class="meta">Only <code translate="no">private-llm</code> backends traverse SQS to ` +
          `<code translate="no">llm-worker</code>; <code translate="no">claude</code> and ` +
          `<code translate="no">openai-compatible</code> backends are called directly from the agent.</p>`;

  return layout(
    "Topology",
    `<h1>Dependency map</h1>
     <p class="meta">Read from this agent's own configuration, plus the tool list
       <code translate="no">devops-mcp-server</code> sent when the agent connected. Nothing here is
       probed — no call leaves the process.</p>
     ${topoFrame(t, nonce, assets)}
     ${section(ICON.inbound, "Inbound")}
     ${nodeRows(t.inbound, "in")}
     ${section(ICON.outbound, "Outbound")}
     ${nodeRows(t.outbound, "out")}
     ${section(ICON.plug, "MCP tools")}
     ${capabilityRows(t.capabilities)}
     ${section(ICON.chip, "LLM backends")}
     ${router}`,
    // The one page with an external stylesheet. It is linked ahead of the inline <style> so
    // the dashboard's own rules win over React Flow's at equal specificity.
    { current: "/topology", openIncidents, stylesheet: assets?.css.path }
  );
}

// Numbers go through `fmtInt`, already imported at the top of views.ts (line 1) and used twenty
// times below. Do NOT add a local `const num = (n) => n.toLocaleString("en-US")` — that is
// html.ts:32-34 rewritten, in the one file that already imports the original, and it would put a
// function named `num` beside the CSS class named "num" that these very cells pass.

// A skill row is a name, a pattern, a size and a sentence — the sentence is what makes this a
// stack rather than pairs. The body does NOT hang off the row: it is 8000 chars at most and a
// <details> inside a table cell expands the row it sits in, so opening one pushed every skill
// below it off the screen and gave the text the width of one column to wrap in. It gets its own
// page instead (skillPage), which the name links to.
function skillRows(skills: ContextView["skills"]): string {
  // No empty state on purpose: loadSkills throws at boot on a directory with no .md files, so a
  // running agent always has skills. An "empty" table here would be a state the process cannot
  // reach — do not add one later.
  return table(
    headers("Skill", "When", "Size"),
    skills
      .map((s) =>
        `<tr role="row">` +
        // The name is the link, not a "view" column: it is what the reader is already looking
        // at, and a row whose target is named twice reads as two destinations. `skillHref`
        // encodes because nothing here may assume the loader's name rule still holds.
        // The description rides under the name, the way an incident's summary rides under its
        // alert. As a fourth column it was the one a person reads and the one the table cut off:
        // the `when` regexes are long unbroken tokens, they took the width, and the description
        // sat past the frame's right edge behind a scroll nothing pointed at (2026-09-28).
        cell(
          "Skill",
          `<a href="${esc(skillHref(s.name))}"><code translate="no">${esc(s.name)}</code></a>` +
            `<div class="sub">${esc(s.description)}</div>`,
          "primary"
        ) +
        cell("When", s.when === "always"
          ? `<span class="badge">ALWAYS</span>`
          : `<code translate="no">${esc(s.when)}</code>`, "trigger") +
        cell("Size", `${fmtInt(s.chars)} chars`, "size") +
        `</tr>`
      )
      .join(""),
    "stack"
  );
}

// encodeURIComponent inside the path segment, esc() on the whole attribute at the call site —
// the same two layers the incident page's Slack link takes. A skill name matches [a-z0-9-] at
// load time (NAME_RE in agent/skills), so today neither layer has anything to do; that rule
// lives in another module and this one does not get to assume it.
const skillHref = (name: string): string => `/context/${encodeURIComponent(name)}`;

/**
 * One skill, whole. The body is the text the model is handed verbatim, so it is rendered
 * preformatted and escaped — never parsed as markdown. What the agent reads and what this page
 * shows have to be the same string, and a renderer is a second interpretation of it.
 */
/**
 * The core prompt, in full.
 *
 * On its own page rather than inline on /context, and for the reason skillPage exists: 24,000
 * characters in a <pre> would bury the budget table under four screens of prompt, which is the
 * same failure a <details> in a table row caused for skills.
 *
 * The text is the RUNNING process's copy. buildStaticSystemPrompt() reads prompts/system.md
 * once and caches it, and the file is editable without a rebuild — so git, the pod's disk and
 * this string can all disagree, and only this one decides what the agent says. The page states
 * that, because a reader who takes it for "what the repo holds" would be reading the wrong
 * thing at the exact moment it matters.
 */
export function promptPage(v: ContextView, openIncidents?: number): string {
  return layout(
    "System prompt",
    `<div class="doc">
     <p class="eyebrow">Core prompt</p>
     <h1 translate="no">prompts/system.md</h1>
     <div class="title-meta">
       <span class="badge">EVERY ITERATION</span>
       <span class="meta">${fmtInt(v.core.lines)} lines · ${fmtInt(v.core.chars)} chars · about ${fmtInt(v.core.tokens)} tokens</span>
       <span class="page-actions"><a class="standalone" href="/context">← Context and skills</a></span>
     </div>
     <p class="meta">Sent whole at the head of every request, on every iteration of every
       investigation — the largest and the only unconditional part of what this agent is told.</p>

     ${section(ICON.layers, "What you are reading")}
     <p class="meta">This is the copy <strong>this process is holding</strong>, not the file as it
       stands on disk: it is read once at boot and cached for the life of the pod, and
       <code translate="no">prompts/system.md</code> is editable without a rebuild. If someone
       changed the file after this pod started, the change is not here — and it is not reaching
       the model either. That is the question this page exists to answer.</p>

     ${section(ICON.context, "Prompt text")}
     <div class="card md">${renderMarkdown(v.core.body)}</div>
     </div>`,
    { current: "/context", openIncidents }
  );
}

export function skillPage(s: ContextView["skills"][number], openIncidents?: number): string {
  const always = s.when === "always";
  // Everything below is ONE block, not a stack of strips laid straight into <main>. The
  // difference is real: loose children each take the column's full width and their own content
  // height, so a page of them is a run of full-bleed bands (an eyebrow renders 880x11) with
  // nothing declaring that they are one document. .doc is that declaration — it establishes the
  // block formatting context the sections' margins collapse inside, and it is the element the
  // width rule attaches to, so the page follows the column instead of a measure of its own.
  return layout(
    s.name,
    `<div class="doc">
     <p class="eyebrow">Skill</p>
     <h1 translate="no">${esc(s.name)}</h1>
     <div class="title-meta">
       ${always ? `<span class="badge">ALWAYS</span>` : `<span class="badge" data-tone="info">MATCHED</span>`}
       <span class="meta">${fmtInt(s.chars)} chars</span>
       <span class="page-actions"><a class="standalone" href="/context">← All skills</a></span>
     </div>
     <p class="meta">${esc(s.description)}</p>

     ${section(ICON.bolt, "Trigger")}
     <p class="meta">${
       always
         ? `Carried into every investigation, whatever the alert says.`
         : `Carried when this pattern matches the alert text. The match is case-insensitive, and ` +
           `it is distinct matches that rank a skill against the others, not how often one word repeats.`
     }</p>
     ${always ? "" : `<pre class="skill-body" translate="no">${esc(s.when)}</pre>`}

     ${section(ICON.context, "Skill text")}
     <p class="meta">Injected verbatim into the first user message of an investigation — never into
       the system prompt, which is cached whole and would miss on every call if it varied.</p>
     <div class="card md">${renderMarkdown(s.body)}</div>
     </div>`,
    { current: "/context", openIncidents }
  );
}

// Seven short numbers and two identifiers: the spec-sheet shape pairs was built for.
function budgetRows(backends: ContextView["backends"]): string {
  return table(
    headers("Backend", "Model", "Window", "Reserve", "Core", "Tools", "Available"),
    backends
      .map((b) =>
        `<tr role="row">` +
        // The window as one bar, split the way the numbers beside it split it — the share left for
        // skills and conversation is what this table is read for. aria-hidden: the four numbers
        // in this row are the accessible statement of the same split.
        cell(
          "Backend",
          `<code translate="no">${esc(b.name)}</code>` +
            `<span class="stack-bar budget" aria-hidden="true">${(["reserve", "core", "tools", "available"] as const)
              .map((k) => `<span data-k="${k}" style="--w:${b.window > 0 ? Math.max(0, Math.round((b[k] / b.window) * 100)) : 0}"></span>`)
              .join("")}</span>`
        ) +
        cell("Model", `<code translate="no">${esc(b.model)}</code>`) +
        // "num" is the class every other numeric cell in this file carries (see the Token usage
        // table, views.ts:273-276) — also a `pairs` table, so the combination is already proven.
        cell("Window", fmtInt(b.window), "num") +
        cell("Reserve", fmtInt(b.reserve), "num") +
        cell("Core", fmtInt(b.core), "num") +
        cell("Tools", fmtInt(b.tools), "num") +
        cell("Available", fmtInt(b.available), "num") +
        `</tr>`
      )
      .join(""),
    "pairs"
  );
}

export function contextPage(v: ContextView, openIncidents?: number): string {
  return layout(
    "Context",
    `<div class="doc">
       <p class="eyebrow">Agent</p>
       <h1>Context and skills</h1>
       <p class="meta">What this agent knows before it reads a single metric, and how much room it
         has to say it. Read from the running process — no database, no call leaves it.</p>
     </div>
     ${statList([
       { icon: ICON.layers, label: "Core prompt", value: `~${fmtInt(v.core.tokens)}`, sub: `tokens on every call · ${fmtInt(v.core.lines)} lines` },
       {
         icon: ICON.context,
         label: "Skills",
         value: fmtInt(v.skills.length),
         sub: `${fmtInt(v.skills.filter((k) => k.when === "always").length)} always · ${fmtInt(v.skills.filter((k) => k.when !== "always").length)} matched on the alert`,
       },
       { icon: ICON.plug, label: "Tool definitions", value: `~${fmtInt(v.backends[0]?.tools ?? 0)}`, sub: "tokens, sent with every call" },
       {
         icon: ICON.chip,
         label: "Room left",
         value: `~${fmtInt(v.effective.available)}`,
         sub: `tokens on ${v.effective.backend}, the smallest window`,
         // The one figure here that can be bad news: a window this full truncates conversation.
         tone: v.effective.available < 8000 ? "warning" : undefined,
       },
     ])}

     ${section(ICON.layers, "Core prompt", `<a class="standalone" href="/prompt">Read the prompt →</a>`)}
     <p class="meta"><code translate="no">prompts/system.md</code> — ${fmtInt(v.core.lines)} lines,
       ${fmtInt(v.core.chars)} chars, about ${fmtInt(v.core.tokens)} tokens. Sent on every iteration of
       every investigation. The skills below are shown in full; so is this.</p>

     ${section(ICON.context, "Skills")}
     <p class="meta">Selected from the alert text and carried in the first user message, never in
       the system prompt — a system prompt that varied per investigation would miss the model's
       prompt cache on every call. Open a skill to read the text the model is handed.</p>
     ${skillRows(v.skills)}

     ${section(ICON.chip, "Budget per backend")}
     <p class="meta">Every request is built to fit <code translate="no">${esc(v.effective.backend)}</code>,
       the smallest window — about ${fmtInt(v.effective.available)} tokens for skills and conversation.
       The router picks a backend after the request is assembled, so the request has to fit the
       smallest one it might land in.</p>
     <p class="stack-legend"><span><i data-k="reserve"></i>reserve</span><span><i data-k="core"></i>core prompt</span><span><i data-k="tools"></i>tools</span><span><i data-k="available"></i>available</span></p>
     ${budgetRows(v.backends)}`,
    { current: "/context", openIncidents }
  );
}
