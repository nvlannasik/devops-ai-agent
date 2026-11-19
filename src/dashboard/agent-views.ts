import { cell, esc, fmtCompact, fmtInt, headers, table } from "./html.js";
import { dependencyList } from "./topology-list.js";
import type { Assets } from "./assets.js";
import { outlineOf, renderMarkdown } from "./markdown.js";
import { shareBar } from "./chart.js";
import { SKILL_MAX_CHARS } from "../agent/skills/index.js";
import type { Topology } from "./topology.js";
import type { ContextView } from "./context.js";
import { ICON, cardHead, empty, jsonBlock, pageHead, statList, panel } from "./parts.js";
import { layout } from "./layout.js";

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
/** What is wired, what is not, and what the agent can reach — the four counts the map draws. */
function topologyShelf(t: Topology): string {
  const deps = [...t.inbound, ...t.outbound];
  const off = deps.filter((n) => !n.configured);
  const tools = t.capabilities.flatMap((c) => c.tools);
  const writes = tools.filter((x) => x.write).length;
  const llm = t.provider === "router" ? t.backends.length : t.activeClient ? 1 : 0;
  return statList([
    { icon: ICON.inbound, label: "Inbound", value: fmtInt(t.inbound.length), sub: "how alerts and people reach the agent" },
    {
      icon: ICON.outbound,
      label: "Not configured",
      value: fmtInt(off.length),
      sub: off.length ? off.slice(0, 2).map((n) => n.label).join(", ") + (off.length > 2 ? ` +${off.length - 2}` : "") : `all ${fmtInt(deps.length)} dependencies wired`,
      tone: off.length ? "warning" : undefined,
    },
    { icon: ICON.plug, label: "MCP tools", value: fmtInt(tools.length), sub: `${fmtInt(t.capabilities.length)} families · ${fmtInt(writes)} can write` },
    { icon: ICON.chip, label: "LLM backends", value: fmtInt(llm), sub: t.provider === "router" ? "routed light → heavy" : `provider ${t.provider}` },
  ]);
}

export function topologyPage(
  t: Topology,
  nonce: string,
  assets: Assets | null,
  openIncidents?: number,
  /** `?tool=` — the tool search under the map. */
  toolQuery = "",
  /** `?family=` — a tool family opened in the page (what a tile links to when no script runs). */
  family = ""
): string {
  return layout(
    "Topology",
    `<div class="doc">
       <p class="eyebrow">Agent</p>
       <h1>Dependency map</h1>
       <p class="meta">Read from this agent's own configuration, plus the tool list
         <code translate="no">devops-mcp-server</code> sent when the agent connected. Nothing here is
         probed — no call leaves the process.</p>
     </div>
     ${topologyShelf(t)}
     ${topoFrame(t, nonce, assets)}
     ${dependencyList(t, toolQuery, family)}`,
    // The one page with an external stylesheet. It is linked ahead of the inline <style> so
    // the dashboard's own rules win over React Flow's at equal specificity.
    { current: "/topology", openIncidents, stylesheet: assets?.css.path }
  );
}

// Numbers go through `fmtInt`, already imported at the top of views.ts (line 1) and used twenty
// times below. Do NOT add a local `const num = (n) => n.toLocaleString("en-US")` — that is
// html.ts:32-34 rewritten, in the one file that already imports the original, and it would put a
// function named `num` beside the CSS class named "num" that these very cells pass.

// encodeURIComponent inside the path segment, esc() on the whole attribute at the call site —
// the same two layers the incident page's Slack link takes. A skill name matches [a-z0-9-] at
// load time (NAME_RE in agent/skills), so today neither layer has anything to do; that rule
// lives in another module and this one does not get to assume it.
const skillHref = (name: string): string => `/context/${encodeURIComponent(name)}`;

/**
 * A document page — the core prompt, or one skill — as the incident page is laid out: the text
 * in the main column and, beside it where there is room, a facts shelf and the document's own
 * outline as in-page links. The text is long (the prompt is ~24,000 chars), and a reader looking
 * for the Loki section scrolled four screens past it with nothing pointing the way.
 */
