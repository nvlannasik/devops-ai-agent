import { cell, esc, fmtInt, headers, table, timeTag } from "./html.js";
import { ICON, badge, cardHead, dash, empty, pageHead, panel, section, statList } from "./parts.js";
import { layout } from "./layout.js";
import { worstTone, type ActionRowLike, type ClusterGroup, type NodeCard, type NodesModel, type Tone } from "./nodes.js";

// --- /nodes (fleet), /nodes/c/<cluster> (one cluster), /nodes/h/<host> (one host) — model: nodes.ts ---

const RATE: Record<Tone, string> = { ok: "rate-ok", warning: "rate-warn", critical: "rate-bad", "": "rate-ok" };
const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const enc = encodeURIComponent;
export const clusterHref = (name: string): string => `/nodes/c/${enc(name)}`;
export const hostHref = (c: NodeCard): string => (c.cluster ? `${clusterHref(c.cluster)}#node-${enc(c.name)}` : `/nodes/h/${enc(c.id)}`);

/** A bar with its number beside it — the bench page's rate bar, toned. Never colour alone: the text says it. */
const meter = (pct: number, t: Tone, text: string): string =>
  `<span class="rate-bar" aria-hidden="true"><span class="rate-fill ${RATE[t]}" style="width:${clampPct(pct)}%"></span></span>` +
  `<span class="node-meter-text">${esc(text)}</span>`;
/** The same bar, stacked under its text, for a table cell. */
const cellMeter = (pct: number, t: Tone, text: string): string =>
  `<span class="rate-bar node-cell-bar" aria-hidden="true"><span class="rate-fill ${RATE[t]}" style="width:${clampPct(pct)}%"></span></span>` +
  `<span class="node-cell-text"${t === "warning" || t === "critical" ? ` data-tone="${t}"` : ""}>${esc(text)}</span>`;

