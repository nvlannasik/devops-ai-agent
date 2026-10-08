/**
 * A change that cannot change anything.
 *
 * Sibling of `replace-guard.ts` and the same principle one step out: that one refuses a
 * REPLACEMENT that rebuilds the identical pod, this one refuses an EDIT that writes back the value
 * already there. Neither can reach a fault, and both arrive as a card a human is asked to approve.
 *
 * Measured on benchmark C03 against the `agus` backend, three attempts out of three: the container
 * is `busybox:1.36` running `sleep 3; exit 1`, it crashes with no logs, and the model proposed
 * `k8s_set_image` to **`busybox:1.36`** — the image it was already running. One of the three said
 * so in its own reason: *"Proposing reapplication of current image as it is the only known..."*.
 *
 * Deliberately NOT a confidence heuristic. The first design refused any proposal whose RCA rated
 * itself `Confidence: Low`, and measuring it over 496 recorded attempts found 14 such proposals of
 * which **4 were correct** — an OOMKill confirmed at a known limit is a fine reason to raise that
 * limit while staying unsure why memory grew. A no-op is decidable without guessing at the
 * model's certainty: the value it proposes is the value already in the spec.
 */

import { parseQuantity } from "../../utils/quantity/index.js";

/** The `containers` entry of a `k8s_list_deployments` / `_statefulsets` / `_daemonsets` item. */
interface WorkloadItem {
  name?: unknown;
  containers?: Array<{ name?: unknown; image?: unknown }>;
}

/** Which listing tool holds the current spec for each kind the proposal may name. */
export const LISTING_FOR_KIND: Readonly<Record<string, string>> = {
  deployment: "k8s_list_deployments",
  statefulset: "k8s_list_statefulsets",
  daemonset: "k8s_list_daemonsets",
};

/** A listing tool's items, or null when the payload is not a readable list. */
function workloadItems(listing: string): WorkloadItem[] | null {
  const start = listing.indexOf("[");
  const end = listing.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const items: unknown = JSON.parse(listing.slice(start, end + 1));
    return Array.isArray(items) ? (items as WorkloadItem[]) : null;
  } catch {
    return null;
  }
}

/** Does this listing hold a workload of that name? null when the listing is unreadable. */
export function holdsWorkload(listing: string, name: string): boolean | null {
  const items = workloadItems(listing);
  return items ? items.some((w) => w && w.name === name) : null;
}

