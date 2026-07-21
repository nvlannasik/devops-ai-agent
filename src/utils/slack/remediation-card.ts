import type { KnownBlock } from "@slack/types";
import type { Proposal } from "../../agent/remediation/proposal.js";

// Approval card for a proposed remediation. action_id carries the flow; value carries
// the remediations row id. The row-flip in RemediationStore is the real idempotency
// guard — the card is just UI.

export function buildRemediationCard(id: number, p: Proposal, dryRunSummary: string, approvers: string[] = []): KnownBlock[] {
  // <@Uxx> in a section block triggers a real Slack notification for each approver
  const mentions = approvers.length > 0 ? `\n*Approval needed from:* ${approvers.map((u) => `<@${u}>`).join(" ")}` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `🔧 *Proposed remediation* — ${p.summary}\n` +
          `*Why:* ${p.reason}\n` +
          `*Dry-run:* ✅ \`${dryRunSummary.slice(0, 400)}\`` +
          mentions,
      },
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
