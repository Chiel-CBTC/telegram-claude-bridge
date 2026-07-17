import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CreateLiveSessionManagerDeps } from '../src/liveSession';

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Import AFTER the mock is set up so createLiveSessionManager picks up the
// mocked `query`.
const { createLiveSessionManager } = await import('../src/liveSession');

function initMessage(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function resultMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'session-1',
  } as unknown as SDKMessage;
}

// Build a fake Query-shaped object: an async generator that yields the given
// messages then blocks forever (never ends), simulating "the query process is
// alive but has no more output". Blocking (rather than returning) keeps the
// reader loop's `for await` suspended, so the session is NOT torn down by the
// stream ending — it can only be closed by the idle timer, which is exactly the
// code path under test. Also exposes interrupt() to mirror the real Query shape.
function makeFakeQuery(messages: SDKMessage[]): Query {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const message of messages) {
      yield message;
    }
    await new Promise<void>(() => {
      /* never resolves — keep the stream open */
    });
  }
  const handle = gen() as unknown as { interrupt: () => Promise<void> };
  handle.interrupt = () => Promise.resolve();
  return handle as unknown as Query;
}

function makeDeps(): CreateLiveSessionManagerDeps {
  return {
    workingDir: '/tmp/live-session-test',
    model: 'claude-test',
    sessionStore: {
      get: () => undefined,
      set: () => undefined,
      reset: () => undefined,
    },
    approvalBroker: {
      request: () => ({ id: 'approval-1', promise: Promise.resolve(true) }),
      resolve: () => true,
    },
    notifyApprovalNeeded: () => undefined,
    idleTimeoutMs: 1000,
  };
}

describe('createLiveSessionManager idle-close lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a fresh session when a message arrives after the idle timer fired, instead of throwing', async () => {
    // First query completes turn 1 (init + result) then blocks, keeping the
    // session alive and idle-timer-armed after the turn resolves.
    mockQuery.mockImplementationOnce(() =>
      makeFakeQuery([initMessage('session-1'), resultMessage()])
    );

    const manager = createLiveSessionManager(makeDeps());

    // Turn 1: send a message and await its reply.
    const reply = await manager.sendMessage(1, 'hello');
    expect(reply).toBe('');
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Idle timer fires. Before Fix 1 this only closed the queue, leaving the
    // session in the map with closed === false; with Fix 1 it routes through
    // teardown, removing the session synchronously with the queue close.
    vi.advanceTimersByTime(1001);
    await Promise.resolve();

    // Second query for the fresh session that the next message should start.
    mockQuery.mockImplementationOnce(() =>
      makeFakeQuery([initMessage('session-2')])
    );

    // Turn 2: a message arriving now must NOT push into the stale closed queue
    // (which threw 'Cannot push to a closed AsyncPushQueue' before Fix 1). It
    // must start a fresh session — i.e. call query a second time.
    let rejected: unknown;
    manager.sendMessage(1, 'second message').catch((err) => {
      rejected = err;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(rejected).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