/** The actions that address a workload by `kind` + `name` — the MCP server defaults kind to deployment. */
export const WORKLOAD_ACTIONS: ReadonlySet<string> = new Set(["k8s_rollout_restart", "k8s_set_image", "k8s_set_resources", "k8s_scale"]);
const KIND_LABEL: Readonly<Record<string, string>> = { deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet" };

/**
 * A workload proposed under a kind it is not.
 *
 * Bench B04 (2026-10-07, -08): `payments` is a StatefulSet and the re-asked proposal said
 * `kind: deployment`. Every kind-keyed check behind it failed open — the no-op gate listed
 * Deployments, found no `payments`, and let through a write of the image already running. In
 * production only the dry-run's NotFound stood behind that, and with a Deployment AND a StatefulSet
 * of the same name the dry-run passes and the card acts on the other workload. So the kind is
 * checked first, against the listings, and a refusal names the kind the workload really is — the
 * one re-ask then has what it needs to get it right.
 *
 * `listings` maps kind → that kind's listing output. Refuses only when the proposed kind's listing
 * is readable and lacks the name while another kind's holds it. Both holding it is not provably
 * wrong; neither holding it belongs to the target gate and the dry-run.
 */
export function wrongKindRefusal(
  action: string,
  params: Record<string, unknown>,
  listings: Readonly<Record<string, string>>
): string | null {
  if (!WORKLOAD_ACTIONS.has(action)) return null;
  const name = typeof params.name === "string" ? params.name : "";
  const ns = typeof params.namespace === "string" ? params.namespace : "";
  const kind = typeof params.kind === "string" ? params.kind : "deployment";
  if (!name || !(kind in LISTING_FOR_KIND)) return null;
  const has = (k: string): boolean | null => (listings[k] === undefined ? null : holdsWorkload(listings[k]!, name));
  if (has(kind) !== false) return null;
  const actual = Object.keys(LISTING_FOR_KIND).filter((k) => k !== kind && has(k) === true);
  if (actual.length === 0) return null;
  const is = actual.map((k) => KIND_LABEL[k]).join(" and a ");
  return (
    `\`${ns}/${name}\` is a ${is}, not a ${KIND_LABEL[kind]} — no ${KIND_LABEL[kind]} of that name exists in ` +
    `\`${ns}\`, so this card would act on nothing, or on another workload that shares the name. If the ` +
    `change is right, propose it again with kind: ${actual[0]}.`
  );
}

/**
 * Why this image change is a no-op, or null to let it through.
 *
 * Tolerant like `parsePods`: the payload is another repo's output, and anything unreadable returns
 * null and refuses nothing. It may only ever ADD a refusal.
 */
export function noOpImageRefusal(
  action: string,
  params: Record<string, unknown>,
  listing: string
): string | null {
  if (action !== "k8s_set_image") return null;
  const workload = typeof params.name === "string" ? params.name : "";
  const proposed = typeof params.image === "string" ? params.image : "";
  const container = typeof params.container === "string" ? params.container : "";
  if (!workload || !proposed) return null;

  const items = workloadItems(listing);
  if (!items) return null;

  const mine = items.find((w) => w && w.name === workload);
  const containers = mine?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return null;

  // With a container named, only that one counts. Without — or with a name no container has, which
  // the model invents (A13: `curl` for a container called `reporter`) — any container already on
  // this image makes the write a no-op for the thing being changed.
  const named = containers.filter((c) => c.name === container);
  const relevant = named.length > 0 ? named : containers;
  if (!relevant.some((c) => c.image === proposed)) return null;

  return (
    `the image being proposed is the image \`${workload}\` is already running (\`${proposed}\`), so this ` +
    `card would write the spec back to what it already says and change nothing. A rollout would restart ` +
    `the pods and they would come up on the same image, against the same fault. If the image really is ` +
    `the problem, the fix names a DIFFERENT tag — the one that was running before, or one the evidence ` +
    `shows works. If it is not the problem, say what is, or that the cause could not be determined.`
  );
}

/** One `k8s_recommend_resources` row: the CONFIGURED values, which is the half this guard needs. */
interface Recommendation {
  workload?: unknown;
  container?: unknown;
  current?: { cpuRequest?: unknown; memoryRequest?: unknown; cpuLimit?: unknown; memoryLimit?: unknown };
}

/** proposal field -> the key `k8s_recommend_resources` reports the configured value under. */
const RESOURCE_FIELDS: ReadonlyArray<readonly [string, keyof NonNullable<Recommendation["current"]>]> = [
  ["cpu_request", "cpuRequest"],
  ["memory_request", "memoryRequest"],
  ["cpu_limit", "cpuLimit"],
  ["memory_limit", "memoryLimit"],
];

/**
 * The same refusal one action along: a resources change that proposes the values already configured.
 *
 * Benchmark A05, 2026-09-23: a pod Pending because `cpu: 64` cannot be scheduled on a 12-core
 * node, answered with `k8s_set_resources cpu_request=64` — the number that does not fit,
 * proposed as the fix for not fitting. Scored a fail on `changed`, and as a card it would have
 * been a rollout that reschedules the same unschedulable pod.
 *
 * Read from `k8s_recommend_resources` rather than the dry-run's `previousResources`, for one
 * reason that decides it: the benchmark never runs the write path, so a guard behind the dry-run
 * is a guard the benchmark cannot see. This one is a read tool and runs in `guardRefusalFor`,
 * where the bench applies the same guards production does.
 *
 * Compared as quantities, so `1000m` and `1` are the same value and `64` and `64m` are not.
 * Anything unreadable returns null: this may only ever ADD a refusal.
 */
export function noOpResourcesRefusal(
  action: string,
  params: Record<string, unknown>,
  recommendations: string
): string | null {
  if (action !== "k8s_set_resources") return null;
  const workload = typeof params.name === "string" ? params.name : "";
  const container = typeof params.container === "string" ? params.container : "";
  if (!workload) return null;

  const start = recommendations.indexOf("[");
  const end = recommendations.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let items: unknown;
  try {
    items = JSON.parse(recommendations.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;

  const rows = (items as Recommendation[]).filter(
    (r) => r && r.workload === workload && (!container || r.container === container)
  );
  if (rows.length === 0) return null;

  const same: string[] = [];
  for (const [field, key] of RESOURCE_FIELDS) {
    const proposed = params[field];
    if (typeof proposed !== "string" || !proposed) continue;
    const configured = rows.map((r) => r.current?.[key]).find((v) => typeof v === "string") as string | undefined;
    if (configured === undefined) return null; // nothing to compare against — say nothing
    const a = parseQuantity(proposed);
    const b = parseQuantity(configured);
    if (a === null || b === null || a !== b) return null; // a real change, or unreadable
    same.push(`${field}=${proposed}`);
  }
  if (same.length === 0) return null;

  return (
    `every value in this proposal is the value \`${workload}\` is already configured with ` +
    `(${same.join(", ")}), so the card would write the spec back to what it already says. If the ` +
    `current size is the fault — a limit too low to run under, a request too large to schedule — the ` +
    `fix names a DIFFERENT number, and \`k8s_recommend_resources\` is where that number comes from. ` +
    `If the size is not the fault, say what is.`
  );
}

const OOM_KILL = /\b(oomkill\w*|out of memory|exit ?code\W{0,3}137)\b/i;

/**
 * A memory limit that does not rise, proposed for a container the kernel killed AT its limit.
 *
 * Bench A02, 2026-10-07, 2 of 3 attempts: OOMKilled at 128Mi, and a card for `memory_limit=32Mi`
 * — "to match observed peak usage", the usage read just before the kill. An OOMKill says the limit
 * is too LOW; the only resize that addresses it raises the limit. Lowering a limit is legitimate
 * rightsizing elsewhere, so this fires only with an OOMKill in what the investigation read.
 *
 * Same source as `noOpResourcesRefusal` (the configured value from `k8s_recommend_resources`), and
 * the same tolerance: anything unreadable returns null.
 */
export function oomShrinkRefusal(
  action: string,
  params: Record<string, unknown>,
  recommendations: string,
  observed: string | null
): string | null {
  if (action !== "k8s_set_resources" || !observed || !OOM_KILL.test(observed)) return null;
  const workload = typeof params.name === "string" ? params.name : "";
  const container = typeof params.container === "string" ? params.container : "";
  const proposed = typeof params.memory_limit === "string" ? parseQuantity(params.memory_limit) : null;
  if (!workload || proposed === null) return null;
  const start = recommendations.indexOf("[");
  const end = recommendations.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let items: unknown;
  try {
    items = JSON.parse(recommendations.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const row = (items as Recommendation[]).find((r) => r && r.workload === workload && (!container || r.container === container));
  const configured = typeof row?.current?.memoryLimit === "string" ? row.current.memoryLimit : null;
  const limit = configured === null ? null : parseQuantity(configured);
  if (limit === null || proposed > limit) return null;
  return (
    `\`${workload}\` was OOMKilled at its memory limit of ${configured}, and this proposal sets ` +
    `memory_limit=${params.memory_limit} — ${proposed === limit ? "the same limit" : "a LOWER one"}. An OOMKill means ` +
    `the container needed more than the limit allows; usage read before the kill is not its peak. The ` +
    `resize that addresses it raises the limit above ${configured}.`
  );
}
