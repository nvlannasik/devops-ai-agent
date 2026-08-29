import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  CreateQueueCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";
import { config } from "../../config/index.js";
import { sanitizeForWire } from "./sanitize.js";
import logger, { errDetail } from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { currentTrace } from "../../utils/trace/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "./types.js";

const FIFO_ATTRS = { FifoQueue: "true", ContentBasedDeduplication: "false" };

// A normal cross-replica response is received by a few non-owners before its
// owner grabs it. Up to this many receives, release it instantly (visibility 0)
// so the owner sees it with near-zero delay. Beyond it, the message is almost
// certainly an orphan (its requester died) — back off so it stops hot-looping
// the shared queue and let SQS message retention clear it.
const RELEASE_FAST_LIMIT = 20;
const ORPHAN_BACKOFF_SEC = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function releaseVisibilitySeconds(receiveCount: number): number {
  return receiveCount > RELEASE_FAST_LIMIT ? ORPHAN_BACKOFF_SEC : 0;
}

/**
 * Parse a response-queue body, returning null for anything unroutable.
 *
 * The shared response queue is the agent's ONLY path for LLM answers, and a body that
 * can't be parsed (or has no requestId) can never be routed to a waiter. Left unguarded,
 * `JSON.parse` threw out of routeMessage, aborted the rest of the receive batch (up to 9
 * valid responses skipped), and left the bad message undeleted — so it came straight back
 * and the dispatcher hot-looped on it while every in-flight investigation timed out.
 * llm-worker has guarded its own request queue this way since the poison-pill fix;
 * this is the same guard on the reply side. Shared by both SQS dispatchers.
 */
export function parseResponseBody(body: string | undefined): { requestId: string; response?: unknown; error?: string } | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const requestId = (parsed as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  return parsed as { requestId: string; response?: unknown; error?: string };
}

async function resolveQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  try {
    const res = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    return res.QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;
    logger.warn(`[sqs-llm] queue "${queueName}" not found — creating...`);
    const res = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: queueName.endsWith(".fifo") ? FIFO_ATTRS : undefined,
    }));
    logger.info(`[sqs-llm] queue created: ${res.QueueUrl}`);
    return res.QueueUrl!;
  }
}

interface PendingWaiter {
  resolve: (response: LLMResponse) => void;
  reject: (error: Error) => void;
}

export class SQSLLMClient implements LLMClient {
  private sqs: SQSClient;
  private cfg = config.llm.sqs;
  private requestQueueUrl?: string;
  private responseQueueUrl?: string;
  // requestId → waiter, for the in-flight requests this replica is awaiting
  private readonly pending = new Map<string, PendingWaiter>();
  // requestId → expiry: requests this replica already sent. Lets us recognise and
  // delete OUR OWN late/duplicate responses (e.g. a request that already timed
  // out) instead of releasing them back to bounce around the shared queue.
  private readonly issued = new Map<string, number>();
  private readonly abort = new AbortController();
  private startPromise?: Promise<void>;

