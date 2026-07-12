import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApprovalBroker } from '../src/approvals';

describe('createApprovalBroker', () => {
  it('resolves the promise with true when approved', async () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id, promise } = broker.request(1, 'run rm -rf /tmp/x');

    const resolved = broker.resolve(id, true);
    expect(resolved).toBe(true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves the promise with false when denied', async () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id, promise } = broker.request(1, 'run rm -rf /tmp/x');

    broker.resolve(id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('returns false and does nothing for an unknown approval id', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const resolved = broker.resolve('does-not-exist', true);
    expect(resolved).toBe(false);
  });

  it('ignores a second resolve call for the same approval id', async () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id, promise } = broker.request(1, 'run rm -rf /tmp/x');

    broker.resolve(id, true);
    const secondResolve = broker.resolve(id, false);

    expect(secondResolve).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it('generates a different id for each request', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const first = broker.request(1, 'action a');
    const second = broker.request(1, 'action b');
    expect(first.id).not.toBe(second.id);
  });
});

describe('createApprovalBroker — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-denies and calls onTimeout when the timeout elapses', async () => {
    const onTimeout = vi.fn();
    const broker = createApprovalBroker({ timeoutMs: 1000, onTimeout });
    const { id, promise } = broker.request(42, 'run sudo apt update');

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toBe(false);
    expect(onTimeout).toHaveBeenCalledWith(id, 42, 'run sudo apt update');
  });

  it('does not call onTimeout if already resolved before the timeout', async () => {
    const onTimeout = vi.fn();
    const broker = createApprovalBroker({ timeoutMs: 1000, onTimeout });
    const { id, promise } = broker.request(42, 'run sudo apt update');

    broker.resolve(id, true);
    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
