import type { Message } from "../llm/types.js";
import type { Redis } from "ioredis";
import { trimToWindow } from "../context/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";

const MAX_MESSAGES = 50;
const REDIS_TTL_SEC = 86400;

export class ConversationMemory {
  private store = new Map<string, Message[]>();
  private rcaThreads = new Set<string>(); // in-memory; Redis uses a separate key
  private redis: Redis | null;

  constructor(redis?: Redis) {
    this.redis = redis ?? null;
  }

  async get(threadId: string): Promise<Message[]> {
    if (this.redis) {
      const raw = await this.redis.get(`conv:${threadId}`);
      if (!raw) return [];
      try {
        return JSON.parse(raw) as Message[];
      } catch (err) {
        // A corrupt cache entry used to throw here, and append() calls get() too — so the
        // thread was wedged permanently behind an opaque parse error. Drop the history
        // instead: the thread loses context but keeps working, and the log says why.
        logger.error(`[${threadId}] corrupt conversation cache (${raw.length} bytes) — starting fresh: ${errDetail(err)}`);
        return [];
      }
    }
    return this.store.get(threadId) ?? [];
  }

  async append(threadId: string, message: Message): Promise<void> {
    const history = await this.get(threadId);
    history.push(message);
    // preserve the original issue (index 0) and keep tool_use/tool_result pairs
    // intact — a blind splice on the oldest messages dropped the issue and could
    // orphan a tool_result, which every later stage then assumes never happens
    const trimmed = trimToWindow(history, MAX_MESSAGES);
    if (this.redis) {
      await this.redis.set(`conv:${threadId}`, JSON.stringify(trimmed), "EX", REDIS_TTL_SEC);
    } else {
      this.store.set(threadId, trimmed);
    }
  }

  async markRcaSent(threadId: string): Promise<void> {
    if (this.redis) {
      await this.redis.set(`rca:${threadId}`, "1", "EX", REDIS_TTL_SEC);
    } else {
      this.rcaThreads.add(threadId);
    }
  }

  async hasRca(threadId: string): Promise<boolean> {
    if (this.redis) {
      return (await this.redis.exists(`rca:${threadId}`)) === 1;
    }
    return this.rcaThreads.has(threadId);
  }

  async clear(threadId: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(`conv:${threadId}`, `rca:${threadId}`);
    } else {
      this.store.delete(threadId);
      this.rcaThreads.delete(threadId);
    }
  }
}
