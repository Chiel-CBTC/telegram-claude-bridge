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
