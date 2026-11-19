import { esc, fmtInt } from "./html.js";
import { AGENT_FAMILY, rowId } from "./topology.js";
import type { BackendNode, Capability, IconName, Node as TopoNode, Tool, Topology } from "./topology.js";
import { ICON, badge, empty, section as sectionHead } from "./parts.js";

// --- /topology: the list under the map, grouped by what each dependency is FOR (2026-11-19) ---
// It replaced four generic tables (Inbound, Outbound, MCP tools, LLM backends) where what Postgres
// and Redis hold was hidden, fifty k8s tools sat behind one disclosure and the write tools did not
// stand out. Every card keeps the id the map links to (rowId: in-<i>, out-<i>, backend-<i>,
// cap-<i>, numbered by position in its Topology array exactly as before), so a click on the map
// still lands on its dependency. Server-rendered and script-free; the tool search is a GET form.

const GLYPH: Record<IconName, string> = {
  chat: ICON.speech,
  bell: ICON.inbound,
  db: ICON.memory,
  cache: ICON.layers,
  queue: ICON.outbound,
  plug: ICON.plug,
  chip: ICON.chip,
  bolt: ICON.bolt,
  tools: ICON.wrench,
};

/** The dashboard's own section heading (glyph + label in one flex item), the note trailing it. */
const heading = (glyph: string, title: string, note = ""): string => sectionHead(glyph, title, note ? `<span class="topo-head-note">${esc(note)}</span>` : "");

function depCard(n: TopoNode, id: string): string {
  const glyph = n.icon ? GLYPH[n.icon] : ICON.plug;
  const holds = n.children?.length
    ? `<ul class="topo-holds" aria-label="${esc(`What ${n.label} holds`)}">${n.children.map((c) => `<li title="${esc(c.detail)}"><code translate="no">${esc(c.label)}</code></li>`).join("")}</ul>`
    : "";
  return (
    `<article class="card topo-dep" id="${esc(id)}"${n.configured ? "" : ` data-tone="warning"`}>` +
    `<div class="topo-dep-head"><span class="topo-glyph" aria-hidden="true">${glyph}</span>` +
    `<div class="topo-dep-title"><strong>${esc(n.label)}</strong>` +
    `<span class="topo-endpoint" translate="no">${esc(n.detail)}</span>` +
    `<span class="topo-meta">${esc(n.meta)}${n.configured ? "" : ` ${badge("not configured", "warning")}`}</span></div></div>` +
    holds +
    `</article>`
  );
}

const section = (glyph: string, title: string, note: string, cards: string[]): string =>
  cards.length ? `<section class="topo-section">${heading(glyph, title, note)}<div class="topo-cards">${cards.join("")}</div></section>` : "";

// ---------- tools ----------

/** k8s tools by the question they answer. A tool missing here (one the server added) lands in
 *  "Other", so nothing the server sends is ever dropped from the page. */
const K8S_GROUPS: ReadonlyArray<{ title: string; tools: readonly string[] }> = [
  { title: "Whole cluster", tools: ["k8s_cluster_health", "k8s_cluster_inventory", "k8s_change_timeline", "k8s_correlate_pods", "k8s_find_by_name", "k8s_find_unused_resources"] },
  { title: "Pods & logs", tools: ["k8s_list_pods", "k8s_describe_pod", "k8s_get_pod_logs", "k8s_list_events"] },
  { title: "Network", tools: ["k8s_list_services", "k8s_get_endpoints", "k8s_list_ingresses", "k8s_list_network_policies"] },
  { title: "Workloads", tools: ["k8s_list_deployments", "k8s_list_statefulsets", "k8s_list_daemonsets", "k8s_list_replicasets", "k8s_list_jobs", "k8s_list_cronjobs", "k8s_list_hpas", "k8s_list_pdbs", "k8s_get_rollout_status"] },
  { title: "Nodes & capacity", tools: ["k8s_list_nodes", "k8s_describe_node", "k8s_node_pods", "k8s_recommend_resources", "k8s_list_resource_quotas"] },
  { title: "Config & access", tools: ["k8s_list_namespaces", "k8s_list_configmaps", "k8s_list_secrets", "k8s_list_service_accounts", "k8s_get_sa_permissions"] },
  { title: "Storage", tools: ["k8s_list_pvcs", "k8s_list_pvs", "k8s_list_storageclasses"] },
  { title: "Any resource", tools: ["k8s_get_resource", "k8s_get_custom_resources", "k8s_list_crds", "k8s_list_api_resources"] },
];
const NODE_WRITES: ReadonlySet<string> = new Set(["k8s_cordon", "k8s_uncordon", "k8s_drain"]);
/** What stands between each write tool and the cluster, in a few words — the guards are code in the
 *  agent and the server (remediation gates, orphanRefusal, the node gate), this only names them. */
