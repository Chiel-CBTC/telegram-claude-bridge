import { describe, it, expect, vi } from 'vitest';
import { createPerKeySerializer } from '../src/perKeySerializer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPerKeySerializer', () => {
  it('resolves with the value returned by the wrapped function', async () => {
    const serializer = createPerKeySerializer<number>();
    const result = await serializer.run(1, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('runs calls for the same key sequentially, in call order', async () => {
    const serializer = createPerKeySerializer<number>();
    const order: string[] = [];
    const first = deferred<void>();

    const call1 = serializer.run(1, async () => {
      order.push('start-1');
      await first.promise;
      order.push('end-1');
      return 'one';
    });

    const call2 = serializer.run(1, async () => {
      order.push('start-2');
      return 'two';
    });

    // call2's work must not start until call1 finishes, even though call1 is
    // still pending on `first`.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['start-1']);

    first.resolve();
    expect(await call1).toBe('one');
    expect(await call2).toBe('two');
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('runs calls for different keys concurrently', async () => {
    const serializer = createPerKeySerializer<number>();
    const order: string[] = [];
    const first = deferred<void>();

    const call1 = serializer.run(1, async () => {
      order.push('start-1');
      await first.promise;
      order.push('end-1');
      return 'one';
    });

    const call2 = serializer.run(2, async () => {
      order.push('start-2');
      return 'two';
    });

    expect(await call2).toBe('two');
    expect(order).toEqual(['start-1', 'start-2']);

    first.resolve();
    expect(await call1).toBe('one');
  });

  it('a rejected call does not block later calls for the same key', async () => {
    const serializer = createPerKeySerializer<number>();

    await expect(
      serializer.run(1, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const result = await serializer.run(1, async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('propagates the correct result to each caller when interleaved', async () => {
    const serializer = createPerKeySerializer<string>();
    const fn = vi.fn(async (value: string) => value.toUpperCase());

    const [a, b, c] = await Promise.all([
      serializer.run('chat-1', () => fn('a')),
      serializer.run('chat-1', () => fn('b')),
      serializer.run('chat-1', () => fn('c')),
    ]);

    expect([a, b, c]).toEqual(['A', 'B', 'C']);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
