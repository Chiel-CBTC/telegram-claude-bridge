# Persistent live Claude session per Telegram-chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bot's "spawn a brand-new `claude` process for every Telegram message" pattern with one warm process per chat, reused across a conversation's turns via the Agent SDK's streaming-input mode, closed after 30 minutes of inactivity.

**Architecture:** A new module `src/liveSession.ts` owns a per-chat live session: a push-based async queue feeds `SDKUserMessage`s into a single long-running `query()` call, a background reader loop splits the continuous output stream into per-turn text keyed by `result` messages, and an idle timer closes the queue (and the underlying process) after inactivity. `src/claudeSession.ts` becomes a thin adapter (per-chat serialization + delegation) over `createLiveSessionManager`.

**Tech Stack:** TypeScript (Node.js, ESM/NodeNext), `@anthropic-ai/claude-agent-sdk` (streaming-input mode), vitest (fake timers for idle-timeout tests).

## Global Constraints

- **No new branch, no worktree.** Work happens on the already-checked-out branch
  `docs/persistent-live-session-design`, which already has an open PR (#5) on GitHub. Per Chiel's
  explicit instruction, design + plan + implementation all land as commits on this one branch and
  merge as a single PR at the end — do not branch off again for implementation, and do not open a
  second PR.
- `settingSources: []` must keep exactly its current effect (the `canUseTool` approval gate remains
  the sole authority over tool execution) — it moves from `src/claudeSession.ts` into
  `src/liveSession.ts` unchanged, not altered.
- Relative imports within `src/` use an explicit `.js` extension (NodeNext module resolution), e.g.
  `from './plugins.js'`. Imports in `tests/` use no extension, matching existing files.
- Idle-timeout default is **30 minutes** (`30 * 60 * 1000` ms), overridable via
  `LIVE_SESSION_IDLE_TIMEOUT_MS`, following the exact same pattern as the existing
  `APPROVAL_TIMEOUT_MS`/`approvalTimeoutMs`.
- The idle timer must **not** close a session while a turn is genuinely in flight — if the timer
  fires while `TurnReader.hasPending()` is true, it must reschedule instead of closing (a turn can
  legitimately run long, e.g. waiting on a Telegram approval up to `approvalTimeoutMs`). This is a
  refinement beyond the literal wording of the design doc, added during planning to close a real
  correctness gap (an idle-close mid-turn would otherwise strand the caller's promise) — call this
  out explicitly in task review, it is intentional.
- No `this`-binding in returned factory objects — this codebase's existing style (see
  `createSessionStore`, `createPerKeySerializer`, `createApprovalBroker`) always captures state via
  closures and returns plain object literals whose methods never reference `this`. Follow that
  pattern in `createLiveSessionManager` too (`closeAll` must not call `this.closeSession(...)`).
- Design doc reference for full rationale/measurements: `docs/superpowers/specs/2026-07-17-persistent-live-session-design.md`.

---

### Task 1: `AsyncPushQueue` in `src/liveSession.ts`

**Files:**
- Create: `src/liveSession.ts`
- Create: `tests/liveSession.test.ts`

**Interfaces:**
- Produces: `createAsyncPushQueue<T>(): AsyncPushQueue<T>`, where
  `interface AsyncPushQueue<T> extends AsyncIterable<T> { push(item: T): void; close(): void; }`.
  Exported from the module (required for the test file to import it), even though the design doc
  calls it "internal" — that means "not part of `LiveSessionManager`'s consumer-facing contract,"
  not "not exported from the TS module." Later tasks (`createLiveSessionManager`, in this same file)
  will use it directly via local reference, not via a separate import.

- [ ] **Step 1: Write the failing tests**

Create `tests/liveSession.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/liveSession.test.ts`
Expected: FAIL — `Cannot find module '../src/liveSession'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/liveSession.ts`:

```ts
export interface AsyncPushQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

class AsyncPushQueueImpl<T> implements AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed AsyncPushQueue');
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

export function createAsyncPushQueue<T>(): AsyncPushQueue<T> {
  return new AsyncPushQueueImpl<T>();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/liveSession.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/liveSession.ts tests/liveSession.test.ts
git commit -m "feat: add AsyncPushQueue for streaming SDK input"
```

---

### Task 2: `TurnReader` in `src/liveSession.ts`

**Files:**
- Modify: `src/liveSession.ts` (add to the file created in Task 1)
- Modify: `tests/liveSession.test.ts` (add to the file created in Task 1)

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent unit in the same file).
- Produces: `export class TurnReader` with `waitForNextTurn(): Promise<string>`,
  `handleMessage(message: SDKMessage): void`, `failNext(err: unknown): boolean`,
  `failAll(err: unknown): void`, `hasPending(): boolean`. `SDKMessage` imported as
  `import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/liveSession.test.ts` (new imports at the top, new `describe` block at the bottom):

