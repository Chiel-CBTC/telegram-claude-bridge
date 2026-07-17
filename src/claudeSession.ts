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
