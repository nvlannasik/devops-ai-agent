import type { ClusterInventory, DashboardClusterModel, ManagedBy } from "./cluster-types.js";
import { cell, esc, fmtInt, headers, table } from "./html.js";
import type { Assets } from "./assets.js";
import { ICON, breakable, empty, jsonBlock, section } from "./parts.js";
import { layout } from "./layout.js";

// --- /cluster (spec 2026-10-07-cluster-tour §3.5) ---
// The mcp-server's k8s_cluster_inventory output — one definition, in cluster-types.ts, which the
// client bundle shares (it must not import anything that reaches server config).
export type { ClusterInventory } from "./cluster-types.js";

const managed = (m: ManagedBy): string => {
  const extra = (v?: string) => (v ? ` <span class="meta">· ${esc(v)}</span>` : "");
  if (m.type === "helmrelease") return `HelmRelease <code translate="no">${esc(`${m.namespace}/${m.name}`)}</code>${extra(m.chart)}`;
  if (m.type === "kustomization") return `Kustomization <code translate="no">${esc(`${m.namespace}/${m.name}`)}</code>${extra(m.path)}`;
  if (m.type === "helm") return `Helm${extra(m.chart)}`;
  return `<span class="meta">not managed by GitOps</span>`;
};

/** The inventory, deterministically — no LLM. `error` is the reason there is no inventory. */
/**
 * The cluster map's frame — topoFrame's contract for the second bundle (client/cluster.tsx): a
 * mount holding the no-JS sentence, the inventory as an escaped JSON block, the script under the
 * response's nonce. No bundle (`npm run dev`) is a note, not an empty frame.
 */
function clusterFrame(inv: ClusterInventory, nonce: string, assets: Assets | null, model: DashboardClusterModel | null): string {
  if (!assets) {
    return (
      `<div class="card topo-frame">` +
      empty("The cluster map is not built.", "Run npm run build:client to bundle it. Every fact it draws is in the tables below.", ICON.plug) +
      `</div>`
    );
  }
  return (
    `<div class="card flush topo-frame">` +
    `<div id="cluster-root" data-fallback>` +
    `<p class="topo-fallback">The cluster map needs JavaScript. The tables below carry the same facts.</p>` +
    `</div>` +
    `</div>` +
    jsonBlock("cluster-data", nonce, inv) +
    (model ? jsonBlock("cluster-model", nonce, model) : "") +
    `<script src="${esc(assets.clusterJs.path)}" nonce="${esc(nonce)}" defer></script>`
  );
}

export function clusterPage(
  inv: ClusterInventory | null,
  error: string | null,
  openIncidents?: number,
  nonce = "",
  assets: Assets | null = null,
  model: DashboardClusterModel | null = null
): string {
  // The cluster model's flow (agent/onboarding) rides beside the inventory. The page never waits for
  // it — a cold cache says so and the next load has it; what could not be read is listed, not hidden.
  const flowNote = !model
    ? `<p class="meta">Request flow is being computed — reload in a few seconds.</p>`
    : model.unknowns.length
      ? `<p class="meta"><strong>Not known</strong></p><ul class="meta">${model.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
      : "";
  const nsBlock = (ns: ClusterInventory["namespaces"][number]): string => {
    if (ns.workloads.length === 0) {
      return `${section(ICON.layers, ns.name)}${empty("Nothing deployed here.", "No Deployment, StatefulSet, DaemonSet or CronJob in this namespace.", ICON.layers)}`;
    }
    const rows = ns.workloads
      .map(
        (w) =>
          `<tr role="row">` +
          cell("Workload", `<code translate="no">${breakable(w.name)}</code>`, "primary") +
          cell("Kind", esc(w.kind) + (w.schedule ? ` <code translate="no" style="white-space:nowrap">${esc(w.schedule)}</code>` : "")) +
          cell("Ready", w.ready === null || w.desired === null ? "—" : `${fmtInt(w.ready)}/${fmtInt(w.desired)}`, "num") +
          cell("Image", w.images.map((i) => `<code translate="no">${esc(i)}</code>`).join("<br>") || "—") +
          cell("Managed by", managed(w.managedBy)) +
          `</tr>`
      )
      .join("");
    const svc = ns.services.map((x) => `<code translate="no">${esc(x.name)}</code> ${esc(x.ports.join(", "))}`).join(" · ");
    const hosts = ns.ingresses.flatMap((x) => x.hosts).map((h) => `<code translate="no">${esc(h)}</code>`).join(" · ");
    return (
      `${section(ICON.layers, ns.name)}` +
      table(headers("Workload", "Kind", ["Ready", "num"], "Image", "Managed by"), rows, "pairs") +
      (svc || hosts
        ? `<p class="meta">${svc ? `Services: ${svc}` : ""}${svc && hosts ? "<br>" : ""}${hosts ? `Ingress: ${hosts}` : ""}</p>`
        : "")
    );
  };
  let body: string;
  if (!inv) {
    body = empty(error ?? "No inventory.", "The inventory comes from the MCP server's k8s_cluster_inventory.", ICON.plug);
  } else {
    const user = inv.namespaces.filter((n) => !n.system);
    const system = inv.namespaces.filter((n) => n.system);
    body =
      (inv.scanned.complete
        ? ""
        : `<p class="meta"><strong>Partial inventory</strong> — the scan hit its ceiling after ${fmtInt(inv.scanned.namespaces)} namespace(s); what is missing is not shown as empty.</p>`) +
      clusterFrame(inv, nonce, assets, model) +
      flowNote +
      user.map(nsBlock).join("") +
      (system.length
        ? `${section(ICON.layers, "System namespaces")}` +
          `<details><summary>Show ${fmtInt(system.length)} namespace(s) the platform runs — ${esc(system.map((n) => n.name).join(", "))}</summary>${system.map(nsBlock).join("")}</details>`
        : "");
  }
  return layout(
    "Cluster",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>Cluster</h1>
     <p class="meta">What runs here and who manages it, read live from <code translate="no">k8s_cluster_inventory</code> —
       the same inventory the agent's cluster tour answers from. No model is involved in this page.</p>
     ${body}
     </div>`,
    { current: "/cluster", openIncidents, stylesheet: assets?.css.path }
  );
}
