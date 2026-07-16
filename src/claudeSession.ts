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
  // Internal integration token from notion.so/my-integrations. When set, the bot
  // gets Notion access via the official stdio MCP server; when unset, Notion tools
  // are simply not offered (no error).
  notionToken?: string;
}

function buildMcpServers(deps: CreateClaudeSessionRunnerDeps): Record<string, { command: string; args: string[]; env: Record<string, string> }> | undefined {
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

export function createClaudeSessionRunner(deps: CreateClaudeSessionRunnerDeps): ClaudeSessionRunner {
  const mcpServers = buildMcpServers(deps);

  return {
    async sendMessage(chatId: number, userMessage: string): Promise<string> {
      const existingSessionId = deps.sessionStore.get(chatId);

      const stream = query({
        prompt: userMessage,
        options: {
          cwd: deps.workingDir,
          model: deps.model,
          ...(mcpServers ? { mcpServers } : {}),
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
