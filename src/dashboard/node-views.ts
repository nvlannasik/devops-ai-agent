import { cell, esc, fmtInt, headers, table, timeTag } from "./html.js";
import { ICON, badge, cardHead, dash, empty, pageHead, panel, section, statList } from "./parts.js";
import { layout } from "./layout.js";
import type { ActionRowLike, NodeCard, NodesModel, Tone } from "./nodes.js";

// --- /nodes: the host half and the Kubernetes half of every node (model: nodes.ts) ---

const RATE: Record<Tone, string> = { ok: "rate-ok", warning: "rate-warn", critical: "rate-bad", "": "rate-ok" };
const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** A bar with its number beside it — the bench page's rate bar, toned. Never colour alone: the text says it. */
const meter = (pct: number, t: Tone, text: string): string =>
  `<span class="rate-bar" aria-hidden="true"><span class="rate-fill ${RATE[t]}" style="width:${clampPct(pct)}%"></span></span>` +
  `<span class="node-meter-text">${esc(text)}</span>`;

const hoursText = (h: number | null): string => (h === null ? "—" : h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`);

function memoryBlock(c: NodeCard): string {
  const h = c.host;
  if (!h) return "";
  const total = Math.max(1, h.totalMi);
  const other = Math.max(0, h.totalMi - h.availableMi - h.anonMi);
  // anonymous (cannot be reclaimed) + the rest in use + what the kernel can still give.
  const w = (mi: number) => clampPct((mi / total) * 100);
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

function nodeCard(c: NodeCard): string {
  const badges =
    (c.controlPlane ? badge("control plane", "info") : badge("worker", "")) +
    c.holds.map((l) => badge(l, "info")).join("") +
    c.flags.map((f) => badge(f.text, f.tone)).join("") +
    (c.flags.length === 0 && c.k8s ? badge("healthy", "ok") : "");
  const facts: string[] = [];
  if (c.agent) facts.push(`agent v${esc(c.agent.version ?? "?")}`);
  if (c.host) facts.push(`snapshot ${fmtInt(c.host.ageSeconds)}s ago`, `load ${esc(c.host.load.map((l) => l.toFixed(2)).join(" "))}`, `up ${hoursText(c.host.uptimeHours)}`);
  if (c.host?.allPodsMi !== null && c.host?.allPodsMi !== undefined) facts.push(`pods cgroup ${fmtInt(c.host.allPodsMi)}Mi`);
  if (c.agent) facts.push(c.agent.units.length ? `may restart: ${c.agent.units.map((u) => esc(u)).join(", ")}` : "restart allowlist empty");
  return (
    `<section class="card node-card" id="node-${esc(c.name)}">` +
    cardHead(c.name) +
    `<div class="node-badges">${badges}</div>` +
    memoryBlock(c) +
    podsBlock(c) +
    diskBlock(c) +
    outsideBlock(c) +
    (c.host === null && c.agent === null ? empty("No host data", "Install devops-vm-agent on this node (homelab-k8s devops-vm-agent.yml).") : "") +
    (facts.length ? `<p class="meta node-facts">${facts.join(" · ")}</p>` : "") +
    (c.k8s?.taints.length ? `<p class="meta node-facts">taints: ${c.k8s.taints.map((t) => `<code translate="no">${esc(t)}</code>`).join(" ")}</p>` : "") +
    `</section>`
  );
}

const STATUS_TONE: Record<string, Tone> = { succeeded: "ok", failed: "critical", refused: "warning", expired: "warning", pending: "", claimed: "" };

function actionsPanel(rows: ActionRowLike[], now: Date): string {
  const body = rows.length
    ? table(
        headers("When", "Host", "Action", "Status", ["Exit", "num"]),
        rows
          .map(
            (a) =>
              `<tr>${cell("When", timeTag(a.createdAt, now))}${cell("Host", `<a href="#node-${esc(a.host)}">${esc(a.host)}</a>`)}` +
              `${cell("Action", `${esc(a.action)} <code translate="no">${esc(a.unit)}</code>`)}${cell("Status", badge(a.status, STATUS_TONE[a.status] ?? ""))}` +
              `${cell("Exit", a.exitCode === null ? dash : esc(a.exitCode), "num")}</tr>`
          )
          .join("")
      )
    : empty("No host actions yet", "An approved restart of a systemd unit on a VM shows here with its result.", ICON.wrench);
  return panel("Host actions", body);
}

export function nodesPage(m: NodesModel, now: Date = new Date(), openIncidents?: number): string {
  const s = m.summary;
  const shelf = statList([
    { label: "Nodes", value: fmtInt(s.nodes), sub: `${fmtInt(s.controlPlanes)} control plane`, icon: ICON.server },
    { label: "Under pressure", value: fmtInt(s.underPressure), sub: "a pressure condition or not Ready", icon: ICON.incidents, ...(s.underPressure > 0 ? { tone: "critical" } : {}) },
    { label: "Host agents reporting", value: `${fmtInt(s.reporting)} / ${fmtInt(s.nodes)}`, sub: "snapshot under 3 minutes old", icon: ICON.plug, ...(s.reporting < s.nodes ? { tone: "warning" } : {}) },
    {
      label: "Tightest pod headroom",
      value: s.tightest ? `${fmtInt(s.tightest.headroomMi)}Mi` : "—",
      sub: s.tightest ? s.tightest.node : "no pod data",
      icon: ICON.memory,
      ...(s.tightest && s.tightest.headroomMi < 200 ? { tone: s.tightest.headroomMi < 100 ? "critical" : "warning" } : {}),
    },
  ]);
  const notes = m.unavailable.length
    ? `<div class="card"><p><strong>Not everything could be read</strong></p><ul class="meta">${m.unavailable.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>`
    : "";
  const body =
    pageHead({
      eyebrow: "Agent",
      title: "Nodes",
      lede: "Each node as its host sees it (devops-vm-agent, every minute) and as Kubernetes sees it: memory outside pods, pods against allocatable, disk, and which control-plane leases it holds.",
    }) +
    shelf +
    notes +
    section(ICON.server, "Nodes") +
    (m.cards.length ? `<div class="node-grid">${m.cards.map(nodeCard).join("")}</div>` : empty("No nodes", "Neither Kubernetes nor any devops-vm-agent reported a node.", ICON.server)) +
    actionsPanel(m.actions, now);
  return layout("Nodes", body, { current: "/nodes", openIncidents });
}
