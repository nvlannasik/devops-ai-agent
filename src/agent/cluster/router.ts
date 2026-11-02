import type { ToolDefinition } from "../llm/types.js";
import type { BridgeTools, McpTools } from "../mcp/types.js";
import { currentCluster, type ClusterRegistry } from "./index.js";
import { queryLanguage, scopeQuery } from "./scope.js";
import logger, { errDetail } from "../../utils/logger/index.js";

// Kubernetes and Flux act on a cluster; Prometheus, Loki, Alertmanager and tracing are central.
export const isClusterTool = (name: string): boolean => /^(k8s|flux)_/.test(name);

/**
 * The agent's one McpTools when a cluster registry is configured (spec 2026-11-02 §1, §3). Cluster
 * tools go to the current cluster — the local HTTP MCP server, or that cluster's SQS bridge — and
 * everything else to the central server. No cluster, or one the registry does not know, means no
 * Kubernetes at all: never a silent fall back to the central cluster's, whose answer would be about
 * the wrong pods.
 */
export class ClusterRouter implements McpTools {
  constructor(
    private readonly central: McpTools,
    private readonly bridges: Map<string, BridgeTools>,
    private readonly registry: ClusterRegistry
  ) {}

  async connect(): Promise<void> {
    await this.central.connect();
    for (const [name, bridge] of this.bridges) {
      // SqsMCPClient.connect never throws; this guards any other bridge, so one cluster that is down
      // does not stop the agent booting for the rest.
      await bridge.connect().catch((err) => logger.warn(`[cluster] bridge ${name} did not connect: ${errDetail(err)}`));
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.central.disconnect(), ...[...this.bridges.values()].map((b) => b.disconnect())]);
  }

  /** The central server only: an unreachable bridge must not take the agent's readiness down. */
  ping(): Promise<boolean> {
    return this.central.ping();
  }

  getTools(): ToolDefinition[] {
    const shared = this.central.getTools().filter((t) => !isClusterTool(t.name));
    const cluster = currentCluster();
    if (!cluster) return shared;
    const source = cluster === this.registry.local ? this.central : this.bridges.get(cluster);
    return [...shared, ...(source?.getTools().filter((t) => isClusterTool(t.name)) ?? [])];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (!isClusterTool(name)) return this.central.callTool(name, scoped(name, input));
    const cluster = currentCluster();
    if (!cluster) {
      throw new Error(`no cluster is bound to this thread, so ${name} cannot run — ask which cluster (${this.registry.names.join(", ")})`);
    }
    if (cluster === this.registry.local) return this.central.callTool(name, input);
    const bridge = this.bridges.get(cluster);
    if (!bridge) throw new Error(`cluster "${cluster}" is not in the registry (${this.registry.names.join(", ")}), so ${name} cannot run`);
    try {
      return await bridge.callTool(name, input);
    } catch (err) {
      throw new Error(`Kubernetes for ${cluster} was unreachable through its bridge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** A central PromQL/LogQL query, held to the current cluster (agent/cluster/scope). No cluster: as written. */
function scoped(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const cluster = currentCluster();
  const lang = queryLanguage(name);
  if (!cluster || !lang || typeof input.query !== "string") return input;
  const query = scopeQuery(input.query, cluster, lang);
  if (query === input.query) return input;
  logger.debug(`[cluster] ${name} held to ${cluster}: ${query}`);
  return { ...input, query };
}

/** The router in strict mode; the central client itself otherwise, so single-cluster mode is untouched. */
export function createMcp(
  registry: ClusterRegistry,
  central: McpTools,
  bridgeFor: (b: { name: string; requestQueueName: string }) => BridgeTools
): McpTools {
  if (!registry.strict) return central;
  return new ClusterRouter(central, new Map(registry.bridges.map((b) => [b.name, bridgeFor(b)])), registry);
}
