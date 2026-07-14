import { Telegraf, Markup } from 'telegraf';
import type { Config } from './config.js';
import type { ClaudeSessionRunner } from './claudeSession.js';
import type { ApprovalBroker } from './approvals.js';
import { splitTelegramMessage } from './telegramFormat.js';

export function createBot(
  config: Config,
  claudeSessionRunner: ClaudeSessionRunner,
  approvalBroker: ApprovalBroker
): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id;
    if (senderId !== config.allowedTelegramUserId) {
      return;
    }
    return next();
  });

  bot.command('reset', (ctx) => {
    claudeSessionRunner.resetSession(ctx.chat.id);
    return ctx.reply('Sessie gereset. Volgend bericht start een nieuw gesprek.');
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.sendChatAction('typing');

    try {
      const reply = await claudeSessionRunner.sendMessage(chatId, ctx.message.text);
      const chunks = splitTelegramMessage(reply || '(geen tekstantwoord)');
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Er ging iets mis: ${message}`);
    }
  });

  bot.action(/^approve:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, true);
    await ctx.answerCbQuery(resolved ? 'Goedgekeurd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      await ctx.editMessageText(`${original}\n\n✅ Goedgekeurd`);
    }
  });

  bot.action(/^deny:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, false);
    await ctx.answerCbQuery(resolved ? 'Geweigerd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      await ctx.editMessageText(`${original}\n\n❌ Geweigerd`);
    }
  });

  return bot;
}

export function notifyApprovalNeeded(
  bot: Telegraf,
  chatId: number,
  approval: { id: string; description: string }
): void {
  const text = `⚠️ Claude wil de volgende actie uitvoeren:\n\n${approval.description}`;
  bot.telegram
    .sendMessage(
      chatId,
      text,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Goedkeuren', `approve:${approval.id}`),
        Markup.button.callback('❌ Weigeren', `deny:${approval.id}`),
      ])
    )
    .catch((error) => {
      console.error('Kon goedkeuringsbericht niet versturen naar Telegram:', error);
    });
}

export function notifyApprovalTimedOut(bot: Telegraf, chatId: number, description: string): void {
  bot.telegram
    .sendMessage(chatId, `⏱️ Geen reactie binnen de tijd — automatisch geweigerd:\n\n${description}`)
    .catch((error) => {
      console.error('Kon timeout-bericht niet versturen naar Telegram:', error);
    });
}
