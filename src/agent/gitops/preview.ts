import type { GitOpsChange } from "./types.js";

// The structured PR preview the MCP GitOps guard returns on a Flux HelmRelease dry-run
// (devops-mcp-server's gitOpsPreviewOrRefuse). It arrives as the dry-run tool result JSON;
// its presence is how the agent knows to route to the PR flow instead of a direct patch.
export interface GitOpsPreview {
  gitOpsPrEligible: true;
  source: string;
  helmRelease: { name: string; namespace: string };
  workload: string;
  action: string;
  container?: string;
  changes: GitOpsChange[];
  message: string;
}

// Parse a dry-run tool result; return the preview only when it's a well-formed
// gitOpsPrEligible object, else null (a normal dry-run validation, or anything unexpected).
export function parseGitOpsPreview(dryRunResult: string): GitOpsPreview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dryRunResult);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.gitOpsPrEligible !== true) return null;
  const hr = p.helmRelease as { name?: unknown; namespace?: unknown } | undefined;
  if (!hr || typeof hr.name !== "string" || typeof hr.namespace !== "string") return null;
  if (typeof p.action !== "string" || !Array.isArray(p.changes)) return null;
  return parsed as GitOpsPreview;
}
