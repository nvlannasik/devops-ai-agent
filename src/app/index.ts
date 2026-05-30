import { App, ExpressReceiver, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import type { Request, Response } from "express";
import { config } from "../config/index.js";
import { DevOpsAgent } from "../agent/index.js";
import { AlertDeduplicator } from "../agent/dedup/index.js";
import { parseConfidence } from "../agent/confidence/index.js";
import logger from "../utils/logger/index.js";

export class SlackApp {
  private app: App;
  private agent: DevOpsAgent;
  private dedup = new AlertDeduplicator();

  constructor(agent: DevOpsAgent) {
    this.agent = agent;

    const receiver = new ExpressReceiver({ signingSecret: config.slack.signingSecret });

    receiver.router.post("/alert", async (req: Request, res: Response) => {
      try {
        await this.handleAlert(req.body as AlertmanagerPayload);
        res.status(200).json({ ok: true });
      } catch (err) {
        logger.error(`Alert webhook error: ${err}`);
        res.status(500).json({ ok: false });
      }
    });

    this.app = new App({
      token: config.slack.botToken,
      receiver,
      ...(config.slack.appToken ? { socketMode: true, appToken: config.slack.appToken } : {}),
    });

    this.app.event("app_mention", async (args) => {
      await this.handleMention(args as AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">);
    });
  }

  private async handleMention(args: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">): Promise<void> {
    const { event, say, client } = args;
    const threadId = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@[^>]+>/g, "").trim();

    if (!text) {
      await say({ text: "Hi! Describe the issue you want me to investigate.", thread_ts: threadId });
      return;
    }

    await say({ text: "🔍 Investigating... I'll update you shortly.", thread_ts: threadId });

    try {
      const rca = await this.agent.investigate(threadId, text);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadId, text: rca, mrkdwn: true });
      await this.notifyIfLowConfidence(event.channel, threadId, rca);
    } catch (err) {
      logger.error(`Investigation failed: ${err}`);
      await say({ text: `❌ Investigation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadId });
    }
  }

  private async handleAlert(payload: AlertmanagerPayload): Promise<void> {
    const channel = config.slack.alertChannel;
    if (!channel) { logger.warn("SLACK_ALERT_CHANNEL not set, skipping"); return; }

    for (const alert of payload.alerts) {
      if (alert.status !== "firing") continue;
      if (!this.dedup.shouldProcess(alert.labels)) {
        logger.info(`Skipping duplicate alert: ${alert.labels.alertname}`);
        continue;
      }

      const issueText = [
        `🚨 *${alert.labels.alertname ?? "Alert"}*`,
        `Severity: ${alert.labels.severity ?? "unknown"}`,
        `Summary: ${alert.annotations?.summary ?? "No summary"}`,
        `Labels: \`${JSON.stringify(alert.labels)}\``,
      ].join("\n");

      const posted = await this.app.client.chat.postMessage({ channel, text: issueText, mrkdwn: true });
      const threadId = posted.ts!;

      await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: "🔍 Auto-investigating..." });
      const rca = await this.agent.investigate(threadId, issueText);
      await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: rca, mrkdwn: true });
      await this.notifyIfLowConfidence(channel, threadId, rca);
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
    await this.app.start(config.port);
    logger.info(`Slack app started on port ${config.port}`);
  }

  async stop(): Promise<void> { await this.app.stop(); }
}

interface AlertmanagerPayload {
  alerts: Array<{ status: "firing" | "resolved"; labels: Record<string, string>; annotations?: Record<string, string> }>;
}
