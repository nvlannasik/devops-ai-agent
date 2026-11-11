import type { ClusterInventory, DashboardClusterModel, ManagedBy } from "./cluster-types.js";
import { cell, esc, fmtInt, headers, table } from "./html.js";
import type { Assets } from "./assets.js";
import { ICON, badge, breakable, cardHead, empty, jsonBlock, panel, statList, toneAttr } from "./parts.js";
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
function clusterFrame(inv: ClusterInventory, nonce: string, assets: Assets | null, model: DashboardClusterModel | null, ns: string, rows: number): string {
  const head = cardHead("Namespace map", `<span class="meta">Drag to move · Ctrl + scroll to zoom</span>`);
  if (!assets) {
    return (
      `<section class="card flush topo-frame">` + head +
      empty("The cluster map is not built.", "Run npm run build:client to bundle it. Every fact it draws is in the table below.", ICON.plug) +
      `</section>`
    );
  }
  // data-ns scopes the map to the namespace this page is showing: the list beside it is the
  // namespace grid the map used to draw, so the map draws one namespace's lanes and nothing else.
  return (
    `<section class="card flush topo-frame">` + head +
    // --rows sizes the frame (styles/content.ts): one namespace is one lane block, a row per
    // workload, and a frame of fixed height left a three-row namespace floating in a tall box.
    `<div id="cluster-root" data-fallback data-ns="${esc(ns)}" style="--rows:${Math.max(1, Math.round(Number(rows)) || 1)}">` +
    `<p class="topo-fallback">The cluster map needs JavaScript. The table below carries the same facts.</p>` +
    `</div>` +
    `</section>` +
    jsonBlock("cluster-data", nonce, inv) +
    (model ? jsonBlock("cluster-model", nonce, model) : "") +
    `<script src="${esc(assets.clusterJs.path)}" nonce="${esc(nonce)}" defer></script>`
  );
}

type Ns = ClusterInventory["namespaces"][number];
const isShort = (w: Ns["workloads"][number]): boolean => w.ready !== null && w.desired !== null && w.ready < w.desired;
const isOutside = (w: Ns["workloads"][number]): boolean => w.managedBy.type === "unmanaged";
/** `5/6` — workloads at their desired count over all of them — toned only when one is short. */
const readyPill = (n: Ns): string => {
  const short = n.workloads.filter(isShort).length;
  const text = `${fmtInt(n.workloads.length - short)}/${fmtInt(n.workloads.length)}`;
  return short ? badge(text, "warning") : `<span class="ns-ready">${text}</span>`;
};