function docPage(
  title: string,
  head: { eyebrow: string; h1: string; lede: string; back: [href: string, label: string] },
  facts: Parameters<typeof statList>[0],
  body: string,
  note: string,
  openIncidents: number | undefined
): string {
  const outline = outlineOf(body);
  // The shallowest level the document uses: `##` in the prompt, whatever a skill starts at.
  const top = Math.min(7, ...outline.map((h) => h.level));
  const items = outline.filter((h) => h.level === top);
  return layout(
    title,
    `<div class="doc">
     ${pageHead({ eyebrow: head.eyebrow, title: head.h1, lede: head.lede, code: true, tools: `<a class="standalone" href="${esc(head.back[0])}">${esc(head.back[1])}</a>` })}
     <div class="detail">
     <aside class="detail-side" aria-label="About this text">
     ${statList(facts, "facts")}
     ${
       items.length > 1
         ? `<nav class="card toc" aria-label="Sections"><p class="toc-title">Sections · ${fmtInt(items.length)}</p><ul>` +
           items.map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join("") +
           `</ul></nav>`
         : ""
     }
     </aside>
     <div class="detail-main">
     ${note}
     <h2 class="sr-only">Text</h2><section class="card md">${renderMarkdown(body)}</section>
     </div>
     </div>
     </div>`,
    { current: "/context", openIncidents }
  );
}

/**
 * The core prompt, in full, on its own page — 24,000 characters inline would bury the budget.
 * The text is the RUNNING process's copy: buildStaticSystemPrompt() reads prompts/system.md once
 * and caches it, and the file is editable without a rebuild — so git, the pod's disk and this
 * string can all disagree, and only this one decides what the agent says. The page says so.
 */
export function promptPage(v: ContextView, openIncidents?: number): string {
  return docPage(
    "System prompt",
    {
      eyebrow: "Core prompt",
      h1: "prompts/system.md",
      lede: "Sent whole at the head of every request, on every iteration of every investigation — the largest and the only unconditional part of what this agent is told.",
      back: ["/context", "← Context and skills"],
    },
    [
      { label: "Sent", value: "Every call", sub: "unconditional" },
      { label: "Tokens", value: `~${fmtInt(v.core.tokens)}`, sub: "estimated" },
      { label: "Lines", value: fmtInt(v.core.lines), sub: `${fmtInt(v.core.chars)} chars` },
      { label: "Sections", value: fmtInt(outlineOf(v.core.body).filter((h) => h.level === 2).length), sub: "## headings" },
    ],
    v.core.body,
    `<p class="callout">This is the copy <strong>this process is holding</strong>, not the file as it
       stands on disk: it is read once at boot and cached for the life of the pod, and
       <code translate="no">prompts/system.md</code> is editable without a rebuild. A change made
       after this pod started is not here — and it is not reaching the model either.</p>`,
    openIncidents
  );
}

