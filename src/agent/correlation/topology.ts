import logger from "../../utils/logger/index.js";

// Cross-group correlation by the LIVE call graph (spec 2026-10-13-alert-correlation-design).
// One fault fires several alert groups — orders-api slows, checkout-gateway (its caller) alerts
// on errors, storefront on latency — and each used to get its own thread, investigation and card.
// Edges come from traffic, never from names: `http_client_requests_total{service,peer}` is the
// sample apps' client-metric contract (devops-sample-apps/packages/platform/src/metrics.ts).
// Fail open: no graph means no correlation, which is today's behaviour.

export const CALL_GRAPH_QUERY = "sum by (namespace, service, peer) (rate(http_client_requests_total[1h])) > 0";
export type CallGraph = Record<string, Array<{ from: string; to: string }>>;
export interface OpenIncident { threadTs: string; channel: string; alertname: string; namespace: string; subjects: string[]; startedAt: number; resolved: boolean; id?: number }
export type Relation = { incident: OpenIncident; via: "same-service" | { from: string; to: string } };

const WINDOW_MS = 30 * 60_000;
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

export function parseCallGraph(promResult: string): CallGraph | null {
  let p: { status?: string; data?: { resultType?: string; result?: Array<{ metric?: Record<string, string> }> } };
  try { p = JSON.parse(promResult); } catch { return null; }
  if (p.status !== "success" || p.data?.resultType !== "vector" || !Array.isArray(p.data.result)) return null;
  const g: CallGraph = {};
  for (const s of p.data.result) {
    const { namespace, service, peer } = s.metric ?? {};
    if (!namespace || !service || !peer || service === peer) continue;
    (g[namespace] ??= []).push({ from: service, to: peer });
  }
  return g;
}

let cached: { at: number; graph: CallGraph } | null = null;
export const resetServiceGraphCache = (): void => { cached = null; };

export async function serviceGraph(
  callTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  now: () => number = Date.now
): Promise<CallGraph | null> {
  if (cached && now() - cached.at < CACHE_MS) return cached.graph;
  try {
    const raw = await Promise.race([
      callTool("prometheus_query", { query: CALL_GRAPH_QUERY }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.(); }),
    ]);
    const graph = parseCallGraph(raw);
    if (!graph) { logger.info(`[correlation] graph unavailable: not a vector (${raw.slice(0, 120)})`); return null; }
    cached = { at: now(), graph };
    return graph;
  } catch (err) {
    logger.info(`[correlation] graph unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function relatedIncident(alert: { namespace: string; subjects: string[]; startsAt: number }, open: OpenIncident[], graph: CallGraph): Relation | null {
  if (alert.subjects.length === 0) return null;
  const edges = graph[alert.namespace] ?? [];
  const viaFor = (c: OpenIncident): Relation["via"] | null => {
    for (const a of alert.subjects) {
      for (const b of c.subjects) {
        if (a === b) return "same-service";
        const e = edges.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
        if (e) return e;
      }
    }
    return null;
  };
  const matches = open
    .filter((c) => c.namespace === alert.namespace && !c.resolved && c.startedAt <= alert.startsAt && alert.startsAt - c.startedAt <= WINDOW_MS)
    .map((c) => ({ incident: c, via: viaFor(c) }))
    .filter((m): m is Relation => m.via !== null)
    .sort((x, y) => y.incident.startedAt - x.incident.startedAt);
  return matches[0] ?? null;
}

export const describeVia = (via: Relation["via"]): string => (via === "same-service" ? "same service" : `${via.from} → ${via.to}`);
