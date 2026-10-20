import { type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import { config } from "../config/index.js";
import { buildTranscript, humanStatements } from "../agent/feedback/index.js";
import { postmortemSlackBlocks, postmortemSlackText } from "../agent/postmortem/slack.js";
import { type StatusCommand } from "../agent/incidents/reconcile.js";
import { splitForSlack } from "../utils/slack/split.js";
import logger, { errDetail } from "../utils/logger/index.js";
import type { SlackHost } from "./host.js";

// A postmortem's "what did humans say" read must not silently drop statements past the first
// page: `conversations.replies` caps at 1000 messages per call and `limit: 100` alone truncates
// any thread longer than that. Five pages (500 messages) is a generous ceiling for an incident
// thread — if a thread outgrows that, the draft is missing from the tail, not silently empty.
const POSTMORTEM_REPLY_PAGES = 5;

export async function fetchThreadReplies(
  client: AllMiddlewareArgs["client"],
  channel: string,
  ts: string
): Promise<Array<{ ts?: string; user?: string; bot_id?: string; text?: string }>> {
  const messages: Array<{ ts?: string; user?: string; bot_id?: string; text?: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < POSTMORTEM_REPLY_PAGES; page++) {
    const resp = await client.conversations.replies({ channel, ts, limit: 100, cursor });
    messages.push(...((resp.messages ?? []) as typeof messages));
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return messages;
}

export class ThreadCommands {
  constructor(private readonly host: SlackHost) {}

  // `@agent learn` handler — see docs/DESIGN_oncall_feedback_learning.md.
  async handleLearn(
    event: SlackEventMiddlewareArgs<"app_mention">["event"],
    client: AllMiddlewareArgs["client"],
    threadId: string
  ): Promise<void> {
    try {
      if (!event.thread_ts) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          text: "Use `learn` inside an incident thread (reply to the alert I investigated), so I know which incident to learn from.",
        });
        return;
      }

      // channels:history / groups:history scopes are already required for the app
      const replies = await client.conversations.replies({ channel: event.channel, ts: threadId, limit: 100 });
      const transcript = buildTranscript(replies.messages ?? []);
      const humanText = humanStatements(replies.messages ?? [], event.ts).join("\n");

      const result = await this.host.agent.learnFromThread(event.channel, threadId, event.user ?? "unknown", event.ts, transcript, humanText);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text: result, mrkdwn: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[slack] learn failed for thread ${threadId}: ${msg}`);
      // missing_scope = reading the thread needs history scopes the app wasn't granted
      const text = msg.includes("missing_scope")
        ? "⚠️ I can't read this thread: the Slack app is missing the `channels:history` scope (`groups:history` for private channels). Add it under *OAuth & Permissions* and reinstall the app, then try `learn` again."
        : `⚠️ Learn failed: ${msg}`;
      await client.chat
        .postMessage({ channel: event.channel, thread_ts: threadId, text, mrkdwn: true })
        .catch((e) => logger.error(`[slack] could not deliver the learn-failure notice to thread ${threadId}: ${errDetail(e)}`));
    }
  }

  /**
   * `@agent postmortem` (spec 2026-10-14-postmortem-draft-design.md §1). Queued on the thread
   * like a mention, so it can't interleave with another turn writing this thread's memory.
   * The incident lookup is `findIncidentForThread`, which is top-level only — a child (merged)
   * incident shares its parent's thread, so this naturally resolves to the parent.
   */
  async handlePostmortem(
    event: SlackEventMiddlewareArgs<"app_mention">["event"],
    client: AllMiddlewareArgs["client"],
    threadId: string
  ): Promise<void> {
    // Queued behind the alert's own investigation the draft can wait minutes, and the progress
    // line is posted only once the queue reaches it — say so now instead of going quiet.
    if (this.host.threadQueue.busy(threadId)) {
      await client.chat
        .postMessage({ channel: event.channel, thread_ts: threadId, text: "⏳ Postmortem queued — it starts when the investigation running in this thread finishes." })
        .catch((e) => { logger.debug(`[slack] postmortem queued ack failed for thread ${threadId}: ${errDetail(e)}`); });
    }
    await this.host.inFlight.track({ channel: event.channel, threadTs: threadId, kind: "mention" }, this.host.threadQueue.run(threadId, async () => {
      const incidentId = await this.host.agent.findIncidentForThread(event.channel, threadId).catch(() => null);
      if (incidentId === null) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          text: "🤷 This thread is not an incident thread — `postmortem` works in the thread of an alert.",
        });
        return;
      }

      const progress = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: "📝 Drafting the postmortem…",
      });
      const progressTs = progress.ts as string | undefined;
      const updateProgress = (text: string): Promise<void> =>
        progressTs
          ? client.chat
              .update({ channel: event.channel, ts: progressTs, text })
              .then(() => {})
              .catch((e) => { logger.debug(`[slack] postmortem progress update failed for thread ${threadId}: ${errDetail(e)}`); })
          : Promise.resolve();

      // Read by SlackApp (it owns the client) — agent.postmortemFacts only ever sees the result.
      // A failed read is `humans: null`, not `[]`: "nobody said anything" and "couldn't check"
      // are different facts, and only the first means there is nothing to quote.
      let humans: string[] | null;
      try {
        const messages = await fetchThreadReplies(client, event.channel, threadId);
        humans = humanStatements(messages, event.ts);
      } catch (err) {
        logger.warn(`[slack] postmortem: could not read thread ${threadId}: ${errDetail(err)}`);
        humans = null;
      }

      try {
        const facts = await this.host.agent.postmortemFacts(incidentId, humans);
        // The incident row itself couldn't be read — treated like any other draft failure:
        // no LLM call, nothing stored.
        if (!facts) {
          await updateProgress(`❌ Could not draft the postmortem: incident #${incidentId} could not be read`);
          return;
        }
        const { markdown, backend } = await this.host.agent.draftPostmortem(facts, threadId);
        const storedId = await this.host.agent.storePostmortem(incidentId, event.user ?? null, markdown, backend);

        const link =
          storedId === null
            ? null
            : config.dashboard.publicUrl
              ? `${config.dashboard.publicUrl}/incidents/${incidentId}/postmortem`
              : `/incidents/${incidentId}/postmortem`;
        await updateProgress(
          link === null ? "📝 Postmortem drafted — not stored (the dashboard will not have it)" : `📝 Postmortem draft ready — ${link}`
        );

        const text = postmortemSlackText(facts, markdown, link);
        try {
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadId,
            text: `📝 Postmortem draft — ${facts.incident.alertname}`,
            blocks: postmortemSlackBlocks(facts, markdown, link),
          });
        } catch (err) {
          // `invalid_blocks` refuses the WHOLE message — the same card goes out as plain mrkdwn
          // rather than the draft reaching nobody (the RCA card's rule, postRca).
          logger.warn(`[slack] postmortem card refused, posting as text: ${errDetail(err)}`);
          for (const part of splitForSlack(text)) {
            await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text: part, mrkdwn: true });
          }
        }
      } catch (err) {
        logger.error(`[slack] postmortem draft failed for thread ${threadId} (incident ${incidentId}): ${errDetail(err)}`);
        await updateProgress(`❌ Could not draft the postmortem: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }

  // Returns false when this thread isn't a stored incident, so the caller can fall through to
  // the agent instead of answering "I can't do that" to what was probably an ordinary message.
  async handleStatusCommand(
    channel: string,
    threadTs: string,
    user: string,
    command: StatusCommand
  ): Promise<boolean> {
    const incidentId = await this.host.agent.findIncidentForThread(channel, threadTs).catch(() => null);
    if (incidentId === null) return false;
    try {
      const { text, clearDedup } = await this.host.agent.setIncidentStatus(channel, threadTs, user, command);
      // Released before the message goes out: a failed Slack post is cosmetic, a held claim
      // silently suppresses the alert's next firing.
      if (clearDedup) {
        await this.host.dedup
          .clear(clearDedup)
          .catch((e) => logger.error(`[status] releasing the dedup claim for incident ${incidentId} failed: ${errDetail(e)}`));
      }
      await this.host.app.client.chat.postMessage({ channel, thread_ts: threadTs, text, mrkdwn: true });
    } catch (err) {
      logger.error(`[status] ${command} failed for incident ${incidentId}: ${errDetail(err)}`);
      await this.host.app.client.chat
        .postMessage({ channel, thread_ts: threadTs, text: `⚠️ Could not change the incident status — check the agent logs.` })
        .catch(() => {});
    }
    return true;
  }

  // E step 5: reaction-triggered learn. Deliberately SILENT when the thread isn't a
  // stored incident — a random ✅ anywhere in the workspace must never make the bot talk.
  async handleLearnByReaction(
    channel: string,
    messageTs: string,
    user: string,
    client: AllMiddlewareArgs["client"]
  ): Promise<void> {
    // a ✅ writes human-confirmed memory, so it needs the same standing as a mention
    if (!this.host.mayUseAgent(user)) {
      logger.info(`[feedback] ✅ from ${user} ignored — not in SLACK_ALLOWED_USERS`);
      return;
    }
    try {
      // the reaction payload has no thread_ts — resolve the reacted message's thread root
      const msg = await client.conversations.replies({ channel, ts: messageTs, limit: 1 });
      const threadTs = msg.messages?.[0]?.thread_ts ?? messageTs;
      const incidentId = await this.host.agent.findIncidentForThread(channel, threadTs);
      if (incidentId === null) return;

      const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 100 });
      const transcript = buildTranscript(replies.messages ?? []);
      // The ✅ endorses the reacted message, whoever wrote it — that is what the reaction means.
      const humanText = humanStatements(replies.messages ?? [], null, messageTs).join("\n");
      // trigger_key = reacted message ts — several ✅ on the same message store once
      const result = await this.host.agent.learnFromThread(channel, threadTs, user, `reaction:${messageTs}`, transcript, humanText);
      if (result.startsWith("📚 Already learned")) return; // repeat reactions stay silent too
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: result, mrkdwn: true });
    } catch (err) {
      logger.error(`[slack] reaction-learn failed in ${channel}: ${errDetail(err)}`);
    }
  }
}
