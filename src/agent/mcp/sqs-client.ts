// The agent's half of the SQS bridge contract (spec 2026-10-15-multi-cluster-sqs-bridge-design §3).
// One SqsMcpDispatcher per process owns the dedicated MCP response queue; one SqsMCPClient per
// cluster wraps it with MCPClient's surface. Mirrors SqsGitOpsClient's dispatcher (send → route
// by requestId → release what isn't ours → tombstone what timed out) rather than sharing a base.
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
import { sqsTraceAttributes } from "../../tracing/sqs.js";
import { randomUUID } from "crypto";
import { config } from "../../config/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { currentTrace } from "../../utils/trace/index.js";
import { releaseVisibilitySeconds, parseResponseBody } from "../llm/sqs.js";
import type { ToolDefinition } from "../llm/types.js";

export type BridgePayload = { tools: ToolDefinition[] } | { content: string; isError?: boolean };
type SqsLike = { send(cmd: unknown, opts?: unknown): Promise<any>; destroy(): void };
interface Waiter {
  label: string;
  resolve: (p: BridgePayload) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SqsMcpDispatcher {
  private readonly sqs: SqsLike;
  private responseQueueUrl?: string;
  private readonly requestUrls = new Map<string, Promise<string>>();
  private readonly pending = new Map<string, Waiter>();
  private readonly issued = new Map<string, number>();
  private readonly abort = new AbortController();
  private startPromise?: Promise<void>;
  private longestTimeoutMs = 60_000;

  constructor(
    private readonly responseQueueName: string,
    sqs?: SqsLike,
    private readonly pollWaitSeconds: number = config.llm.sqs.pollWaitSeconds
  ) {
    this.sqs =
      sqs ??
      new SQSClient({
        region: config.llm.sqs.region,
        requestHandler: { connectionTimeout: 5000, requestTimeout: (pollWaitSeconds + 15) * 1000 },
        maxAttempts: 3,
      });
  }

  async request(
    requestQueueName: string,
    msg: { op: "list_tools" | "call_tool"; tool?: string; args?: Record<string, unknown> },
    timeoutMs: number,
    label: string,
    opts: { deadline?: number } = {}
  ): Promise<BridgePayload> {
    await this.ensureStarted();
    const requestUrl = await this.requestUrl(requestQueueName);
    const requestId = randomUUID();
    const deadline = opts.deadline ?? Date.now() + timeoutMs;
    this.longestTimeoutMs = Math.max(this.longestTimeoutMs, timeoutMs);

    const answer = new Promise<BridgePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.tombstone(requestId);
        reject(new Error(`bridge ${label} did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(requestId, {
        label,
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: requestUrl,
          MessageBody: JSON.stringify({ requestId, ...msg, deadline, traceId: currentTrace() }),
          MessageGroupId: requestId,
          // The active span's W3C context, as attributes — the body stays the contract it was (tracing/sqs.ts).
          MessageAttributes: sqsTraceAttributes(),
          MessageDeduplicationId: requestId,
        })
      );
    } catch (err) {
      this.pending.get(requestId)?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.delete(requestId);
    }
    logger.debug(`[mcp-sqs] → ${label} ${msg.op}${msg.tool ? ` ${msg.tool}` : ""} requestId=${requestId}`);
    return answer;
  }

  private requestUrl(name: string): Promise<string> {
    let url = this.requestUrls.get(name);
    if (!url) {
      url = this.resolveQueueUrl(name);
      this.requestUrls.set(name, url);
      url.catch(() => this.requestUrls.delete(name)); // a failed lookup is retried next call
    }
    return url;
  }

  private async resolveQueueUrl(name: string): Promise<string> {
    try {
      return (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    } catch (err) {
      if (!(err instanceof QueueDoesNotExist)) throw err;
      logger.warn(`[mcp-sqs] queue "${name}" not found — creating`);
      return (
        await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }))
      ).QueueUrl!;
    }
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.responseQueueUrl = await this.resolveQueueUrl(this.responseQueueName);
    logger.info(`[mcp-sqs] response queue: ${this.responseQueueUrl}`);
    void this.dispatchLoop();
  }

  private async dispatchLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.responseQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.pollWaitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: this.abort.signal }
        );
        this.purgeExpiredTombstones();
        for (const msg of result.Messages ?? []) {
          await this.routeMessage(msg).catch((err) => logger.error(`[mcp-sqs] routing failed (left for redelivery): ${errDetail(err)}`));
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        logger.error(`[mcp-sqs] dispatcher error — retrying in 2s: ${errDetail(err)}`);
        await sleep(2000);
      }
    }
  }

  private async routeMessage(msg: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }): Promise<void> {
    const body = parseResponseBody(msg.Body) as { requestId: string; response?: BridgePayload; error?: string } | null;
    if (!body) {
      logger.error(`[mcp-sqs] unroutable response body — deleting: ${truncate(msg.Body ?? "(empty)", 200)}`);
      await this.deleteMessage(msg.ReceiptHandle!);
      return;
    }
    const waiter = this.pending.get(body.requestId);
    if (waiter) {
      await this.deleteMessage(msg.ReceiptHandle!);
      this.pending.delete(body.requestId);
      this.tombstone(body.requestId);
      if (body.error) waiter.reject(new Error(`bridge ${waiter.label}: ${body.error}`));
      else if (!body.response) waiter.reject(new Error(`bridge ${waiter.label} returned an empty envelope`));
      else waiter.resolve(body.response);
      return;
    }
    if (this.issued.has(body.requestId)) {
      await this.deleteMessage(msg.ReceiptHandle!); // our own late reply — drop
      return;
    }
    // another replica's — release it
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.responseQueueUrl,
        ReceiptHandle: msg.ReceiptHandle!,
        VisibilityTimeout: releaseVisibilitySeconds(Number(msg.Attributes?.ApproximateReceiveCount ?? "1")),
      })
    );
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.responseQueueUrl, ReceiptHandle: receiptHandle }));
  }

  private tombstone(requestId: string): void {
    this.issued.set(requestId, Date.now() + 2 * this.longestTimeoutMs);
  }

  private purgeExpiredTombstones(): void {
    const now = Date.now();
    for (const [id, expiry] of this.issued) if (now >= expiry) this.issued.delete(id);
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const w of this.pending.values()) w.reject(new Error("MCP SQS dispatcher shutting down"));
    this.pending.clear();
    this.issued.clear();
    this.sqs.destroy();
  }
}

export class SqsMCPClient {
  private tools: ToolDefinition[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private readonly listTimeoutMs: number;
  private readonly refreshMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    readonly cluster: string,
    private readonly requestQueueName: string,
    private readonly dispatcher: SqsMcpDispatcher,
    opts: { listTimeoutMs?: number; refreshMs?: number; callTimeoutMs?: number } = {}
  ) {
    this.listTimeoutMs = opts.listTimeoutMs ?? 15_000;
    this.refreshMs = opts.refreshMs ?? 300_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? config.mcp.toolTimeoutMs;
  }

  /** Never throws: one unreachable cluster must not stop the agent booting for the others. */
  async connect(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshMs);
    this.refreshTimer.unref();
  }

  private async refresh(): Promise<void> {
    try {
      const p = await this.dispatcher.request(this.requestQueueName, { op: "list_tools" }, this.listTimeoutMs, this.cluster);
      if (!("tools" in p)) throw new Error("list_tools answered without tools");
      this.tools = p.tools;
      logger.info(`[mcp-sqs] ${this.cluster}: ${p.tools.length} tools`);
    } catch (err) {
      logger.warn(`[mcp-sqs] ${this.cluster} unreachable — keeping ${this.tools.length} known tool(s): ${errDetail(err)}`);
    }
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * NEVER retries. MCPClient retries once after a reconnect, which is safe for an in-process HTTP
   * session; over SQS a retry is a second request under a new requestId, so a write whose reply was
   * lost would run twice. The model may call again — that is a decision the trace records.
   */
  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    const p = await this.dispatcher.request(this.requestQueueName, { op: "call_tool", tool: name, args: input }, this.callTimeoutMs, this.cluster);
    if (!("content" in p)) throw new Error(`bridge ${this.cluster} answered call_tool without content`);
    return p.content;
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