const hoursText = (h: number | null): string => (h === null ? "—" : h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`);
const statusBadge = (c: NodeCard): string => (c.flags.length ? badge(c.flags[0]!.text, c.flags[0]!.tone) : badge("healthy", "ok"));

// ---------- the detail card (cluster page and host page) ----------

function memoryBlock(c: NodeCard): string {
  const h = c.host;
  if (!h) return "";
  const total = Math.max(1, h.totalMi);
  const other = Math.max(0, h.totalMi - h.availableMi - h.anonMi);
  const w = (v: number) => clampPct((v / total) * 100);
  return (
    `<div class="node-row"><span class="node-label">Host memory</span><div>` +
    `<span class="stack-bar node-mem" aria-hidden="true">` +
    `<span data-k="mem-anon" style="--w:${w(h.anonMi)}"></span><span data-k="mem-other" style="--w:${w(other)}"></span>` +
    `<span data-k="mem-free" style="--w:${w(h.availableMi)}"></span></span>` +
    `<p class="stack-legend"><span><i data-k="mem-anon"></i>${fmtInt(h.anonMi)}Mi anonymous</span>` +
    `<span><i data-k="mem-other"></i>${fmtInt(other)}Mi cache &amp; other</span>` +
    `<span><i data-k="mem-free"></i>${fmtInt(h.availableMi)}Mi available</span>` +
    `<span>of ${fmtInt(h.totalMi)}Mi · swap ${esc(h.swap)}</span></p></div></div>`
  );
}

function podsBlock(c: NodeCard): string {
  if (!c.k8s && !c.pods) return "";
  const p = c.pods;
  if (!p) return `<div class="node-row"><span class="node-label">Pods vs allocatable</span><span class="meta">not available</span></div>`;
  return (
    `<div class="node-row"><span class="node-label">Pods vs allocatable</span><div>` +
    meter((p.workingSetMi / Math.max(1, p.allocatableMi)) * 100, p.tone, `${fmtInt(p.workingSetMi)} / ${fmtInt(p.allocatableMi)}Mi · ${fmtInt(p.headroomMi)}Mi headroom`) +
    `<p class="meta">${fmtInt(p.count)} pods. The kubelet raises MemoryPressure when headroom drops under 100Mi, whatever the host has free.</p>` +
    `</div></div>`
  );
}

function diskBlock(c: NodeCard): string {
  const d = c.host?.disk;
  if (!d) return "";
  return `<div class="node-row"><span class="node-label">Root disk</span><div>${meter(d.usedPct, d.tone, `${d.usedPct}% · ${d.availableGi}Gi free of ${d.totalGi}Gi`)}</div></div>`;
}

function outsideBlock(c: NodeCard): string {
  const h = c.host;
  if (!h) return "";
  const services = h.services.slice(0, 6);
  const procs = h.processes.slice(0, 8);
  const svc = services.length
    ? table(headers("Systemd service", ["Memory", "num"]), services.map((s) => `<tr>${cell("Systemd service", `<code translate="no">${esc(s.unit)}</code>`)}${cell("Memory", `${fmtInt(s.mi)}Mi`, "num")}</tr>`).join(""))
    : "";
  const pr = procs.length
    ? table(
        headers("Process", ["RSS", "num"], "Runs in"),
        procs
          .map((p) => `<tr>${cell("Process", `<code translate="no">${esc(p.name)}</code>`)}${cell("RSS", `${fmtInt(p.mi)}Mi`, "num")}${cell("Runs in", p.where === "pod" ? badge("pod", "") : `<code translate="no">${esc(p.where)}</code>`)}</tr>`)
          .join("")
      )
    : "";
  return `<div class="node-tables">${svc}${pr}</div>`;
}

export function nodeCard(c: NodeCard): string {
  const badges =
    (c.controlPlane ? badge("control plane", "info") : c.k8s ? badge("worker", "") : badge(c.cluster ? "host" : "standalone", "")) +
    c.holds.map((l) => badge(l, "info")).join("") +
    c.flags.map((f) => badge(f.text, f.tone)).join("") +
    (c.flags.length === 0 ? badge("healthy", "ok") : "");
  const facts: string[] = [];
  if (c.agent) facts.push(`agent v${esc(c.agent.version ?? "?")}${c.id !== c.name ? ` as <code translate="no">${esc(c.id)}</code>` : ""}`);
  if (c.host) facts.push(`snapshot ${fmtInt(c.host.ageSeconds)}s ago`, `load ${esc(c.host.load.map((l) => l.toFixed(2)).join(" "))}`, `up ${hoursText(c.host.uptimeHours)}`);
  if (c.host?.allPodsMi !== null && c.host?.allPodsMi !== undefined && c.k8s) facts.push(`pods cgroup ${fmtInt(c.host.allPodsMi)}Mi`);
  if (c.agent) facts.push(c.agent.units.length ? `may restart: ${c.agent.units.map((u) => `<code translate="no">${esc(u)}</code>`).join(", ")}` : "restart allowlist empty");
  return (
    `<section class="card node-card" id="node-${esc(c.name)}">` +
    cardHead(c.name) +
    `<div class="node-badges">${badges}</div>` +
    memoryBlock(c) +
    podsBlock(c) +
    diskBlock(c) +
    outsideBlock(c) +
    (c.host === null && c.agent === null ? empty("No host data", "Install devops-vm-agent on this machine (homelab-k8s devops-vm-agent.yml).") : "") +
    (facts.length ? `<p class="meta node-facts">${facts.join(" · ")}</p>` : "") +
    (c.k8s?.taints.length ? `<p class="meta node-facts">taints: ${c.k8s.taints.map((t) => `<code translate="no">${esc(t)}</code>`).join(" ")}</p>` : "") +
    `</section>`
  );
}

const STATUS_TONE: Record<string, Tone> = { succeeded: "ok", failed: "critical", refused: "warning", expired: "warning", pending: "", claimed: "" };

function actionsPanel(rows: ActionRowLike[], now: Date, link: (host: string) => string | null): string {
  const body = rows.length
    ? table(
        headers("When", "Host", "Action", "Status", ["Exit", "num"]),
        rows
          .map((a) => {
            const href = link(a.host);
            return (
              `<tr>${cell("When", timeTag(a.createdAt, now))}${cell("Host", href ? `<a href="${esc(href)}">${esc(a.host)}</a>` : esc(a.host))}` +
              `${cell("Action", `${esc(a.action)} <code translate="no">${esc(a.unit)}</code>`)}${cell("Status", badge(a.status, STATUS_TONE[a.status] ?? ""))}` +
              `${cell("Exit", a.exitCode === null ? dash : esc(a.exitCode), "num")}</tr>`
            );
          })
          .join("")
      )
    : empty("No host actions yet", "An approved restart of a systemd unit on a host shows here with its result.", ICON.wrench);
  return panel("Host actions", body);
}

const notesBlock = (m: NodesModel): string =>
  m.unavailable.length
    ? `<div class="card node-notes"><p><strong>Not everything could be read</strong></p><ul class="meta">${m.unavailable.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>`
    : "";

const allCards = (m: NodesModel): NodeCard[] => [...m.clusters.flatMap((g) => g.cards), ...m.standalone];

// ---------- /nodes: the fleet ----------

export interface FleetView {
  /** A cluster name, "standalone", or null for all. */
  group: string | null;
  attention: boolean;
  q: string;
}

const fleetHref = (v: FleetView, change: Partial<FleetView>): string => {
  const n = { ...v, ...change };
  const qs = new URLSearchParams();
  if (n.group) qs.set("group", n.group);
  if (n.attention) qs.set("attention", "1");
  if (n.q) qs.set("q", n.q);
  const s = qs.toString();
  return `/nodes${s ? `?${s}` : ""}`;
};

const holdersStrip = (g: ClusterGroup): string =>
  g.holders.length
    ? `<p class="node-holders">${g.holders.map((h) => `<span>${esc(h.label)} <strong>${esc(h.node)}</strong></span>`).join("")}</p>`
    : "";

function k8sRows(cards: NodeCard[]): string {
  return table(
    headers("Host", "Status", "Memory free", "Pod headroom", ["Disk", "num"], "Largest outside pods", "Agent"),
    cards
      .map((c) => {
        const h = c.host;
        const top = h?.services[0];
        const sub = [c.controlPlane ? "control plane" : c.k8s ? "worker" : "host", ...c.holds.map((x) => x.replace(" leader", "").replace(" (kube-vip)", "")), c.pods ? `${fmtInt(c.pods.count)} pods` : ""].filter(Boolean).join(" · ");
        return (
          `<tr${worstTone(c) === "warning" || worstTone(c) === "critical" ? ` data-attention` : ""}>` +
          cell("Host", `<a href="${esc(hostHref(c))}" class="node-host">${esc(c.name)}</a><span class="node-sub">${esc(sub)}</span>`) +
          cell("Status", statusBadge(c)) +
          cell("Memory free", h ? cellMeter((h.availableMi / Math.max(1, h.totalMi)) * 100, "ok", `${fmtInt(h.availableMi)}Mi of ${fmtInt(h.totalMi)}Mi`) : dash) +
          cell("Pod headroom", c.pods ? cellMeter((c.pods.workingSetMi / Math.max(1, c.pods.allocatableMi)) * 100, c.pods.tone, `${fmtInt(c.pods.headroomMi)}Mi left`) : dash) +
          cell("Disk", h?.disk ? `<span${h.disk.tone !== "ok" ? ` data-tone="${h.disk.tone}"` : ""}>${h.disk.usedPct}%</span>` : dash, "num") +
          cell("Largest outside pods", top ? `<code translate="no">${esc(top.unit)}</code> ${fmtInt(top.mi)}Mi` : dash) +
          cell("Agent", c.agent ? `v${esc(c.agent.version ?? "?")} · ${h ? `${fmtInt(h.ageSeconds)}s` : "no snapshot"}` : dash) +
          `</tr>`
        );
      })
      .join("")
  );
}

function standaloneRows(cards: NodeCard[], now: Date): string {
  return table(
    headers("Host", "Status", "Memory free", ["Disk", "num"], "Largest services", "May restart", "Last action", "Agent"),
    cards
      .map((c) => {
        const h = c.host;
        const a = c.lastAction;
        return (
          `<tr${worstTone(c) === "warning" || worstTone(c) === "critical" ? ` data-attention` : ""}>` +
          cell("Host", `<a href="${esc(hostHref(c))}" class="node-host">${esc(c.name)}</a><span class="node-sub">standalone</span>`) +
          cell("Status", statusBadge(c)) +
          cell("Memory free", h ? cellMeter((h.availableMi / Math.max(1, h.totalMi)) * 100, "ok", `${fmtInt(h.availableMi)}Mi of ${fmtInt(h.totalMi)}Mi`) : dash) +
          cell("Disk", h?.disk ? `<span${h.disk.tone !== "ok" ? ` data-tone="${h.disk.tone}"` : ""}>${h.disk.usedPct}%</span>` : dash, "num") +
          cell("Largest services", h?.services.length ? h.services.slice(0, 2).map((s) => `<code translate="no">${esc(s.unit)}</code> ${fmtInt(s.mi)}Mi`).join("<br>") : dash) +
          cell("May restart", c.agent?.units.length ? c.agent.units.map((u) => `<code translate="no">${esc(u)}</code>`).join("<br>") : `<span class="meta">none</span>`) +
          cell("Last action", a ? `${badge(`${a.action} ${a.status}`, STATUS_TONE[a.status] ?? "")}<br><code translate="no">${esc(a.unit)}</code> · ${timeTag(a.createdAt, now)}` : dash) +
          cell("Agent", c.agent ? `v${esc(c.agent.version ?? "?")} · ${h ? `${fmtInt(h.ageSeconds)}s` : "no snapshot"}` : dash) +
          `</tr>`
        );
      })
      .join("")
  );
}

const keep = (v: FleetView) => (c: NodeCard): boolean =>
  (!v.attention || worstTone(c) === "warning" || worstTone(c) === "critical") && (!v.q || c.name.includes(v.q) || c.id.includes(v.q));

function groupSection(g: ClusterGroup, v: FleetView): string {
  const cards = g.cards.filter(keep(v));
  const head =
    `<header class="node-group-head"><div class="node-group-title"><h2 class="card-title">${esc(g.name)}</h2>` +
    badge(`Kubernetes · ${fmtInt(g.cards.length)} node${g.cards.length === 1 ? "" : "s"}`, "info") +
    (g.reachable ? badge("reachable", "ok") : badge("unreachable", "critical")) +
    `</div><a class="standalone" href="${esc(clusterHref(g.name))}">Open cluster view →</a></header>`;
  const body = !g.reachable && g.cards.length === 0
    ? `<div class="node-group-empty"><strong>The cluster did not answer, and no host agent reports from it.</strong><p class="meta">${esc(g.note ?? "")}. Its hosts appear here once either answers — the rest of the page does not wait for it.</p></div>`
    : (g.reachable ? "" : `<p class="meta node-group-note">Kubernetes half missing: ${esc(g.note ?? "unreachable")}. Showing what the host agents report.</p>`) +
      (cards.length ? k8sRows(cards) : `<p class="meta node-group-note">No host here matches the filter.</p>`);
  return `<section class="card flush node-group" id="group-${esc(g.name)}">${head}${holdersStrip(g)}${body}</section>`;
}

export function hostsPage(m: NodesModel, v: FleetView, now: Date = new Date(), openIncidents?: number): string {
  const s = m.summary;
  const groups = [...m.clusters.map((g) => ({ key: g.name, label: g.name, n: g.cards.length })), ...(m.standalone.length ? [{ key: "standalone", label: "Standalone", n: m.standalone.length }] : [])];
  const seg =
    `<nav class="seg" aria-label="Group"><a href="${esc(fleetHref(v, { group: null }))}"${v.group === null ? ` aria-current="true"` : ""}>All · ${fmtInt(s.hosts)}</a>` +
    groups.map((g) => `<a href="${esc(fleetHref(v, { group: g.key }))}"${v.group === g.key ? ` aria-current="true"` : ""}>${esc(g.label)} · ${fmtInt(g.n)}</a>`).join("") +
    `</nav>`;
  const tools =
    `<div class="node-filters">${seg}` +
    `<a class="node-toggle" href="${esc(fleetHref(v, { attention: !v.attention }))}"${v.attention ? ` aria-current="true"` : ""}>${v.attention ? "Showing only what needs a look" : "Only what needs a look"}</a>` +
    `<form class="node-search" method="get" action="/nodes" role="search">` +
    (v.group ? `<input type="hidden" name="group" value="${esc(v.group)}">` : "") +
    (v.attention ? `<input type="hidden" name="attention" value="1">` : "") +
    `<label><span class="sr-only">Search hosts</span><input type="search" name="q" value="${esc(v.q)}" placeholder="Search hosts"></label></form></div>`;
  const shelf = statList([
    { label: "Hosts", value: fmtInt(s.hosts), sub: `${fmtInt(s.clusters)} cluster${s.clusters === 1 ? "" : "s"} · ${fmtInt(s.standalone)} standalone`, icon: ICON.server },
    { label: "Need a look", value: fmtInt(s.needLook.length), sub: s.needLook.slice(0, 3).join(" · ") || "nothing flagged", icon: ICON.incidents, ...(s.needLook.length ? { tone: "warning" } : {}) },
    { label: "Clusters unreachable", value: fmtInt(s.unreachable.length), sub: s.unreachable.join(" · ") || "all answered", icon: ICON.layers, ...(s.unreachable.length ? { tone: "critical" } : {}) },
    { label: "Agents reporting", value: `${fmtInt(s.reporting)} / ${fmtInt(s.hosts)}`, sub: "snapshot under 3 minutes old", icon: ICON.plug, ...(s.reporting < s.hosts ? { tone: "warning" } : {}) },
  ]);
  const showGroup = (key: string) => v.group === null || v.group === key;
  const standaloneCards = m.standalone.filter(keep(v));
  const standaloneSection =
    m.standalone.length && showGroup("standalone")
      ? `<section class="card flush node-group" id="group-standalone"><header class="node-group-head"><div class="node-group-title"><h2 class="card-title">Standalone hosts</h2>` +
        badge(`no cluster · ${fmtInt(m.standalone.length)} host${m.standalone.length === 1 ? "" : "s"}`, "") +
        `</div><span class="meta">Matched to alerts by their hostname label</span></header>` +
        (standaloneCards.length ? standaloneRows(standaloneCards, now) : `<p class="meta node-group-note">No host here matches the filter.</p>`) +
        `</section>`
      : "";
  const body =
    pageHead({
      eyebrow: "Agent",
      title: "Hosts",
      lede: "Every machine that runs devops-vm-agent, Kubernetes node or not — grouped by cluster, machines outside any cluster standalone.",
    }) +
    shelf +
    tools +
    notesBlock(m) +
    m.clusters.filter((g) => showGroup(g.name)).map((g) => groupSection(g, v)).join("") +
    standaloneSection +
    (s.hosts === 0 && m.clusters.length === 0 ? empty("No hosts", "No cluster answered and no devops-vm-agent has reported yet.", ICON.server) : "") +
    actionsPanel(m.actions, now, (host) => {
      const c = allCards(m).find((x) => x.id === host);
      return c ? hostHref(c) : null;
    });
  return layout("Hosts", body, { current: "/nodes", openIncidents });
}

// ---------- /nodes/c/<cluster> ----------

function budgetColumn(c: NodeCard): string {
  const b = c.budget!;
  const total = Math.max(1, b.totalMi);
  const pct = (v: number) => Math.round((v / total) * 1000) / 10;
  const segs = b.parts.map((p) => `<span data-k="b-${p.key}" style="--h:${pct(p.mi)}"></span>`).join("");
  const legend = [...b.parts]
    .reverse()
    .map((p) => `<li><i data-k="b-${p.key}"></i><span>${esc(p.label)}</span><strong>${fmtInt(p.mi)}Mi</strong></li>`)
    .join("");
  return (
    `<div class="budget-col">` +
    `<p class="budget-name"><a href="#node-${esc(c.name)}">${esc(c.name)}</a></p>` +
    `<div class="node-badges">${c.holds.map((l) => badge(l, "info")).join("")}${c.pods ? badge(`${fmtInt(c.pods.headroomMi)}Mi pod headroom`, c.pods.tone) : ""}</div>` +
    `<div class="budget-body"><div class="budget-bar" role="img" aria-label="${esc(`${c.name}: ${b.parts.map((p) => `${p.label} ${p.mi}Mi`).join(", ")}; allocatable ${b.allocatableMi}Mi`)}">${segs}` +
    `<span class="budget-line" style="--at:${pct(b.allocatableMi)}" title="allocatable ${fmtInt(b.allocatableMi)}Mi"></span></div>` +
    `<ul class="budget-legend">${legend}<li class="budget-alloc"><span>allocatable (dashed line)</span><strong>${fmtInt(b.allocatableMi)}Mi</strong></li></ul></div>` +
    `</div>`
  );
}

export function nodeClusterPage(m: NodesModel, name: string, now: Date = new Date(), openIncidents?: number): string | null {
  const g = m.clusters.find((x) => x.name === name);
  if (!g) return null;
  const planes = g.cards.filter((c) => c.budget);
  const ids = new Set(g.cards.map((c) => c.id));
  const body =
    pageHead({
      eyebrow: "Hosts",
      title: g.name,
      lede: g.reachable
        ? "The control planes' memory as one budget each, then every node in detail."
        : `Kubernetes did not answer (${g.note ?? "unreachable"}); what the host agents report is below.`,
      tools: `<a class="standalone" href="/nodes">← All hosts</a>`,
    }) +
    (g.holders.length ? `<div class="card node-map">${holdersStrip(g)}<p class="meta">Leader leases move: the node holding them carries the extra memory, so pressure can move with no change at all.</p></div>` : "") +
    (planes.length
      ? section(ICON.layers, "Control plane") +
        `<div class="card budget-grid">${planes.map(budgetColumn).join("")}</div>`
      : "") +
    section(ICON.server, "Nodes") +
    (g.cards.length ? `<div class="node-grid">${g.cards.map(nodeCard).join("")}</div>` : empty("No nodes", "Neither Kubernetes nor any host agent reported a node of this cluster.", ICON.server)) +
    actionsPanel(m.actions.filter((a) => ids.has(a.host)), now, (host) => `#node-${host}`);
  return layout(`${g.name} · Hosts`, body, { current: "/nodes", openIncidents });
}

// ---------- /nodes/h/<host> ----------

export function hostPage(m: NodesModel, id: string, now: Date = new Date(), openIncidents?: number): string | null {
  const c = allCards(m).find((x) => x.id === id || (!x.cluster && x.name === id));
  if (!c) return null;
  const back = c.cluster ? `<a class="standalone" href="${esc(clusterHref(c.cluster))}">← ${esc(c.cluster)}</a>` : `<a class="standalone" href="/nodes?group=standalone">← Standalone hosts</a>`;
  const body =
    pageHead({ eyebrow: c.cluster ? `Hosts · ${c.cluster}` : "Hosts · standalone", title: c.name, code: true, tools: back }) +
    nodeCard(c) +
    actionsPanel(m.actions.filter((a) => a.host === c.id), now, () => null);
  return layout(`${c.name} · Hosts`, body, { current: "/nodes", openIncidents });
}
