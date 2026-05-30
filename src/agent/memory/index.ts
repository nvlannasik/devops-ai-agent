import type { Message } from "../llm/types.js";

const MAX_MESSAGES = 50; // prevent unbounded growth

export class ConversationMemory {
  private store = new Map<string, Message[]>();

  get(threadId: string): Message[] {
    return this.store.get(threadId) ?? [];
  }

  append(threadId: string, message: Message): void {
    const history = this.store.get(threadId) ?? [];
    history.push(message);
    // trim oldest messages if exceeding limit (keep system context intact)
    if (history.length > MAX_MESSAGES) {
      history.splice(0, history.length - MAX_MESSAGES);
    }
    this.store.set(threadId, history);
  }

  clear(threadId: string): void {
    this.store.delete(threadId);
  }
}
