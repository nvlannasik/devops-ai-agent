/**
 * The cluster tour's inventory as Block Kit tables, built from `k8s_cluster_inventory`'s own result
 * — never from the model's prose. So every name in a table is one the cluster returned: the D02
 * rerun (2026-10-07) had the model write its own inventory and invent `catalog-api-svc` for a
 * Service called `catalog-api`. The model keeps what only it can write: what each workload is
 * probably FOR (cluster-tour.md, *Dugaan fungsi*).
 *
 * Two shapes, decided by the payload (mcp-server `overviewOf`): an overview's workloads are one-line
 * strings, a namespace in detail carries objects. `text` is the same facts as mrkdwn — the message's
 * notification text, the fallback when Slack refuses the blocks, and what the bench scores.
 *
 * Returns null for anything that is not an inventory; the caller then posts the reply as before.
 */
import type { KnownBlock } from "@slack/types";
import { toSpans } from "./rca-tables.js";

type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };
interface DetailWorkload { kind: string; name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string }
interface Namespace {
  name: string;
  system: boolean;
  workloads: Array<string | DetailWorkload>;
  hosts?: string[];
  services?: Array<{ name: string; type: string; ports: string[] }>;
  ingresses?: Array<{ name: string; hosts: string[] }>;
}
interface Inventory { scanned: { namespaces: number; complete: boolean }; namespaces: Namespace[] }

const MAX_ROWS = 50; // per table; Slack allows 100, and rca-tables uses the same ceiling
const EMPTY = "—";

const cell = (text: string): KnownBlock =>
  ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: toSpans(text.trim() === "" ? EMPTY : text.trim()) }] }) as KnownBlock;
const head = (label: string) => ({ type: "raw_text", text: label });
const section = (text: string): KnownBlock => ({ type: "section", text: { type: "mrkdwn", text } }) as KnownBlock;

const code = (s: string) => `\`${s}\``;

/** "helmrelease flux-app/x" (overview) or a ManagedBy object (detail), as one reader-facing phrase. */
function owner(m: string | ManagedBy): string {
  if (typeof m === "string") {
    const [type, ref] = m.split(" ");
    if (type === "helmrelease") return `HelmRelease ${code(ref ?? "")}`;
    if (type === "kustomization") return `Kustomization ${code(ref ?? "")}`;
    if (type === "helm") return "Helm";
    return "not managed by GitOps";
  }
  if (m.type === "helmrelease") return `HelmRelease ${code(`${m.namespace}/${m.name}`)}${m.chart ? ` · ${m.chart}` : ""}`;
  if (m.type === "kustomization") return `Kustomization ${code(`${m.namespace}/${m.name}`)}${m.path ? ` · ${m.path}` : ""}`;
  if (m.type === "helm") return `Helm${m.chart ? ` · ${m.chart}` : ""}`;
  return "not managed by GitOps";
}

/** "Deployment storefront — helmrelease flux-app/storefront" → "`storefront` Deployment · HelmRelease `flux-app/storefront`". */
function overviewLine(w: string): string {
  const m = /^(\S+) (\S+) — (.+)$/.exec(w);
  return m ? `${code(m[2]!)} ${m[1]} · ${owner(m[3]!)}` : w;
}

function parse(raw: string | null): Inventory | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as Inventory;
    return v && Array.isArray(v.namespaces) && v.namespaces.length > 0 && v.scanned ? v : null;
  } catch {
    return null;
  }
}

function tables(header: string[], rows: string[][], wrapped: boolean[]): KnownBlock[] {
  const out: KnownBlock[] = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS) {
    out.push({
      type: "table",
      column_settings: wrapped.map((w) => ({ is_wrapped: w })),
      rows: [header.map(head), ...rows.slice(i, i + MAX_ROWS).map((r) => r.map(cell))],
    } as KnownBlock);
  }
  return out;
}