const GUARD: Readonly<Record<string, string>> = {
  k8s_scale: "zero only as a quarantine",
  k8s_set_resources: "never below an OOM floor",
  k8s_delete_orphan: "only what nothing declares, 14+ days old",
  k8s_drain: "refused if the pods cannot fit elsewhere",
  flux_reconcile: "re-applies what the repo declares",
  vm_restart_service: "a unit in the host's own allowlist",
};
const FAMILY_NOTE: Readonly<Record<string, string>> = {
  [AGENT_FAMILY]: "the agent's own, not devops-mcp-server's: the host agents",
  alertmanager: "what is firing — silenced alerts labelled, not hidden",
  flux: "undoes drift, adds nothing new",
  tracing: "Tempo / Jaeger",
};

const toolName = (t: Tool): string =>
  `<code translate="no"${t.summary ? ` title="${esc(t.summary)}"` : ""}>${esc(t.name)}</code>`;
const chips = (tools: Tool[]): string => `<ul class="topo-chips">${tools.map((t) => `<li>${toolName(t)}</li>`).join("")}</ul>`;
const matches = (q: string) => (t: Tool): boolean => !q || t.name.toLowerCase().includes(q) || (t.summary ?? "").toLowerCase().includes(q);

function writeBox(title: string, groups: Array<{ title: string; tools: Tool[]; note?: string }>): string {
  const shown = groups.filter((g) => g.tools.length);
  if (!shown.length) return "";
  const n = shown.reduce((a, g) => a + g.tools.length, 0);
  return (
    `<div class="topo-writes"><p class="topo-writes-head"><strong>${esc(title)} · ${fmtInt(n)}</strong>` +
    `<span>never called during an investigation — only as a proposal a human approves, after the gates</span></p>` +
    `<div class="topo-write-grid">` +
    shown
      .map(
        (g) =>
          `<div><p class="topo-group-title">${esc(g.title)} · ${fmtInt(g.tools.length)}</p><ul class="topo-write-list">` +
          g.tools.map((t) => `<li>${toolName(t)}${GUARD[t.name] ? ` <span class="meta">— ${esc(GUARD[t.name]!)}</span>` : ""}</li>`).join("") +
          `</ul>${g.note ? `<p class="meta">${esc(g.note)}</p>` : ""}</div>`
      )
      .join("") +
    `</div></div>`
  );
}

/** One family's tools. `popup`: the card a tile (or the map) opens over the page — it names itself
 *  for the dialog and carries a way back; inline (a search) it is plain. The id the map links to
 *  sits on the wrapper toolsSection() puts around it, never on this card. */
function familyDetail(c: Capability, i: number, q: string, popup: boolean): string {
  const shown = c.tools.filter(matches(q));
  if (!shown.length) return "";
  const reads = shown.filter((t) => !t.write);
  const writes = shown.filter((t) => t.write);
  const writeCount = c.tools.filter((t) => t.write).length;
  const title =
    `<header class="topo-family-head"><h3${popup ? ` id="${esc(rowId("cap", i))}-title"` : ""}><code translate="no">${esc(c.name === AGENT_FAMILY ? "agent's own" : c.name)}</code> · ${fmtInt(c.tools.length)} tool${c.tools.length === 1 ? "" : "s"}` +
    (writeCount ? ` ${badge(`${writeCount} write`, "warning")}` : "") +
    `</h3>${FAMILY_NOTE[c.name] ? `<span class="meta">${esc(FAMILY_NOTE[c.name]!)}</span>` : ""}` +
    (popup ? `<a class="topo-pop-close" href="#tools">Close<span class="sr-only"> the ${esc(c.name)} tools</span></a>` : "") +
    `</header>`;
  if (c.name === "k8s") {
    const placed = new Set(K8S_GROUPS.flatMap((g) => g.tools));
    const groups = [...K8S_GROUPS.map((g) => ({ title: g.title, tools: reads.filter((t) => g.tools.includes(t.name)) })), { title: "Other", tools: reads.filter((t) => !placed.has(t.name)) }].filter((g) => g.tools.length);
    return (
      `<section class="card topo-family">${title}` +
      `<div class="topo-groups">${groups.map((g) => `<div><p class="topo-group-title">${esc(g.title)} · ${fmtInt(g.tools.length)}</p>${chips(g.tools)}</div>`).join("")}</div>` +
      writeBox("Can change the cluster", [
        { title: "Workloads", tools: writes.filter((t) => !NODE_WRITES.has(t.name)), note: "A Flux-managed workload gets a GitOps PR instead of a patch." },
        { title: "Nodes", tools: writes.filter((t) => NODE_WRITES.has(t.name)), note: "Never on a control-plane node, whoever asks." },
      ]) +
      `</section>`
    );
  }
  return (
    `<section class="card topo-family topo-family-small">${title}` +
    (reads.length ? chips(reads) : "") +
    (writes.length
      ? `<ul class="topo-write-list">${writes.map((t) => `<li>${toolName(t)} ${badge("write", "warning")}${GUARD[t.name] ? ` <span class="meta">— ${esc(GUARD[t.name]!)}</span>` : ""}</li>`).join("")}</ul>`
      : "") +
    `</section>`
  );
}

