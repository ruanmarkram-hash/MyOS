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
   * When true, new enqueue() calls are silently dropped. Set by close()
   * during graceful shutdown so drain() actually means "queue is empty",
   * not "queue WAS empty 5ms ago and is now growing again".
   */
  private closed = false;

  /**
   * Stop accepting new handlers. Idempotent. Existing chains keep running
   * until their natural completion. Pair with drain() to wait for them.
   */
  close(): void {
    this.closed = true;
  }

  /** Whether close() has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue a message handler for a given chat. Handlers for the same
   * chatId run sequentially in FIFO order. Different chatIds run in parallel.
   *
   * After {@link close}, new enqueues are dropped with a warning log.
   * This is the lever that makes drain() meaningful during shutdown.
   */
  enqueue(chatId: string, handler: () => Promise<void>): void {
    if (this.closed) {
      logger.warn({ chatId }, 'Message dropped — queue is closed (shutting down)');
      return;
    }
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
   * Wait for the queue to be fully empty, or until `timeoutMs` elapses.
   * Used by graceful shutdown so the in-flight assistant reply gets fully
   * flushed (Telegram send + DB commit) before the bot process exits.
   *
   * IMPORTANT: drain only means "queue empty" if {@link close} has been
   * called first. Otherwise, new enqueues racing with drain can produce a
   * false `drained: true` because the snapshot of chains-at-start-time has
   * resolved while new chats joined behind it. The shutdown handler in
   * `index.ts` calls `close()` before `drain()`.
   *
   * The implementation loops: settle the current snapshot, then check if
   * new chains appeared (only possible if NOT closed); if so, settle those
   * too; repeat until either empty or timeout.
   *
   * Returns `{drained: true}` if the queue emptied, `{drained: false}` if
   * timeout fired (in which case `remaining` is the number of chats that
   * still had pending work).
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
    const start = Date.now();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    try {
      while (this.chains.size > 0 && !timedOut) {
        const snapshot = Array.from(this.chains.values());
        const winner = await Promise.race([
          Promise.allSettled(snapshot).then(() => 'done' as const),
          timeout,
        ]);
        if (winner === 'timeout') break;
        // Loop: if more chains arrived during settle (open queue) we'll
        // pick them up. If queue is closed, snapshot covers all there is.
        if (this.chains.size === 0) break;
        // Defensive cap: never spin more than `timeoutMs` total.
        if (Date.now() - start >= timeoutMs) {
          timedOut = true;
          break;
        }
      }
      return { drained: this.chains.size === 0, remaining: this.chains.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** TEST-ONLY: reset internal state. Do not call from production code. */
  _resetForTest(): void {
    this.chains.clear();
    this.pending.clear();
    this.closed = false;
  }
}

export const messageQueue = new MessageQueue();
