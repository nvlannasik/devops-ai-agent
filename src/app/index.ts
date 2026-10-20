import { createServer, type Server } from "http";
import { App, ExpressReceiver, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import express, { type Request, type Response } from "express";
import { config } from "../config/index.js";
import { DevOpsAgent, type RunMeta } from "../agent/index.js";
import { AlertDeduplicator } from "../agent/dedup/index.js";
import { parseConfidence } from "../agent/confidence/index.js";
import { mentionBudget, wantsInvestigation, wantsTour } from "../agent/intent/index.js";
import { learnIntent } from "../agent/feedback/index.js";
import { postmortemIntent } from "../agent/postmortem/intent.js";
import { parseStatusCommand } from "../agent/incidents/reconcile.js";
import { dropCardPromises, explainGate, parseOffer, worthProposing } from "../agent/remediation/proposal.js";
import { timingSafeEqualStr, bearerToken, slackUserAllowed } from "../utils/auth/index.js";
import { buildRcaBlocks, isRcaResponse, leaksRcaStructure, formatRunFooter, type Block } from "../utils/slack/blocks.js";
import { splitForSlack, toMrkdwn } from "../utils/slack/split.js";
import { flowMessages, stripRepeatedInventory, tourBlocks } from "../utils/slack/tour-tables.js";
import { flowFacts, renderModelText } from "../agent/onboarding/model.js";
import type { ClusterModel } from "../agent/onboarding/types.js";
import { truncate } from "../utils/truncate/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { buildMentionMarker } from "../agent/prompts/system.js";
import { RECENT_CHANGES_BLOCK } from "../agent/changes/index.js";
import { withRoute, withTrace } from "../utils/trace/index.js";
import { Semaphore, ThreadQueue, InFlightWork, RESTART_NOTICE, type Accepted } from "./queue.js";
import type { SlackHost, UnstoredAlert } from "./host.js";
import { AlertFlow, type AlertmanagerPayload } from "./alerts.js";
import { RemediationFlow } from "./remediation.js";
import { ThreadCommands } from "./commands.js";

export { ThreadQueue, InFlightWork } from "./queue.js";
export { fetchThreadReplies } from "./commands.js";
export { frameChangeTimeline } from "./alerts.js";

/**
 * What the proposal call is asked to act on: this turn, plus the turn that set it up.
 *
 * An approval turn is two sentences long — "ya", and an offer — while everything that justifies
 * the action was said the turn before. Measured on bench case C09: the agent answered "ya" with
 * nothing but its `[OFFER]` line, the proposal call saw one sentence naming a Service, and it
 * answered {"action": null} — the findings behind the offer (no endpoints, nothing declares it)
 * were one turn back.
 *
 * Truncated rather than whole: `buildProposalPrompt` keeps the TAIL of what it is given, because
 * Recommended Actions live there, so an unbounded history would push this turn out of the window
 * it reads.
 */
const PREVIOUS_TURN_CHARS = 1500;

export function buildProposalContext(userText: string, reply: string, offer: string | null, previousReply: string): string {
  const prior = previousReply.trim()
    ? `Previous turn — the agent's own findings, which this request is answering:\n${truncate(previousReply.trim(), PREVIOUS_TURN_CHARS)}\n\n`
    : "";
  return `${prior}User request: ${userText}\n\nAgent reply:\n${reply}${offer ? `\n\nAgent offered: ${offer}` : ""}`;
}

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
      await this.handleMention(args as AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">);
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
   * The tour's inventory as tables (utils/slack/tour-tables), from the thread's latest
   * k8s_cluster_inventory result. Refused blocks go again as the same facts in plain mrkdwn —
   * a table must never cost the facts. No inventory in the thread posts nothing.
   */
  private async postTourTables(channel: string, threadTs: string, client: AllMiddlewareArgs["client"]): Promise<string | null> {
    const raw = await this.agent.lastToolResult(threadTs, "k8s_cluster_inventory").catch(() => null);
    const tour = tourBlocks(raw);
    if (!tour) return null;
    try {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: tour.text, blocks: tour.blocks });
    } catch (err) {
      logger.warn(`[slack] tour tables refused, posting them as text (thread ${threadTs}): ${errDetail(err)}`);
      const sent = await client.chat.postMessage({ channel, thread_ts: threadTs, text: tour.text, mrkdwn: true }).then(
        () => true,
        (e) => (logger.warn(`[slack] tour text post failed (thread ${threadTs}): ${errDetail(e)}`), false)
      );
      // Neither form reached Slack: keep the model's reply whole, it is the only copy of the facts.
      if (!sent) return null;
    }
    return raw;
  }

  /**
   * A namespace tour's cluster model (agent/onboarding), prefetched before the investigation so the
   * reply can cite the flow and the flow tables come from the same model. Best-effort: no namespace
   * named, or a failed build, is today's tour. A non-tour mention never pays for it.
   * Bounded: a cold build waits on `locate` over SQS (up to SQS_GITOPS_TIMEOUT_SECONDS — 240 s live),
   * so a down worker would hold every tour reply that long. Past the bound the tour goes on without
   * the model; the build keeps running and fills the cache for the next tour.
   */
  private async tourContext(text: string, boundMs = 20_000, threadId?: string): Promise<{ isTour: boolean; ns: string | null; model: ClusterModel | null; text: string }> {
    const none = { isTour: false, ns: null, model: null, text: "" };
    const asked = wantsTour(text);
    // "how about the devops-tools namespace?" carries no tour vocabulary; after a tour it is one.
    const followUp = !asked && !!threadId && this.tourThreads.has(threadId) && !wantsInvestigation(text);
    if (!asked && !followUp) return none;
    const ns = await this.agent.tourNamespace(text).catch(() => null);
    if (followUp && !ns) return none;
    if (threadId) this.tourThreads.add(threadId);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), boundMs); });
    const model = ns
      ? await Promise.race([this.agent.clusterModel(ns).catch(() => null), bound]).finally(() => clearTimeout(timer))
      : null;
    if (ns && !model) logger.info(`[onboarding] tour went on without the cluster model for ${ns} (not ready within ${boundMs / 1000}s or failed)`);
    if (!ns) return { isTour: true, ns, model, text: "" };
    // Live 2026-10-17: the namespace was known, yet the model called the cluster-wide overview and
    // the tour posted 21 namespaces. Said once, outside the data frame, model or no model.
    const scope = `[TOUR SCOPE] The user asked about namespace \`${ns}\`: call \`k8s_cluster_inventory\` with namespace \`${ns}\`, not the cluster-wide overview.`;
    return { isTour: true, ns, model, text: model ? `${renderModelText(model, ns)}\n${scope}` : scope };
  }

  /** The cluster model's flow and where-to-change, one message each; a refused table re-posts as text. */
  private async postFlowTables(channel: string, threadTs: string, client: AllMiddlewareArgs["client"], model: ClusterModel, ns: string): Promise<void> {
    for (const msg of flowMessages(model, ns)) {
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg.text, blocks: msg.blocks });
      } catch (err) {
        logger.warn(`[slack] flow table refused, posting it as text (thread ${threadTs}): ${errDetail(err)}`);
        await client.chat
          .postMessage({ channel, thread_ts: threadTs, text: msg.text, mrkdwn: true })
          .catch((e) => logger.warn(`[slack] flow text post failed (thread ${threadTs}): ${errDetail(e)}`));
      }
    }
  }

  private async handleMention(args: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">): Promise<void> {
    const { event, say, client } = args;
    const threadId = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@[^>]+>/g, "").trim();

    // log the raw text here — the Issue preview inside investigate() now starts with the
    // [USER MESSAGE ...] marker, which eats the whole 120-char preview
    logger.info(`[slack] mention received — channel: ${event.channel}, thread: ${threadId}, user: ${event.user}, text: ${truncate(text, 200)}`);

    if (!this.mayUseAgent(event.user)) {
      logger.warn(`[slack] mention from ${event.user ?? "unknown"} refused — not in SLACK_ALLOWED_USERS`);
      if (event.user) {
        await client.chat
          .postEphemeral({
            channel: event.channel,
            user: event.user,
            // only a thread that already exists: an ephemeral in a reply-less thread is never shown
            thread_ts: event.thread_ts,
            text: ":denied: You're not registered to use this agent (SLACK_ALLOWED_USERS). Ask the on-call to add you.",
          })
          .catch((err) => logger.warn(`[slack] refusal note failed: ${errDetail(err)}`));
      }
      return;
    }

    if (!text) {
      await say({ text: "Hi! Describe the issue you want me to investigate.", thread_ts: threadId });
      return;
    }

    // `@agent learn` — on-call feedback learning: extract the thread's confirmed
    // conclusion into durable memory. Separate flow, no agentic loop involved.
    if (/^learn\b/i.test(text)) {
      // "learn dihiraukan aja" — "ignore learn for now" — is not a request to learn (incident 208).
      if (learnIntent(text) === "declined") {
        await say({ text: "👍 OK — nothing learned from this thread.", thread_ts: threadId });
        return;
      }
      await this.commands.handleLearn(event, client, threadId);
      return;
    }

    // `@agent postmortem` — draft + store a postmortem for this thread's incident (spec
    // 2026-10-14-postmortem-draft-design.md). Same decline shape as `learn`.
    const pm = postmortemIntent(text);
    if (pm === "declined") {
      await say({ text: "👍 OK — no postmortem for now.", thread_ts: threadId });
      return;
    }
    if (pm === "postmortem") {
      await this.commands.handlePostmortem(event, client, threadId);
      return;
    }

    // `@agent resolved` / `@agent reopen` — on-call's word on the incident's status, which
    // beats both the webhook and the sweeper. Only inside a thread that maps to a stored
    // incident: anywhere else "resolved" is just a word in a sentence, and the mention falls
    // through to the normal agent flow.
    const status = parseStatusCommand(text);
    if (status && (await this.commands.handleStatusCommand(event.channel, threadId, event.user ?? "unknown", status))) return;

    await say({ text: ":pepe-hacker: On it...", thread_ts: threadId });

    // Per-message mode marker — same mechanism as the [FOLLOW-UP] prefix. Distant
    // system-prompt rules alone don't hold: the model defaults to RCA format for any
    // first message (see MEMORY_BANK). Only Alertmanager messages carry [SOURCE: ...].
    // The alert clause restates what the thread is about next to the question. history[0] is
    // pinned and still carries it, but a pinned sentence at the far end of the window loses to
    // the freshest tool result — see buildMentionMarker.
    const message = buildMentionMarker(text, await this.agent.threadAlertIdentity(event.channel, threadId));

    // Plain data questions get a hard tool budget (MENTION_TOOL_ROUNDS, default 2);
    // explicit investigation requests (and the alert webhook path) keep the full budget.
    const investigation = wantsInvestigation(text);
    const budget = mentionBudget(text, { mention: config.mentionToolRounds, tour: config.tourToolRounds });

    // Serialised per thread: the card and the notices this turn produces must land before
    // the next turn in the same conversation starts, and previousReply must be read after
    // the previous turn finished writing it. The semaphore is acquired INSIDE, so waiting
    // for our turn never holds a global investigation slot.
    await this.inFlight.track({ channel: event.channel, threadTs: threadId, kind: "mention" }, this.threadQueue.run(threadId, async () => {
      await this.semaphore.acquire();
      // Captured before the investigation appends this turn's own messages: a bare "ya" is an
      // approval only if the agent put a change on the table in the turn before it.
      const previousReply = await this.agent.lastAssistantText(threadId).catch(() => "");
      // A namespace tour gets the cluster model PREFETCHED, outside the investigation like the change
      // timeline (so replay never re-runs it) — see tourContext.
      const tour = await this.tourContext(text, undefined, threadId);
      // A follow-up tour gets the tour budget too; mentionBudget sees only this message's words.
      const turnBudget = tour.isTour && !investigation ? { maxToolRounds: config.tourToolRounds } : budget;
      const tourMessage = tour.text ? `${tour.text}\n\n---\n\n${message}` : message;
      try {
        // normalize Markdown **bold** to Slack mrkdwn *bold* up front — also fixes
        // format detection when the model bolds the RCA labels with **
        // Conversation-mode mentions are the cheap tier. Investigation requests and the alert
        // path stay heavy by omission — default heavy is deliberate, so a new LLM call added
        // later gets the strong model rather than a silent downgrade.
        let meta: RunMeta | undefined;
        const onComplete = (m: RunMeta) => { meta = m; };

        const progress = this.progressNotifier(client, event.channel, threadId);
        const onProgress = progress.onProgress;

        // The mode keeps `rca-format` off a casual mention and the log-gap gate off a question
        // with no affected pod — see RunMode. It is NOT derivable from `budget`: an explicit
        // investigation request and the alert path share the same infinite one.
        const mode = investigation ? "investigation" : "conversation";
        let reply = toMrkdwn(
          investigation
            ? await this.agent.investigate(threadId, tourMessage, { ...turnBudget, mode, onComplete, onProgress })
            : await withRoute("light", () => this.agent.investigate(threadId, tourMessage, { ...turnBudget, mode, onComplete, onProgress }))
        );

        await progress.clear();
        // !investigation: the mention path's own gate on the reformat half — see conversationReply.
        reply = await this.conversationReply(reply, threadId, !investigation);
        // The reply investigate() returned has the [OFFER] line stripped; memory still has it.
        const offer = parseOffer(await this.agent.lastAssistantText(threadId).catch(() => ""));
        const isRca = isRcaResponse(reply);
        logger.info(`[slack] response type=${isRca ? "rca" : "conversation"} thread=${threadId}`);
        const footer = meta ? formatRunFooter(meta) : undefined;
        if (isRca) {
          await this.postRca(event.channel, threadId, reply, buildRcaBlocks(reply, footer));
        } else {
          reply = await this.postConversation(event.channel, threadId, client, reply, footer, tour);
        }
        if (isRca) {
          await this.agent.markRcaSent(threadId);
        }
        // Approval-gated remediation runs for BOTH mention response types: an RCA that
        // implies a fix, or a direct request ("restart X") answered in conversation mode.
        // The user text is part of the proposal context so an explicit command is enough
        // evidence. No incident row to link (no alert labels), so incidentId is null.
        // The gate is what keeps a read-only "status check" on a healthy cluster from
        // spending a heavy LLM call to be told {"action": null} — see worthProposing.
        // The tour's cluster model is evidence too: every name in it came from a tool (agent/onboarding).
        await this.warnIfUngrounded(event.channel, threadId, reply, tour.text);
        await this.notifyIfLowConfidence(event.channel, threadId, reply);
        await this.proposeAfterMention(event.channel, threadId, text, reply, isRca, previousReply, offer);
      } catch (err) {
        logger.error(`[slack] investigation failed for thread ${threadId}: ${errDetail(err)}`);
        await say({ text: `❌ Investigation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadId });
      } finally {
        this.semaphore.release();
      }
    }));
  }

  /**
   * The ":spinthinking: Round N" notice for one mention.
   * The notice is created on the FIRST tool round, not up front. A one-round answer ("what can you
   * do?") then posts nothing extra at all, while a scan that is about to spend minutes says so from
   * the moment it starts spending them. No timer, and no "thinking..." message left hanging over a
   * reply that already landed. `clear` deletes it rather than updating it to "done": in a
   * conversation the notice has no value once the answer is under it, and a leftover "Round 3" line
   * reads like the agent is still going.
   */
  private progressNotifier(client: AllMiddlewareArgs["client"], channel: string, threadId: string): { onProgress: (round: number, tools: string[]) => void; clear: () => Promise<void> } {
    let noticeTs: string | undefined;
    let noticePending = false;
    const onProgress = (round: number, tools: string[]) => {
      const text = `:spinthinking: Round ${round}${tools.length > 0 ? ` — ${tools.join(", ")}` : ""}`;
      if (noticeTs) {
        void client.chat.update({ channel, ts: noticeTs, text })
          .catch((e) => logger.debug(`[slack] progress update failed for thread ${threadId}: ${errDetail(e)}`));
        return;
      }
      if (noticePending) return; // first post still in flight — the next round updates it
      noticePending = true;
      void client.chat.postMessage({ channel, thread_ts: threadId, text })
        .then((r) => { noticeTs = r.ts as string | undefined; })
        .catch((e) => logger.debug(`[slack] progress notice failed for thread ${threadId}: ${errDetail(e)}`));
    };
    const clear = async () => {
      if (noticeTs) {
        await client.chat.delete({ channel, ts: noticeTs })
          .catch((e) => logger.debug(`[slack] could not remove the progress notice for thread ${threadId}: ${errDetail(e)}`));
      }
    };
    return { onProgress, clear };
  }

  /** A conversation reply: the tour's tables first, then the reply in Slack-sized parts. Returns the reply as posted. */
  private async postConversation(channel: string, threadId: string, client: AllMiddlewareArgs["client"], reply: string, footer: string | undefined, tour: { isTour: boolean; ns: string | null; model: ClusterModel | null }): Promise<string> {
    // A cluster tour's facts are tables built from the tool's own result, posted first; the
    // model's reply below is what only it can write — what each workload is probably for.
    if (tour.isTour) {
      const inventory = await this.postTourTables(channel, threadId, client);
      if (tour.model && tour.ns) await this.postFlowTables(channel, threadId, client, tour.model, tour.ns);
      // The tables carry the facts; what the model restated of them goes (stripRepeatedInventory).
      if (inventory) reply = stripRepeatedInventory(reply, inventory, tour.model && tour.ns ? flowFacts(tour.model, tour.ns) : []) || reply;
    }
    // Slack hard-splits >~4000 chars and breaks code fences — split ourselves,
    // fence-safe, so displayed logs keep rendering as code blocks
    const parts = splitForSlack(reply);
    for (const [i, part] of parts.entries()) {
      // Footer on the LAST part only, and appended to the text rather than added as a
      // block: a conversation reply is posted as plain mrkdwn, and nothing parses it back.
      const last = i === parts.length - 1;
      await client.chat.postMessage({
        channel,
        thread_ts: threadId,
        text: last && footer ? `${part}\n\n_${footer}_` : part,
        mrkdwn: true,
      });
    }
    return reply;
  }

  /** After a mention's reply: decide whether a remediation card is worth proposing, log why, and propose it. */
  private async proposeAfterMention(channel: string, threadId: string, text: string, reply: string, isRca: boolean, previousReply: string, offer: ReturnType<typeof parseOffer>): Promise<void> {
    // AWAITED, and last. Fire-and-forget put the card wherever the backend's latency
    // happened to land it — on a slow private LLM, 40 seconds later and under the NEXT
    // question. Awaiting is what makes the ThreadQueue above mean anything: the turn is
    // not over until its card is posted. withTrace so the proposal's own LLM call carries
    // the threadId, which as a detached call it never did — the one log line you needed to
    // join an orphan card back to its conversation was the one line that had no trace.
    const gate = worthProposing(text, reply, isRca, previousReply, offer);
    // Logged on BOTH branches now. Only the skip was logged before, so a card that should
    // never have been proposed left no trace of why it was — which is exactly what happened
    // on 2026-09-16, when a cleanup question produced a GitOps PR card and the log said
    // nothing at all about the decision.
    // The checks ride on the skip line: that is the branch whose cause used to need a trip
    // into Redis to find (2026-09-22). The propose branch already names its reason.
    logger.info(
      `[remediation] ${gate.propose ? "proposing" : "no proposal call"} for thread ${threadId} — ${gate.reason}` +
      (gate.propose ? "" : ` | ${explainGate(text, reply, previousReply, offer)}`)
    );
    if (gate.propose) {
      await withTrace(threadId, () =>
        this.remediation.maybeProposeRemediation(
          channel,
          threadId,
          null,
          {},
          // The offer names the exact object; on a bare "ya" the user text names nothing, and
          // the evidence is a turn back — see buildProposalContext.
          buildProposalContext(text, reply, offer, previousReply),
          // worthProposing already decided this; it is the only place that knows whether the
          // words came from a person or the fault vocabulary came from the agent's own answer.
          gate.byUser,
          offer
        )
      );
    }
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

