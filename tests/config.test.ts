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