function toolsSection(t: Topology, q: string): string {
  const caps = t.capabilities;
  const mcpIndex = t.outbound.findIndex((n) => n.icon === "plug");
  const mcp = mcpIndex >= 0 ? t.outbound[mcpIndex]! : null;
  const all = caps.flatMap((c) => c.tools);
  const fromServer = caps.filter((c) => c.name !== AGENT_FAMILY).flatMap((c) => c.tools);
  const own = all.length - fromServer.length;
  const note = mcp
    ? `${fmtInt(fromServer.length)} tools from ${mcp.label}, ${fmtInt(fromServer.filter((x) => x.write).length)} can write${own ? ` · plus ${fmtInt(own)} of the agent's own` : ""}`
    : "";
  const head =
    `<div class="topo-tools-head">${heading(ICON.wrench, "What it can read and change", note)}` +
    `<form class="topo-search" method="get" action="/topology" role="search"><label><span class="sr-only">Find a tool</span>` +
    `<input type="search" name="tool" value="${esc(q)}" placeholder="Find a tool, e.g. logs, rollout, node"></label></form></div>`;
  const server = mcp ? depCard(mcp, rowId("out", mcpIndex)) : "";
  if (!caps.length) {
    return `<section class="topo-section">${head}${server}${empty("No tools discovered yet.", "The agent lists them when it connects to devops-mcp-server. If this persists, the server is unreachable.", ICON.plug)}</section>`;
  }
  const tiles =
    `<nav class="topo-tiles" aria-label="Tool families">` +
    caps
      .map((c, i) => {
        const hits = c.tools.filter(matches(q)).length;
        const w = c.tools.filter((x) => x.write).length;
        return (
          `<a class="topo-tile${w ? " has-write" : ""}${q && !hits ? " is-empty" : ""}" href="#${esc(rowId("cap", i))}"${q ? "" : ` aria-haspopup="dialog"`}>` +
          `<code translate="no">${esc(c.name === AGENT_FAMILY ? "agent's own" : c.name)}</code>` +
          // Where the tools come from, in words: these two are the agent's own, not the server's.
          (c.name === AGENT_FAMILY ? `<em class="topo-tile-origin">agent</em>` : "") +
          `<strong>${fmtInt(q ? hits : c.tools.length)}</strong>` +
          `<span>${q ? `of ${fmtInt(c.tools.length)} match` : w === c.tools.length ? `${fmtInt(w)} write` : w ? `${fmtInt(c.tools.length - w)} read · ${fmtInt(w)} write` : "read only"}</span></a>`
        );
      })
      .join("") +
    `</nav>`;
  // A search shows its hits in place: that is what a search is for. Otherwise each family is a
  // pop-up — hidden until its tile (or its card on the map) links to it, then laid over the page by
  // CSS :target alone, so it needs no script and the map's own links open the same pop-up. The
  // scrim behind the card and the Close link both go back to #tools.
  if (q) {
    const hits = caps.map((c, i) => ({ html: familyDetail(c, i, q, false), id: rowId("cap", i) })).filter((d) => d.html);
    const none = hits.length === 0 ? `<p class="meta">No tool matches “${esc(q)}”. <a href="/topology#tools">Show every tool</a></p>` : "";
    return (
      `<section class="topo-section" id="tools">${head}${server}${tiles}${none}` +
      hits.map((d) => `<div class="topo-result" id="${esc(d.id)}">${d.html}</div>`).join("") +
      `</section>`
    );
  }
  const pops = caps
    .map((c, i) => {
      const id = rowId("cap", i);
      return (
        `<div class="topo-pop" id="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}-title">` +
        `<a class="topo-pop-scrim" href="#tools" tabindex="-1" aria-hidden="true"></a>` +
        familyDetail(c, i, "", true) +
        `</div>`
      );
    })
    .join("");
  return `<section class="topo-section" id="tools">${head}${server}${tiles}<p class="meta">Open a family for its tools.</p>${pops}</section>`;
}

