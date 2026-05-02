import { logger } from './logger.js';

/**
 * Per-chat FIFO message queue. Ensures only one message is processed
 * at a time per chat_id, preventing race conditions on sessions,
 * abort controllers, and conversation logs.
 */
class MessageQueue {
  private chains = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();

  /**
   * Enqueue a message handler for a given chat. Handlers for the same
   * chatId run sequentially in FIFO order. Different chatIds run in parallel.
   */
  enqueue(chatId: string, handler: () => Promise<void>): void {
    const queued = (this.pending.get(chatId) ?? 0) + 1;
    this.pending.set(chatId, queued);

    if (queued > 1) {
      logger.info({ chatId, queued }, 'Message queued (another is processing)');
    }

    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await handler();
      } catch (err) {
        logger.error({ err, chatId }, 'Unhandled message error');
      } finally {
        const remaining = (this.pending.get(chatId) ?? 1) - 1;
        if (remaining <= 0) {
          this.pending.delete(chatId);
          this.chains.delete(chatId);
        } else {
          this.pending.set(chatId, remaining);
        }
      }
    });

    this.chains.set(chatId, next);
  }

  /** Number of chats with pending messages. */
  get activeChats(): number {
    return this.chains.size;
  }

  /** Number of pending messages for a given chat. */
  queuedFor(chatId: string): number {
    return this.pending.get(chatId) ?? 0;
  }

  /**
   * Wait for all pending handlers across every chat to finish, or until
   * `timeoutMs` elapses. Used by graceful shutdown so the in-flight
   * assistant reply gets fully flushed (Telegram send + DB commit) before
   * the bot process exits.
   *
   * Returns `{drained: true}` if the queue emptied, `{drained: false}` if
   * it timed out (in which case `remaining` is the number of chats that
   * still had pending work).
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
    if (this.chains.size === 0) return { drained: true, remaining: 0 };
    const allPending = Promise.allSettled(Array.from(this.chains.values()));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const winner = await Promise.race([
      allPending.then(() => 'done' as const),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return { drained: winner === 'done', remaining: this.chains.size };
  }
}

export const messageQueue = new MessageQueue();
