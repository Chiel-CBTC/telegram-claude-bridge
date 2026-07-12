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
            if (decision.allow) {
              return { behavior: 'allow' };
            }
            return { behavior: 'deny', message: 'Denied by approval broker.' };
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
