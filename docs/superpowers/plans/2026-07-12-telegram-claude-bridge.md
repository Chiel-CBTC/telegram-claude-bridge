# Telegram ↔ Claude Code Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram bot, running in its own Docker container on this server, that lets Chiel hold a doorlopende conversation with a Claude agent (via the Claude Agent SDK) — with risky actions (git push, rm -rf, sudo, force ops, writes outside the working directory) gated behind an approve/deny prompt sent back through Telegram.

**Architecture:** A Node.js/TypeScript service with two layers: a Telegram layer (`telegraf`, long polling) and a Claude layer (`@anthropic-ai/claude-agent-sdk`'s `query()`). One Claude session per Telegram chat, resumed across messages via the SDK's `resume` option and persisted to a local JSON file. A `canUseTool` hook classifies every tool call as `auto` or `confirm`; `confirm` calls pause the agent and round-trip through a Telegram inline-keyboard approval before continuing.

**Tech Stack:** Node.js 20, TypeScript (strict, ESM/NodeNext), `telegraf` (Telegram Bot API), `@anthropic-ai/claude-agent-sdk`, `vitest` (unit tests), Docker + Docker Compose.

## Global Constraints

- Working directory for the agent: `/home/chiel` (spec default; configurable via `WORKING_DIR`).
- Only the Telegram user ID in `ALLOWED_TELEGRAM_USER_ID` may interact with the bot; every other sender is silently ignored.
- Approval timeout: 15 minutes (`900000` ms), auto-deny on expiry, with a Telegram notification.
- Automatically allowed: reading/editing/creating files inside the working directory, running tests/builds/read-only bash, local git commits.
- Requires confirmation: `git push`, `git reset --hard`, `git clean -f*`, `git checkout -- <path>`, `rm -rf`/`rm -fr` (any flag order), `sudo`, and any file write outside the working directory.
- `.env` (real secrets) is never committed; `.env.example` documents the required variables.
- No automated tests for the Telegram/Agent-SDK integration layer itself (per the approved design spec) — verified manually. Pure logic (config, risk classification, message chunking, session store, approval broker, permission decider) is unit-tested with `vitest`.
- Project uses ESM with `"type": "module"` and `moduleResolution: "NodeNext"` — **relative imports between `src/*.ts` files must use a `.js` extension** (e.g. `from './riskRules.js'`), even though the source file is `.ts`. This is correct and required by NodeNext, not a typo to "fix".
- Design spec: `docs/superpowers/specs/2026-07-12-telegram-claude-bridge-design.md`.

---

### Task 1: Project scaffolding + config loader

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config`, where
  ```ts
  interface Config {
    telegramBotToken: string;
    allowedTelegramUserId: number;
    anthropicApiKey: string;
    workingDir: string;
    claudeModel: string;
    approvalTimeoutMs: number;
    sessionStorePath: string;
  }
  ```

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "telegram-claude-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "dotenv": "^16.4.0",
    "telegraf": "^4.16.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
.env
*.log
```

- [ ] **Step 5: Create `.env.example`**

```
# Verkrijg via @BotFather in Telegram (zie README.md)
TELEGRAM_BOT_TOKEN=

# Jouw eigen Telegram user-ID (bv. via @userinfobot), zodat alleen jij de bot kunt gebruiken
ALLOWED_TELEGRAM_USER_ID=

# Anthropic API key voor de Claude Agent SDK
ANTHROPIC_API_KEY=

# Optioneel — standaardwaarden hieronder
# WORKING_DIR=/home/chiel
# CLAUDE_MODEL=claude-sonnet-5
# APPROVAL_TIMEOUT_MS=900000
# SESSION_STORE_PATH=./data/sessions.json
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` and `package-lock.json` are created, no errors.

- [ ] **Step 7: Write the failing test for `loadConfig`**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const validEnv = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  ALLOWED_TELEGRAM_USER_ID: '123456',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

describe('loadConfig', () => {
  it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
    const env = { ...validEnv, TELEGRAM_BOT_TOKEN: '' };
    expect(() => loadConfig(env)).toThrow('TELEGRAM_BOT_TOKEN');
  });

  it('throws when ALLOWED_TELEGRAM_USER_ID is missing', () => {
    const env = { ...validEnv, ALLOWED_TELEGRAM_USER_ID: '' };
    expect(() => loadConfig(env)).toThrow('ALLOWED_TELEGRAM_USER_ID');
  });

  it('throws when ALLOWED_TELEGRAM_USER_ID is not an integer', () => {
    const env = { ...validEnv, ALLOWED_TELEGRAM_USER_ID: 'not-a-number' };
    expect(() => loadConfig(env)).toThrow('integer');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    const env = { ...validEnv, ANTHROPIC_API_KEY: '' };
    expect(() => loadConfig(env)).toThrow('ANTHROPIC_API_KEY');
  });

  it('applies defaults when optional vars are not set', () => {
    const config = loadConfig(validEnv);
    expect(config.workingDir).toBe('/home/chiel');
    expect(config.claudeModel).toBe('claude-sonnet-5');
    expect(config.approvalTimeoutMs).toBe(15 * 60 * 1000);
    expect(config.sessionStorePath).toBe('./data/sessions.json');
  });

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

  it('returns parsed allowedTelegramUserId as a number', () => {
    const config = loadConfig(validEnv);
    expect(config.allowedTelegramUserId).toBe(123456);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config'`

- [ ] **Step 9: Implement `src/config.ts`**

```ts
import 'dotenv/config';

export interface Config {
  telegramBotToken: string;
  allowedTelegramUserId: number;
  anthropicApiKey: string;
  workingDir: string;
  claudeModel: string;
  approvalTimeoutMs: number;
  sessionStorePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken || telegramBotToken.trim() === '') {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_TOKEN');
  }

  const allowedUserIdRaw = env.ALLOWED_TELEGRAM_USER_ID;
  if (!allowedUserIdRaw || allowedUserIdRaw.trim() === '') {
    throw new Error('Missing required environment variable: ALLOWED_TELEGRAM_USER_ID');
  }
  const allowedTelegramUserId = Number(allowedUserIdRaw);
  if (!Number.isInteger(allowedTelegramUserId)) {
    throw new Error('ALLOWED_TELEGRAM_USER_ID must be an integer');
  }

  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey || anthropicApiKey.trim() === '') {
    throw new Error('Missing required environment variable: ANTHROPIC_API_KEY');
  }

  return {
    telegramBotToken,
    allowedTelegramUserId,
    anthropicApiKey,
    workingDir: env.WORKING_DIR?.trim() || '/home/chiel',
    claudeModel: env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5',
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS ? Number(env.APPROVAL_TIMEOUT_MS) : 15 * 60 * 1000,
    sessionStorePath: env.SESSION_STORE_PATH?.trim() || './data/sessions.json',
  };
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — 7 tests passing

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts tests/config.test.ts
git commit -m "feat: project scaffolding and config loader"
```

---

### Task 2: Risk classification

**Files:**
- Create: `src/riskRules.ts`
- Test: `tests/riskRules.test.ts`

**Interfaces:**
- Produces: `classifyToolUse(toolName: string, input: Record<string, unknown>, workingDir: string): 'auto' | 'confirm'`

- [ ] **Step 1: Write the failing tests**

Create `tests/riskRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyToolUse } from '../src/riskRules';

const WORKING_DIR = '/home/chiel';

describe('classifyToolUse — Bash commands', () => {
  const cases: Array<[string, 'auto' | 'confirm']> = [
    ['git push origin main', 'confirm'],
    ['git push', 'confirm'],
    ['git reset --hard HEAD~1', 'confirm'],
    ['git clean -fd', 'confirm'],
    ['git checkout -- src/index.ts', 'confirm'],
    ['rm -rf /tmp/build', 'confirm'],
    ['rm -fr node_modules', 'confirm'],
    ['sudo apt update', 'confirm'],
    ['ls -la', 'auto'],
    ['npm test', 'auto'],
    ['git status', 'auto'],
    ['git commit -m "fix"', 'auto'],
    ['rm build.log', 'auto'],
  ];

  for (const [command, expected] of cases) {
    it(`classifies "${command}" as ${expected}`, () => {
      const result = classifyToolUse('Bash', { command }, WORKING_DIR);
      expect(result).toBe(expected);
    });
  }
});

describe('classifyToolUse — file writes', () => {
  it('allows writing inside the working directory', () => {
    const result = classifyToolUse('Write', { file_path: '/home/chiel/git/foo/bar.ts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });

  it('requires confirmation for writes outside the working directory', () => {
    const result = classifyToolUse('Write', { file_path: '/etc/passwd' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });

  it('requires confirmation for path-traversal writes that escape the working directory', () => {
    const result = classifyToolUse(
      'Write',
      { file_path: '/home/chiel/../root/.ssh/authorized_keys' },
      WORKING_DIR
    );
    expect(result).toBe('confirm');
  });

  it('does not false-positive on a sibling directory sharing a prefix', () => {
    const result = classifyToolUse('Write', { file_path: '/home/chiel2/evil.ts' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });

  it('applies the same rule to Edit', () => {
    const result = classifyToolUse('Edit', { file_path: '/etc/hosts' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });
});

describe('classifyToolUse — other tools', () => {
  it('allows Read regardless of path (not covered by the write rule)', () => {
    const result = classifyToolUse('Read', { file_path: '/etc/hosts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });

  it('allows tools with no special classification by default', () => {
    const result = classifyToolUse('Glob', { pattern: '**/*.ts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/riskRules.test.ts`
Expected: FAIL — `Cannot find module '../src/riskRules'`

- [ ] **Step 3: Implement `src/riskRules.ts`**

```ts
import path from 'node:path';

export type RiskDecision = 'auto' | 'confirm';

const CONFIRM_BASH_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\brm\s+[^\n]*-[a-z]*r[a-z]*f\b/i,
  /\brm\s+[^\n]*-[a-z]*f[a-z]*r\b/i,
  /\bsudo\b/i,
];

function classifyBashCommand(command: string): RiskDecision {
  return CONFIRM_BASH_PATTERNS.some((pattern) => pattern.test(command)) ? 'confirm' : 'auto';
}

function isOutsideWorkingDir(filePath: string, workingDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkingDir = path.resolve(workingDir);
  const relative = path.relative(resolvedWorkingDir, resolvedPath);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit']);

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string
): RiskDecision {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return classifyBashCommand(command);
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (filePath && isOutsideWorkingDir(filePath, workingDir)) {
      return 'confirm';
    }
    return 'auto';
  }

  return 'auto';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/riskRules.test.ts`
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/riskRules.ts tests/riskRules.test.ts
git commit -m "feat: risk classification for tool calls"
```

---

### Task 3: Telegram message chunking

**Files:**
- Create: `src/telegramFormat.ts`
- Test: `tests/telegramFormat.test.ts`

**Interfaces:**
- Produces: `splitTelegramMessage(text: string, maxLength?: number): string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/telegramFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitTelegramMessage } from '../src/telegramFormat';

describe('splitTelegramMessage', () => {
  it('returns an empty array for empty input', () => {
    expect(splitTelegramMessage('')).toEqual([]);
  });

  it('returns a single chunk for text under the limit', () => {
    const text = 'Hello, world!';
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it('returns a single chunk for text exactly at the limit', () => {
    const text = 'a'.repeat(4096);
    const result = splitTelegramMessage(text);
    expect(result).toEqual([text]);
  });

  it('splits text over the limit into multiple chunks', () => {
    const text = 'a'.repeat(9000);
    const result = splitTelegramMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('')).toBe(text);
  });

  it('never returns a chunk longer than maxLength', () => {
    const text = 'a'.repeat(9000);
    const result = splitTelegramMessage(text);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('prefers splitting on a newline boundary when one is available', () => {
    const line = 'x'.repeat(100);
    const text = Array(50).fill(line).join('\n');
    const result = splitTelegramMessage(text, 500);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    for (const chunk of result.slice(0, -1)) {
      expect(chunk.endsWith(line)).toBe(true);
    }
  });

  it('respects a custom maxLength', () => {
    const text = 'a'.repeat(30);
    const result = splitTelegramMessage(text, 10);
    expect(result).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaaaaaaa']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/telegramFormat.test.ts`
Expected: FAIL — `Cannot find module '../src/telegramFormat'`

- [ ] **Step 3: Implement `src/telegramFormat.ts`**

```ts
const TELEGRAM_MAX_LENGTH = 4096;

export function splitTelegramMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length === 0) {
    return [];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/telegramFormat.test.ts`
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/telegramFormat.ts tests/telegramFormat.test.ts
git commit -m "feat: Telegram message chunking"
```

---

### Task 4: Session store

**Files:**
- Create: `src/sessionStore.ts`
- Test: `tests/sessionStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SessionStore {
    get(chatId: number): string | undefined;
    set(chatId: number, sessionId: string): void;
    reset(chatId: number): void;
  }
  function createSessionStore(filePath: string): SessionStore;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/sessionStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../src/sessionStore';

let testFilePath: string;

beforeEach(() => {
  testFilePath = path.join(
    os.tmpdir(),
    `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
});

afterEach(() => {
  if (fs.existsSync(testFilePath)) {
    fs.unlinkSync(testFilePath);
  }
});

describe('createSessionStore', () => {
  it('returns undefined for a chat with no stored session', () => {
    const store = createSessionStore(testFilePath);
    expect(store.get(123)).toBeUndefined();
  });

  it('returns the session id after set', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');
    expect(store.get(123)).toBe('session-abc');
  });

  it('persists to disk so a new store instance can read it back', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');

    const secondStore = createSessionStore(testFilePath);
    expect(secondStore.get(123)).toBe('session-abc');
  });

  it('creates the containing directory if it does not exist yet', () => {
    const nestedPath = path.join(os.tmpdir(), `session-store-nested-${Date.now()}`, 'sessions.json');
    const store = createSessionStore(nestedPath);
    store.set(1, 'abc');
    expect(fs.existsSync(nestedPath)).toBe(true);
    fs.rmSync(path.dirname(nestedPath), { recursive: true, force: true });
  });

  it('removes the mapping on reset', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');
    store.reset(123);
    expect(store.get(123)).toBeUndefined();
  });

  it('keeps separate mappings for different chat ids', () => {
    const store = createSessionStore(testFilePath);
    store.set(1, 'session-one');
    store.set(2, 'session-two');
    expect(store.get(1)).toBe('session-one');
    expect(store.get(2)).toBe('session-two');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sessionStore.test.ts`
Expected: FAIL — `Cannot find module '../src/sessionStore'`

- [ ] **Step 3: Implement `src/sessionStore.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface SessionStore {
  get(chatId: number): string | undefined;
  set(chatId: number, sessionId: string): void;
  reset(chatId: number): void;
}

interface SessionStoreData {
  [chatId: string]: string;
}

function loadFromDisk(filePath: string): SessionStoreData {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (raw.trim() === '') {
    return {};
  }
  return JSON.parse(raw) as SessionStoreData;
}

export function createSessionStore(filePath: string): SessionStore {
  const data: SessionStoreData = loadFromDisk(filePath);

  function persist(): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return {
    get(chatId: number): string | undefined {
      return data[String(chatId)];
    },
    set(chatId: number, sessionId: string): void {
      data[String(chatId)] = sessionId;
      persist();
    },
    reset(chatId: number): void {
      delete data[String(chatId)];
      persist();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sessionStore.test.ts`
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts tests/sessionStore.test.ts
git commit -m "feat: per-chat session id store"
```

---

### Task 5: Approval broker

**Files:**
- Create: `src/approvals.ts`
- Test: `tests/approvals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ApprovalRequest {
    id: string;
    promise: Promise<boolean>;
  }
  interface ApprovalBroker {
    request(chatId: number, description: string): ApprovalRequest;
    resolve(approvalId: string, approved: boolean): boolean;
  }
  interface CreateApprovalBrokerOptions {
    timeoutMs: number;
    onTimeout?: (approvalId: string, chatId: number, description: string) => void;
  }
  function createApprovalBroker(options: CreateApprovalBrokerOptions): ApprovalBroker;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/approvals.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/approvals.test.ts`
Expected: FAIL — `Cannot find module '../src/approvals'`

- [ ] **Step 3: Implement `src/approvals.ts`**

```ts
import crypto from 'node:crypto';

export interface ApprovalRequest {
  id: string;
  promise: Promise<boolean>;
}

export interface ApprovalBroker {
  request(chatId: number, description: string): ApprovalRequest;
  resolve(approvalId: string, approved: boolean): boolean;
}

interface PendingApproval {
  chatId: number;
  description: string;
  resolveFn: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface CreateApprovalBrokerOptions {
  timeoutMs: number;
  onTimeout?: (approvalId: string, chatId: number, description: string) => void;
}

export function createApprovalBroker(options: CreateApprovalBrokerOptions): ApprovalBroker {
  const pending = new Map<string, PendingApproval>();

  return {
    request(chatId: number, description: string): ApprovalRequest {
      const id = crypto.randomUUID();

      const promise = new Promise<boolean>((resolvePromise) => {
        const timeoutHandle = setTimeout(() => {
          const entry = pending.get(id);
          if (!entry) {
            return;
          }
          pending.delete(id);
          resolvePromise(false);
          options.onTimeout?.(id, chatId, entry.description);
        }, options.timeoutMs);

        pending.set(id, {
          chatId,
          description,
          resolveFn: resolvePromise,
          timeoutHandle,
        });
      });

      return { id, promise };
    },

    resolve(approvalId: string, approved: boolean): boolean {
      const entry = pending.get(approvalId);
      if (!entry) {
        return false;
      }
      pending.delete(approvalId);
      clearTimeout(entry.timeoutHandle);
      entry.resolveFn(approved);
      return true;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/approvals.test.ts`
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/approvals.ts tests/approvals.test.ts
git commit -m "feat: approval broker with timeout"
```

---

### Task 6: Permission decider

**Files:**
- Create: `src/permissionDecider.ts`
- Test: `tests/permissionDecider.test.ts`

**Interfaces:**
- Consumes: `classifyToolUse` from Task 2 (`src/riskRules.js`); `ApprovalBroker` from Task 5 (`src/approvals.js`)
- Produces:
  ```ts
  interface PermissionDecision {
    allow: boolean;
  }
  interface DecidePermissionDeps {
    workingDir: string;
    approvalBroker: ApprovalBroker;
    chatId: number;
    notifyApprovalNeeded: (approval: { id: string; description: string }) => void;
  }
  function describeToolUse(toolName: string, input: Record<string, unknown>): string;
  function decidePermission(
    toolName: string,
    input: Record<string, unknown>,
    deps: DecidePermissionDeps
  ): Promise<PermissionDecision>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/permissionDecider.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { decidePermission, describeToolUse } from '../src/permissionDecider';
import type { ApprovalBroker } from '../src/approvals';

const WORKING_DIR = '/home/chiel';

function fakeApprovalBroker(result: boolean): ApprovalBroker {
  return {
    request: vi.fn((_chatId: number, _description: string) => ({
      id: 'fake-id',
      promise: Promise.resolve(result),
    })),
    resolve: vi.fn(() => true),
  };
}

describe('describeToolUse', () => {
  it('describes a Bash tool call with its command', () => {
    expect(describeToolUse('Bash', { command: 'git push' })).toBe('Bash: git push');
  });

  it('describes a Write tool call with its file path', () => {
    expect(describeToolUse('Write', { file_path: '/etc/hosts' })).toBe('Write: /etc/hosts');
  });

  it('falls back to a JSON dump for unrecognized shapes', () => {
    expect(describeToolUse('Glob', { pattern: '**/*.ts' })).toBe('Glob: {"pattern":"**/*.ts"}');
  });
});

describe('decidePermission', () => {
  it('allows auto-classified tool calls without asking for approval', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'npm test' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: true });
    expect(approvalBroker.request).not.toHaveBeenCalled();
    expect(notifyApprovalNeeded).not.toHaveBeenCalled();
  });

  it('requests approval for a risky Bash command and allows it when approved', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'git push origin main' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: true });
    expect(approvalBroker.request).toHaveBeenCalledWith(1, 'Bash: git push origin main');
    expect(notifyApprovalNeeded).toHaveBeenCalledWith({ id: 'fake-id', description: 'Bash: git push origin main' });
  });

  it('denies a risky action when the approval is denied', async () => {
    const approvalBroker = fakeApprovalBroker(false);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'sudo apt update' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: false });
  });

  it('requests approval for a Write outside the working directory', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    await decidePermission(
      'Write',
      { file_path: '/etc/hosts' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(approvalBroker.request).toHaveBeenCalledWith(1, 'Write: /etc/hosts');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/permissionDecider.test.ts`
Expected: FAIL — `Cannot find module '../src/permissionDecider'`

- [ ] **Step 3: Implement `src/permissionDecider.ts`**

```ts
import type { ApprovalBroker } from './approvals.js';
import { classifyToolUse } from './riskRules.js';

export interface PermissionDecision {
  allow: boolean;
}

export interface DecidePermissionDeps {
  workingDir: string;
  approvalBroker: ApprovalBroker;
  chatId: number;
  notifyApprovalNeeded: (approval: { id: string; description: string }) => void;
}

export function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `Bash: ${input.command}`;
  }
  if (
    (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') &&
    typeof input.file_path === 'string'
  ) {
    return `${toolName}: ${input.file_path}`;
  }
  return `${toolName}: ${JSON.stringify(input)}`;
}

export async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  deps: DecidePermissionDeps
): Promise<PermissionDecision> {
  const classification = classifyToolUse(toolName, input, deps.workingDir);

  if (classification === 'auto') {
    return { allow: true };
  }

  const description = describeToolUse(toolName, input);
  const { id, promise } = deps.approvalBroker.request(deps.chatId, description);
  deps.notifyApprovalNeeded({ id, description });

  const approved = await promise;
  return { allow: approved };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/permissionDecider.test.ts`
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/permissionDecider.ts tests/permissionDecider.test.ts
git commit -m "feat: permission decider combining risk rules and approval broker"
```

---

### Task 7: Claude Agent SDK session runner

**Files:**
- Create: `src/claudeSession.ts`
- Create: `scripts/smoke-test-claude-session.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 4), `ApprovalBroker` (Task 5), `decidePermission` (Task 6)
- Produces:
  ```ts
  interface ClaudeSessionRunner {
    sendMessage(chatId: number, userMessage: string): Promise<string>;
    resetSession(chatId: number): void;
  }
  interface CreateClaudeSessionRunnerDeps {
    workingDir: string;
    model: string;
    sessionStore: SessionStore;
    approvalBroker: ApprovalBroker;
    notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
  }
  function createClaudeSessionRunner(deps: CreateClaudeSessionRunnerDeps): ClaudeSessionRunner;
  ```

This task integrates a real external package (`@anthropic-ai/claude-agent-sdk`) whose exact shipped type names can drift from documentation between versions. Per the design spec, this layer is verified manually rather than with automated tests.

- [ ] **Step 1: Locate the installed package's own type declarations**

Run: `find node_modules/@anthropic-ai/claude-agent-sdk -name "*.d.ts" | xargs grep -l "PermissionResult" 2>/dev/null`

Open the file(s) reported and read the exact shape of `PermissionResult`, `SDKMessage`, `SDKAssistantMessage`, and `SDKResultMessage`. The code below is written against the documented shape (`{ allow: boolean }` for `PermissionResult`; assistant text at `message.message.content[].text` where `block.type === 'text'`; session id at `message.session_id` on a `type: 'result'` message). If the installed package's types differ, adjust the code in Step 2 to match — the compiler check in Step 3 will catch any mismatch.

- [ ] **Step 2: Implement `src/claudeSession.ts`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStore } from './sessionStore.js';
import type { ApprovalBroker } from './approvals.js';
import { decidePermission } from './permissionDecider.js';

export interface ClaudeSessionRunner {
  sendMessage(chatId: number, userMessage: string): Promise<string>;
  resetSession(chatId: number): void;
}

export interface CreateClaudeSessionRunnerDeps {
  workingDir: string;
  model: string;
  sessionStore: SessionStore;
  approvalBroker: ApprovalBroker;
  notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
}

export function createClaudeSessionRunner(deps: CreateClaudeSessionRunnerDeps): ClaudeSessionRunner {
  return {
    async sendMessage(chatId: number, userMessage: string): Promise<string> {
      const existingSessionId = deps.sessionStore.get(chatId);

      const stream = query({
        prompt: userMessage,
        options: {
          cwd: deps.workingDir,
          model: deps.model,
          ...(existingSessionId ? { resume: existingSessionId } : {}),
          canUseTool: async (toolName, input) => {
            const decision = await decidePermission(toolName, input, {
              workingDir: deps.workingDir,
              approvalBroker: deps.approvalBroker,
              chatId,
              notifyApprovalNeeded: (approval) => deps.notifyApprovalNeeded(chatId, approval),
            });
            return { allow: decision.allow };
          },
        },
      });

      let finalText = '';
      let newSessionId: string | undefined;

      for await (const message of stream) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              finalText += block.text;
            }
          }
        }
        if (message.type === 'result') {
          newSessionId = message.session_id;
        }
      }

      if (newSessionId) {
        deps.sessionStore.set(chatId, newSessionId);
      }

      return finalText;
    },

    resetSession(chatId: number): void {
      deps.sessionStore.reset(chatId);
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: compiles with no errors. If TypeScript reports a property that does not exist (e.g. on `PermissionResult`, `message.message.content`, or `message.session_id`), open the type declaration file found in Step 1, find the correct field name, and update `src/claudeSession.ts` to match. Re-run until it compiles cleanly.

- [ ] **Step 4: Write the manual smoke-test script**

Create `scripts/smoke-test-claude-session.ts`:

```ts
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
});

const chatId = 999;
const reply = await runner.sendMessage(chatId, 'Say "hello from the smoke test" and nothing else.');
console.log('Claude replied:', reply);
```

- [ ] **Step 5: Run the smoke test**

Run: `ANTHROPIC_API_KEY=<your-key> npx tsx scripts/smoke-test-claude-session.ts`
Expected: prints `Claude replied: ...` containing "hello from the smoke test". If it errors on `canUseTool`'s return shape, revisit Step 3.

- [ ] **Step 6: Commit**

```bash
git add src/claudeSession.ts scripts/smoke-test-claude-session.ts
git commit -m "feat: Claude Agent SDK session runner with permission gating"
```

---

### Task 8: Telegram bot wiring and entrypoint

**Files:**
- Create: `src/bot.ts`
- Create: `src/index.ts`
- Modify: `.env` (real secrets, not committed — created from `.env.example`)

**Interfaces:**
- Consumes: `Config` (Task 1), `SessionStore`/`createSessionStore` (Task 4), `ApprovalBroker`/`createApprovalBroker` (Task 5), `ClaudeSessionRunner`/`createClaudeSessionRunner` (Task 7)
- Produces: `createBot(config, claudeSessionRunner, approvalBroker): Telegraf`, `notifyApprovalNeeded(bot, chatId, approval)`, `notifyApprovalTimedOut(bot, chatId, description)`, and the running entrypoint `src/index.ts`

- [ ] **Step 1: Create the Telegram bot via @BotFather**

In Telegram, open a chat with `@BotFather` and send:
1. `/newbot`
2. Choose a display name (e.g. "Chiel Claude Bridge")
3. Choose a username ending in `bot` (e.g. `chiel_claude_bridge_bot`)
4. BotFather replies with an HTTP API token (looks like `123456789:AAExampleTokenValue`) — copy it.

- [ ] **Step 2: Get your own Telegram user ID**

In Telegram, open a chat with `@userinfobot` and send any message. It replies with your numeric user ID.

- [ ] **Step 3: Create the real `.env` file**

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `TELEGRAM_BOT_TOKEN` — the token from Step 1
- `ALLOWED_TELEGRAM_USER_ID` — your user ID from Step 2
- `ANTHROPIC_API_KEY` — your Anthropic API key

- [ ] **Step 4: Implement `src/bot.ts`**

```ts
import { Telegraf, Markup } from 'telegraf';
import type { Config } from './config.js';
import type { ClaudeSessionRunner } from './claudeSession.js';
import type { ApprovalBroker } from './approvals.js';
import { splitTelegramMessage } from './telegramFormat.js';

export function createBot(
  config: Config,
  claudeSessionRunner: ClaudeSessionRunner,
  approvalBroker: ApprovalBroker
): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id;
    if (senderId !== config.allowedTelegramUserId) {
      return;
    }
    return next();
  });

  bot.command('reset', (ctx) => {
    claudeSessionRunner.resetSession(ctx.chat.id);
    return ctx.reply('Sessie gereset. Volgend bericht start een nieuw gesprek.');
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.sendChatAction('typing');

    try {
      const reply = await claudeSessionRunner.sendMessage(chatId, ctx.message.text);
      const chunks = splitTelegramMessage(reply || '(geen tekstantwoord)');
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Er ging iets mis: ${message}`);
    }
  });

  bot.action(/^approve:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, true);
    await ctx.answerCbQuery(resolved ? 'Goedgekeurd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      await ctx.editMessageText(`${original}\n\n✅ Goedgekeurd`);
    }
  });

  bot.action(/^deny:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, false);
    await ctx.answerCbQuery(resolved ? 'Geweigerd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      await ctx.editMessageText(`${original}\n\n❌ Geweigerd`);
    }
  });

  return bot;
}

export function notifyApprovalNeeded(
  bot: Telegraf,
  chatId: number,
  approval: { id: string; description: string }
): void {
  const text = `⚠️ Claude wil de volgende actie uitvoeren:\n\n${approval.description}`;
  bot.telegram
    .sendMessage(
      chatId,
      text,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Goedkeuren', `approve:${approval.id}`),
        Markup.button.callback('❌ Weigeren', `deny:${approval.id}`),
      ])
    )
    .catch((error) => {
      console.error('Kon goedkeuringsbericht niet versturen naar Telegram:', error);
    });
}

export function notifyApprovalTimedOut(bot: Telegraf, chatId: number, description: string): void {
  bot.telegram
    .sendMessage(chatId, `⏱️ Geen reactie binnen de tijd — automatisch geweigerd:\n\n${description}`)
    .catch((error) => {
      console.error('Kon timeout-bericht niet versturen naar Telegram:', error);
    });
}
```

- [ ] **Step 5: Implement `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { createSessionStore } from './sessionStore.js';
import { createApprovalBroker } from './approvals.js';
import { createClaudeSessionRunner } from './claudeSession.js';
import { createBot, notifyApprovalNeeded, notifyApprovalTimedOut } from './bot.js';

const config = loadConfig();

const sessionStore = createSessionStore(config.sessionStorePath);

// `bot` is referenced by the callbacks below before it exists yet — those callbacks
// only run later (on a timeout or an approval request), by which point `bot` has
// been assigned. This breaks the circular dependency between the bot needing the
// approval broker / session runner, and those needing the bot to send messages.
let bot: ReturnType<typeof createBot>;

const approvalBroker = createApprovalBroker({
  timeoutMs: config.approvalTimeoutMs,
  onTimeout: (_approvalId, chatId, description) => {
    notifyApprovalTimedOut(bot, chatId, description);
  },
});

const claudeSessionRunner = createClaudeSessionRunner({
  workingDir: config.workingDir,
  model: config.claudeModel,
  sessionStore,
  approvalBroker,
  notifyApprovalNeeded: (chatId, approval) => {
    notifyApprovalNeeded(bot, chatId, approval);
  },
});

bot = createBot(config, claudeSessionRunner, approvalBroker);

bot.launch();
console.log('Telegram-Claude bridge gestart.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 7: Manually verify a basic message round-trip**

Run: `npm run dev`

From your own Telegram account, message your bot: "Say hello in one sentence."
Expected: a "typing…" indicator, followed by a reply from Claude.

- [ ] **Step 8: Manually verify the approval flow**

In an empty scratch git repo you don't mind pushing to (e.g. create one with `git init /tmp/approval-test && cd /tmp/approval-test && git commit --allow-empty -m init`), message the bot: "In /tmp/approval-test, run git push (it will fail since there's no remote, that's fine — I just want to see the approval prompt)."
Expected: the bot sends a message with "Goedkeuren"/"Weigeren" buttons describing the `git push` command. Tap "Goedkeuren" and confirm the action proceeds (and the button message updates to show "✅ Goedgekeurd"). Repeat and tap "Weigeren" this time, confirm it's declined (message updates to "❌ Geweigerd").

- [ ] **Step 9: Manually verify `/reset`**

Send a message establishing context (e.g. "Remember the word banana."), then send `/reset`, then ask "What word did I ask you to remember?"
Expected: Claude has no memory of "banana" after the reset.

- [ ] **Step 10: Stop the dev server and commit**

Press `Ctrl+C` to stop `npm run dev`.

```bash
git add src/bot.ts src/index.ts .gitignore
git commit -m "feat: Telegram bot wiring and entrypoint"
```

(`.env` itself is not committed — it's excluded by `.gitignore` from Task 1.)

---

### Task 9: Dockerize and deploy

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `src/index.ts` (Task 8) as the container's entrypoint (compiled to `dist/index.js`)

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  telegram-claude-bridge:
    build: .
    container_name: telegram-claude-bridge
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - /home/chiel:/home/chiel
```

Note: `/home/chiel:/home/chiel` bind-mounts the real host home directory into the container at the same path, so that `cwd: '/home/chiel'` inside the agent resolves to your actual files — without it, the agent would only see the container's own empty filesystem. The container runs as root (the Dockerfile has no `USER` directive), so it can read/write everything under `/home/chiel` regardless of host file ownership — this matches the "brede toegang, net als nu" access level from the design spec.

- [ ] **Step 3: Create `README.md`**

```markdown
# Telegram ↔ Claude Code Bridge

Chat with a Claude agent running on this server, from Telegram.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather): `/newbot`, choose a name and
   username, copy the API token it gives you.
2. Get your own Telegram user ID from [@userinfobot](https://t.me/userinfobot).
3. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`,
   and `ANTHROPIC_API_KEY`.
4. `docker compose up -d --build`

## Usage

- Send any message to chat with Claude. Context is kept per Telegram chat until you send `/reset`.
- When Claude wants to do something risky (`git push`, `rm -rf`, `sudo`, writing outside
  `/home/chiel`, ...), it sends an approval request with **Goedkeuren**/**Weigeren** buttons
  and waits up to 15 minutes before auto-denying.
- Only the Telegram user ID in `ALLOWED_TELEGRAM_USER_ID` can use the bot — everyone else is
  silently ignored.

## Adjusting risk rules

Edit `src/riskRules.ts` to change which Bash command patterns or file paths require
confirmation, then rebuild: `docker compose up -d --build`.

## Logs

```bash
docker compose logs -f
```
```

- [ ] **Step 4: Build the image**

Run: `docker compose build`
Expected: builds successfully with no errors.

- [ ] **Step 5: Start the container**

Run: `docker compose up -d`

- [ ] **Step 6: Check the logs**

Run: `docker compose logs -f`
Expected: `Telegram-Claude bridge gestart.` with no errors. Press `Ctrl+C` to stop following logs (the container keeps running).

- [ ] **Step 7: Quick sanity check**

From Telegram, send the bot a short message and confirm you get a reply.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "feat: Dockerize and document deployment"
```

---

### Task 10: End-to-end verification

**Files:** none (manual verification only)

Run through the full checklist from the design spec's "Testen" section against the deployed container (from Task 9), not the `npm run dev` process:

- [ ] **Step 1: Normal message round-trip**

Send a plain message, confirm a reply arrives.

- [ ] **Step 2: Approve a risky action**

Trigger a risky action (e.g. ask Claude to run `git push` in a scratch repo as in Task 8 Step 8), tap "Goedkeuren", confirm it proceeds.

- [ ] **Step 3: Deny a risky action**

Trigger another risky action, tap "Weigeren", confirm it's declined and Claude adapts (e.g. reports it couldn't proceed).

- [ ] **Step 4: `/reset` clears context**

Establish context, send `/reset`, ask about that context again, confirm Claude no longer remembers it.

- [ ] **Step 5: Unauthorized sender is ignored**

From a second Telegram account (or ask someone else), message the bot. Confirm no reply is sent, and (if you have log access) that nothing sensitive is logged beyond "ignored".

- [ ] **Step 6: Session survives a container restart**

Establish context, run `docker compose restart`, send a follow-up message in the same chat, confirm the context is still intact.

- [ ] **Step 7: Timeout auto-denies (optional, takes ~15 minutes)**

Trigger a risky action and don't respond. After 15 minutes, confirm a "automatisch geweigerd" message arrives.

- [ ] **Step 8: Final commit**

If any fixes were needed during verification, commit them:

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```

(Skip this commit if no changes were needed.)