export function clusterPage(
  inv: ClusterInventory | null,
  error: string | null,
  openIncidents?: number,
  nonce = "",
  assets: Assets | null = null,
  model: DashboardClusterModel | null = null,
  /** Multi-cluster only: the registry, and which cluster this render is for. Absent = single-cluster,
   *  and the page is unchanged (no switch, no cluster in the title). */
  view?: { current: string; names: string[] },
  /** `?ns=` — the namespace the detail pane shows. Unknown or absent picks one (see `pick`). */
  ns?: string
): string {
  const clusterNav = view
    ? `<nav class="seg" aria-label="Cluster">` +
      view.names.map((c) => `<a href="/cluster?cluster=${esc(c)}"${c === view.current ? ` aria-current="true"` : ""}>${esc(c)}</a>`).join("") +
      `</nav>`
    : "";
  // The cluster model's flow (agent/onboarding) rides beside the inventory. The page never waits for
  // it — a cold cache says so and the next load has it; what could not be read is listed, not hidden.
  const flowNote = !model
    ? `<p class="meta">Request flow is being computed — reload in a few seconds.</p>`
    : model.unknowns.length
      ? `<p class="meta"><strong>Not known</strong></p><ul class="meta">${model.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
      : "";
  // A link, not a script: the selection is in the URL, so it survives a reload and can be shared.
  const nsHref = (name: string): string =>
    esc(`/cluster?${view ? `cluster=${encodeURIComponent(view.current)}&` : ""}ns=${encodeURIComponent(name)}`);
  const nsLinks = (list: Ns[], current: string): string =>
    `<ul>` +
    list
      .map((n) => {
        const outside = n.workloads.filter(isOutside).length;
        return (
          `<li><a href="${nsHref(n.name)}"${n.name === current ? ` aria-current="true"` : ""}>` +
          `<span><span class="ns-name" translate="no">${breakable(n.name)}</span>` +
          `<span class="ns-note">${fmtInt(n.workloads.length)} workload${n.workloads.length === 1 ? "" : "s"}${outside ? ` · ${fmtInt(outside)} outside GitOps` : ""}</span></span>` +
          readyPill(n) +
          `</a></li>`
        );
      })
      .join("") +
    `</ul>`;
  // One namespace, whole: what it is, its map, and its workloads with where each is declared.
  const nsDetail = (n: Ns): string => {
    const short = n.workloads.filter(isShort).length;
    const outside = n.workloads.filter(isOutside).length;
    const hosts = n.ingresses.flatMap((x) => x.hosts);
    const fact = (label: string, value: string, warn = false): string =>
      `<div><dt>${label}</dt><dd${warn ? ` data-tone="warning"` : ""}>${value}</dd></div>`;
    const summary =
      `<section class="card ns-summary"><div><h2 class="ns-title" translate="no">${breakable(n.name)}</h2>` +
      `<p class="meta">${n.system ? "System namespace — the platform runs it." : "Application namespace."}${
        model ? ` Flux applied <code translate="no">${esc(model.snapshot.appliedRevision ?? "unknown")}</code>.` : ""
      }</p></div>` +
      `<dl class="ns-facts">` +
      fact("Ready", `${fmtInt(n.workloads.length - short)}/${fmtInt(n.workloads.length)}`, short > 0) +
      fact("Services", fmtInt(n.services.length)) +
      fact("Ingress hosts", fmtInt(hosts.length)) +
      fact("Outside GitOps", fmtInt(outside), outside > 0) +
      `</dl></section>`;
    if (n.workloads.length === 0) {
      return summary + flowNote + panel("Workloads", empty("Nothing deployed here.", "No Deployment, StatefulSet, DaemonSet or CronJob in this namespace.", ICON.layers));
    }
    // Where the image is declared in Git (the cluster model's `locate`), as a line under the owner
    // rather than a sixth column: a path is the longest string in the row and the table has a
    // namespace list beside it. Only with a model — a cold cache must not print "not located" for
    // a workload nobody has looked for yet — and never for a workload Git does not declare.
    const where = (w: Ns["workloads"][number]): string => {
      if (!model || isOutside(w)) return "";
      const k = model.changeAt[`wl/${n.name}/${w.name}`]?.image;
      return (
        `<div class="sub">` +
        (k
          ? `<code translate="no">${esc(`${k.path}:${k.line}`)}</code>${k.drift ? ` ${badge("drift", "warning")}` : ""}`
          : "not located in Git") +
        `</div>`
      );
    };
    // What someone acts on first: short of desired, then outside GitOps, then the rest as scanned.
    const rank = (w: Ns["workloads"][number]): number => (isShort(w) ? 0 : isOutside(w) ? 1 : 2);
    const rows = [...n.workloads]
      .sort((a, b) => rank(a) - rank(b))
      .map(
        (w) =>
          `<tr role="row"${toneAttr(isShort(w) ? "warning" : undefined)}>` +
          cell("Workload", `<code translate="no">${breakable(w.name)}</code>`, "primary") +
          cell("Kind", esc(w.kind) + (w.schedule ? ` <code translate="no" style="white-space:nowrap">${esc(w.schedule)}</code>` : "")) +
          // Short of desired is the one state in this table someone acts on, so it is the one toned.
          cell(
            "Ready",
            w.ready === null || w.desired === null
              ? "—"
              : isShort(w)
                ? badge(`${fmtInt(w.ready)}/${fmtInt(w.desired)}`, "warning")
                : `${fmtInt(w.ready)}/${fmtInt(w.desired)}`,
            "num"
          ) +
          cell("Image", w.images.map((i) => `<code translate="no">${esc(i)}</code>`).join("<br>") || "—") +
          cell("Managed by", managed(w.managedBy) + where(w)) +
          `</tr>`
      )
      .join("");
    const svc = n.services.map((x) => `<code translate="no">${esc(x.name)}</code> ${esc(x.ports.join(", "))}`).join(" · ");
    const hostList = hosts.map((h) => `<code translate="no">${esc(h)}</code>`).join(" · ");
    const head = headers("Workload", "Kind", ["Ready", "num"], "Image", "Managed by");
    return (
      summary +
      clusterFrame(inv!, nonce, assets, model, n.name, n.workloads.length) +
      flowNote +
      panel(
        "Workloads",
        table(head, rows, "pairs") +
          (svc || hostList
            ? `<p class="meta">${svc ? `Services: ${svc}` : ""}${svc && hostList ? "<br>" : ""}${hostList ? `Ingress: ${hostList}` : ""}</p>`
            : ""),
        `<span class="meta">not ready first</span>`
      )
    );
  };
  let body: string;
  if (!inv) {
    body = empty(error ?? "No inventory.", "The inventory comes from the MCP server's k8s_cluster_inventory.", ICON.plug);
  } else {
    const user = inv.namespaces.filter((n) => !n.system);
    const system = inv.namespaces.filter((n) => n.system);
    const workloads = user.flatMap((n) => n.workloads);
    const short = workloads.filter(isShort);
    // The map's own predicate (cluster-graph.ts card()): applied by hand, not plain Helm.
    const outside = workloads.filter(isOutside);
    const names = (ws: typeof workloads) => ws.slice(0, 2).map((w) => w.name).join(", ") + (ws.length > 2 ? ` +${ws.length - 2}` : "");
    const shelf = statList([
      { icon: ICON.layers, label: "Namespaces", value: fmtInt(user.length), sub: system.length ? `+${fmtInt(system.length)} system` : "application namespaces" },
      { icon: ICON.overview, label: "Workloads", value: fmtInt(workloads.length), sub: "in the application namespaces" },
      {
        icon: ICON.incidents,
        label: "Not ready",
        value: fmtInt(short.length),
        sub: short.length ? names(short) : "every workload at its desired count",
        tone: short.length ? "warning" : undefined,
      },
      { icon: ICON.changes, label: "Outside GitOps", value: fmtInt(outside.length), sub: outside.length ? names(outside) : "everything is declared in Git" },
    ]);
    // The namespace the URL names; else the first application namespace with something to act on,
    // else the first one — so the page opens on the thing a reader came to look at.
    const pick =
      inv.namespaces.find((n) => n.name === ns) ??
      user.find((n) => n.workloads.some((w) => isShort(w) || isOutside(w))) ??
      user[0] ??
      system[0];
    body =
      shelf +
      (inv.scanned.complete
        ? ""
        : `<p class="meta"><strong>Partial inventory</strong> — the scan hit its ceiling after ${fmtInt(inv.scanned.namespaces)} namespace(s); what is missing is not shown as empty.</p>`) +
      (pick
        ? `<div class="ns-split">` +
          `<nav class="card ns-list" aria-label="Namespaces">` +
          (user.length ? `<p class="ns-group">Application</p>${nsLinks(user, pick.name)}` : "") +
          (system.length ? `<p class="ns-group">System</p>${nsLinks(system, pick.name)}` : "") +
          `</nav>` +
          `<div class="ns-detail">${nsDetail(pick)}</div>` +
          `</div>`
        : empty("No namespaces in the inventory.", "The scan returned nothing to show.", ICON.layers));
  }
  return layout(
    view ? `Cluster · ${view.current}` : "Cluster",
    `<div class="doc">
     <header class="page-head"><div class="page-title">
       <p class="eyebrow">Agent</p>
       <h1>Cluster</h1>
       <p class="meta">What runs here and who manages it, read live from <code translate="no">k8s_cluster_inventory</code> —
         the same inventory the agent's cluster tour answers from. No model is involved in this page.</p>
     </div>${view ? `<div class="page-tools">${clusterNav}</div>` : ""}</header>
     ${body}
     </div>`,
    { current: "/cluster", openIncidents, stylesheet: assets?.css.path }
  );
}
