// Agent ↔ llm-worker GitOps PR-flow contract (mirror of the worker's src/gitops/message.ts).
// Requests go to the gitops request queue; responses share the LLM response queue, routed
// by requestId. Changing this shape breaks both sides — see DESIGN_gitops_pr_remediation.md.

export interface GitOpsChange {
  field: string;
  from: string | number;
  to: string | number;
}

export interface GitOpsRequestBody {
  op: "dry_run" | "open_pr";
  helmRelease: { name: string; namespace: string };
  action: string;
  container?: string;
  component?: string; // chart component (multi-component values disambiguation)
  changes: GitOpsChange[];
  pathPrefix?: string; // repo subtree, auto-detected from the Flux Kustomization spec.path
  incident?: { summary?: string; threadUrl?: string };
}

// The repo declares this key, but the cluster is running a different value — somebody
// changed the cluster outside GitOps. The repo is the source of truth, so the answer is a
// Flux reconcile, not a PR that would encode a value nobody declared.
export interface GitOpsDrift {
  path: string; // repo file that declares the value
  valuesKey: string;
  gitValue: string;
  clusterValue: string;
}

export type GitOpsPayload =
  | { ok: true; op: "dry_run"; path: string; valuesKey: string; before: string; after: string; diff: string }
  | { ok: true; op: "open_pr"; path: string; prUrl: string }
  | { ok: false; reason: string; drift?: GitOpsDrift };
