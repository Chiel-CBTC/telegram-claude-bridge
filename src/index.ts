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
  notionToken: config.notionToken,
  excludedPlugins: config.excludedPlugins,
  liveSessionIdleTimeoutMs: config.liveSessionIdleTimeoutMs,
});

bot = createBot(config, claudeSessionRunner, approvalBroker);

bot.launch();
console.log('Telegram-Claude bridge gestart.');

// Defense-in-depth for an unattended long-running bot: log instead of letting
// an unexpected unhandled rejection take down the whole process (mirrors
// bot.ts's bot.catch philosophy — log and continue).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.once('SIGINT', () => {
  // Best-effort: closeAll() fires interrupt() calls without awaiting the SDK's
  // ~2s graceful shutdown, which likely won't finish before exit — tini
  // (init: true in docker-compose.yml) reaps any orphaned child processes.
  claudeSessionRunner.closeAll();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  // Best-effort shutdown; see the SIGINT handler above.
  claudeSessionRunner.closeAll();
  bot.stop('SIGTERM');
});
