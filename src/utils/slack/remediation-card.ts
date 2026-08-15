import type { KnownBlock } from "@slack/types";
import type { Proposal } from "../../agent/remediation/proposal.js";

// Approval card for a proposed remediation. action_id carries the flow; value carries
// the remediations row id. The row-flip in RemediationStore is the real idempotency
// guard — the card is just UI.

export interface GitOpsCardContext {
  path: string;
  valuesKey: string;
  helmRelease: { name: string; namespace: string };
}

export function buildRemediationCard(
  id: number,
  p: Proposal,
  dryRunSummary: string,
  approvers: string[] = [],
  gitOps?: GitOpsCardContext
): KnownBlock[] {
  // <@Uxx> in a section block triggers a real Slack notification for each approver
  const mentions = approvers.length > 0 ? `\n*Approval needed from:* ${approvers.map((u) => `<@${u}>`).join(" ")}` : "";
  // GitOps variant: the dry-run summary is a unified diff — render it in a ```diff block and
  // name the target file/values-key; a direct remediation shows the compact validation inline.
  const detail = gitOps
    ? `🔀 *Proposed GitOps PR* — ${p.summary}\n` +
      `*Why:* ${p.reason}\n` +
      `*HelmRelease:* \`${gitOps.helmRelease.namespace}/${gitOps.helmRelease.name}\` · *File:* \`${gitOps.path}\` · *Key:* \`${gitOps.valuesKey}\`\n` +
      "```diff\n" +
      dryRunSummary.slice(0, 2500) +
      "\n```" +
      "\n_Approve opens a PR; merge applies it (Flux syncs after merge)._" +
      mentions
    : `🔧 *Proposed remediation* — ${p.summary}\n` +
      `*Why:* ${p.reason}\n` +
      `*Dry-run:* ✅ \`${dryRunSummary.slice(0, 400)}\`` +
      mentions;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: detail },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve_remediation",
          style: "primary",
          text: { type: "plain_text", text: "✅ Approve", emoji: true },
          value: String(id),
        },
        {
          type: "button",
          action_id: "reject_remediation",
          style: "danger",
          text: { type: "plain_text", text: "🚫 Reject", emoji: true },
          value: String(id),
        },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Expires in 15 minutes · nothing runs without approval" }],
    },
  ];
}

export function remediationStatusBlocks(text: string): KnownBlock[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}
