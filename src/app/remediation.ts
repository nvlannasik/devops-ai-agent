import { type AllMiddlewareArgs } from "@slack/bolt";
import { config } from "../config/index.js";
import { splitForSlack } from "../utils/slack/split.js";
import { buildRemediationCard, remediationStatusBlocks } from "../utils/slack/remediation-card.js";
import { truncate } from "../utils/truncate/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import type { SlackHost } from "./host.js";

export class RemediationFlow {
  constructor(private readonly host: SlackHost) {}

  async maybeProposeRemediation(
    channel: string,
    threadId: string,
    incidentId: number | null, // null when the investigation came from a human mention
    labels: Record<string, string>,
    rca: string,
    // The human named the action, rather than the model reaching for one. Skips the replacement
    // guard only — every other check, including the dry-run and the approval click, still runs.
    userRequested = false,
    // What the agent put on the table this turn, when it used the `[OFFER]` line. The proposal
    // may not wander off it — see offerMismatchRefusal.
    offer: string | null = null
  ): Promise<void> {
    try {
      // threadId: the quarantine gate reads this thread's tool results for the idle measurement
      // a scale-to-zero has to stand on. Both call sites already have it.
      const proposed = await this.host.agent.proposeRemediation(incidentId, labels, rca, { userRequested, threadId, offer });
      if (!proposed) {
        this.host.agent.recordGate(threadId, "proposal", "null");
        return; // no write tools / no confident proposal / already active
      }
      if ("refused" in proposed) {
        // Posted only when a HUMAN asked for the change: then the refusal is the answer to their
        // request. When the MODEL proposed it — the alert path, an RCA, an [OFFER] nobody has said
        // yes to yet — the refusal is the gates overruling the model, and posting it put a
        // paragraph about an image the model invented into every on-call thread (three
        // checkout-gateway incidents, 2026-09-29). Logged instead, and noted for the agent below
        // either way, so a follow-up question is still answered truthfully.
        if (!userRequested) {
          logger.info(`[remediation] refusal not posted (the model's proposal, not a request): ${truncate(proposed.refused, 200)}`);
          this.host.agent.recordGate(threadId, "proposal", "refused-hidden", truncate(proposed.refused, 200));
          await this.host.agent.noteInThread(threadId, `Remediation was REFUSED by the server: ${truncate(proposed.refused, 300)} — do not promise an approval card for this action again; explain the refusal if asked.`);
          return;
        }
        this.host.agent.recordGate(threadId, "proposal", "refused-posted", truncate(proposed.refused, 200));
        await this.host.app.client.chat.postMessage({
          channel,
          thread_ts: threadId,
          text: `:denied: *Remediation not proposed* — ${truncate(proposed.refused, 500)}`,
          mrkdwn: true,
        });
        await this.host.agent.noteInThread(threadId, `Remediation was REFUSED by the server: ${truncate(proposed.refused, 300)} — do not promise an approval card for this action again; explain the refusal instead.`);
        return;
      }
      // mention the approvers so the card actually notifies them (same list the buttons enforce)
      const approvers = config.slack.approverUsers.length > 0 ? config.slack.approverUsers : config.slack.oncallUsers;
      const gitOps = "gitOps" in proposed ? proposed.gitOps : undefined;
      const card = await this.host.app.client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text: `🔧 Remediation needed${gitOps ? " (GitOps PR)" : ""}: ${proposed.proposal.summary} — approve or reject`,
        blocks: buildRemediationCard(proposed.id, proposed.proposal, proposed.dryRunSummary, approvers, gitOps),
      });
      // The message id is known here and nowhere else until somebody clicks. Without it the
      // expiry sweep can close the row but not the card, which is the half a human sees.
      if (card.ts) await this.host.agent.recordCardMessage(proposed.id, channel, card.ts, threadId);
      this.host.agent.recordGate(threadId, "proposal", "posted", proposed.proposal.summary);
      logger.info(`[remediation] ${gitOps ? "GitOps PR " : ""}approval card posted (incident ${incidentId}, remediation ${proposed.id})`);
      await this.host.agent.noteInThread(threadId, `An approval card was posted for: ${proposed.proposal.summary}. A human must click Approve — nothing has been executed yet.`);
    } catch (err) {
      logger.error(`[remediation] proposal flow failed for incident ${incidentId}: ${errDetail(err)}`);
    }
  }

  // Approve/Reject button clicks. ack() must return within 3s (Slack hard timeout) —
  // the actual execution happens after, with the card updated at each stage.
  async handleRemediationAction(
    approve: boolean,
    body: Record<string, any>, // Bolt BlockAction payload
    actionValue: string | undefined,
    client: AllMiddlewareArgs["client"]
  ): Promise<void> {
    const userId: string | undefined = body.user?.id;
    const channel: string | undefined = body.channel?.id;
    const messageTs: string | undefined = body.message?.ts;
    const remediationId = parseInt(actionValue ?? "", 10);
    if (!userId || !channel || !messageTs || !Number.isFinite(remediationId)) {
      // a click that silently does nothing is the worst thing to debug — say why
      logger.warn(
        `[remediation] ignoring ${approve ? "approve" : "reject"} click with an incomplete payload ` +
        `(user=${userId ?? "?"} channel=${channel ?? "?"} ts=${messageTs ?? "?"} value=${actionValue ?? "?"})`
      );
      return;
    }

    try {
      // Approver gate: SLACK_APPROVER_USERS, falling back to SLACK_ONCALL_USERS.
      const approvers = config.slack.approverUsers.length > 0 ? config.slack.approverUsers : config.slack.oncallUsers;
      if (approvers.length > 0 && !approvers.includes(userId)) {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          text: ":denied: You're not authorized to approve/reject remediations (SLACK_APPROVER_USERS).",
        });
        return;
      }
      if (approvers.length === 0) {
        logger.warn(`[remediation] no approver allowlist configured — allowing decision by ${userId}`);
      }

      if (!approve) {
        const text = await this.host.agent.rejectRemediation(remediationId, userId);
        await client.chat.update({ channel, ts: messageTs, text, blocks: remediationStatusBlocks(text) });
        const rejectThread: string | undefined = body.message?.thread_ts;
        if (rejectThread) await this.host.agent.noteInThread(rejectThread, text);
        return;
      }

      // show progress immediately — the MCP call may take a while
      const progress = `⏳ Executing remediation ${remediationId} — approved by <@${userId}>...`;
      await client.chat.update({ channel, ts: messageTs, text: progress, blocks: remediationStatusBlocks(progress) });

      const { text, target, backup } = await this.host.agent.executeRemediation(remediationId, userId);
      await client.chat.update({ channel, ts: messageTs, text, blocks: remediationStatusBlocks(text) });
      const noteThread: string | undefined = body.message?.thread_ts;
      if (noteThread) await this.host.agent.noteInThread(noteThread, text);

      // The deleted object's manifest, posted where whoever approved it can reach it. The row in
      // Postgres is the primary copy; this one exists because it is the only copy that survives
      // losing that database, and because a restore at 3am should not require DB access. JSON
      // rather than YAML: `kubectl apply -f` takes it and it costs no dependency. Failures are
      // logged, never thrown — the object is already gone and the row already holds the backup,
      // so losing this copy must not report the deletion as failed.
      if (backup) {
        const manifest = JSON.stringify(backup, null, 2);
        for (const part of splitForSlack(
          `♻️ *Backup of the deleted object* — remediation \`${remediationId}\`. Restore with ` +
            `\`kubectl apply -f -\` and this manifest:\n\`\`\`\n${manifest}\n\`\`\``
        )) {
          await client.chat
            .postMessage({ channel, thread_ts: body.message?.thread_ts ?? messageTs, text: part, mrkdwn: true })
            .catch((e) => logger.error(`[remediation] could not post the backup for ${remediationId}: ${errDetail(e)}`));
        }
      }

      // Post-remediation verification: scheduled in Postgres, not on a timer in this pod, so
      // a restart between the click and the check costs nothing — whichever replica polls
      // next answers it. `target` is absent for GitOps PR remediations (nothing is live
      // until the PR merges and Flux syncs), which is exactly when there's nothing to verify.
      if (target) {
        const threadTs: string = body.message?.thread_ts ?? messageTs;
        await this.host.agent
          .scheduleRemediationCheck(remediationId, channel, threadTs, target)
          .catch((e) => logger.error(`[remediation] could not schedule verification for ${remediationId}: ${errDetail(e)}`));
      }
    } catch (err) {
      const msg = `⚠️ Remediation handling failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[remediation] ${errDetail(err)}`);
      // if this update is swallowed the card stays frozen mid-flight and the operator has
      // no way to tell whether the action ran — say so in the log at least
      await client.chat
        .update({ channel, ts: messageTs, text: msg, blocks: remediationStatusBlocks(msg) })
        .catch((e) => logger.error(`[remediation] card ${messageTs} left showing a stale state — update failed: ${errDetail(e)}`));
    }
  }

  // Drain whatever verification checks are due and post each verdict into its own thread.
  // The loop is in-process but the schedule is not: it only asks Postgres "is anything due",
  // so a check outlives the pod that scheduled it. One slow tick can't overlap the next —
  // the timer is re-armed after the work, not on a fixed interval.
  startVerificationPoller(): void {
    if (!config.incidents.enabled) return; // checks live in Postgres; no DB, no schedule
    const tick = async (): Promise<void> => {
      try {
        for (const msg of await this.host.agent.runDueRemediationChecks()) {
          await this.host.app.client.chat.postMessage({ channel: msg.channel, thread_ts: msg.threadTs, text: msg.text, mrkdwn: true });
          // the agent should know its own fix didn't hold before the next follow-up question
          await this.host.agent.noteInThread(msg.threadTs, `Post-remediation verification: ${msg.text}`);
        }
      } catch (err) {
        logger.error(`[remediation] verification poll failed: ${errDetail(err)}`);
      }
      // So does the approval-window sweep: a card nobody clicked keeps an Approve button that
      // now refuses, and blocks later proposals for the same target (see pendingFor). Its own
      // try, like the others — one failing edit must not stop the rest of the pass.
      try {
        for (const card of await this.host.agent.expireStaleRemediations()) {
          logger.info(`[remediation] expired card ${card.id} — the approval window passed without a click`);
          // The agent is told too, for the same reason a refusal is: the loop never sees a
          // lifecycle event, so without this a "what happened to that card?" is answered from the
          // last thing it knew — that one was posted and a human had to click it.
          if (card.threadTs) {
            await this.host.agent.noteInThread(
              card.threadTs,
              `The approval card for "${card.summary}" EXPIRED — nobody clicked within the window and nothing ran. It is closed; do not say it is still pending. If the change still matters it has to be proposed again.`
            );
          }
          if (!card.channel || !card.ts) continue;
          const text = `:hourglass: *Expired* — nobody approved this within the window, so it was closed: ${card.summary}. Nothing ran. Ask again if it still matters.`;
          await this.host.app.client.chat
            .update({ channel: card.channel, ts: card.ts, text, blocks: remediationStatusBlocks(text) })
            .catch((e) => logger.error(`[remediation] could not close card ${card.id} in Slack: ${errDetail(e)}`));
        }
      } catch (err) {
        logger.error(`[remediation] expiry sweep failed: ${errDetail(err)}`);
      }

      // Missed-resolved reconciliation rides the same poller — same shape of work (ask
      // Postgres what is outstanding, ask the cluster, post the result) and no second timer.
      // Its own try: a Slack outage failing a verdict post must not also stop incidents from
      // being closed, because closing them is what releases the dedup claims.
      try {
        for (const inc of await this.host.agent.runIncidentReconcile()) {
          // Claim first, message second: a lost message is cosmetic, a held claim suppresses
          // the next firing of this alert for the claim's whole TTL.
          await this.host.dedup
            .clear(inc.groupLabels)
            .catch((e) => logger.error(`[reconcile] releasing the dedup claim for ${inc.groupLabels.alertname} failed: ${errDetail(e)}`));
          if (inc.channel && inc.threadTs) {
            await this.host.app.client.chat.postMessage({ channel: inc.channel, thread_ts: inc.threadTs, text: inc.text, mrkdwn: true });
          }
        }
      } catch (err) {
        logger.error(`[reconcile] incident reconciliation pass failed: ${errDetail(err)}`);
      }
      // Trace retention (migrations/011) — same poller, its own try, like the passes above.
      try {
        const n = await this.host.agent.pruneTraces();
        if (n > 0) logger.info(`[trace] pruned ${n} event(s) past retention`);
      } catch (err) {
        logger.error(`[trace] retention pass failed: ${errDetail(err)}`);
      } finally {
        if (!this.host.stopping) this.armVerificationPoller(tick);
      }
    };
    this.armVerificationPoller(tick);
    logger.info(`[remediation] verification poller every ${Math.round(config.remediation.verifyPollMs / 1000)}s`);
  }

  armVerificationPoller(tick: () => Promise<void>): void {
    this.host.verifyTimer = setTimeout(() => void tick(), config.remediation.verifyPollMs);
    this.host.verifyTimer.unref(); // auxiliary work must never be what keeps the process alive
  }
}