// ---------- LLM backends ----------

const LANES: ReadonlyArray<{ route: BackendNode["route"]; title: string }> = [
  { route: "light", title: "Light — asked first" },
  { route: "heavy", title: "Heavy — when light fails or the work is large" },
  { route: "unrouted", title: "Unrouted" },
];

function backendsSection(t: Topology): string {
  if (t.provider !== "router") {
    return section(ICON.chip, "Who it asks", `provider ${t.provider} — one client, no routing`, t.activeClient ? [depCard(t.activeClient, "active-client")] : []);
  }
  if (t.registryError) {
    return `<section class="topo-section">${heading(ICON.chip, "Who it asks")}${empty("The backend registry could not be read.", t.registryError, ICON.chip)}</section>`;
  }
  if (!t.backends.length) return "";
  // A route outside the three known ones still renders, under Unrouted: dropping a backend from
  // the list because its route is unexpected would hide exactly the misconfiguration to look at.
  const known = new Set(LANES.map((l) => l.route));
  const laneOf = (b: BackendNode): BackendNode["route"] => (known.has(b.route) ? b.route : "unrouted");
  const lanes = LANES.map((l) => ({ ...l, items: t.backends.map((b, i) => ({ b, i })).filter((x) => laneOf(x.b) === l.route) })).filter((l) => l.items.length);
  return (
    `<section class="topo-section">${heading(ICON.chip, "Who it asks", "router · light first, then heavy")}<div class="topo-cards">` +
    lanes
      .map(
        (l) =>
          `<div class="card topo-lane"><p class="topo-group-title">${esc(l.title)}</p><ul class="topo-backends">` +
          l.items
            .map(
              ({ b, i }) =>
                `<li id="${esc(rowId("backend", i))}"><strong>${esc(b.name)}</strong>` +
                `<span class="topo-endpoint" translate="no">${esc(b.model)} · ${esc(b.kind)}${laneOf(b) !== b.route ? ` · route ${esc(b.route)}` : ""}</span>` +
                `<span class="topo-meta" translate="no">${b.viaWorker ? "via llm-worker (SQS) — stays in the private network" : `${esc(b.endpoint)} — called directly`}</span></li>`
            )
            .join("") +
          `</ul></div>`
      )
      .join("") +
    `</div><p class="meta">Only <code translate="no">private-llm</code> backends traverse SQS to <code translate="no">llm-worker</code>; the others are called from the agent itself, so the evidence they are given leaves for their API.</p></section>`
  );
}

/** Everything under the map, in the order an operator asks about it. */
export function dependencyList(t: Topology, q = ""): string {
  const query = q.trim().toLowerCase().slice(0, 64);
  const out = t.outbound.map((n, i) => ({ n, id: rowId("out", i) }));
  const stores = out.filter((x) => x.n.icon === "db" || x.n.icon === "cache");
  const queues = out.filter((x) => x.n.icon === "queue");
  const other = out.filter((x) => !["db", "cache", "queue", "plug"].includes(x.n.icon ?? ""));
  return (
    `<div class="topo-list">` +
    (t.inbound.length
      ? section(ICON.inbound, "How work arrives", "alerts and people", t.inbound.map((n, i) => depCard(n, rowId("in", i))))
      : `<section class="topo-section">${heading(ICON.inbound, "How work arrives")}${empty("Nothing configured in this group.", "Set the matching environment variables to wire one up.", ICON.plug)}</section>`) +
    section(ICON.memory, "What it remembers", "incident and conversation memory", stores.map((x) => depCard(x.n, x.id))) +
    section(ICON.outbound, "Queues to the private network", "llm-worker over SQS", queues.map((x) => depCard(x.n, x.id))) +
    section(ICON.plug, "Other dependencies", "", other.map((x) => depCard(x.n, x.id))) +
    toolsSection(t, query) +
    backendsSection(t) +
    `</div>`
  );
}
