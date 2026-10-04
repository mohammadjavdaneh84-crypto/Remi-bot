import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Targets } from '../../app/services/targets.js';
import { handleMembership } from './targets.js';
import { registerWizard } from './wizard.js';
import type { CreationWizard } from '../../app/wizard/service.js';
import type { HistoryRepository } from '../../app/delivery/history.js';
import { registerHistory } from './history.js';
import { registerManagement } from './management.js';
import type { ManagementRepository } from '../../app/management/model.js';
import { registerDailyHeaders } from './daily-headers.js';
import type { PgDailyHeaders } from '../db/daily-headers.js';
import type { HeaderTransport } from '../../app/daily-header/model.js';
export interface TelegramFeatures {
  targets: Targets;
  storageChatId: string;
  wizard?: CreationWizard;
  dailyHeaders?: {
    repository: PgDailyHeaders;
    ownerId: string;
    transport: HeaderTransport;
    onError?: () => void;
  };
  history?: { repository: HistoryRepository; ownerId: string };
  management?: {
    repository: ManagementRepository;
    ownerId: string;
    onError?: () => void;
  };
}
export function createBot(
  token: string,
  ownerId: string,
  configure?: (bot: Bot) => TelegramFeatures,
) {
  const bot = new Bot(token);
  const features = configure?.(bot);
  // Infrastructure events must be handled before the private control-plane gate.
  bot.on('my_chat_member', async (ctx) => {
    if (features)
      await handleMembership(
        ctx.myChatMember,
        features.targets,
        bot.api,
        ownerId,
        features.storageChatId,
      );
  });
  bot.on(
    ['message:migrate_to_chat_id', 'message:migrate_from_chat_id'],
    async (ctx) => {
      if (!features || String(ctx.chat.id) === features.storageChatId) return;
      const oldId = ctx.message.migrate_from_chat_id ?? ctx.chat.id;
      const newId = ctx.message.migrate_to_chat_id ?? ctx.chat.id;
      if (
        !Number.isSafeInteger(oldId) ||
        !Number.isSafeInteger(newId) ||
        String(newId) === features.storageChatId
      )
        return;
      await features.targets.migrate(String(oldId), String(newId));
    },
  );
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    if (String(ctx.from?.id) !== ownerId) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({ text: 'این ربات خصوصی است.' });
      else if (ctx.message) await ctx.reply('این ربات خصوصی است.');
      return;
    }
    await next();
  });
  bot.command('start', (ctx) =>
    ctx.reply(
      features?.wizard
        ? 'به REMI خوش آمدید. برای ساخت یا ادامهٔ پیش‌نویس /new، مدیریت یادآورها /reminders، نتیجهٔ ارسال /history، تاریخ امروز /daily و مقصدها /targets را بزنید.'
        : 'به REMI خوش آمدید. زیرساخت آماده است؛ ساخت یادآور در مرحلهٔ بعد اضافه می‌شود.',
    ),
  );
  async function showTargets(ctx: Context, page: number, refresh = false) {
    if (!features) return;
    const rows = await features.targets.list(page);
    const visible = rows.slice(0, 10);
    let failures = 0;
    if (refresh)
      for (let index = 0; index < visible.length; index++) {
        try {
          visible[index] = await features.targets.revalidate(
            visible[index]!.id,
          );
        } catch {
          failures++;
          visible[index] = await features.targets.resolve(visible[index]!.id);
        }
      }
    const keyboard = new InlineKeyboard();
    if (page > 0) keyboard.text('قبلی', `targets:page:${page - 1}`);
    if (rows.length > 10) keyboard.text('بعدی', `targets:page:${page + 1}`);
    if (visible.length)
      keyboard.row().text('بررسی دسترسی‌ها', `targets:refresh:${page}`);
    const text = visible.length
      ? '📍 مقصدها\n\n' +
        visible
          .map(
            (t) =>
              `${t.reachable && Object.values(t.permissions.send).some(Boolean) ? '🟢' : '🔴'} ${t.title.slice(0, 128)}`,
          )
          .join('\n')
      : 'هنوز مقصدی ثبت نشده است. ربات را خودتان به گروه یا کانال اضافه کنید.';
    const notice = failures
      ? '\n\nبررسی بعضی مقصدها ناموفق بود؛ دوباره تلاش کنید.'
      : '';
    await ctx.reply(text + notice, { reply_markup: keyboard });
  }
  bot.command('targets', (ctx) => showTargets(ctx, 0));
  bot.callbackQuery(/^targets:(page|refresh):(\d{1,5})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = Number(ctx.match[2]);
    if (page > 10000) return;
    await showTargets(ctx, page, ctx.match[1] === 'refresh');
  });
  if (features?.history)
    registerHistory(bot, features.history.repository, features.history.ownerId);
  if (features?.dailyHeaders)
    registerDailyHeaders(
      bot,
      features.dailyHeaders.repository,
      features.dailyHeaders.ownerId,
      features.targets,
      features.dailyHeaders.transport,
      features.dailyHeaders.onError,
    );
  if (features?.management && features.wizard)
    registerManagement(
      bot,
      features.management.repository,
      features.management.ownerId,
      features.wizard,
      undefined,
      features.management.onError,
    );
  if (features?.wizard) registerWizard(bot, features.wizard);
  return bot;
}
