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
