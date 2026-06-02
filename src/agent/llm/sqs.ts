import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  CreateQueueCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";
import { config } from "../../config/index.js";
import logger from "../../utils/logger/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "./types.js";

const FIFO_ATTRS = { FifoQueue: "true", ContentBasedDeduplication: "false" };

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

export class SQSLLMClient implements LLMClient {
  private sqs: SQSClient;
  private cfg = config.llm.sqs;
  private requestQueueUrl?: string;
  private responseQueueUrl?: string;

  constructor() {
    this.sqs = new SQSClient({ region: this.cfg.region });
  }

  private async resolveUrls(): Promise<void> {
    if (this.requestQueueUrl && this.responseQueueUrl) return;
    const [req, res] = await Promise.all([
      resolveQueueUrl(this.sqs, this.cfg.requestQueueName),
      resolveQueueUrl(this.sqs, this.cfg.responseQueueName),
    ]);
    this.requestQueueUrl = req;
    this.responseQueueUrl = res;
    logger.info(`[sqs-llm] request queue: ${this.requestQueueUrl}`);
    logger.info(`[sqs-llm] response queue: ${this.responseQueueUrl}`);
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    await this.resolveUrls();
    const requestId = randomUUID();

    await this.sqs.send(new SendMessageCommand({
      QueueUrl: this.requestQueueUrl,
      MessageBody: JSON.stringify({ requestId, messages, tools, systemPrompt }),
      MessageGroupId: requestId,
      MessageDeduplicationId: requestId,
    }));

    logger.debug(`[sqs-llm] request published requestId=${requestId}`);
    return this.pollResponse(requestId);
  }

  private async pollResponse(requestId: string): Promise<LLMResponse> {
    const deadline = Date.now() + this.cfg.timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.sqs.send(new ReceiveMessageCommand({
        QueueUrl: this.responseQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.cfg.pollWaitSeconds,
        MessageAttributeNames: ["requestId"],
      }));

      for (const msg of result.Messages ?? []) {
        const body = JSON.parse(msg.Body!) as { requestId: string; response?: LLMResponse; error?: string };
        if (body.requestId !== requestId) continue;

        await this.sqs.send(new DeleteMessageCommand({
          QueueUrl: this.responseQueueUrl,
          ReceiptHandle: msg.ReceiptHandle!,
        }));

        if (body.error) throw new Error(`LLM worker error: ${body.error}`);
        logger.debug(`[sqs-llm] response received requestId=${requestId}`);
        return body.response!;
      }
    }

    throw new Error(`SQS LLM timeout after ${this.cfg.timeoutMs}ms for requestId=${requestId}`);
  }
}
