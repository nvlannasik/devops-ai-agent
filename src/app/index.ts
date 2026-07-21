import { createServer, type Server } from "http";
import { App, ExpressReceiver, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import express, { type Request, type Response } from "express";
import { config } from "../config/index.js";
import { DevOpsAgent } from "../agent/index.js";
import { AlertDeduplicator } from "../agent/dedup/index.js";
import { parseConfidence } from "../agent/confidence/index.js";
import { wantsInvestigation } from "../agent/intent/index.js";
import { buildTranscript } from "../agent/feedback/index.js";
import { buildRcaBlocks, isRcaResponse, extractSection, leaksRcaStructure } from "../utils/slack/blocks.js";
import { splitForSlack, toMrkdwn } from "../utils/slack/split.js";
import { buildRemediationCard, remediationStatusBlocks } from "../utils/slack/remediation-card.js";
import { truncate } from "../utils/truncate/index.js";
import logger from "../utils/logger/index.js";

// how long after a successful remediation to post the pod-status check into the thread
// ponytail: fixed 90s covers a typical rolling update; env var if workloads need more
const STATUS_CHECK_DELAY_MS = 90_000;

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

export class SlackApp {
  private app: App;
  private agent: DevOpsAgent;
  private dedup = new AlertDeduplicator();
  private semaphore = new Semaphore(config.maxConcurrentInvestigations);
  private httpServer: Server | null = null;

  constructor(agent: DevOpsAgent) {
    this.agent = agent;

    if (config.slack.appToken) {
      // Socket Mode — Bolt connects outbound to Slack via WebSocket.
      // No public URL required: app_mention events work behind ClusterIP/NAT.
      // Alertmanager webhook (/alert) runs on a separate Express server on the same port.
      this.app = new App({
        token: config.slack.botToken,
        socketMode: true,
        appToken: config.slack.appToken,
      });
      logger.info("Slack mode: Socket Mode (WebSocket). Alertmanager webhook served on standalone Express.");
    } else {
      // HTTP Mode — Slack sends events to a publicly reachable URL via Events API.
      // Requires an Ingress or LoadBalancer so Slack can POST to this service.
      const receiver = new ExpressReceiver({ signingSecret: config.slack.signingSecret });
      receiver.router.use(express.json());
      this._mountAlertRoute(receiver.router);
      this.app = new App({ token: config.slack.botToken, receiver });
      logger.info("Slack mode: HTTP Mode. Ensure the service is publicly reachable for Slack Events API.");
    }

    this.app.event("app_mention", async (args) => {
      await this.handleMention(args as AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">);
    });

    // Remediation approval buttons (Block Kit). ack() first — Slack's 3s hard timeout.
    this.app.action("approve_remediation", async ({ ack, body, action, client }) => {
      await ack();
      await this.handleRemediationAction(true, body as Record<string, any>, (action as { value?: string }).value, client);
    });
    this.app.action("reject_remediation", async ({ ack, body, action, client }) => {
      await ack();
      await this.handleRemediationAction(false, body as Record<string, any>, (action as { value?: string }).value, client);
    });

    // E step 5: ✅ reaction inside an investigated thread = same learn flow as
    // `@agent learn`. Needs reactions:read + the reaction_added event subscription.
    this.app.event("reaction_added", async ({ event, client }) => {
      if (event.reaction !== config.slack.learnReaction) return;
      const item = event.item as { type: string; channel?: string; ts?: string };
      if (item.type !== "message" || !item.channel || !item.ts) return;
      void this.handleLearnByReaction(item.channel, item.ts, event.user ?? "unknown", client);
    });

    // catch-all error handler — surfaces silent Slack errors
    this.app.error(async (error) => {
      logger.error(`[slack] unhandled error: ${error.message ?? error}`);
    });
  }

  // Mount /alert and /health onto any Express router (used by both modes)
  private _mountAlertRoute(router: express.IRouter): void {
    router.post("/alert", (req: Request, res: Response) => {
      const payload = req.body as AlertmanagerPayload;
      if (!payload || !Array.isArray(payload.alerts)) {
        res.status(400).json({ ok: false, error: "invalid alertmanager payload" });
        return;
      }
      // Ack immediately. An investigation takes minutes; holding the connection
      // open makes Alertmanager time out (seconds) and retry the whole batch.
      // Notifications + investigations run in the background after this returns.
      res.status(200).json({ ok: true });
      this.handleAlert(payload).catch((err) =>
        logger.error(`[slack] alert processing failed: ${err instanceof Error ? err.message : err}`)
      );
    });

    router.get("/health", async (_req: Request, res: Response) => {
      const mode = config.slack.appToken ? "socket" : "http";
      try {
        const health = await this.agent.healthCheck();
        // 503 when a dependency is down so K8s readiness probe stops routing traffic here.
        res.status(health.ok ? 200 : 503).json({ ok: health.ok, mode, checks: health.checks });
      } catch (err) {
        res.status(503).json({ ok: false, mode, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private async handleMention(args: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">): Promise<void> {
    const { event, say, client } = args;
    const threadId = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@[^>]+>/g, "").trim();

    // log the raw text here — the Issue preview inside investigate() now starts with the
    // [USER MESSAGE ...] marker, which eats the whole 120-char preview
    logger.info(`[slack] mention received — channel: ${event.channel}, thread: ${threadId}, user: ${event.user}, text: ${truncate(text, 200)}`);

    if (!text) {
      await say({ text: "Hi! Describe the issue you want me to investigate.", thread_ts: threadId });
      return;
    }

    // `@agent learn` — on-call feedback learning: extract the thread's confirmed
    // conclusion into durable memory. Separate flow, no agentic loop involved.
    if (/^learn\b/i.test(text)) {
      await this.handleLearn(event, client, threadId);
      return;
    }

    await say({ text: "🤖 On it...", thread_ts: threadId });

    // Per-message mode marker — same mechanism as the [FOLLOW-UP] prefix. Distant
    // system-prompt rules alone don't hold: the model defaults to RCA format for any
    // first message (see MEMORY_BANK). Only Alertmanager messages carry [SOURCE: ...].
    const message =
      `[USER MESSAGE — conversation mode by default: answer directly in Slack mrkdwn. ` +
      `Do NOT use the RCA incident format unless this message explicitly asks to investigate an incident.]\n${text}`;

    // Plain data questions get a hard tool budget (MENTION_TOOL_ROUNDS, default 3);
    // explicit investigation requests (and the alert webhook path) keep the full budget.
    const investigation = wantsInvestigation(text);
    const budget = investigation ? {} : { maxToolRounds: config.mentionToolRounds };

    await this.semaphore.acquire();
    try {
      // normalize Markdown **bold** to Slack mrkdwn *bold* up front — also fixes
      // format detection when the model bolds the RCA labels with **
      let reply = toMrkdwn(await this.agent.investigate(threadId, message, budget));
      if (!investigation && (isRcaResponse(reply) || leaksRcaStructure(reply))) {
        // Deterministic format backstop — the model sometimes ignores the conversation-mode
        // marker (full RCA format, or a partial leak: plan/impact/confidence sections on a
        // simple change request). Rewrite instead of shipping the wall of text.
        logger.warn(`[slack] conversation-mode mention leaked RCA structure — reformatting (thread ${threadId})`);
        reply = await this.agent.reformatToConversation(reply).catch(() => reply);
      }
      const isRca = isRcaResponse(reply);
      logger.info(`[slack] response type=${isRca ? "rca" : "conversation"} thread=${threadId}`);
      if (isRca) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          text: reply,
          blocks: buildRcaBlocks(reply),
        });
      } else {
        // Slack hard-splits >~4000 chars and breaks code fences — split ourselves,
        // fence-safe, so displayed logs keep rendering as code blocks
        for (const part of splitForSlack(reply)) {
          await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text: part, mrkdwn: true });
        }
      }
      if (isRca) {
        await this.agent.markRcaSent(threadId);
      }
      // Approval-gated remediation runs for BOTH mention response types: an RCA that
      // implies a fix, or a direct request ("restart X") answered in conversation mode.
      // The user text is part of the proposal context so an explicit command is enough
      // evidence. Costs one extra LLM call per mention; {"action": null} is the escape.
      // No incident row to link (no alert labels), so incidentId is null.
      void this.maybeProposeRemediation(event.channel, threadId, null, {}, `User request: ${text}\n\nAgent reply:\n${reply}`);
      await this.notifyIfLowConfidence(event.channel, threadId, reply);
    } catch (err) {
      logger.error(`[slack] investigation failed for thread ${threadId}: ${err}`);
      await say({ text: `❌ Investigation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadId });
    } finally {
      this.semaphore.release();
    }
  }

  // `@agent learn` handler — see docs/DESIGN_oncall_feedback_learning.md.
  private async handleLearn(
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

      const result = await this.agent.learnFromThread(event.channel, threadId, event.user ?? "unknown", event.ts, transcript);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text: result, mrkdwn: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[slack] learn failed for thread ${threadId}: ${msg}`);
      // missing_scope = reading the thread needs history scopes the app wasn't granted
      const text = msg.includes("missing_scope")
        ? "⚠️ I can't read this thread: the Slack app is missing the `channels:history` scope (`groups:history` for private channels). Add it under *OAuth & Permissions* and reinstall the app, then try `learn` again."
        : `⚠️ Learn failed: ${msg}`;
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text, mrkdwn: true }).catch(() => {});
    }
  }

  // E step 5: reaction-triggered learn. Deliberately SILENT when the thread isn't a
  // stored incident — a random ✅ anywhere in the workspace must never make the bot talk.
  private async handleLearnByReaction(
    channel: string,
    messageTs: string,
    user: string,
    client: AllMiddlewareArgs["client"]
  ): Promise<void> {
    try {
      // the reaction payload has no thread_ts — resolve the reacted message's thread root
      const msg = await client.conversations.replies({ channel, ts: messageTs, limit: 1 });
      const threadTs = msg.messages?.[0]?.thread_ts ?? messageTs;
      const incidentId = await this.agent.findIncidentForThread(channel, threadTs);
      if (incidentId === null) return;

      const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 100 });
      const transcript = buildTranscript(replies.messages ?? []);
      // trigger_key = reacted message ts — several ✅ on the same message store once
      const result = await this.agent.learnFromThread(channel, threadTs, user, `reaction:${messageTs}`, transcript);
      if (result.startsWith("📚 Already learned")) return; // repeat reactions stay silent too
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: result, mrkdwn: true });
    } catch (err) {
      logger.error(`[slack] reaction-learn failed in ${channel}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async handleAlert(payload: AlertmanagerPayload): Promise<void> {
    const channel = config.slack.alertChannel;
    if (!channel) { logger.warn("SLACK_ALERT_CHANNEL not set, skipping"); return; }

    logger.info(`[slack] alert webhook received — ${payload.alerts.length} alert(s)`);

    for (const alert of payload.alerts) {
      const alertName = alert.labels.alertname ?? "Unknown";
      if (alert.status !== "firing") {
        if (alert.status === "resolved") void this.handleResolvedAlert(alert);
        else logger.debug(`[slack] skipping non-firing alert: ${alertName} (${alert.status})`);
        continue;
      }
      if (!(await this.dedup.shouldProcess(alert.labels))) {
        logger.info(`[slack] duplicate alert suppressed: ${alertName}`);
        continue;
      }

      const severity = alert.labels.severity ?? "unknown";
      logger.info(`[slack] processing alert: ${alertName} severity=${severity}`);

      const issueText = this.buildAlertText(alert);

      // Post the alert + investigating notice up front so it shows in Slack
      // immediately — never gated behind another alert's multi-minute investigation.
      const posted = await this.app.client.chat.postMessage({ channel, text: issueText, mrkdwn: true });
      const threadId = posted.ts!;
      await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: "🔍 Auto-investigating..." });

      // Fire-and-forget — the LLM run must not delay the next alert's notification.
      // Concurrency stays bounded by the semaphore inside the background task.
      void this.investigateAlertInBackground(channel, threadId, issueText, alert.labels);
    }
  }

  // D. resolved-alert loop: release the dedup claim (a re-fire must re-investigate),
  // mark the incident resolved in the DB, and close the Slack thread with a ✅.
  private async handleResolvedAlert(alert: AlertmanagerPayload["alerts"][number]): Promise<void> {
    const alertName = alert.labels.alertname ?? "Unknown";
    try {
      await this.dedup.clear(alert.labels);
      const thread = await this.agent.resolveIncident(alert.labels);
      if (!thread) {
        logger.debug(`[slack] resolved alert ${alertName} has no stored unresolved incident — dedup cleared only`);
        return;
      }
      const endedAt = alert.endsAt ? ` at \`${new Date(alert.endsAt).toISOString()}\`` : "";
      const ns = alert.labels.namespace ? ` in \`${alert.labels.namespace}\`` : "";
      await this.app.client.chat.postMessage({
        channel: thread.channel,
        thread_ts: thread.threadTs,
        text: `✅ *Alert resolved* — ${alertName}${ns}${endedAt}. If a manual fix did it, react :${config.slack.learnReaction}: on the message describing it (or mention me with \`learn\`) so I remember.`,
        mrkdwn: true,
      });
      logger.info(`[slack] alert resolved: ${alertName} — thread updated, incident marked, dedup cleared`);
    } catch (err) {
      logger.error(`[slack] resolved-alert handling failed for ${alertName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private buildAlertText(alert: AlertmanagerPayload["alerts"][number]): string {
    const alertName = alert.labels.alertname ?? "Unknown";
    const severity = alert.labels.severity ?? "unknown";
    const emoji = ({ critical: "🔴", warning: "🟡", info: "🔵" } as Record<string, string>)[severity] ?? "⚪";

    const lines: string[] = [
      `🚨 *${alertName}*`,
      `*Severity:* ${emoji} \`${severity}\``,
    ];
    if (alert.annotations?.summary)     lines.push(`*Summary:* ${alert.annotations.summary}`);
    if (alert.annotations?.description) lines.push(`*Description:* ${alert.annotations.description}`);
    if (alert.labels.namespace)         lines.push(`*Namespace:* \`${alert.labels.namespace}\``);
    if (alert.labels.pod)               lines.push(`*Pod:* \`${alert.labels.pod}\``);
    if (alert.startsAt)                 lines.push(`*Firing since:* \`${new Date(alert.startsAt).toISOString()}\` (unix: \`${Math.floor(new Date(alert.startsAt).getTime() / 1000)}\`)`);

    return lines.join("\n");
  }

  private async investigateAlertInBackground(
    channel: string,
    threadId: string,
    issueText: string,
    labels: Record<string, string>
  ): Promise<void> {
    await this.semaphore.acquire();
    try {
      // Prepend any prior similar incidents so the agent can recognize a recurrence.
      // Best-effort: a recall failure must not block the investigation.
      const prior = await this.agent.recallIncidents(labels).catch(() => "");
      // The [SOURCE: ...] marker is the deterministic mode signal for the system prompt:
      // only Alertmanager-driven messages carry it → mandatory investigation mode.
      // Human mentions have no marker → conversation-first (see prompts/system.md).
      const fullIssue =
        `[SOURCE: Alertmanager webhook — automated incident investigation]\n\n` +
        (prior ? `${prior}\n\n---\n\n${issueText}` : issueText);

      const rca = toMrkdwn(await this.agent.investigate(threadId, fullIssue));
      // Format-agnostic on purpose: a first occurrence gets the full RCA card, while a
      // recognized recurrence may be a concise conversational reply (known issue +
      // confirmed fix) — forcing it back into the template via a reformat LLM call
      // produced garbage twice. Incident store + remediation don't need the template.
      const structured = isRcaResponse(rca) && !!extractSection(rca, "Root Cause");
      if (structured) {
        await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: rca, blocks: buildRcaBlocks(rca) });
      } else {
        logger.info(`[slack] alert response without RCA structure (recurrence shortcut?) — posting as conversation (thread ${threadId})`);
        for (const part of splitForSlack(rca)) {
          await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: part, mrkdwn: true });
        }
      }
      await this.agent.markRcaSent(threadId);
      const incidentId = await this.agent.storeIncident(labels, rca, channel, threadId).catch((e) => {
        logger.error(`[slack] failed to store incident for thread ${threadId}: ${e}`);
        return null;
      });
      // Guarded Remediation: best-effort, after the response is posted — never blocks or
      // breaks the investigation flow. Nothing executes without an approval click.
      // The CONFIRMED prior goes into the proposal context too — a recurrence's proven
      // fix ("change tag to X") is exactly what the proposal model needs.
      const proposalContext = prior ? `${prior.slice(0, 1200)}\n\n---\n\n${rca}` : rca;
      if (incidentId) void this.maybeProposeRemediation(channel, threadId, incidentId, labels, proposalContext);
      await this.notifyIfLowConfidence(channel, threadId, rca);
    } catch (err) {
      logger.error(`[slack] background investigation failed for thread ${threadId}: ${err}`);
      await this.app.client.chat
        .postMessage({
          channel,
          thread_ts: threadId,
          text: `❌ Investigation failed: ${err instanceof Error ? err.message : String(err)}`,
          mrkdwn: true,
        })
        .catch((e) => logger.error(`[slack] failed to post error notice to thread ${threadId}: ${e}`));
    } finally {
      this.semaphore.release();
    }
  }

  // ---- Guarded Remediation (docs/DESIGN_guarded_remediation.md) ----

  private async maybeProposeRemediation(
    channel: string,
    threadId: string,
    incidentId: number | null, // null when the investigation came from a human mention
    labels: Record<string, string>,
    rca: string
  ): Promise<void> {
    try {
      const proposed = await this.agent.proposeRemediation(incidentId, labels, rca);
      if (!proposed) return; // no write tools / no confident proposal / already active
      if ("refused" in proposed) {
        // the model wanted to act but the MCP server refused (GitOps guard, blocked
        // namespace, bad target) — surface the reason instead of failing silently
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadId,
          text: `🚫 *Remediation not proposed* — ${truncate(proposed.refused, 500)}`,
          mrkdwn: true,
        });
        await this.agent.noteInThread(threadId, `Remediation was REFUSED by the server: ${truncate(proposed.refused, 300)} — do not promise an approval card for this action again; explain the refusal instead.`);
        return;
      }
      // mention the approvers so the card actually notifies them (same list the buttons enforce)
      const approvers = config.slack.approverUsers.length > 0 ? config.slack.approverUsers : config.slack.oncallUsers;
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text: `🔧 Proposed remediation: ${proposed.proposal.summary} — approve or reject`,
        blocks: buildRemediationCard(proposed.id, proposed.proposal, proposed.dryRunSummary, approvers),
      });
      logger.info(`[remediation] approval card posted (incident ${incidentId}, remediation ${proposed.id})`);
      await this.agent.noteInThread(threadId, `An approval card was posted for: ${proposed.proposal.summary}. A human must click Approve — nothing has been executed yet.`);
    } catch (err) {
      logger.error(`[remediation] proposal flow failed for incident ${incidentId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Approve/Reject button clicks. ack() must return within 3s (Slack hard timeout) —
  // the actual execution happens after, with the card updated at each stage.
  private async handleRemediationAction(
    approve: boolean,
    body: Record<string, any>, // Bolt BlockAction payload
    actionValue: string | undefined,
    client: AllMiddlewareArgs["client"]
  ): Promise<void> {
    const userId: string | undefined = body.user?.id;
    const channel: string | undefined = body.channel?.id;
    const messageTs: string | undefined = body.message?.ts;
    const remediationId = parseInt(actionValue ?? "", 10);
    if (!userId || !channel || !messageTs || !Number.isFinite(remediationId)) return;

    try {
      // Approver gate: SLACK_APPROVER_USERS, falling back to SLACK_ONCALL_USERS.
      const approvers = config.slack.approverUsers.length > 0 ? config.slack.approverUsers : config.slack.oncallUsers;
      if (approvers.length > 0 && !approvers.includes(userId)) {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          text: "🚫 You're not authorized to approve/reject remediations (SLACK_APPROVER_USERS).",
        });
        return;
      }
      if (approvers.length === 0) {
        logger.warn(`[remediation] no approver allowlist configured — allowing decision by ${userId}`);
      }

      if (!approve) {
        const text = await this.agent.rejectRemediation(remediationId, userId);
        await client.chat.update({ channel, ts: messageTs, text, blocks: remediationStatusBlocks(text) });
        const rejectThread: string | undefined = body.message?.thread_ts;
        if (rejectThread) await this.agent.noteInThread(rejectThread, text);
        return;
      }

      // show progress immediately — the MCP call may take a while
      const progress = `⏳ Executing remediation ${remediationId} — approved by <@${userId}>...`;
      await client.chat.update({ channel, ts: messageTs, text: progress, blocks: remediationStatusBlocks(progress) });

      const { text, target } = await this.agent.executeRemediation(remediationId, userId);
      await client.chat.update({ channel, ts: messageTs, text, blocks: remediationStatusBlocks(text) });
      const noteThread: string | undefined = body.message?.thread_ts;
      if (noteThread) await this.agent.noteInThread(noteThread, text);

      // Post-remediation status check: give the rolling update time to converge, then
      // post the workload's pod status into the thread so the outcome is visible.
      // ponytail: in-process timer — lost if this pod restarts within the delay; a
      // durable scheduler is the upgrade path if that ever matters
      if (target) {
        const threadTs: string = body.message?.thread_ts ?? messageTs;
        setTimeout(() => void this.postRemediationStatusCheck(channel, threadTs, target), STATUS_CHECK_DELAY_MS);
      }
    } catch (err) {
      const msg = `⚠️ Remediation handling failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[remediation] ${msg}`);
      await client.chat.update({ channel, ts: messageTs, text: msg, blocks: remediationStatusBlocks(msg) }).catch(() => {});
    }
  }

  private async postRemediationStatusCheck(
    channel: string,
    threadTs: string,
    target: { namespace: string; name: string }
  ): Promise<void> {
    try {
      const status = await this.agent.remediationStatus(target.namespace, target.name);
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text:
          `🔎 *Status check* — \`${target.namespace}/${target.name}\`, ${Math.round(STATUS_CHECK_DELAY_MS / 1000)}s after remediation:\n` +
          `\`\`\`\n${status}\n\`\`\``,
        mrkdwn: true,
      });
    } catch (err) {
      logger.error(`[remediation] status check failed for ${target.namespace}/${target.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async notifyIfLowConfidence(channel: string, threadId: string, rca: string): Promise<void> {
    const confidence = parseConfidence(rca);
    const oncallUsers = config.slack.oncallUsers;

    if (confidence === "low" && oncallUsers.length > 0) {
      const mentions = oncallUsers.map((id) => `<@${id}>`).join(" ");
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text: `⚠️ ${mentions} Agent confidence is *Low* — human review recommended.`,
        mrkdwn: true,
      });
      logger.info(`Low confidence RCA — notified on-call: ${oncallUsers.join(", ")}`);
    }
  }

  async start(): Promise<void> {
    if (config.slack.appToken) {
      // Socket Mode: Bolt connects WebSocket to Slack (no port needed).
      // Run a standalone Express server on PORT for /alert and /health.
      await this.app.start();

      const expressApp = express();
      expressApp.use(express.json());
      this._mountAlertRoute(expressApp);

      await new Promise<void>((resolve, reject) => {
        this.httpServer = createServer(expressApp);
        this.httpServer.listen(config.port, () => {
          logger.info(`Slack app started in Socket Mode`);
          logger.info(`Alert webhook: POST http://0.0.0.0:${config.port}/alert`);
          resolve();
        });
        this.httpServer.once("error", reject);
      });
    } else {
      // HTTP Mode: Bolt's ExpressReceiver serves everything on one port.
      await this.app.start(config.port);
      logger.info(`Slack app started in HTTP Mode on port ${config.port}`);
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }
}

interface AlertmanagerPayload {
  alerts: Array<{
    status: "firing" | "resolved";
    labels: Record<string, string>;
    annotations?: Record<string, string>;
    startsAt?: string;
    endsAt?: string;
  }>;
}
