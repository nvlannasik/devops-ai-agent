// The k8s_cluster_inventory payload as the dashboard reads it (mcp-server owns the shape).
// No imports, on purpose: the client bundle imports this, and must never reach server config.
export type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };
export interface ClusterWorkload { kind: string; name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string }
export interface ClusterNamespace {
  name: string;
  system: boolean;
  workloads: ClusterWorkload[];
  services: Array<{ name: string; type: string; ports: string[]; serves?: string[] }>;
  ingresses: Array<{ name: string; hosts: string[]; backends?: Array<{ host: string; service: string }> }>;
}
export interface ClusterInventory { scanned: { namespaces: number; complete: boolean }; namespaces: ClusterNamespace[] }

// The onboarding cluster model (agent/onboarding/types.ts ClusterModel), mirrored field for field so
// the dashboard — and its client bundle — never import agent code. cluster-types.check.test.ts is the
// compile-time proof the two still agree.
export interface DashboardGitKey { path: string; line: number; key: string; gitValue: string; drift: boolean }
export type DashboardModelNode =
  | { id: string; kind: "host"; namespace: string; host: string }
  | { id: string; kind: "service"; namespace: string; name: string }
  | { id: string; kind: "workload"; namespace: string; name: string; workloadKind: string };
export type DashboardEvidence = { type: "k8s"; ref: string } | { type: "metric"; query: string } | { type: "env"; workload: string; via: string };
export interface DashboardModelEdge {
  from: string;
  to: string;
  kind: "routes" | "calls" | "depends";
  certainty: "observed" | "configured" | "declared";
  role?: "app" | "telemetry";
  evidence: DashboardEvidence[];
}
export interface DashboardClusterModel {
  snapshot: { at: string; appliedRevision: string | null; repoRevision: string | null };
  nodes: DashboardModelNode[];
  edges: DashboardModelEdge[];
  external: Array<{ workload: string; host: string; via: string }>;
  changeAt: Record<string, { image?: DashboardGitKey; replicas?: DashboardGitKey }>;
  unknowns: string[];
}
