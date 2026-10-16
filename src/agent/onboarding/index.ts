// Reads the cluster model's sources (spec 2026-10-16-cluster-onboarding-flow §3) — each one
// fail-open — and caches the result 5 minutes. Runs outside any investigation, like the change
// timeline, so replay never executes it.
import logger, { errDetail } from "../../utils/logger/index.js";
import type { CallGraph } from "../correlation/topology.js";
import type { GitOpsPayload, LocateTarget } from "../gitops/types.js";
import { assembleModel } from "./model.js";
import type { ClusterModel, InventoryDetail, LocateOutcome } from "./types.js";

export interface ModelSources {
  inventory(namespace?: string): Promise<string>;
  callGraph(): Promise<CallGraph | null>;
  locate?: (pathPrefix: string | undefined, targets: LocateTarget[]) => Promise<GitOpsPayload>;
  overlayPath(hr: { name: string; namespace: string }): Promise<string | undefined>;
  now(): number;
}

/** The worker's `locate` parser ceiling (devops-ai-agent-worker src/gitops/message.ts). */
export const LOCATE_MAX_TARGETS = 50;

function parseInventory(raw: string): InventoryDetail | null {
  try {
    const v = JSON.parse(raw) as InventoryDetail;
    return v && Array.isArray(v.namespaces) && v.scanned ? v : null;
  } catch {
    return null;
  }
}

export async function buildClusterModel(src: ModelSources, namespace?: string): Promise<ClusterModel | null> {
  const [rawInv, graph] = await Promise.all([
    src.inventory(namespace).catch((e) => `Error: ${errDetail(e)}`),
    src.callGraph().catch(() => null),
  ]);
  const inventory = parseInventory(rawInv);
  if (!inventory) {
    logger.warn(`[onboarding] inventory unreadable for ${namespace ?? "the cluster"}: ${rawInv.slice(0, 160)}`);
    return null;
  }
  let locate: LocateOutcome[] | null = null;
  const locateFn = src.locate;
  if (locateFn) {
    const byPrefix = new Map<string | undefined, LocateTarget[]>();
    for (const ns of inventory.namespaces) {
      for (const w of ns.workloads) {
        if (w.managedBy.type !== "helmrelease") continue;
        const hr = { name: w.managedBy.name, namespace: w.managedBy.namespace };
        const prefix = await src.overlayPath(hr).catch(() => undefined);
        const list = byPrefix.get(prefix) ?? [];
        if (!list.some((t) => t.name === hr.name && t.namespace === hr.namespace)) {
          list.push({ ...hr, current: { ...(w.images[0] ? { image: w.images[0] } : {}), ...(w.desired !== null ? { replicas: w.desired } : {}) } });
        }
        byPrefix.set(prefix, list);
      }
    }
    // The worker's parser refuses a request of more than LOCATE_MAX_TARGETS as poison — dropped, not
    // answered — so a bigger prefix goes in chunks rather than as one request that waits out its timeout.
    const chunks: Array<[string | undefined, LocateTarget[]]> = [];
    for (const [pathPrefix, targets] of byPrefix) {
      for (let i = 0; i < targets.length; i += LOCATE_MAX_TARGETS) chunks.push([pathPrefix, targets.slice(i, i + LOCATE_MAX_TARGETS)]);
    }
    locate = await Promise.all(
      chunks.map(async ([pathPrefix, targets]): Promise<LocateOutcome> => {
        try {
          const payload = await locateFn(pathPrefix, targets);
          if (payload.ok && payload.op === "locate") return { pathPrefix, payload };
          return { pathPrefix, payload: payload.ok ? { ok: false, reason: `unexpected op ${payload.op}` } : { ok: false, reason: payload.reason } };
        } catch (e) {
          return { pathPrefix, payload: { error: e instanceof Error ? e.message : String(e) } };
        }
      })
    );
  }
  return assembleModel({ inventory, graph, locate, at: new Date(src.now()).toISOString() });
}

/** Per namespace scope ("" = whole cluster). ponytail: per process — replicas each build their own. */
export class ClusterModelCache {
  private readonly entries = new Map<string, { at: number; model: ClusterModel | null; building?: Promise<ClusterModel | null> }>();
  constructor(
    private readonly build: (ns?: string) => Promise<ClusterModel | null>,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = Date.now
  ) {}

  private rebuild(key: string): Promise<ClusterModel | null> {
    const e = this.entries.get(key);
    if (e?.building) return e.building;
    const building = this.build(key || undefined)
      .catch((err) => { logger.warn(`[onboarding] model build failed for ${key || "the cluster"}: ${errDetail(err)}`); return null; })
      .then((model) => {
        const prev = this.entries.get(key)?.model ?? null;
        // A failed rebuild keeps the last good model rather than replacing it with nothing.
        const kept = model ?? prev;
        this.entries.set(key, { at: model ? this.now() : this.entries.get(key)?.at ?? 0, model: kept });
        return kept;
      });
    this.entries.set(key, { at: e?.at ?? 0, model: e?.model ?? null, building });
    return building;
  }

  async get(ns?: string): Promise<ClusterModel | null> {
    const key = ns ?? "";
    const e = this.entries.get(key);
    if (e?.model && this.now() - e.at < this.ttlMs) return e.model;
    if (e?.model) { void this.rebuild(key); return e.model; }
    return this.rebuild(key);
  }

  peek(ns?: string): ClusterModel | null {
    const key = ns ?? "";
    const e = this.entries.get(key);
    if (!e?.model || this.now() - e.at >= this.ttlMs) void this.rebuild(key);
    return e?.model ?? null;
  }
}
