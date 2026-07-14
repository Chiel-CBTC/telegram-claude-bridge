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
  const bot = new Telegraf(config.telegramBotToken, {
    // Telegraf's default handlerTimeout (90s) is shorter than our own approval
    // timeout (config.approvalTimeoutMs, default 15 min) — without this, a
    // pending approval outlives telegraf's own timeout, which throws and (by
    // telegraf's default error handler) crashes the whole process. Give it
    // enough headroom that our own approval timeout always resolves first.
    handlerTimeout: config.approvalTimeoutMs + 60_000,
  });

  // Defense in depth: telegraf's default error handler logs and re-throws,
  // crashing the process on any unhandled error. Overriding it here ensures
  // an unexpected failure degrades to a logged error (and, where possible, a
  // Telegram reply) instead of taking the whole bot down for every chat.
  bot.catch((error, ctx) => {
    console.error('Onverwachte fout tijdens verwerken van update:', error);
    ctx.reply('Er ging iets onverwachts mis. Probeer het opnieuw.').catch((replyError) => {
      console.error('Kon foutmelding niet versturen naar Telegram:', replyError);
    });
  });

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

  bot.on('text', (ctx) => {
    // Deliberately not awaited: telegraf's polling loop processes each fetched
    // batch of updates via `Promise.all(...)` before it fetches the next batch
    // (see node_modules/telegraf/lib/core/network/polling.js). A Claude turn
    // can legitimately block here for minutes while a risky action awaits
    // Telegram approval — if this handler awaited that, polling itself would
    // stall, so the approve/deny button tap (a *later* update) could never be
    // fetched, deadlocking the whole flow. Firing this via an un-awaited IIFE
    // lets the handler return immediately, so polling keeps going and the
    // button tap arrives while this is still in flight.
    void (async () => {
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
    })().catch((error) => {
      console.error('Onverwachte fout bij verwerken van tekstbericht:', error);
    });
  });

  bot.action(/^approve:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, true);
    await ctx.answerCbQuery(resolved ? 'Goedgekeurd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      // editMessageText leaves the existing inline keyboard in place unless a
      // reply_markup is explicitly passed — without this, the buttons stay
      // tappable (and misleading) after the approval is already resolved.
      await ctx.editMessageText(`${original}\n\n✅ Goedgekeurd`, Markup.inlineKeyboard([]));
    }
  });

  bot.action(/^deny:(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    const resolved = approvalBroker.resolve(approvalId, false);
    await ctx.answerCbQuery(resolved ? 'Geweigerd' : 'Deze aanvraag is niet meer geldig');
    if (resolved) {
      const original =
        ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';
      await ctx.editMessageText(`${original}\n\n❌ Geweigerd`, Markup.inlineKeyboard([]));
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