```ts
import { describe, it, expect } from 'vitest';
import { createAsyncPushQueue, TurnReader } from '../src/liveSession';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ...(existing createAsyncPushQueue describe block stays as-is)...

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/liveSession.test.ts`
Expected: FAIL — `TurnReader` is not exported from `../src/liveSession`.

- [ ] **Step 3: Write the implementation**

Append to `src/liveSession.ts` (add the import at the top of the file, alongside the existing content from Task 1):

```ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

export class TurnReader {
  private readonly pendingTurns: PendingTurn[] = [];
  private currentText = '';

  waitForNextTurn(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingTurns.push({ resolve, reject });
    });
  }

  handleMessage(message: SDKMessage): void {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          this.currentText += block.text;
        }
      }
    }
    if (message.type === 'result') {
      const text = this.currentText;
      this.currentText = '';
      const turn = this.pendingTurns.shift();
      turn?.resolve(text);
    }
  }

  failNext(err: unknown): boolean {
    const turn = this.pendingTurns.shift();
    if (!turn) {
      return false;
    }
    turn.reject(err);
    return true;
  }

  failAll(err: unknown): void {
    while (this.pendingTurns.length > 0) {
      const turn = this.pendingTurns.shift();
      turn?.reject(err);
    }
  }

  hasPending(): boolean {
    return this.pendingTurns.length > 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/liveSession.test.ts`
Expected: PASS (18 tests: 9 from Task 1 + 9 new)

- [ ] **Step 5: Commit**

```bash
git add src/liveSession.ts tests/liveSession.test.ts
git commit -m "feat: add TurnReader to split the live output stream into turns"
```

---

### Task 3: `IdleCloser` in `src/liveSession.ts`

**Files:**
- Modify: `src/liveSession.ts` (add to the file from Tasks 1-2)
- Modify: `tests/liveSession.test.ts` (add to the file from Tasks 1-2)

**Interfaces:**
- Produces: `export class IdleCloser` with constructor `(timeoutMs: number, onIdle: () => void)`,
  methods `touch(): void` (reset/(re)start the timer) and `cancel(): void` (stop it, safe to call
  even if never touched).

- [ ] **Step 1: Write the failing tests**

Append to `tests/liveSession.test.ts` (add `vi`, `beforeEach`, `afterEach` to the existing vitest
import, add `IdleCloser` to the existing `../src/liveSession` import, add this `describe` block):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncPushQueue, TurnReader, IdleCloser } from '../src/liveSession';

// ...(existing describe blocks stay as-is)...

