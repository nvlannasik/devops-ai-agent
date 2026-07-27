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
import logger, { errDetail } from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { releaseVisibilitySeconds, parseResponseBody } from "../llm/sqs.js";
import type { GitOpsRequestBody, GitOpsPayload } from "./types.js";

// SQS RPC client for the GitOps PR flow. Deliberately mirrors SQSLLMClient's dispatcher
// pattern rather than sharing a base with it: that client is the battle-tested critical
// path (see MEMORY_BANK SQS bug #8) and GitOps traffic is rare, so an isolated copy is the
// smaller-blast-radius change. Sends to the gitops request queue; routes responses by
// requestId off the SHARED LLM response queue. When both this and the LLM client run in
// one process there are two dispatchers — they cooperate via the same release-non-owned
// mechanism used across replicas. ponytail: extract a shared SqsRpc core only if the churn
// ever matters.

const FIFO_ATTRS = { FifoQueue: "true", ContentBasedDeduplication: "false" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  try {
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;
    logger.warn(`[sqs-gitops] queue "${queueName}" not found — creating...`);
    const res = await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: queueName.endsWith(".fifo") ? FIFO_ATTRS : undefined }));
    return res.QueueUrl!;
  }
}

interface Waiter {
  resolve: (payload: GitOpsPayload) => void;
  reject: (error: Error) => void;
}

export class SqsGitOpsClient {
  private sqs: SQSClient;
  private cfg = {
    region: config.llm.sqs.region,
    requestQueueName: config.gitops.requestQueueName,
    responseQueueName: config.llm.sqs.responseQueueName, // shared with the LLM path
    pollWaitSeconds: config.llm.sqs.pollWaitSeconds,
    timeoutMs: config.gitops.timeoutMs,
  };
  private requestQueueUrl?: string;
  private responseQueueUrl?: string;
  private readonly pending = new Map<string, Waiter>();
  private readonly issued = new Map<string, number>();
  private readonly abort = new AbortController();
  private startPromise?: Promise<void>;

  constructor() {
    this.sqs = new SQSClient({
      region: this.cfg.region,
      requestHandler: { connectionTimeout: 5000, requestTimeout: (this.cfg.pollWaitSeconds + 15) * 1000 },
      maxAttempts: 3,
    });
  }

  async request(body: GitOpsRequestBody): Promise<GitOpsPayload> {
    await this.ensureStarted();
    const requestId = randomUUID();

    const responsePromise = new Promise<GitOpsPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.tombstone(requestId);
        reject(new Error(`GitOps SQS timeout after ${this.cfg.timeoutMs}ms for requestId=${requestId}`));
      }, this.cfg.timeoutMs);
      this.pending.set(requestId, {
        resolve: (payload) => { clearTimeout(timer); resolve(payload); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });

    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.requestQueueUrl,
        MessageBody: JSON.stringify({ requestId, ...body }),
        MessageGroupId: requestId,
        MessageDeduplicationId: requestId,
      }));
    } catch (err) {
      const waiter = this.pending.get(requestId);
      this.pending.delete(requestId);
      waiter?.reject(err instanceof Error ? err : new Error(String(err)));
    }

    logger.debug(`[sqs-gitops] request published requestId=${requestId} op=${body.op}`);
    return responsePromise;
  }

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
    logger.info(`[sqs-gitops] request queue:  ${this.requestQueueUrl}`);
    logger.info(`[sqs-gitops] response queue: ${this.responseQueueUrl} (shared)`);
    void this.dispatchLoop();
  }

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
          { abortSignal: this.abort.signal }
        );
        this.purgeExpiredTombstones();
        // per-message isolation: one bad message must not skip the rest of the batch
        for (const msg of result.Messages ?? []) {
          await this.routeMessage(msg).catch((err) =>
            logger.error(`[sqs-gitops] routing failed (message left for redelivery): ${errDetail(err)}`)
          );
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        logger.error(`[sqs-gitops] dispatcher error — retrying in 2s: ${errDetail(err)}`);
        await sleep(2000);
      }
    }
    logger.info("[sqs-gitops] dispatcher stopped");
  }

  private async routeMessage(msg: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }): Promise<void> {
    const body = parseResponseBody(msg.Body) as { requestId: string; response?: GitOpsPayload; error?: string } | null;
    if (!body) {
      logger.error(`[sqs-gitops] unroutable response body — deleting: ${truncate(msg.Body ?? "(empty)", 200)}`);
      await this.deleteMessage(msg.ReceiptHandle!);
      return;
    }
    const waiter = this.pending.get(body.requestId);

    if (waiter) {
      await this.deleteMessage(msg.ReceiptHandle!);
      this.pending.delete(body.requestId);
      this.tombstone(body.requestId);
      if (body.error) {
        logger.warn(`[sqs-gitops] ← error requestId=${body.requestId}: ${body.error}`);
        waiter.reject(new Error(`GitOps worker error: ${body.error}`));
      } else if (!body.response) {
        logger.error(`[sqs-gitops] ← empty envelope requestId=${body.requestId} (no response, no error)`);
        waiter.reject(new Error(`GitOps worker returned an empty envelope for requestId=${body.requestId}`));
      } else {
        waiter.resolve(body.response);
      }
      return;
    }

    if (this.issued.has(body.requestId)) {
      await this.deleteMessage(msg.ReceiptHandle!); // our own late/duplicate — drop
      return;
    }

    // not ours (another replica's LLM/gitops response, or an orphan) — release it
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.responseQueueUrl,
      ReceiptHandle: msg.ReceiptHandle!,
      VisibilityTimeout: releaseVisibilitySeconds(receiveCount),
    }));
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.responseQueueUrl, ReceiptHandle: receiptHandle }));
  }

  private tombstone(requestId: string): void {
    this.issued.set(requestId, Date.now() + 2 * this.cfg.timeoutMs);
  }

  private purgeExpiredTombstones(): void {
    const now = Date.now();
    for (const [requestId, expiry] of this.issued) if (now >= expiry) this.issued.delete(requestId);
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const waiter of this.pending.values()) waiter.reject(new Error("GitOps SQS client shutting down"));
    this.pending.clear();
    this.issued.clear();
    this.sqs.destroy();
  }
}