export function skillPage(s: ContextView["skills"][number], openIncidents?: number): string {
  const always = s.when === "always";
  return docPage(
    s.name,
    { eyebrow: "Skill", h1: s.name, lede: s.description, back: ["/context", "← All skills"] },
    [
      { label: "Carried", value: always ? "Always" : "On a match", sub: always ? "every investigation" : "when the trigger matches" },
      { label: "Size", value: `${fmtInt(s.chars)}`, sub: `of ${fmtInt(SKILL_MAX_CHARS)} chars` },
      { label: "Tokens", value: `~${fmtInt(Math.ceil(s.chars / 4))}`, sub: "estimated" },
      { label: "Lines", value: fmtInt(s.body.split("\n").length), sub: "of skill text" },
    ],
    s.body,
    `<section class="card trigger-card"><h2 class="card-title">Trigger</h2>` +
      (always
        ? `<p class="meta">Carried into every investigation, whatever the alert says.</p>`
        : `<p class="meta">Carried when this pattern matches the alert text — case-insensitive; distinct
           matches, not repeats of one word, rank a skill against the others. Injected verbatim into the
           first user message, never the system prompt.</p><pre class="skill-body" translate="no">${esc(s.when)}</pre>`) +
      `</section>`,
    openIncidents
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
  const always = v.skills.filter((k) => k.when === "always");
  const matched = v.skills.filter((k) => k.when !== "always");
  const eff = v.backends.find((b) => b.name === v.effective.backend) ?? v.backends[0];
  // The question this page is opened for — how much room is left — as one bar of the window the
  // request is built to fit, split the way the budget table below splits every window.
  const windowCard = eff
    ? `<section class="card window-card">` +
      `<header class="chart-head"><p class="figure"><b>~${esc(fmtInt(v.effective.available))}</b><span>tokens left for skills and conversation</span></p>` +
      `<span class="chart-window" translate="no">${esc(eff.name)} · ${esc(fmtInt(eff.window))} window</span></header>` +
      shareBar(
        [
          { label: "core prompt", value: eff.core, tone: "", lead: true, display: fmtCompact(eff.core) },
          { label: "tools", value: eff.tools, tone: "info", display: fmtCompact(eff.tools) },
          { label: "reserve", value: eff.reserve, tone: "", display: fmtCompact(eff.reserve) },
          { label: "available", value: eff.available, tone: "ok", display: fmtCompact(eff.available) },
        ],
        { label: `${eff.name} context window` }
      ) +
      `<p class="meta">Every request is built to fit <code translate="no">${esc(v.effective.backend)}</code>, the
        smallest window — about ${fmtInt(v.effective.available)} tokens for skills and conversation. The router picks a
        backend after the request is assembled, so it has to fit the smallest one it might land in. Under pressure
        skills drop before history.</p>` +
      `</section>`
    : "";
  const prompt = outlineOf(v.core.body).filter((h) => h.level === 2);
  const promptCard =
    `<section class="card prompt-card">` +
    cardHead("Core prompt", `<a class="standalone" href="/prompt">Read the prompt →</a>`) +
    `<p class="meta"><code translate="no">prompts/system.md</code> — ${fmtInt(v.core.lines)} lines, ${fmtInt(v.core.chars)} chars,
      about ${fmtInt(v.core.tokens)} tokens, on every iteration of every investigation.</p>` +
    (prompt.length
      ? `<ul class="chips-list">${prompt.map((h) => `<li><a href="/prompt#${esc(h.id)}">${esc(h.text)}</a></li>`).join("")}</ul>`
      : "") +
    `</section>`;
  const skillCard = (k: ContextView["skills"][number]): string => {
    const pct = Math.min(100, Math.round((k.chars / SKILL_MAX_CHARS) * 100));
    return (
      `<article class="card skill-card">` +
      `<header><a href="${esc(skillHref(k.name))}"><code translate="no">${esc(k.name)}</code></a>` +
      (k.when === "always" ? `<span class="badge">ALWAYS</span>` : "") +
      `</header>` +
      `<p>${esc(k.description)}</p>` +
      (k.when === "always" ? "" : `<code class="skill-when" translate="no" title="${esc(k.when)}">${esc(k.when)}</code>`) +
      // How close the skill is to the 8,000-char cap a skill file is refused at, at boot.
      `<div class="skill-size"><span class="ratio" style="--a:${pct}" aria-hidden="true"><span></span></span>` +
      `<span>${fmtInt(k.chars)} / ${fmtInt(SKILL_MAX_CHARS)} chars</span></div>` +
      `</article>`
    );
  };
  const skillGroup = (title: string, list: ContextView["skills"], note: string): string =>
    list.length
      ? `<section class="skill-group"><header class="card-head"><h2 class="card-title">${esc(title)} · ${fmtInt(list.length)}</h2><span class="meta">${esc(note)}</span></header>` +
        `<div class="skill-grid">${list.map(skillCard).join("")}</div></section>`
      : "";
  return layout(
    "Context",
    `${pageHead({
      eyebrow: "Agent",
      title: "Context and skills",
      lede: "What this agent knows before it reads a single metric, and how much room it has to say it. Read from the running process — no database, no call leaves it.",
    })}
     ${statList([
       { icon: ICON.layers, label: "Core prompt", value: `~${fmtInt(v.core.tokens)}`, sub: `tokens on every call · ${fmtInt(v.core.lines)} lines` },
       {
         icon: ICON.context,
         label: "Skills",
         value: fmtInt(v.skills.length),
         sub: `${fmtInt(always.length)} always · ${fmtInt(matched.length)} matched on the alert`,
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
     ${windowCard}
     ${promptCard}
     ${skillGroup("Always carried", always, "in every investigation")}
     ${skillGroup("Matched on the alert", matched, "selected from the alert text, in the first user message — never the system prompt")}
     ${panel("Budget per backend", `<p class="stack-legend"><span><i data-k="reserve"></i>reserve</span><span><i data-k="core"></i>core prompt</span><span><i data-k="tools"></i>tools</span><span><i data-k="available"></i>available</span></p>` + budgetRows(v.backends))}`,
    { current: "/context", openIncidents }
  );
}
