import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config/index.js";

// Multi-cluster 2a (spec 2026-11-02-multi-cluster-routing-design). Which clusters exist, and which
// one the current piece of work is about. The cluster rides in AsyncLocalStorage like the trace id
// (utils/trace), so the 27 MCP call sites never learn about it: ClusterRouter reads it per call.

export interface ClusterRegistry {
  /** The cluster the agent's own HTTP MCP server reads (MCP_LOCAL_CLUSTER), or null. */
  local: string | null;
  bridges: Array<{ name: string; requestQueueName: string }>;
  /** Cluster-aware behaviour at all. Off = today's single-cluster agent, byte for byte. */
  strict: boolean;
  /** Local first, then the bridges. */
  names: string[];
}

type McpRegistryConfig = { localCluster: string | null; sqs: { clusters: Array<{ name: string; requestQueueName: string }> } };

export function clusterRegistry(mcp: McpRegistryConfig = config.mcp): ClusterRegistry {
  const local = mcp.localCluster;
  const bridges = mcp.sqs.clusters;
  if (local !== null) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(local)) throw new Error(`MCP_LOCAL_CLUSTER: bad cluster name "${local}" (lowercase letters, digits, -)`);
    if (bridges.some((b) => b.name === local)) throw new Error(`MCP_LOCAL_CLUSTER "${local}" is also a bridge in MCP_SQS_CLUSTERS`);
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

export const withCluster = <T>(cluster: string | null, fn: () => Promise<T>): Promise<T> => store.run(cluster, fn);

export const currentCluster = (): string | null | undefined => store.getStore();

/** A database row's cluster: NULL is everything written before multi-cluster — the local cluster. */
export const storedCluster = (stored: string | null, registry: ClusterRegistry = clusterRegistry()): string | null =>
  stored ?? registry.local;
