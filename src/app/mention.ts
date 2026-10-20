import { type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import { config } from "../config/index.js";
import { type RunMeta } from "../agent/index.js";
import { mentionBudget, wantsInvestigation, wantsTour } from "../agent/intent/index.js";
import { learnIntent } from "../agent/feedback/index.js";
import { postmortemIntent } from "../agent/postmortem/intent.js";
import { parseStatusCommand } from "../agent/incidents/reconcile.js";
import { explainGate, parseOffer, worthProposing } from "../agent/remediation/proposal.js";
import { buildRcaBlocks, isRcaResponse, formatRunFooter } from "../utils/slack/blocks.js";
import { splitForSlack, toMrkdwn } from "../utils/slack/split.js";
import { flowMessages, stripRepeatedInventory, tourBlocks } from "../utils/slack/tour-tables.js";
import { flowFacts, renderModelText } from "../agent/onboarding/model.js";
import type { ClusterModel } from "../agent/onboarding/types.js";
import { truncate } from "../utils/truncate/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { buildMentionMarker } from "../agent/prompts/system.js";
import { withRoute, withTrace } from "../utils/trace/index.js";
import type { SlackHost } from "./host.js";

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

export class MentionFlow {
  constructor(private readonly host: SlackHost) {}

  /**
   * The tour's inventory as tables (utils/slack/tour-tables), from the thread's latest
   * k8s_cluster_inventory result. Refused blocks go again as the same facts in plain mrkdwn —
   * a table must never cost the facts. No inventory in the thread posts nothing.
   */
  async postTourTables(channel: string, threadTs: string, client: AllMiddlewareArgs["client"]): Promise<string | null> {
    const raw = await this.host.agent.lastToolResult(threadTs, "k8s_cluster_inventory").catch(() => null);
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
  async tourContext(text: string, boundMs = 20_000, threadId?: string): Promise<{ isTour: boolean; ns: string | null; model: ClusterModel | null; text: string }> {
    const none = { isTour: false, ns: null, model: null, text: "" };
    const asked = wantsTour(text);
    // "how about the devops-tools namespace?" carries no tour vocabulary; after a tour it is one.
    const followUp = !asked && !!threadId && this.host.tourThreads.has(threadId) && !wantsInvestigation(text);
    if (!asked && !followUp) return none;
    const ns = await this.host.agent.tourNamespace(text).catch(() => null);
    if (followUp && !ns) return none;
    if (threadId) this.host.tourThreads.add(threadId);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), boundMs); });
    const model = ns
      ? await Promise.race([this.host.agent.clusterModel(ns).catch(() => null), bound]).finally(() => clearTimeout(timer))
      : null;
    if (ns && !model) logger.info(`[onboarding] tour went on without the cluster model for ${ns} (not ready within ${boundMs / 1000}s or failed)`);
    if (!ns) return { isTour: true, ns, model, text: "" };
    // Live 2026-10-17: the namespace was known, yet the model called the cluster-wide overview and
    // the tour posted 21 namespaces. Said once, outside the data frame, model or no model.
    const scope = `[TOUR SCOPE] The user asked about namespace \`${ns}\`: call \`k8s_cluster_inventory\` with namespace \`${ns}\`, not the cluster-wide overview.`;
    return { isTour: true, ns, model, text: model ? `${renderModelText(model, ns)}\n${scope}` : scope };
  }

  /** The cluster model's flow and where-to-change, one message each; a refused table re-posts as text. */
  async postFlowTables(channel: string, threadTs: string, client: AllMiddlewareArgs["client"], model: ClusterModel, ns: string): Promise<void> {
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

  async handleMention(args: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">): Promise<void> {
    const { event, say, client } = args;
    const threadId = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@[^>]+>/g, "").trim();

    // log the raw text here — the Issue preview inside investigate() now starts with the
    // [USER MESSAGE ...] marker, which eats the whole 120-char preview
    logger.info(`[slack] mention received — channel: ${event.channel}, thread: ${threadId}, user: ${event.user}, text: ${truncate(text, 200)}`);

    if (!this.host.mayUseAgent(event.user)) {
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
      await this.host.handleLearn(event, client, threadId);
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
      await this.host.handlePostmortem(event, client, threadId);
      return;
    }

    // `@agent resolved` / `@agent reopen` — on-call's word on the incident's status, which
    // beats both the webhook and the sweeper. Only inside a thread that maps to a stored
    // incident: anywhere else "resolved" is just a word in a sentence, and the mention falls
    // through to the normal agent flow.
    const status = parseStatusCommand(text);
    if (status && (await this.host.handleStatusCommand(event.channel, threadId, event.user ?? "unknown", status))) return;

    await say({ text: ":pepe-hacker: On it...", thread_ts: threadId });

    // Per-message mode marker — same mechanism as the [FOLLOW-UP] prefix. Distant
    // system-prompt rules alone don't hold: the model defaults to RCA format for any
    // first message (see MEMORY_BANK). Only Alertmanager messages carry [SOURCE: ...].
    // The alert clause restates what the thread is about next to the question. history[0] is
    // pinned and still carries it, but a pinned sentence at the far end of the window loses to
    // the freshest tool result — see buildMentionMarker.
    const message = buildMentionMarker(text, await this.host.agent.threadAlertIdentity(event.channel, threadId));

    // Plain data questions get a hard tool budget (MENTION_TOOL_ROUNDS, default 2);
    // explicit investigation requests (and the alert webhook path) keep the full budget.
    const investigation = wantsInvestigation(text);
    const budget = mentionBudget(text, { mention: config.mentionToolRounds, tour: config.tourToolRounds });

    // Serialised per thread: the card and the notices this turn produces must land before
    // the next turn in the same conversation starts, and previousReply must be read after
    // the previous turn finished writing it. The semaphore is acquired INSIDE, so waiting
    // for our turn never holds a global investigation slot.
    await this.host.inFlight.track({ channel: event.channel, threadTs: threadId, kind: "mention" }, this.host.threadQueue.run(threadId, async () => {
      await this.host.semaphore.acquire();
      // Captured before the investigation appends this turn's own messages: a bare "ya" is an
      // approval only if the agent put a change on the table in the turn before it.
      const previousReply = await this.host.agent.lastAssistantText(threadId).catch(() => "");
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
            ? await this.host.agent.investigate(threadId, tourMessage, { ...turnBudget, mode, onComplete, onProgress })
            : await withRoute("light", () => this.host.agent.investigate(threadId, tourMessage, { ...turnBudget, mode, onComplete, onProgress }))
        );

        await progress.clear();
        // !investigation: the mention path's own gate on the reformat half — see conversationReply.
        reply = await this.host.conversationReply(reply, threadId, !investigation);
        // The reply investigate() returned has the [OFFER] line stripped; memory still has it.
        const offer = parseOffer(await this.host.agent.lastAssistantText(threadId).catch(() => ""));
        const isRca = isRcaResponse(reply);
        logger.info(`[slack] response type=${isRca ? "rca" : "conversation"} thread=${threadId}`);
        const footer = meta ? formatRunFooter(meta) : undefined;
        if (isRca) {
          await this.host.postRca(event.channel, threadId, reply, buildRcaBlocks(reply, footer));
        } else {
          reply = await this.postConversation(event.channel, threadId, client, reply, footer, tour);
        }
        if (isRca) {
          await this.host.agent.markRcaSent(threadId);
        }
        // Approval-gated remediation runs for BOTH mention response types: an RCA that
        // implies a fix, or a direct request ("restart X") answered in conversation mode.
        // The user text is part of the proposal context so an explicit command is enough
        // evidence. No incident row to link (no alert labels), so incidentId is null.
        // The gate is what keeps a read-only "status check" on a healthy cluster from
        // spending a heavy LLM call to be told {"action": null} — see worthProposing.
        // The tour's cluster model is evidence too: every name in it came from a tool (agent/onboarding).
        await this.host.warnIfUngrounded(event.channel, threadId, reply, tour.text);
        await this.host.notifyIfLowConfidence(event.channel, threadId, reply);
        await this.proposeAfterMention(event.channel, threadId, text, reply, isRca, previousReply, offer);
      } catch (err) {
        logger.error(`[slack] investigation failed for thread ${threadId}: ${errDetail(err)}`);
        await say({ text: `❌ Investigation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadId });
      } finally {
        this.host.semaphore.release();
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
  progressNotifier(client: AllMiddlewareArgs["client"], channel: string, threadId: string): { onProgress: (round: number, tools: string[]) => void; clear: () => Promise<void> } {
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
  async postConversation(channel: string, threadId: string, client: AllMiddlewareArgs["client"], reply: string, footer: string | undefined, tour: { isTour: boolean; ns: string | null; model: ClusterModel | null }): Promise<string> {
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
  async proposeAfterMention(channel: string, threadId: string, text: string, reply: string, isRca: boolean, previousReply: string, offer: ReturnType<typeof parseOffer>): Promise<void> {
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
        this.host.maybeProposeRemediation(
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
}
