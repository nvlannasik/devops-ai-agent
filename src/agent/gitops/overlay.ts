// Auto-detect the GitOps overlay path from Flux's own config (DESIGN_gitops_pr_remediation.md):
// a workload's HelmRelease CR carries `kustomize.toolkit.fluxcd.io/{name,namespace}` labels
// (stamped by the Flux Kustomization that applied it); that Kustomization's `spec.path` is the
// per-environment overlay (e.g. "./apps/dev/applications"). This makes the PR target the right
// overlay for dev/stg/prd with zero config. Pure helpers here; the CRD reads live in the agent.

// The Flux CRD coordinates for k8s_get_custom_resources. Their repo uses v2 / v1; adjust if a
// different Flux version is in use.
export const FLUX_HELMRELEASE = { group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases" };
export const FLUX_KUSTOMIZATION = { group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations" };

// The Kustomization that applied a HelmRelease, from the HR CR's labels — or null.
export function kustomizeRefOf(hrObject: unknown): { name: string; namespace: string } | null {
  const labels = (hrObject as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels ?? {};
  const name = labels["kustomize.toolkit.fluxcd.io/name"];
  const namespace = labels["kustomize.toolkit.fluxcd.io/namespace"];
  return name && namespace ? { name, namespace } : null;
}

// A Flux Kustomization spec.path ("./apps/dev/applications") → a repo-relative prefix
// ("apps/dev/applications"). Returns undefined when there's no usable path.
export function fluxPathToPrefix(ksObject: unknown): string | undefined {
  const path = (ksObject as { spec?: { path?: string } })?.spec?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  const prefix = path.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return prefix || undefined;
}
