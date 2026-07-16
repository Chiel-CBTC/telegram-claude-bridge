import 'dotenv/config';

const DEFAULT_EXCLUDED_PLUGINS = ['caveman'];

function parseExcludedPlugins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return DEFAULT_EXCLUDED_PLUGINS;
  }
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

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
    notionToken: env.NOTION_TOKEN?.trim() || undefined,
    excludedPlugins: parseExcludedPlugins(env.EXCLUDED_PLUGINS),
  };
}
