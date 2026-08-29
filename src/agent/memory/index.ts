import type { Message } from "../llm/types.js";
import type { Redis } from "ioredis";
import { trimToWindow } from "../context/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";

const MAX_MESSAGES = 50;
const REDIS_TTL_SEC = 86400;

export class ConversationMemory {
  private store = new Map<string, Message[]>();
  private rcaThreads = new Set<string>(); // in-memory; Redis uses a separate key
  private skillThreads = new Map<string, string[]>(); // ditto — playbook names per thread
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

  /**
   * The playbooks this thread has accumulated, by name. Durable for the same reason the
   * conversation is: the two are keyed by the same threadId and a thread outlives a pod.
   *
   * Before this, `DevOpsAgent.threadSkills` was a plain in-process Map while the conversation
   * sat in Redis, so a restart left a live thread with its history intact and its playbooks
   * gone — a follow-up on a latency incident answered without the latency playbook, silently,
   * with nothing in the log to say a playbook had been lost. Observed after the 01:47 rollout:
   * the thread came back with `[rca-format]` where it had been carrying three more.
   *
   * Names, not bodies: the registry is the source of truth for what a skill says, so a skill
   * edited or removed between the two turns resolves to its current text or to nothing.
   */
  async getSkills(threadId: string): Promise<string[]> {
    if (!this.redis) return this.skillThreads.get(threadId) ?? [];
    const raw = await this.redis.get(`skills:${threadId}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch (err) {
      // Same trade as get(): a corrupt entry costs this thread its playbooks, not its ability
      // to answer. Selection runs again on the next message.
      logger.warn(`[${threadId}] corrupt skills cache — reselecting from scratch: ${errDetail(err)}`);
      return [];
    }
  }

  async setSkills(threadId: string, names: string[]): Promise<void> {
    if (!this.redis) {
      this.skillThreads.set(threadId, names);
      return;
    }
    await this.redis.set(`skills:${threadId}`, JSON.stringify(names), "EX", REDIS_TTL_SEC);
  }

  async clear(threadId: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(`conv:${threadId}`, `rca:${threadId}`, `skills:${threadId}`);
    } else {
      this.store.delete(threadId);
      this.rcaThreads.delete(threadId);
      this.skillThreads.delete(threadId);
    }
  }
}
