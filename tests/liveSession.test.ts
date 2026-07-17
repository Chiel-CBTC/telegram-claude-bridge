import { describe, it, expect } from 'vitest';
import { createAsyncPushQueue, TurnReader } from '../src/liveSession';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

describe('createAsyncPushQueue', () => {
  it('yields an item pushed before iteration starts', async () => {
    const queue = createAsyncPushQueue<string>();
    queue.push('a');

    const iterator = queue[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result).toEqual({ value: 'a', done: false });
  });

  it('yields an item pushed after iteration has started waiting', async () => {
    const queue = createAsyncPushQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const pending = iterator.next();
    queue.push('b');

    await expect(pending).resolves.toEqual({ value: 'b', done: false });
  });

  it('yields multiple pushed items in order', async () => {
    const queue = createAsyncPushQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    expect(await iterator.next()).toEqual({ value: 3, done: false });
  });

  it('ends iteration when closed with no pending items', async () => {
    const queue = createAsyncPushQueue<string>();
    queue.close();

    const iterator = queue[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result).toEqual({ value: undefined, done: true });
  });

  it('ends a pending next() call when closed while waiting', async () => {
    const queue = createAsyncPushQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const pending = iterator.next();
    queue.close();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it('drains already-queued items before signaling done, even after close', async () => {
    const queue = createAsyncPushQueue<string>();
    queue.push('x');
    queue.close();

    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'x', done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('throws when pushing to an already-closed queue', () => {
    const queue = createAsyncPushQueue<string>();
    queue.close();

    expect(() => queue.push('late')).toThrow('Cannot push to a closed AsyncPushQueue');
  });

  it('close() is idempotent', async () => {
    const queue = createAsyncPushQueue<string>();
    queue.close();
    expect(() => queue.close()).not.toThrow();

    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('supports for-await-of consuming pushed items followed by close', async () => {
    const queue = createAsyncPushQueue<number>();
    const results: number[] = [];

    const consume = (async () => {
      for await (const item of queue) {
        results.push(item);
      }
    })();

    queue.push(1);
    queue.push(2);
    queue.close();

    await consume;
    expect(results).toEqual([1, 2]);
  });
});

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: 'uuid-1',
    session_id: 'session-1',
  } as unknown as SDKMessage;
}

function resultMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'session-1',
  } as unknown as SDKMessage;
}

describe('TurnReader', () => {
  it('resolves the pending turn with accumulated assistant text on result', async () => {
    const reader = new TurnReader();
    const turnPromise = reader.waitForNextTurn();

    reader.handleMessage(assistantText('Hello'));
    reader.handleMessage(assistantText(', world'));
    reader.handleMessage(resultMessage());

    await expect(turnPromise).resolves.toBe('Hello, world');
  });

  it('resolves an empty string when a turn has no assistant text blocks', async () => {
    const reader = new TurnReader();
    const turnPromise = reader.waitForNextTurn();

    reader.handleMessage(resultMessage());

    await expect(turnPromise).resolves.toBe('');
  });

  it('resolves turns in order for consecutive turns', async () => {
    const reader = new TurnReader();
    const firstTurn = reader.waitForNextTurn();

    reader.handleMessage(assistantText('first'));
    reader.handleMessage(resultMessage());

    await expect(firstTurn).resolves.toBe('first');

    const secondTurn = reader.waitForNextTurn();
    reader.handleMessage(assistantText('second'));
    reader.handleMessage(resultMessage());

    await expect(secondTurn).resolves.toBe('second');
  });

  it('does not leak text from a completed turn into the next one', async () => {
    const reader = new TurnReader();
    const firstTurn = reader.waitForNextTurn();
    reader.handleMessage(assistantText('first'));
    reader.handleMessage(resultMessage());
    await firstTurn;

    const secondTurn = reader.waitForNextTurn();
    reader.handleMessage(resultMessage());

    await expect(secondTurn).resolves.toBe('');
  });

  it('ignores a result message with no pending turn instead of throwing', () => {
    const reader = new TurnReader();
    expect(() => reader.handleMessage(resultMessage())).not.toThrow();
  });

  it('failNext rejects the oldest pending turn and returns true', async () => {
    const reader = new TurnReader();
    const turnPromise = reader.waitForNextTurn();

    const rejected = reader.failNext(new Error('boom'));

    expect(rejected).toBe(true);
    await expect(turnPromise).rejects.toThrow('boom');
  });

  it('failNext returns false when there is no pending turn', () => {
    const reader = new TurnReader();
    expect(reader.failNext(new Error('boom'))).toBe(false);
  });

  it('failAll rejects every pending turn', async () => {
    const reader = new TurnReader();
    const first = reader.waitForNextTurn();
    const second = reader.waitForNextTurn();

    reader.failAll(new Error('session ended'));

    await expect(first).rejects.toThrow('session ended');
    await expect(second).rejects.toThrow('session ended');
  });

  it('hasPending reflects whether a turn is awaiting resolution', () => {
    const reader = new TurnReader();
    expect(reader.hasPending()).toBe(false);

    reader.waitForNextTurn();
    expect(reader.hasPending()).toBe(true);

    reader.handleMessage(resultMessage());
    expect(reader.hasPending()).toBe(false);
  });
});
