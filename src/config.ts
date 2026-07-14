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