describe('IdleCloser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onIdle after the configured timeout with no further activity', () => {
    const onIdle = vi.fn();
    const closer = new IdleCloser(1000, onIdle);

    closer.touch();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('resets the timer on each touch(), delaying onIdle', () => {
    const onIdle = vi.fn();
    const closer = new IdleCloser(1000, onIdle);

    closer.touch();
    vi.advanceTimersByTime(700);
    closer.touch();
    vi.advanceTimersByTime(700);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not call onIdle after cancel()', () => {
    const onIdle = vi.fn();
    const closer = new IdleCloser(1000, onIdle);

    closer.touch();
    closer.cancel();
    vi.advanceTimersByTime(2000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('cancel() before any touch() is a no-op', () => {
    const onIdle = vi.fn();
    const closer = new IdleCloser(1000, onIdle);

    expect(() => closer.cancel()).not.toThrow();
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('calling touch() again after onIdle already fired schedules a fresh timeout', () => {
    const onIdle = vi.fn();
    const closer = new IdleCloser(1000, onIdle);

    closer.touch();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    closer.touch();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/liveSession.test.ts`
Expected: FAIL — `IdleCloser` is not exported from `../src/liveSession`.

- [ ] **Step 3: Write the implementation**

Append to `src/liveSession.ts`:

```ts
export class IdleCloser {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void
  ) {}

  touch(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onIdle();
    }, this.timeoutMs);
  }

  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/liveSession.test.ts`
Expected: PASS (23 tests: 18 from Tasks 1-2 + 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/liveSession.ts tests/liveSession.test.ts
git commit -m "feat: add IdleCloser for closing an inactive live session"
```

---

### Task 4: `liveSessionIdleTimeoutMs` in `src/config.ts`

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.liveSessionIdleTimeoutMs: number` (new required field on the existing `Config`
  interface).

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`, extend the two existing tests below (do not add new `it()` blocks for
this — follow the file's existing pattern of asserting `approvalTimeoutMs` inside these same two
tests):

Change:
```ts
  it('applies defaults when optional vars are not set', () => {
    const config = loadConfig(validEnv);
    expect(config.workingDir).toBe('/home/chiel');
    expect(config.claudeModel).toBe('claude-sonnet-5');
    expect(config.approvalTimeoutMs).toBe(15 * 60 * 1000);
    expect(config.sessionStorePath).toBe('./data/sessions.json');
  });
```
to:
```ts
  it('applies defaults when optional vars are not set', () => {
    const config = loadConfig(validEnv);
    expect(config.workingDir).toBe('/home/chiel');
    expect(config.claudeModel).toBe('claude-sonnet-5');
    expect(config.approvalTimeoutMs).toBe(15 * 60 * 1000);
    expect(config.sessionStorePath).toBe('./data/sessions.json');
    expect(config.liveSessionIdleTimeoutMs).toBe(30 * 60 * 1000);
  });
```

Change:
```ts
  it('uses provided values when optional vars are set', () => {
    const env = {
      ...validEnv,
      WORKING_DIR: '/home/chiel/git',
      CLAUDE_MODEL: 'claude-opus-4-8',
      APPROVAL_TIMEOUT_MS: '60000',
      SESSION_STORE_PATH: '/data/custom.json',
    };
    const config = loadConfig(env);
    expect(config.workingDir).toBe('/home/chiel/git');
    expect(config.claudeModel).toBe('claude-opus-4-8');
    expect(config.approvalTimeoutMs).toBe(60000);
    expect(config.sessionStorePath).toBe('/data/custom.json');
  });
```
to:
```ts
  it('uses provided values when optional vars are set', () => {
    const env = {
      ...validEnv,
      WORKING_DIR: '/home/chiel/git',
      CLAUDE_MODEL: 'claude-opus-4-8',
      APPROVAL_TIMEOUT_MS: '60000',
      SESSION_STORE_PATH: '/data/custom.json',
      LIVE_SESSION_IDLE_TIMEOUT_MS: '900000',
    };
    const config = loadConfig(env);
    expect(config.workingDir).toBe('/home/chiel/git');
    expect(config.claudeModel).toBe('claude-opus-4-8');
    expect(config.approvalTimeoutMs).toBe(60000);
    expect(config.sessionStorePath).toBe('/data/custom.json');
    expect(config.liveSessionIdleTimeoutMs).toBe(900000);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `config.liveSessionIdleTimeoutMs` is `undefined`, both `toBe(...)` assertions on it
fail.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, add the field to the interface:

```ts
export interface Config {
  telegramBotToken: string;
  allowedTelegramUserId: number;
  anthropicApiKey: string;
  workingDir: string;
  claudeModel: string;
  approvalTimeoutMs: number;
  sessionStorePath: string;
  notionToken?: string;
  excludedPlugins: string[];
  liveSessionIdleTimeoutMs: number;
}
```

Add to the `return { ... }` block in `loadConfig`, after `excludedPlugins: parseExcludedPlugins(env.EXCLUDED_PLUGINS),`:

```ts
    liveSessionIdleTimeoutMs: env.LIVE_SESSION_IDLE_TIMEOUT_MS
      ? Number(env.LIVE_SESSION_IDLE_TIMEOUT_MS)
      : 30 * 60 * 1000,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (all tests, including the two modified ones)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add liveSessionIdleTimeoutMs config field (LIVE_SESSION_IDLE_TIMEOUT_MS)"
```

---

### Task 5: `createLiveSessionManager` in `src/liveSession.ts`

**Files:**
- Modify: `src/liveSession.ts` (add to the file from Tasks 1-3)

**Interfaces:**
- Consumes: `createAsyncPushQueue`, `TurnReader`, `IdleCloser` (all Tasks 1-3, same file, local
  reference — no import needed); `SessionStore` from `./sessionStore.js`; `ApprovalBroker` from
  `./approvals.js`; `decidePermission` from `./permissionDecider.js`; `loadPluginConfigs` from
  `./plugins.js`; `query`, `Query`, `SDKUserMessage`, `McpStdioServerConfig` from
  `@anthropic-ai/claude-agent-sdk`.
- Produces:
  ```ts
  export interface LiveSessionManager {
    sendMessage(chatId: number, userMessage: string): Promise<string>;
    closeSession(chatId: number): void;
    closeAll(): void;
  }

  export interface CreateLiveSessionManagerDeps {
    workingDir: string;
    model: string;
    sessionStore: SessionStore;
    approvalBroker: ApprovalBroker;
    notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
    notionToken?: string;
    excludedPlugins?: string[];
    idleTimeoutMs: number;
  }

  export function createLiveSessionManager(deps: CreateLiveSessionManagerDeps): LiveSessionManager;
  ```

This task has no dedicated unit tests — it wires the primitives from Tasks 1-3 to the real Agent SDK
(spawning a real subprocess), which is exactly the kind of process-orchestration code that today's
`src/claudeSession.ts` already leaves untested (see the design doc's Testen section). Verification
for this task is `npm run build` (tsc) staying clean and the full existing suite (Tasks 1-4's tests)
continuing to pass — real end-to-end verification happens in Task 8 (smoke test) and Task 9.

- [ ] **Step 1: Write the implementation**

Add these imports to the top of `src/liveSession.ts` (merge with the existing `import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';` from Task 2 into one import statement):

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import path from 'node:path';
import type { SessionStore } from './sessionStore.js';
import type { ApprovalBroker } from './approvals.js';
import { decidePermission } from './permissionDecider.js';
import { loadPluginConfigs } from './plugins.js';
```

Append the rest to `src/liveSession.ts`, after the `IdleCloser` class from Task 3:

```ts
export interface LiveSessionManager {
  sendMessage(chatId: number, userMessage: string): Promise<string>;
  closeSession(chatId: number): void;
  closeAll(): void;
}

export interface CreateLiveSessionManagerDeps {
  workingDir: string;
  model: string;
  sessionStore: SessionStore;
  approvalBroker: ApprovalBroker;
  notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
  // Internal integration token from notion.so/my-integrations. When set, the bot
  // gets Notion access via the official stdio MCP server; when unset, Notion tools
  // are simply not offered (no error).
  notionToken?: string;
  // Plugin names (matched against the part before '@' in
  // installed_plugins.json) to exclude from the bot session. Loaded via
  // loadConfig()'s excludedPlugins; defaults to ['caveman'] there.
  excludedPlugins?: string[];
  // How long a live session may sit with no new Telegram message before it is
  // closed and its process torn down. Loaded via loadConfig()'s
  // liveSessionIdleTimeoutMs; defaults to 30 minutes there.
  idleTimeoutMs: number;
}

function buildMcpServers(deps: CreateLiveSessionManagerDeps): Record<string, McpStdioServerConfig> | undefined {
  if (!deps.notionToken) {
    return undefined;
  }
  return {
    notion: {
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_TOKEN: deps.notionToken },
    },
  };
}

function toSDKUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

interface LiveSession {
  queue: AsyncPushQueue<SDKUserMessage>;
  queryHandle: Query;
  reader: TurnReader;
  idleCloser: IdleCloser;
  closed: boolean;
}

export function createLiveSessionManager(deps: CreateLiveSessionManagerDeps): LiveSessionManager {
  const mcpServers = buildMcpServers(deps);
  const excludedPlugins = deps.excludedPlugins ?? [];
  // installed_plugins.json is owned by the plugin marketplace CLI; reading it
  // fresh each time a session starts (not on every message anymore — only at
  // session start, since a live session now spans many messages) means
  // `/plugin update` in a terminal takes effect on the next fresh session
  // (after /reset or an idle-close), not mid-conversation.
  const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const sessions = new Map<number, LiveSession>();

  function teardown(chatId: number, session: LiveSession, err?: unknown): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    session.idleCloser.cancel();
    sessions.delete(chatId);
    if (err !== undefined) {
      session.reader.failAll(err);
    }
  }

  function handleIdle(chatId: number): void {
    const session = sessions.get(chatId);
    if (!session) {
      return;
    }
    if (session.reader.hasPending()) {
      // A turn is genuinely in flight (e.g. waiting on a Telegram approval) —
      // don't close mid-turn, just re-check after another full timeout.
      session.idleCloser.touch();
      return;
    }
    session.queue.close();
  }

  function startSession(chatId: number): LiveSession {
    const plugins = loadPluginConfigs(installedPluginsPath, excludedPlugins);
    const existingSessionId = deps.sessionStore.get(chatId);
    const queue = createAsyncPushQueue<SDKUserMessage>();
    const reader = new TurnReader();

    const queryHandle = query({
      prompt: queue,
      options: {
        cwd: deps.workingDir,
        model: deps.model,
        ...(mcpServers ? { mcpServers } : {}),
        ...(plugins.length > 0 ? { plugins } : {}),
        // Isolate from the host user's own ~/.claude/settings.json (and any
        // project/local settings). Without this, a permissive rule there
        // (e.g. Bash(*) under an "auto" defaultMode) resolves tool calls
        // before canUseTool below is ever consulted, silently bypassing our
        // own risk-based approval gate. canUseTool must be the sole authority.
        settingSources: [],
        // AskUserQuestion is the CLI's interactive clarification tool — the
        // Telegram bot has no UI for it, so a question posed through it just
        // goes unanswered and Claude gives up silently instead of attempting
        // the actual tool call. Disallowing it forces Claude to attempt the
        // real action, which is what routes through canUseTool below and
        // surfaces the Telegram approve/deny buttons.
        disallowedTools: ['AskUserQuestion'],
        ...(existingSessionId ? { resume: existingSessionId } : {}),
        canUseTool: async (toolName, input) => {
          const decision = await decidePermission(toolName, input, {
            workingDir: deps.workingDir,
            approvalBroker: deps.approvalBroker,
            chatId,
            notifyApprovalNeeded: (approval) => deps.notifyApprovalNeeded(chatId, approval),
          });
          if (decision.allow) {
            return { behavior: 'allow' };
          }
          return { behavior: 'deny', message: 'Denied by approval broker.' };
        },
      },
    });

    const session: LiveSession = {
      queue,
      queryHandle,
      reader,
      idleCloser: new IdleCloser(deps.idleTimeoutMs, () => handleIdle(chatId)),
      closed: false,
    };
    sessions.set(chatId, session);
    session.idleCloser.touch();

    void (async () => {
      try {
        for await (const message of queryHandle) {
          if (message.type === 'system' && message.subtype === 'init') {
            deps.sessionStore.set(chatId, message.session_id);
          }
          session.reader.handleMessage(message);
          if (message.type === 'result') {
            session.idleCloser.touch();
          }
        }
        // Stream ended with no thrown error. If we closed it ourselves
        // (idle timeout or closeSession), session.closed is already true and
        // teardown() below is a no-op. If it ended on its own while a turn
        // was still pending, that's an unexpected process exit — fail the
        // pending turn instead of leaving its caller hanging forever.
        teardown(
          chatId,
          session,
          session.reader.hasPending() ? new Error('Live sessie is onverwacht beëindigd.') : undefined
        );
      } catch (err) {
        teardown(chatId, session, err);
      }
    })();

    return session;
  }

  function closeSessionInternal(chatId: number): void {
    const session = sessions.get(chatId);
    if (!session) {
      return;
    }
    if (session.reader.hasPending()) {
      session.reader.failNext(new Error('Sessie is gereset.'));
      void session.queryHandle.interrupt().catch(() => undefined);
    }
    session.queue.close();
    teardown(chatId, session);
  }

  return {
    async sendMessage(chatId: number, userMessage: string): Promise<string> {
      let session = sessions.get(chatId);
      if (!session || session.closed) {
        session = startSession(chatId);
      }
      const turn = session.reader.waitForNextTurn();
      session.queue.push(toSDKUserMessage(userMessage));
      return turn;
    },

    closeSession(chatId: number): void {
      closeSessionInternal(chatId);
    },

    closeAll(): void {
      for (const chatId of [...sessions.keys()]) {
        closeSessionInternal(chatId);
      }
    },
  };
}
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 3: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests from Tasks 1-4 still pass (this task adds no new tests of its own).

- [ ] **Step 4: Commit**

```bash
git add src/liveSession.ts
git commit -m "feat: add createLiveSessionManager wiring queue, reader, idle-close and the SDK"
```

---

### Task 6: Delegate `src/claudeSession.ts` to `createLiveSessionManager`

**Files:**
- Modify: `src/claudeSession.ts` (full rewrite — the one-shot `query()` logic is replaced entirely)

**Interfaces:**
- Consumes: `createLiveSessionManager` from `./liveSession.js` (Task 5).
- Produces: `ClaudeSessionRunner` gains a third method, `closeAll(): void` (needed by Task 7's
  SIGINT/SIGTERM handling). `CreateClaudeSessionRunnerDeps` gains a new required field
  `liveSessionIdleTimeoutMs: number`, replacing nothing (it's additive) but note the old file's
  one-shot-specific logic — `buildMcpServers`, the `query()` call, the plugin-loading-per-message
  call, `decidePermission` wiring — all move into `liveSession.ts` (Task 5) and are removed from
  this file entirely.

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/claudeSession.ts` with:

```ts
import type { SessionStore } from './sessionStore.js';
import type { ApprovalBroker } from './approvals.js';
import { createPerKeySerializer } from './perKeySerializer.js';
import { createLiveSessionManager } from './liveSession.js';

export interface ClaudeSessionRunner {
  sendMessage(chatId: number, userMessage: string): Promise<string>;
  resetSession(chatId: number): void;
  closeAll(): void;
}

export interface CreateClaudeSessionRunnerDeps {
  workingDir: string;
  model: string;
  sessionStore: SessionStore;
  approvalBroker: ApprovalBroker;
  notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
  notionToken?: string;
  excludedPlugins?: string[];
  liveSessionIdleTimeoutMs: number;
}

export function createClaudeSessionRunner(deps: CreateClaudeSessionRunnerDeps): ClaudeSessionRunner {
  const liveSessionManager = createLiveSessionManager({
    workingDir: deps.workingDir,
    model: deps.model,
    sessionStore: deps.sessionStore,
    approvalBroker: deps.approvalBroker,
    notifyApprovalNeeded: deps.notifyApprovalNeeded,
    notionToken: deps.notionToken,
    excludedPlugins: deps.excludedPlugins,
    idleTimeoutMs: deps.liveSessionIdleTimeoutMs,
  });
  // Without this, a second Telegram message arriving while the first is still
  // being processed (e.g. waiting on a slow tool call) would push into the
  // live session's queue and register a second "wait for the next turn"
  // concurrently with the first — breaking the one-pending-turn-at-a-time
  // assumption the turn/result correlation in liveSession.ts relies on.
  // Serializing per chatId makes the second message wait instead.
  const messageQueue = createPerKeySerializer<number>();

  return {
    sendMessage(chatId: number, userMessage: string): Promise<string> {
      return messageQueue.run(chatId, () => liveSessionManager.sendMessage(chatId, userMessage));
    },

    resetSession(chatId: number): void {
      liveSessionManager.closeSession(chatId);
      deps.sessionStore.reset(chatId);
    },

    closeAll(): void {
      liveSessionManager.closeAll();
    },
  };
}
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: no TypeScript errors. If `src/index.ts` now shows an error about a missing
`liveSessionIdleTimeoutMs` property in the object passed to `createClaudeSessionRunner`, that's
expected and fixed by Task 7 — do not fix `index.ts` in this task.

- [ ] **Step 3: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests from Tasks 1-4 still pass (this file has no dedicated unit tests of its own,
matching its state before this change — it's a thin adapter over `liveSession.ts`, verified via
build + the smoke test in Task 8 + manual Telegram use).

- [ ] **Step 4: Commit**

```bash
git add src/claudeSession.ts
git commit -m "refactor: delegate claudeSession.ts to the live session manager"
```

---

### Task 7: Wire `liveSessionIdleTimeoutMs` and graceful shutdown in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Config.liveSessionIdleTimeoutMs` (Task 4); `ClaudeSessionRunner.closeAll()` (Task 6).

- [ ] **Step 1: Pass `liveSessionIdleTimeoutMs` to `createClaudeSessionRunner`**

In `src/index.ts`, change:

```ts
const claudeSessionRunner = createClaudeSessionRunner({
  workingDir: config.workingDir,
  model: config.claudeModel,
  sessionStore,
  approvalBroker,
  notifyApprovalNeeded: (chatId, approval) => {
    notifyApprovalNeeded(bot, chatId, approval);
  },
  notionToken: config.notionToken,
  excludedPlugins: config.excludedPlugins,
});
```

to:

```ts
const claudeSessionRunner = createClaudeSessionRunner({
  workingDir: config.workingDir,
  model: config.claudeModel,
  sessionStore,
  approvalBroker,
  notifyApprovalNeeded: (chatId, approval) => {
    notifyApprovalNeeded(bot, chatId, approval);
  },
  notionToken: config.notionToken,
  excludedPlugins: config.excludedPlugins,
  liveSessionIdleTimeoutMs: config.liveSessionIdleTimeoutMs,
});
```

- [ ] **Step 2: Close live sessions gracefully on shutdown**

Change:

```ts
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

to:

```ts
process.once('SIGINT', () => {
  claudeSessionRunner.closeAll();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  claudeSessionRunner.closeAll();
  bot.stop('SIGTERM');
});
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: no TypeScript errors (the error noted at the end of Task 6, if any, is now resolved).

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests pass (`src/index.ts` has no dedicated test file, matching its state before this
change).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire liveSessionIdleTimeoutMs and close live sessions on shutdown"
```

---

### Task 8: Extend the smoke test with a two-message latency comparison

**Files:**
- Modify: `scripts/smoke-test-claude-session.ts`

**Interfaces:**
- Consumes: `ClaudeSessionRunner.closeAll()` (Task 6) — required so the script can exit promptly
  instead of hanging on the now-persistent live process and its 30-minute idle timer.

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `scripts/smoke-test-claude-session.ts` with:

```ts
import 'dotenv/config';
import { createSessionStore } from '../src/sessionStore.js';
import { createApprovalBroker } from '../src/approvals.js';
import { createClaudeSessionRunner } from '../src/claudeSession.js';

const workingDir = process.env.WORKING_DIR ?? '/home/chiel';
const model = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5';

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Set ANTHROPIC_API_KEY before running this smoke test.');
}

const sessionStore = createSessionStore('./data/smoke-test-sessions.json');
const approvalBroker = createApprovalBroker({ timeoutMs: 60_000 });

const runner = createClaudeSessionRunner({
  workingDir,
  model,
  sessionStore,
  approvalBroker,
  notifyApprovalNeeded: (chatId, approval) => {
    console.log(`[approval requested] chat ${chatId}: ${approval.description}`);
  },
  liveSessionIdleTimeoutMs: 30 * 60 * 1000,
});

const chatId = 999;

const start1 = Date.now();
const reply1 = await runner.sendMessage(chatId, 'Say "hello from the smoke test" and nothing else.');
console.log(`Claude replied (${Date.now() - start1}ms):`, reply1);

const start2 = Date.now();
const reply2 = await runner.sendMessage(chatId, 'Now say "second message" and nothing else.');
console.log(`Claude replied (${Date.now() - start2}ms):`, reply2);

console.log(
  'Expect the second message to be noticeably faster than the first ' +
    '(warm live session, no new process/MCP-server spawn).'
);

runner.closeAll();
process.exit(0);
```

- [ ] **Step 2: Run it manually and inspect the timings**

Run: `npx tsx scripts/smoke-test-claude-session.ts`
Expected: two `Claude replied (...)` lines print, the second with a visibly smaller millisecond
count than the first (confirms the live session is warm-reused rather than respawned). This step is
a manual sanity check, not part of `npm test` — record the two timings in the task report.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-test-claude-session.ts
git commit -m "test: extend smoke test with a two-message live-session latency check"
```

---

### Task 9: Final verification and PR update

**Files:** no source changes — verification and PR bookkeeping only.

- [ ] **Step 1: Full test suite and build**

Run: `npm test`
Expected: all tests pass (Tasks 1-4's new/modified tests, plus the full pre-existing suite
untouched).

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 2: Push and update PR #5's checklist**

```bash
git push
gh pr edit 5 --body "$(cat <<'BODY'
## Summary
- Reduces bot response latency: today every Telegram message spawns a brand-new `claude` subprocess + Notion MCP subprocess (~2.2s pure npx overhead) + re-reads plugins/skills from disk. This keeps one warm process per chat alive across a conversation's turns (SDK's streaming-input mode), closed after 30 min of inactivity.
- Also informed by a measured memory cost (~460MB per live session), which is why the idle-timeout is 30 min rather than "keep forever" - this host is already under memory pressure (~5.4GiB swap used).

## Contents (single PR for the whole feature)
- [x] Design: docs/superpowers/specs/2026-07-17-persistent-live-session-design.md
- [x] Implementation plan: docs/superpowers/plans/2026-07-17-persistent-live-session.md
- [x] Implementation: src/liveSession.ts, changes to src/claudeSession.ts, src/config.ts, src/index.ts, scripts/smoke-test-claude-session.ts

## Test plan
- [x] npm test passing
- [x] npm run build clean
- [ ] Manual: two consecutive Telegram messages in the same chat, confirm the second is noticeably faster than the first
- [ ] Manual: /reset mid-conversation, confirm a fresh session starts cleanly
- [ ] Manual: leave a chat idle past 30 min, confirm the next message still works (cold start via resume)

Generated with Claude Code
BODY
)"
```

Note: use `gh api repos/Chiel-CBTC/telegram-claude-bridge/pulls/5 -X PATCH -f body="..."` instead of
`gh pr edit` if the latter fails with a `Projects (classic)` GraphQL error (observed earlier in this
repo — a `gh`-CLI-side issue unrelated to the edit itself).

- [ ] **Step 3: Hand off manual verification**

The following can only be verified by Chiel, against the real deployed bot, and are listed on PR
#5's checklist above — not part of this task's automated steps:

1. Deploy: `docker compose up -d --build`.
2. Send two messages in quick succession in the same Telegram chat; confirm the second reply comes
   back noticeably faster than the first (mirrors Task 8's smoke-test scenario, but through the real
   bot).
3. Send `/reset` mid-conversation; confirm the next message starts a clean new conversation (no
   leftover context from before the reset).
4. Leave the chat idle for more than 30 minutes, then send a message; confirm it still works (pays
   the cold-start cost once, then resumes the prior conversation via `resume`).
5. `docker compose logs -f` — confirm no unexpected errors, and that the container does not appear
   to be holding an ever-growing number of child processes over time (`docker exec
   telegram-claude-bridge ps aux` — should show at most one live `claude`/MCP-server process tree at
   a time per active chat, not an accumulating pile).

Only merge PR #5 once these manual checks pass.
