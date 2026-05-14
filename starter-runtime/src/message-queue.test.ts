import { describe, it, expect } from 'vitest';
import { messageQueue } from './message-queue.js';

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MessageQueue.drain', () => {
  it('returns drained=true immediately when queue is empty', async () => {
    const result = await messageQueue.drain(1000);
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('waits for an in-flight handler before resolving', async () => {
    const gate = defer<void>();
    let handlerStarted = false;
    let handlerFinished = false;

    messageQueue.enqueue('chat-drain-1', async () => {
      handlerStarted = true;
      await gate.promise;
      handlerFinished = true;
    });

    // Kick off drain — should not resolve until we let the handler finish.
    const drainPromise = messageQueue.drain(5000);
    // Give the microtask queue a moment to start the handler.
    await new Promise((r) => setTimeout(r, 10));
    expect(handlerStarted).toBe(true);
    expect(handlerFinished).toBe(false);

    gate.resolve();
    const result = await drainPromise;
    expect(result.drained).toBe(true);
    expect(handlerFinished).toBe(true);
  });

  it('returns drained=false when timeout elapses with handlers still pending', async () => {
    const gate = defer<void>();
    messageQueue.enqueue('chat-drain-2', async () => {
      await gate.promise;
    });

    const result = await messageQueue.drain(50);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);

    // Cleanup so we don't leak the pending chain into other tests.
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    messageQueue._resetForTest();
  });

  it('exposes active chat ids while handlers are still pending', async () => {
    messageQueue._resetForTest();

    const gate = defer<void>();
    messageQueue.enqueue('chat-active-1', async () => {
      await gate.promise;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(messageQueue.activeChatIds).toEqual(['chat-active-1']);

    gate.resolve();
    await messageQueue.drain(1000);
    expect(messageQueue.activeChatIds).toEqual([]);
    messageQueue._resetForTest();
  });
});

describe('MessageQueue.close', () => {
  it('drops new enqueues after close()', async () => {
    messageQueue._resetForTest();

    let firstHandlerRan = false;
    let secondHandlerRan = false;

    messageQueue.enqueue('chat-close-1', async () => {
      firstHandlerRan = true;
    });
    // Wait for the first to be processed before close.
    await new Promise((r) => setTimeout(r, 10));
    expect(firstHandlerRan).toBe(true);

    messageQueue.close();
    expect(messageQueue.isClosed).toBe(true);

    messageQueue.enqueue('chat-close-2', async () => {
      secondHandlerRan = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondHandlerRan).toBe(false);

    messageQueue._resetForTest();
  });

  it('drain after close means queue is genuinely empty (no race)', async () => {
    messageQueue._resetForTest();

    const gate = defer<void>();
    messageQueue.enqueue('chat-close-3', async () => {
      await gate.promise;
    });

    messageQueue.close();
    // Try to enqueue more after close — these must NOT extend the drain.
    let droppedRan = false;
    messageQueue.enqueue('chat-close-4', async () => {
      droppedRan = true;
    });

    const drainPromise = messageQueue.drain(2000);
    gate.resolve();
    const result = await drainPromise;
    expect(result.drained).toBe(true);
    expect(droppedRan).toBe(false);

    messageQueue._resetForTest();
  });
});
