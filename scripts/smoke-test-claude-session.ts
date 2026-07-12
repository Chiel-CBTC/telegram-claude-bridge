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
});

const chatId = 999;
const reply = await runner.sendMessage(chatId, 'Say "hello from the smoke test" and nothing else.');
console.log('Claude replied:', reply);
