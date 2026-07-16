export interface PerKeySerializer<K> {
  run<T>(key: K, fn: () => Promise<T>): Promise<T>;
}

export function createPerKeySerializer<K>(): PerKeySerializer<K> {
  const queues = new Map<K, Promise<unknown>>();

  return {
    run<T>(key: K, fn: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      // Chain future calls off a version that never rejects, so one caller's
      // failure doesn't poison the queue for the next caller on the same key.
      queues.set(
        key,
        next.catch(() => undefined)
      );
      return next;
    },
  };
}