  constructor() {
    this.sqs = new SQSClient({
      region: this.cfg.region,
      // Bound every SQS call. The dispatcher is the SOLE deliverer of LLM responses;
      // without a timeout, one hung request (network blip, credential refresh) freezes
      // it forever and every later investigation times out. requestTimeout must exceed
      // the long-poll wait so normal empty receives aren't cut short.
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: (this.cfg.pollWaitSeconds + 15) * 1000,
      },
      maxAttempts: 3,
    });
  }

  async chat(rawMessages: Message[], tools: ToolDefinition[], rawSystemPrompt: string): Promise<LLMResponse> {
    // Lone surrogates make the body unparseable for the server, identically on every
    // backend — see sanitize.ts. Guarded here, at the wire, not at the producers.
    const { messages, systemPrompt } = sanitizeForWire(rawMessages, rawSystemPrompt);
    await this.ensureStarted();
    const requestId = randomUUID();

    const responsePromise = new Promise<LLMResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.tombstone(requestId); // a late response may still arrive — mark it ours so we drop it
        reject(new Error(`SQS LLM timeout after ${this.cfg.timeoutMs}ms for requestId=${requestId}`));
      }, this.cfg.timeoutMs);

      // register the waiter BEFORE publishing so a fast response is never missed
      this.pending.set(requestId, {
        resolve: (response) => { clearTimeout(timer); resolve(response); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });

    // traceId = the Slack threadId of the running investigation (undefined outside one).
    // It is what joins this agent log line to the llm-worker's log for the same call.
    const traceId = currentTrace();

    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.requestQueueUrl,
        MessageBody: JSON.stringify({ requestId, messages, tools, systemPrompt, traceId }),
        MessageGroupId: requestId,
        MessageDeduplicationId: requestId,
      }));
    } catch (err) {
      logger.error(`[sqs-llm] publish failed requestId=${requestId}${traceId ? ` trace=${traceId}` : ""}: ${errDetail(err)}`);
      const waiter = this.pending.get(requestId);
      this.pending.delete(requestId);
      this.tombstone(requestId); // never published, but keep the id owned so a stray reply is dropped
      waiter?.reject(err instanceof Error ? err : new Error(String(err)));
      return responsePromise;
    }

    // info, not debug: this is the ONLY line that maps a Slack thread to a worker requestId
    logger.info(
      `[sqs-llm] → requestId=${requestId}${traceId ? ` trace=${traceId}` : ""} ` +
      `msgs=${messages.length} tools=${tools.length} awaiting=${this.pending.size}`
    );
    return responsePromise;
  }

  // memoized so concurrent first calls share one startup and never send before URLs resolve
  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const [requestUrl, responseUrl] = await Promise.all([
      resolveQueueUrl(this.sqs, this.cfg.requestQueueName),
      resolveQueueUrl(this.sqs, this.cfg.responseQueueName),
    ]);
    this.requestQueueUrl = requestUrl;
    this.responseQueueUrl = responseUrl;
    logger.info(`[sqs-llm] request queue:  ${this.requestQueueUrl}`);
    logger.info(`[sqs-llm] response queue: ${this.responseQueueUrl} (shared)`);
    void this.dispatchLoop();
  }

  /**
   * Single poller per process over the SHARED response queue. SQS has no selective
   * receive, so a replica may pull a response belonging to another replica. We
   * route by requestId:
   *   - ours & awaited      → delete + resolve/reject
   *   - ours & already done → delete (a late/duplicate response we no longer need)
   *   - not ours            → release immediately so the owning replica can grab it
   *                           (the old code skipped without releasing, leaving the
   *                           message invisible for the whole visibility timeout)
   */
  private async dispatchLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.responseQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.cfg.pollWaitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: this.abort.signal },
        );

        this.purgeExpiredTombstones();

        for (const msg of result.Messages ?? []) {
          // per-message isolation: one bad receipt handle or a transient SQS error on
          // message 1 must not skip messages 2..10 in the same batch
          await this.routeMessage(msg).catch((err) =>
            logger.error(`[sqs-llm] routing failed (message left for redelivery): ${errDetail(err)}`)
          );
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        logger.error(`[sqs-llm] dispatcher error — retrying in 2s: ${errDetail(err)}`);
        await sleep(2000);
      }
    }
    logger.info("[sqs-llm] dispatcher stopped");
  }

  private async routeMessage(msg: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }): Promise<void> {
    const body = parseResponseBody(msg.Body) as { requestId: string; response?: LLMResponse; error?: string } | null;
    if (!body) {
      // unroutable forever — delete it rather than let it wedge the queue (see parseResponseBody)
      logger.error(`[sqs-llm] unroutable response body — deleting: ${truncate(msg.Body ?? "(empty)", 200)}`);
      await this.deleteMessage(msg.ReceiptHandle!);
      return;
    }
    const waiter = this.pending.get(body.requestId);

    if (waiter) {
      await this.deleteMessage(msg.ReceiptHandle!);
      this.pending.delete(body.requestId);
      this.tombstone(body.requestId); // guard against a duplicate redelivery
      if (body.error) {
        logger.warn(`[sqs-llm] ← error requestId=${body.requestId}: ${body.error}`);
        waiter.reject(new Error(`LLM worker error: ${body.error}`));
      } else if (!body.response) {
        // an envelope with neither response nor error is a worker bug — fail the waiter
        // loudly instead of resolving `undefined` into the agentic loop
        logger.error(`[sqs-llm] ← empty envelope requestId=${body.requestId} (no response, no error)`);
        waiter.reject(new Error(`LLM worker returned an empty envelope for requestId=${body.requestId}`));
      } else {
        logger.debug(`[sqs-llm] ← ok requestId=${body.requestId} stop=${body.response.stopReason}`);
        waiter.resolve(body.response);
      }
      return;
    }

    if (this.issued.has(body.requestId)) {
      // our own response, but we already timed out / resolved it — drop it
      await this.deleteMessage(msg.ReceiptHandle!);
      return;
    }

    // belongs to another replica (or an orphan whose requester is gone) — release it
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.responseQueueUrl,
      ReceiptHandle: msg.ReceiptHandle!,
      VisibilityTimeout: releaseVisibilitySeconds(receiveCount),
    }));
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({
      QueueUrl: this.responseQueueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }

  private tombstone(requestId: string): void {
    this.issued.set(requestId, Date.now() + 2 * this.cfg.timeoutMs);
  }

  private purgeExpiredTombstones(): void {
    const now = Date.now();
    for (const [requestId, expiry] of this.issued) {
      if (now >= expiry) this.issued.delete(requestId);
    }
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("SQS LLM client shutting down"));
    }
    this.pending.clear();
    this.issued.clear();
    this.sqs.destroy();
  }
}
