import { createServer, type Server } from "http";
import { App, ExpressReceiver, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import express, { type Request, type Response } from "express";
import { config } from "../config/index.js";
import { DevOpsAgent } from "../agent/index.js";
import { AlertDeduplicator } from "../agent/dedup/index.js";
import { parseConfidence } from "../agent/confidence/index.js";
import { wantsInvestigation } from "../agent/intent/index.js";
import { buildTranscript } from "../agent/feedback/index.js";
import { buildRcaBlocks, isRcaResponse } from "../utils/slack/blocks.js";
import { splitForSlack } from "../utils/slack/split.js";
import { truncate } from "../utils/truncate/index.js";
import logger from "../utils/logger/index.js";

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
      let reply = await this.agent.investigate(threadId, message, budget);
      if (!investigation && isRcaResponse(reply)) {
        // Deterministic format backstop — the model sometimes ignores the conversation-mode
        // marker when tool results look alarming. Rewrite instead of shipping an incident card.
        logger.warn(`[slack] conversation-mode mention returned RCA format — reformatting (thread ${threadId})`);
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
      if (isRca) await this.agent.markRcaSent(threadId);
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

  private async handleAlert(payload: AlertmanagerPayload): Promise<void> {
    const channel = config.slack.alertChannel;
    if (!channel) { logger.warn("SLACK_ALERT_CHANNEL not set, skipping"); return; }

    logger.info(`[slack] alert webhook received — ${payload.alerts.length} alert(s)`);

    for (const alert of payload.alerts) {
      const alertName = alert.labels.alertname ?? "Unknown";
      if (alert.status !== "firing") {
        logger.debug(`[slack] skipping non-firing alert: ${alertName} (${alert.status})`);
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

      const rca = await this.agent.investigate(threadId, fullIssue);
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text: rca,
        ...(isRcaResponse(rca) ? { blocks: buildRcaBlocks(rca) } : { mrkdwn: true }),
      });
      if (isRcaResponse(rca)) {
        await this.agent.markRcaSent(threadId);
        await this.agent.storeIncident(labels, rca, channel, threadId).catch((e) =>
          logger.error(`[slack] failed to store incident for thread ${threadId}: ${e}`)
        );
      }
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
