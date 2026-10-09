// Agent ↔ llm-worker GitOps PR-flow contract (mirror of the worker's src/gitops/message.ts).
// Requests go to the gitops request queue; responses share the LLM response queue, routed
// by requestId. Changing this shape breaks both sides — see DESIGN_gitops_pr_remediation.md.

export interface GitOpsChange {
  field: string;
  from: string | number;
  to: string | number;
}

export interface GitOpsChangeBody {
  op: "dry_run" | "open_pr";
  helmRelease: { name: string; namespace: string };
  action: string;
  container?: string;
  component?: string; // chart component (multi-component values disambiguation)
  changes: GitOpsChange[];
  pathPrefix?: string; // repo subtree, auto-detected from the Flux Kustomization spec.path
  incident?: { summary?: string; threadUrl?: string };
}

export interface GitOpsHistoryBody {
  op: "history";
  helmRelease: { name: string; namespace: string };
  pathPrefix?: string;
  since: string; // ISO
}

// A rollback on a Flux-managed workload: Flux would revert a cluster patch, so the undo is a
// revert PR of the Git commit that made the change (picked by pickRevertCommit from the change
// timeline, never a sha the model proposed).
export interface GitOpsRevertBody {
  op: "revert_pr";
  helmRelease: { name: string; namespace: string };
  sha: string;
  pathPrefix?: string;
  dryRun?: boolean;
  incident?: { summary?: string; threadUrl?: string };
}

export type GitOpsRequestBody = GitOpsChangeBody | GitOpsHistoryBody | GitOpsRevertBody;

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
  | { ok: true; op: "history"; commits: Array<{ sha: string; at: string; author: string; message: string; url: string; paths: string[] }> }
  | { ok: true; op: "revert_pr"; dryRun: true; paths: string[]; diff: string }
  | { ok: true; op: "revert_pr"; dryRun: false; paths: string[]; prUrl: string }
  | { ok: false; reason: string; drift?: GitOpsDrift };