export function tourBlocks(raw: string | null): { blocks: KnownBlock[]; text: string } | null {
  const inv = parse(raw);
  if (!inv) return null;
  const partial = inv.scanned.complete
    ? ""
    : `\n_Partial inventory — the scan hit its ceiling after ${inv.scanned.namespaces} namespace(s); what is missing is not shown._`;
  const isOverview = inv.namespaces.some((n) => n.workloads.some((w) => typeof w === "string")) ||
    inv.namespaces.every((n) => n.services === undefined);

  if (isOverview) {
    const rows = inv.namespaces.map((n) => [
      n.name,
      n.workloads.map((w) => overviewLine(String(w))).join("\n"),
      (n.hosts ?? []).join("\n"),
    ]);
    const title = `*Cluster inventory* — ${inv.namespaces.length} namespace(s), read from ${code("k8s_cluster_inventory")}${partial}`;
    const text = [title, ...inv.namespaces.map((n) =>
      `• *${n.name}*: ${n.workloads.length ? n.workloads.map((w) => overviewLine(String(w))).join("; ") : EMPTY}` +
      ((n.hosts ?? []).length ? ` · Ingress ${(n.hosts ?? []).map(code).join(", ")}` : ""))].join("\n");
    return { blocks: [section(title), ...tables(["Namespace", "Workloads", "Ingress"], rows, [false, true, true])], text };
  }

  const blocks: KnownBlock[] = [];
  const text: string[] = [];
  for (const n of inv.namespaces) {
    const ws = n.workloads as DetailWorkload[];
    const title = `*Namespace ${code(n.name)}* — ${ws.length} workload(s)${partial}`;
    const svc = (n.services ?? []).map((s) => `${code(s.name)} ${s.type} ${s.ports.join(", ")}`).join(" · ");
    const hosts = (n.ingresses ?? []).flatMap((i) => i.hosts).map(code).join(", ");
    const extra = [svc && `*Services:* ${svc}`, hosts && `*Ingress:* ${hosts}`].filter(Boolean).join("\n");
    blocks.push(section(title));
    if (ws.length) {
      blocks.push(...tables(
        ["Workload", "Kind", "Ready", "Image", "Managed by"],
        ws.map((w) => [
          code(w.name),
          w.schedule ? `${w.kind} ${code(w.schedule)}` : w.kind,
          w.ready === null || w.desired === null ? EMPTY : `${w.ready}/${w.desired}`,
          w.images.map(code).join("\n"),
          owner(w.managedBy),
        ]),
        [true, false, false, true, true]
      ));
    }
    if (extra) blocks.push(section(extra));
    text.push(title, ...ws.map((w) =>
      `• ${code(w.name)} ${w.kind}${w.schedule ? ` ${code(w.schedule)}` : ""}` +
      `${w.ready === null || w.desired === null ? "" : ` ${w.ready}/${w.desired}`} · ${w.images.map(code).join(", ")} · ${owner(w.managedBy)}`), ...(extra ? [extra] : []));
  }
  return { blocks, text: text.join("\n") };
}

const KIND = /\b(Deployment|StatefulSet|DaemonSet|CronJob)\b/;
const BULLET = /^\s*([•\-]|\*(?=\s))\s*/;
const HEADING = /^\s*(\*{1,2}|_)[^\n]+?(\*{1,2}|_):?\s*$/;
const DUGAAN = /dugaan/i;

/**
 * The model's reply with what the tables already say removed (bench 2026-10-07: 4 of 6 replies
 * restated the inventory under the tables, one as its own markdown table — raw pipes in Slack —
 * though cluster-tour.md forbids it). Facts come from the same inventory the tables were built
 * from: a line carrying an image, a port, a host or a schedule restates it, and so does a bullet
 * naming a workload with its kind. Markdown table rows go; headings left with nothing under them
 * go. Anything under or about *Dugaan fungsi* is kept whole — it is the part only the model writes.
 * ponytail: line-level heuristics over prose; a restatement that names neither a fact nor a kind
 * survives — harmless, it is the reply as it was.
 */
export function stripRepeatedInventory(reply: string, raw: string | null): string {
  const inv = parse(raw);
  if (!inv) return reply;
  const facts: string[] = [];
  const names: string[] = [];
  for (const n of inv.namespaces) {
    facts.push(...(n.hosts ?? []), ...(n.ingresses ?? []).flatMap((i) => i.hosts));
    for (const s of n.services ?? []) facts.push(...s.ports.map((p) => p.split("→")[0]!));
    for (const w of n.workloads) {
      if (typeof w === "string") {
        const m = /^\S+ (\S+) —/.exec(w);
        if (m) names.push(m[1]!);
      } else {
        names.push(w.name);
        facts.push(...w.images, ...(w.schedule ? [w.schedule] : []));
      }
    }
  }
  const lines = reply.split("\n");
  const drop = lines.map(() => false);
  let inDugaan = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (HEADING.test(t)) inDugaan = DUGAAN.test(t);
    if (inDugaan || DUGAAN.test(t)) return;
    if (t.startsWith("|")) drop[i] = true;
    else if (facts.some((f) => f && line.includes(f))) drop[i] = true;
    else if (BULLET.test(line) && KIND.test(t) && names.some((nm) => t.includes(nm))) drop[i] = true;
  });
  const nextKept = (i: number): number => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim() && !drop[j]) return j;
    return -1;
  };
  const nextAny = (i: number): number => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim()) return j;
    return -1;
  };
  // Lead-ins and headings whose content was all dropped — "Workloads:", "*Detail*".
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t || drop[i] || DUGAAN.test(t)) continue;
    const any = nextAny(i);
    if (t.endsWith(":") && any >= 0 && drop[any]) drop[i] = true;
    else if (HEADING.test(t)) {
      const k = nextKept(i);
      if (k < 0 || HEADING.test(lines[k]!.trim())) drop[i] = true;
    }
  }
  return lines.filter((_, i) => !drop[i]).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
