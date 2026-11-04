import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config/index.js";

// Multi-cluster 2a (spec 2026-11-02-multi-cluster-routing-design). Which clusters exist, and which
// one the current piece of work is about. The cluster rides in AsyncLocalStorage like the trace id
// (utils/trace), so the 27 MCP call sites never learn about it: ClusterRouter reads it per call.

export interface ClusterRegistry {
  /** The cluster the agent's own HTTP MCP server reads (MCP_LOCAL_CLUSTER), or null. */
  local: string | null;
  /** Remote clusters: an SQS bridge (`requestQueueName`) or an MCP server over HTTP (`url`). */
  bridges: Bridge[];
  /** Cluster-aware behaviour at all. Off = today's single-cluster agent, byte for byte. */
  strict: boolean;
  /** Local first, then the bridges. */
  names: string[];
}

export type Bridge = { name: string; requestQueueName: string } | { name: string; url: string };

type McpRegistryConfig = {
  localCluster: string | null;
  sqs: { clusters: Array<{ name: string; requestQueueName: string }> };
  http?: { clusters: Array<{ name: string; url: string }> };
};

export function clusterRegistry(mcp: McpRegistryConfig = config.mcp): ClusterRegistry {
  const local = mcp.localCluster;
  const http = mcp.http?.clusters ?? [];
  const both = mcp.sqs.clusters.find((b) => http.some((h) => h.name === b.name));
  if (both) throw new Error(`cluster "${both.name}" is in both MCP_SQS_CLUSTERS and MCP_HTTP_CLUSTERS — one transport per cluster`);
  const bridges: Bridge[] = [...mcp.sqs.clusters, ...http];
  if (local !== null) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(local)) throw new Error(`MCP_LOCAL_CLUSTER: bad cluster name "${local}" (lowercase letters, digits, -)`);
    if (bridges.some((b) => b.name === local)) throw new Error(`MCP_LOCAL_CLUSTER "${local}" is also a remote cluster in MCP_SQS_CLUSTERS / MCP_HTTP_CLUSTERS`);
  }
  return {
    local,
    bridges,
    strict: local !== null || bridges.length > 0,
    names: [...(local ? [local] : []), ...bridges.map((b) => b.name)],
  };
}

// null = "no cluster" on purpose (an unbound thread, an unlabelled alert); undefined = never set.
const store = new AsyncLocalStorage<string | null>();

// Sync-capable (part 3 task 5): a per-cluster cache's builder re-enters this around a background
// rebuild, and mcpTools() needs the local cluster's tools with no await at all. Existing async
// callers are unchanged — T is just inferred as the Promise they already pass.
export const withCluster = <T>(cluster: string | null, fn: () => T): T => store.run(cluster, fn);

export const currentCluster = (): string | null | undefined => store.getStore();

/** A database row's cluster: NULL is everything written before multi-cluster — the local cluster. */
export const storedCluster = (stored: string | null, registry: ClusterRegistry = clusterRegistry()): string | null =>
  stored ?? registry.local;
