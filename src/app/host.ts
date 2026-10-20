import type { App } from "@slack/bolt";
import type { DevOpsAgent } from "../agent/index.js";
import type { AlertDeduplicator } from "../agent/dedup/index.js";
import type { AlertItem } from "../agent/correlation/index.js";
import type { Block } from "../utils/slack/blocks.js";
import type { ThreadCommands } from "./commands.js";
import type { RemediationFlow } from "./remediation.js";
import type { Accepted, InFlightWork, Semaphore, ThreadQueue } from "./queue.js";

/** An alert thread whose incident is not stored yet, and a resolve that arrived for it meanwhile. */
export type UnstoredAlert = { key: string; resolved?: AlertItem[]; channel?: string; namespace?: string; subjects?: string[]; startedAt?: number; alertname?: string };

/**
 * The one object SlackApp hands every flow (2026-10-21 split of app/index.ts). Every member is read
 * LIVE through a getter, like RemediatorHost: a flow never holds a copy of SlackApp's state.
 */
export interface SlackHost {
  readonly agent: DevOpsAgent;
  readonly app: App;
  readonly dedup: AlertDeduplicator;
  readonly semaphore: Semaphore;
  readonly threadQueue: ThreadQueue;
  readonly inFlight: InFlightWork<Accepted>;
  readonly unstored: Map<string, UnstoredAlert>;
  readonly tourThreads: Set<string>;
  readonly stopping: boolean;
  /** SlackApp's own field: the poller arms it, stop() clears it. */
  verifyTimer: NodeJS.Timeout | null;
  mayUseAgent(user: string | undefined): boolean;
  postRca(channel: string, threadId: string, rca: string, blocks: Block[]): Promise<void>;
  conversationReply(reply: string, threadId: string, reformat: boolean): Promise<string>;
  warnIfUngrounded(channel: string, threadId: string, answer: string, trigger?: string): Promise<void>;
  notifyIfLowConfidence(channel: string, threadId: string, rca: string): Promise<void>;
  maybeProposeRemediation: RemediationFlow["maybeProposeRemediation"];
  handleStatusCommand: ThreadCommands["handleStatusCommand"];
  handlePostmortem: ThreadCommands["handlePostmortem"];
  handleLearn: ThreadCommands["handleLearn"];
}
