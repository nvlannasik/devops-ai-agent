import type { AllMiddlewareArgs } from "@slack/bolt";
import type { Block } from "../utils/slack/blocks.js";
import logger, { errDetail } from "../utils/logger/index.js";
import type { SlackHost } from "./host.js";

// One-click feedback on the resolve message (2026-11-20, ideation D1).
//
// `learn` and the ✅ reaction need someone to write (or find) the sentence that says what the cause
// was. Most incidents end with nobody doing that, so the human tier of recall (`incident_feedback`)
// stays empty even when the agent was right. The resolve message now carries two buttons:
//
//   ✅ RCA was right   — stores the incident's OWN stored root cause as human-confirmed, because a
//                        person with standing (SLACK_ALLOWED_USERS, like a mention) clicked to say so.
//                        Once per incident (trigger key `button:rca-confirm`); a repeat is silent.
//   ✏️ Something else  — stores nothing. Asks in the thread for the real cause, which then goes
//                        through `learn` / ✅ as before. A wrong RCA is never written anywhere as a
//                        "confirmed negative": recall has no tier for it, and an empty row would read
//                        as a confirmation.
//
// The rule "agent-produced verdicts never reach incident_feedback" still holds: the row exists only
// because a human clicked, and it records who.

export const RCA_CONFIRM = "rca_confirm";
export const RCA_CORRECT = "rca_correct";
const TRIGGER_KEY = "button:rca-confirm";

/** The resolve message: its text, plus the two buttons when there is a stored root cause to confirm. */
export function resolvedBlocks(text: string, incidentId: number | undefined, hasRootCause: boolean): Block[] | undefined {
  if (incidentId === undefined || !hasRootCause) return undefined;
  const value = String(incidentId);
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: "rca-feedback",
      elements: [
        { type: "button", action_id: RCA_CONFIRM, style: "primary", value, text: { type: "plain_text", text: "✅ RCA was right", emoji: true } },
        { type: "button", action_id: RCA_CORRECT, value, text: { type: "plain_text", text: "✏️ It was something else", emoji: true } },
      ],
    },
  ] as Block[];
}

/** The same message after a click: the buttons give way to a line saying who answered what. */
export function answeredBlocks(text: string, verdict: "confirmed" | "corrected", user: string): Block[] {
  const line =
    verdict === "confirmed"
      ? `✅ <@${user}> confirmed the RCA's root cause — remembered as human-confirmed for the next time this fires.`
      : `✏️ <@${user}> says the cause was something else — waiting for it in this thread.`;
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "context", elements: [{ type: "mrkdwn", text: line }] },
  ] as Block[];
}

export class FeedbackFlow {
  constructor(private readonly host: SlackHost) {}

  async handle(verdict: "confirmed" | "corrected", body: Record<string, any>, value: string | undefined, client: AllMiddlewareArgs["client"]): Promise<void> {
    const user: string | undefined = body.user?.id;
    const channel: string | undefined = body.channel?.id ?? body.container?.channel_id;
    const ts: string | undefined = body.message?.ts ?? body.container?.message_ts;
    const threadTs: string | undefined = body.message?.thread_ts ?? ts;
    const text: string = body.message?.blocks?.[0]?.text?.text ?? body.message?.text ?? "";
    const id = Number(value);
    if (!user || !channel || !ts || !Number.isInteger(id) || id <= 0) return;

    const ephemeral = (t: string) =>
      client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text: t }).catch((e) => logger.debug(`[feedback] ephemeral failed: ${errDetail(e)}`));

    // A confirmation writes the human tier of memory: the same standing as a mention or a ✅.
    if (!this.host.mayUseAgent(user)) {
      logger.info(`[feedback] ${verdict} click from ${user} ignored — not in SLACK_ALLOWED_USERS`);
      await ephemeral("Only people allowed to use the agent can confirm an RCA.");
      return;
    }

    try {
      if (verdict === "confirmed") {
        const subject = await this.host.agent.rootCauseOf(id);
        if (!subject?.rootCause) {
          await ephemeral(`Incident #${id} has no stored root cause to confirm — mention me with \`learn\` and say what it was.`);
          return;
        }
        const stored = await this.host.agent.storeFeedback(id, {
          slackUser: user,
          triggerKey: TRIGGER_KEY,
          rawExcerpt: "one-click confirmation on the resolve message",
          confirmed_root_cause: subject.rootCause,
          action_taken: null,
          outcome: "resolved",
        });
        if (stored === "failed") {
          await ephemeral("Could not store the confirmation (the incident database did not answer) — try again, or use `learn`.");
          return;
        }
        logger.info(`[feedback] incident ${id}: RCA confirmed by ${user} (${stored})`);
      } else {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `<@${user}> what was the real cause? Say it in this thread and mention me with \`learn\` (or react :white_check_mark: on the message that says it) — I'll remember that instead of my RCA.`,
        });
        logger.info(`[feedback] incident ${id}: RCA disputed by ${user}`);
      }
      await client.chat
        .update({ channel, ts, text, blocks: answeredBlocks(text, verdict, user) })
        .catch((e) => logger.warn(`[feedback] could not update the resolve message ${ts}: ${errDetail(e)}`));
    } catch (err) {
      logger.error(`[feedback] ${verdict} for incident ${id} failed: ${errDetail(err)}`);
    }
  }
}
