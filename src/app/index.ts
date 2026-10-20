import { createServer, type Server } from "http";
import { App, ExpressReceiver, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import express, { type Request, type Response } from "express";
import { config } from "../config/index.js";
import { DevOpsAgent } from "../agent/index.js";
import { AlertDeduplicator } from "../agent/dedup/index.js";
import { parseConfidence } from "../agent/confidence/index.js";
import { dropCardPromises } from "../agent/remediation/proposal.js";
import { timingSafeEqualStr, bearerToken, slackUserAllowed } from "../utils/auth/index.js";
import { isRcaResponse, leaksRcaStructure, type Block } from "../utils/slack/blocks.js";
import { splitForSlack } from "../utils/slack/split.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { RECENT_CHANGES_BLOCK } from "../agent/changes/index.js";
import { Semaphore, ThreadQueue, InFlightWork, RESTART_NOTICE, type Accepted } from "./queue.js";
import type { SlackHost, UnstoredAlert } from "./host.js";
import { MentionFlow } from "./mention.js";
import { AlertFlow, type AlertmanagerPayload } from "./alerts.js";
import { RemediationFlow } from "./remediation.js";
import { ThreadCommands } from "./commands.js";

export { ThreadQueue, InFlightWork } from "./queue.js";
export { fetchThreadReplies } from "./commands.js";
export { frameChangeTimeline } from "./alerts.js";
export { buildProposalContext } from "./mention.js";

// How many ungrounded names the thread warning lists before it summarises the rest. A wall of
// them says the same thing as five of them — the answer is not standing on its evidence.
const UNGROUNDED_SHOWN = 5;

export class SlackApp {
  private app: App;
  private agent: DevOpsAgent;
  private dedup = new AlertDeduplicator();
  private semaphore = new Semaphore(config.maxConcurrentInvestigations);
  private readonly threadQueue = new ThreadQueue();
  // Threads that had a cluster tour: there a follow-up naming a namespace is a tour too.
  // ponytail: in-memory, a restart forgets it — the next "jelasin namespace X" starts over.
  private readonly tourThreads = new Set<string>();
  private readonly inFlight = new InFlightWork<Accepted>();
  /**
   * Alert threads whose incident is not stored yet, and a resolve that arrived for one meanwhile
   * — see handleResolvedAlert. Also doubles as the in-flight half of correlate()'s candidate set:
   * an incident not stored yet is still an open incident another alert can be merged into.
   */
  private readonly unstored = new Map<string, UnstoredAlert>();
  private httpServer: Server | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private host!: SlackHost;
  private mentions!: MentionFlow;
  private alerts!: AlertFlow;
  private remediation!: RemediationFlow;
  private commands!: ThreadCommands;

  constructor(agent: DevOpsAgent) {
    this.agent = agent;
    this.wire();

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

    if (config.slack.allowedUsers.length === 0) {
      logger.warn("SLACK_ALLOWED_USERS not set — anyone in a channel the bot is in can mention it and ✅-learn.");
    }

    this.app.event("app_mention", async (args) => {
      await this.mentions.handleMention(args as AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">);
    });

    // Remediation approval buttons (Block Kit). ack() first — Slack's 3s hard timeout.
    this.app.action("approve_remediation", async ({ ack, body, action, client }) => {
      await ack();
      await this.remediation.handleRemediationAction(true, body as Record<string, any>, (action as { value?: string }).value, client);
    });
    this.app.action("reject_remediation", async ({ ack, body, action, client }) => {
      await ack();
      await this.remediation.handleRemediationAction(false, body as Record<string, any>, (action as { value?: string }).value, client);
    });

    // E step 5: ✅ reaction inside an investigated thread = same learn flow as
    // `@agent learn`. Needs reactions:read + the reaction_added event subscription.
    this.app.event("reaction_added", async ({ event, client }) => {
      if (event.reaction !== config.slack.learnReaction) return;
      const item = event.item as { type: string; channel?: string; ts?: string };
      if (item.type !== "message" || !item.channel || !item.ts) return;
      void this.commands.handleLearnByReaction(item.channel, item.ts, event.user ?? "unknown", client);
    });

    // catch-all error handler — surfaces silent Slack errors
    this.app.error(async (error) => {
      logger.error(`[slack] unhandled error: ${errDetail(error)}`);
    });
  }

  /**
   * The one host object every flow reads SlackApp through (app/host.ts). ONE literal, never spread:
   * a spread evaluates the getters once and freezes values that tests and initialize-time code swap.
   */
  private wire(): void {
    const self = this;
    this.host = {
      get agent() { return self.agent; },
      get app() { return self.app; },
      get dedup() { return self.dedup; },
      get semaphore() { return self.semaphore; },
      get threadQueue() { return self.threadQueue; },
      get inFlight() { return self.inFlight; },
      get unstored() { return self.unstored; },
      get tourThreads() { return self.tourThreads; },
      get stopping() { return self.stopping; },
      get verifyTimer() { return self.verifyTimer; },
      set verifyTimer(t: NodeJS.Timeout | null) { self.verifyTimer = t; },
      mayUseAgent: (user) => self.mayUseAgent(user),
      postRca: (...a) => self.postRca(...a),
      conversationReply: (...a) => self.conversationReply(...a),
      warnIfUngrounded: (...a) => self.warnIfUngrounded(...a),
      notifyIfLowConfidence: (...a) => self.notifyIfLowConfidence(...a),
      handleLearn: (...a) => self.commands.handleLearn(...a),
      handlePostmortem: (...a) => self.commands.handlePostmortem(...a),
      handleStatusCommand: (...a) => self.commands.handleStatusCommand(...a),
      maybeProposeRemediation: (...a) => self.remediation.maybeProposeRemediation(...a),
    };
    this.commands = new ThreadCommands(this.host);
    this.remediation = new RemediationFlow(this.host);
    this.alerts = new AlertFlow(this.host);
    this.mentions = new MentionFlow(this.host);
  }

  // Mount /alert and /health onto any Express router (used by both modes)
  private _mountAlertRoute(router: express.IRouter): void {
    if (!config.alertWebhook.token) {
      logger.warn(
        "ALERT_WEBHOOK_TOKEN not set — /alert is UNAUTHENTICATED. Anyone who can reach this port can trigger investigations and remediation proposals. Set it and configure Alertmanager http_config.authorization.credentials."
      );
    }
    router.post("/alert", (req: Request, res: Response) => {
      if (!this._authorizeAlert(req)) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }
      const payload = req.body as AlertmanagerPayload;
      if (!payload || !Array.isArray(payload.alerts)) {
        res.status(400).json({ ok: false, error: "invalid alertmanager payload" });
        return;
      }
      // Ack immediately. An investigation takes minutes; holding the connection
      // open makes Alertmanager time out (seconds) and retry the whole batch.
      // Notifications + investigations run in the background after this returns.
      res.status(200).json({ ok: true });
      this.alerts.handleAlert(payload).catch((err) =>
        logger.error(`[slack] alert processing failed: ${errDetail(err)}`)
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

  // Bearer-token gate for /alert. Unset token = open (a startup warning is logged once).
  // Constant-time compare so a wrong token never leaks length/prefix via timing.
  private _authorizeAlert(req: Request): boolean {
    const expected = config.alertWebhook.token;
    if (!expected) return true;
    const provided = bearerToken(req.header("authorization"));
    return provided !== null && timingSafeEqualStr(provided, expected);
  }

  private mayUseAgent(user: string | undefined): boolean {
    return slackUserAllowed(user, {
      allowed: config.slack.allowedUsers,
      oncall: config.slack.oncallUsers,
      approvers: config.slack.approverUsers,
    });
  }

  /**
   * Post an RCA as a Block Kit card, and never lose it to the card.
   *
   * Live 2026-09-23 04:41: a 4961-character section (Slack's limit is 3000) was answered with
   * `invalid_blocks` for the WHOLE message, the exception unwound the background investigation,
   * and seven LLM calls' worth of RCA reached nobody — the on-call thread showed the progress
   * notice and then nothing. `buildRcaBlocks` splits sections now, which closes that cause; this
   * closes the shape of it. A card is a rendering of the answer, and the answer is what matters.
   */
  private async postRca(channel: string, threadId: string, rca: string, blocks: Block[]): Promise<void> {
    try {
      await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: rca, blocks });
    } catch (err) {
      // One retry without the tables or the change timeline block before the card is given up
      // entirely.
      //
      // The tables are the newest and least settled thing in this message, and on 2026-09-25 a
      // single empty cell in one of them cost two complete RCAs their card — Slack answers
      // `invalid_blocks` for the WHOLE message, so a defect confined to one block was paid for by
      // every other block in it. That asymmetry is what this closes: a table bug should cost the
      // table. The change timeline block is the other newest block (env values, commit messages
      // re-rendered into Slack mrkdwn) and shares the same risk, so it is dropped with them.
      //
      // Only attempted when there IS a table or a timeline block to drop, and the plain-text path
      // stays underneath for everything else — a section over the limit, a lone surrogate, an
      // outage at Slack.
      const withoutTables = blocks.filter((b) => b.type !== "table" && b.block_id !== RECENT_CHANGES_BLOCK);
      if (withoutTables.length < blocks.length) {
        try {
          await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: rca, blocks: withoutTables });
          logger.warn(
            `[slack] RCA card rejected for thread ${threadId} WITH tables/timeline block, posted without them: ${errDetail(err)}`
          );
          return;
        } catch (second) {
          logger.error(`[slack] RCA card rejected for thread ${threadId} without tables too: ${errDetail(second)}`);
        }
      }
      logger.error(`[slack] RCA card rejected for thread ${threadId}, posting as plain text: ${errDetail(err)}`);
      for (const part of splitForSlack(rca)) {
        await this.app.client.chat.postMessage({ channel, thread_ts: threadId, text: part, mrkdwn: true });
      }
    }
  }

  /**
   * Post-processing a conversation-mode reply needs before it reaches Slack — shared between a
   * mention's own reply and the correlation follow-up's, which is always conversation mode.
   *
   * `reformat` gates ONLY the deterministic format backstop: the mention path passes
   * `!investigation` so an explicit investigation request is left exactly as before (it never
   * reformatted); the correlation follow-up passes `true` (there is no `investigation` flag on
   * that path — it is conversation mode by construction). The card-promise scrub below is NOT
   * gated by `reformat` — the mention path ran it unconditionally (only `!isRcaResponse(reply)`
   * gated it), so moving it here keeps that half byte-identical too.
   */
  private async conversationReply(reply: string, threadId: string, reformat: boolean): Promise<string> {
    if (reformat && (isRcaResponse(reply) || leaksRcaStructure(reply))) {
      // Deterministic format backstop — the model sometimes ignores the conversation-mode
      // marker (full RCA format, or a partial leak: plan/impact/confidence sections on a
      // simple change request). Rewrite instead of shipping the wall of text.
      logger.warn(`[slack] conversation-mode mention leaked RCA structure — reformatting (thread ${threadId})`);
      reply = await this.agent.reformatToConversation(reply).catch(() => reply);
    }
    // Not the prompt's job alone — see dropCardPromises. Conversation replies only: an RCA is
    // parsed into Block Kit sections and a dropped sentence there would be a silent edit. The
    // correlation follow-up never makes a card either, so a promised one would be just as false.
    if (!isRcaResponse(reply)) {
      const cleaned = dropCardPromises(reply);
      if (cleaned.dropped > 0) {
        logger.warn(`[slack] dropped ${cleaned.dropped} sentence(s) promising or excusing an approval card (thread ${threadId})`);
        reply = cleaned.text;
      }
    }
    return reply;
  }

  /**
   * Posts the evidence-grounding gaps as their own message rather than editing the answer: the
   * RCA is parsed by shape downstream (buildRcaBlocks, dashboard/rca.ts, extractSection), and a
   * line appended past the last section is a line those parsers have to be taught about.
   *
   * Best-effort, like every other post-answer step here — a check that cannot run must not take
   * the investigation down with it.
   */
  private async warnIfUngrounded(channel: string, threadId: string, answer: string, trigger = ""): Promise<void> {
    try {
      const names = await this.agent.ungroundedNames(threadId, answer, trigger);
      if (names.length === 0) return;
      this.agent.recordGate(threadId, "grounding", "gap", names.join(", "), { count: names.length });
      const shown = names.slice(0, UNGROUNDED_SHOWN).map((n) => `\`${n}\``).join(", ");
      const rest = names.length - UNGROUNDED_SHOWN;
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text:
          `⚠️ *Not backed by evidence:* ${shown}${rest > 0 ? ` (+${rest} more)` : ""} — named above, ` +
          `but returned by no tool call in this thread. Verify before acting on them.`,
        mrkdwn: true,
      });
    } catch (err) {
      logger.warn(`[slack] grounding check failed for thread ${threadId}: ${errDetail(err)}`);
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
    this.remediation.startVerificationPoller();
  }

  /**
   * Waits up to `budgetMs` for the investigations this pod already accepted, then says so in every
   * thread still waiting on one. Call after stop(), so nothing new arrives, and before
   * agent.shutdown(), so the work still has its MCP and SQS clients while it finishes.
   */
  async drain(budgetMs: number): Promise<void> {
    const cut = await this.inFlight.drain(budgetMs);
    if (cut.length === 0) return;
    // One notice per thread: a follow-up queued behind a running turn is cut with it.
    const threads = new Map(cut.map((w) => [`${w.channel}/${w.threadTs}`, w]));
    logger.warn(`[slack] shutting down with ${cut.length} investigation(s) unfinished — telling ${threads.size} thread(s)`);
    await Promise.allSettled(
      [...threads.values()].map((w) =>
        this.app.client.chat
          .postMessage({ channel: w.channel, thread_ts: w.threadTs, text: RESTART_NOTICE[w.kind] })
          .catch((err) => logger.error(`[slack] restart notice not posted to ${w.threadTs}: ${errDetail(err)}`))
      )
    );
  }

  async stop(): Promise<void> {
    // stop the poller first: a tick that starts now would post into a thread with a Slack
    // client that's about to close. Anything already due stays due — another pod, or this
    // one after the restart, claims it.
    this.stopping = true;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    await this.app.stop();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }
}

