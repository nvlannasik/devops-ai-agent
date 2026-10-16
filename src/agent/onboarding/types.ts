// The onboarding cluster model (spec 2026-10-16-cluster-onboarding-flow §3). Type-only — it imports
// only types from ../gitops/types.js — so the dashboard's structural mirror (dashboard/cluster-types.ts)
// can be checked against it at compile time without the dashboard importing agent code.
import type { GitKey, LocateResult } from "../gitops/types.js";

export type ModelNode =
  | { id: string; kind: "host"; namespace: string; host: string }
  | { id: string; kind: "service"; namespace: string; name: string }
  | { id: string; kind: "workload"; namespace: string; name: string; workloadKind: string };

export type Evidence = { type: "k8s"; ref: string } | { type: "metric"; query: string } | { type: "env"; workload: string; via: string };

export interface ModelEdge {
  from: string;
  to: string;
  kind: "routes" | "calls" | "depends";
  certainty: "observed" | "configured" | "declared";
  role?: "app" | "telemetry";
  evidence: Evidence[];
}

export interface ClusterModel {
  snapshot: { at: string; appliedRevision: string | null; repoRevision: string | null };
  nodes: ModelNode[];
  edges: ModelEdge[];
  external: Array<{ workload: string; host: string; via: string }>;
  changeAt: Record<string, { image?: GitKey; replicas?: GitKey }>;
  unknowns: string[];
}

type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };

/** k8s_cluster_inventory's detail payload as the model reads it (mcp-server owns the shape). */
export interface InventoryDetail {
  scanned: { namespaces: number; complete: boolean; configMaps?: boolean };
  fluxRevisions?: Array<{ kustomization: string; revision: string }>;
  namespaces: Array<{
    name: string;
    system: boolean;
    workloads: Array<{
      kind: string;
      name: string;
      ready: number | null;
      desired: number | null;
      images: string[];
      managedBy: ManagedBy;
      schedule?: string;
      dependsOn?: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>;
      externalHosts?: Array<{ host: string; via: string }>;
      unresolved?: Array<{ host: string; via: string }>;
    }>;
    services: Array<{ name: string; type: string; ports: string[]; serves?: string[] }>;
    ingresses: Array<{ name: string; hosts: string[]; backends?: Array<{ host: string; service: string }> }>;
  }>;
}

export interface LocateOutcome {
  pathPrefix: string | undefined;
  payload: { ok: true; op: "locate"; revision: string; releases: LocateResult[] } | { ok: false; reason: string } | { error: string };
}

export type { GitKey };
