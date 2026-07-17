import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import path from 'node:path';
import type { SessionStore } from './sessionStore.js';
import type { ApprovalBroker } from './approvals.js';
import { decidePermission } from './permissionDecider.js';
import { loadPluginConfigs } from './plugins.js';

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
    this.currentText = '';
    const turn = this.pendingTurns.shift();
    if (!turn) {
      return false;
    }
    turn.reject(err);
    return true;
  }

  failAll(err: unknown): void {
    this.currentText = '';
    while (this.pendingTurns.length > 0) {
      const turn = this.pendingTurns.shift();
      turn?.reject(err);
    }
  }

  hasPending(): boolean {
    return this.pendingTurns.length > 0;
  }
}

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
