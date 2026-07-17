import { describe, it, expect } from 'vitest';
import { createAsyncPushQueue } from '../src/liveSession';

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
