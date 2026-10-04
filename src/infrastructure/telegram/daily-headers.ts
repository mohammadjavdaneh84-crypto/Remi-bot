import { InlineKeyboard, type Bot, type Context } from 'grammy';
import {
  HeaderConflict,
  type HeaderSession,
  type HeaderTransport,
} from '../../app/daily-header/model.js';
import type { PgDailyHeaders } from '../db/daily-headers.js';
import type { Targets } from '../../app/services/targets.js';
import { TargetUnavailable } from '../../app/services/targets.js';
import { normalizeDigits } from '../../ui/fa/normalize.js';
import { headerSettingsSchema } from '../../domain/daily-header/schedule.js';
import { timezoneSchema } from '../../domain/schedule/rule.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function registerDailyHeaders(
  bot: Bot,
  repository: PgDailyHeaders,
  owner: string,
  targets: Targets,
  transport: HeaderTransport,
  report: () => void = () => {},
  clock = () => new Date().toISOString(),
) {
  const guard =
    (handler: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
      try {
        await handler(ctx);
      } catch (e) {
        if (!(e instanceof HeaderConflict || e instanceof TargetUnavailable))
          report();
        await ctx.reply(
          e instanceof HeaderConflict
            ? e.message
            : e instanceof TargetUnavailable
              ? 'اجازهٔ ارسال یا پین در این مقصد وجود ندارد. دسترسی را اصلاح کنید یا «فقط ارسال» را انتخاب کنید.'
              : 'عملیات انجام نشد؛ تنظیمات قبلی محفوظ است. /daily را دوباره باز کنید.',
        );
      }
    };
  async function list(ctx: Context, page = 0) {
    const configs = await repository.list(owner, page);
    const keyboard = new InlineKeyboard();
    for (const c of configs.slice(0, 10))
      keyboard
        .text(
          `${c.enabled ? '🟢' : '⏸'} ${c.title.slice(0, 60)}`,
          `dh:show:${c.id}`,
        )
        .row();
    if (page) keyboard.text('قبلی', `dh:list:${page - 1}`);
    if (configs.length > 10) keyboard.text('بعدی', `dh:list:${page + 1}`);
    keyboard.row().text('➕ تاریخ روز برای مقصد تازه', 'dh:new');
    await ctx.reply(
      '📅 تاریخ امروز\nهر روز یک پیام تاریخ، با پین اختیاری. مقصد را انتخاب کنید.',
      { reply_markup: keyboard },
    );
  }
  async function detail(ctx: Context, id: string) {
    const c = await repository.get(owner, id);
    if (!c) throw new HeaderConflict();
    const history = await repository.history(owner, id);
    const statuses: Record<string, string> = {
      SUCCEEDED: 'انجام شد',
      FAILED: 'ناموفق؛ دسترسی مقصد را بررسی کنید',
      UNKNOWN: 'نتیجه نامعلوم؛ برای جلوگیری از تکرار دوباره ارسال نشد',
      CANCELLED: 'لغو شد',
      ACTIVE: 'در انتظار ادامه یا تلاش دوباره',
    };
    const keyboard = new InlineKeyboard()
      .text('✏️ ویرایش', `dh:edit:${id}:${c.revision}`)
      .row()
      .text(
        c.enabled ? '⏸ توقف' : '▶️ ادامه',
        `dh:${c.enabled ? 'off' : 'on'}:${id}:${c.revision}`,
      )
      .row()
      .text('بازگشت', 'dh:list:0');
    await ctx.reply(
      `📅 ${c.title.slice(0, 128)}\n${c.enabled ? 'فعال' : 'متوقف'} — ${c.localTime} (${c.timezone})\n${c.pin ? 'ارسال و پین' : 'فقط ارسال'}\n\n` +
        history
          .map(
            (h) =>
              `${h.date}: ${statuses[h.state]}${h.stage === 'PIN' || h.stage === 'UNPIN' ? ' (متن ارسال شده؛ مرحلهٔ پین)' : ''}`,
          )
          .join('\n'),
      { reply_markup: keyboard },
    );
  }
  async function view(ctx: Context, s: HeaderSession, page = 0) {
    const p = s.payload;
    const prefix = `dh:d:${s.token.replaceAll('-', '').slice(0, 12)}:${s.revision}:`;
    const keyboard = new InlineKeyboard();
    let text = '';
    if (p.step === 'TARGET') {
      text = 'تاریخ امروز به کجا فرستاده شود؟';
      keyboard.text('پیوی من با REMI', prefix + 'private').row();
      const rows = await targets.list(page);
      for (const t of rows.slice(0, 10))
        keyboard.text(t.title.slice(0, 60), prefix + 't:' + t.id).row();
      if (page) keyboard.text('قبلی', prefix + 'page:' + (page - 1));
      if (rows.length > 10)
        keyboard.text('بعدی', prefix + 'page:' + (page + 1));
    } else if (p.step === 'TIME') {
      text = `ساعت روزانه را بفرستید، مثلاً 08:00.\nمقدار فعلی: ${p.localTime}`;
      keyboard.text('همین ساعت', prefix + 'keep');
    } else if (p.step === 'TIMEZONE') {
      text = `منطقهٔ زمانی فعلی: ${p.timezone}\nبرای تغییر، نامی مثل Asia/Tehran را بفرستید.`;
      keyboard.text('همین منطقهٔ زمانی', prefix + 'keep');
    } else if (p.step === 'PIN') {
      text = 'پیام تاریخ پین هم بشود؟ فقط پین قبلیِ خود REMI برداشته می‌شود.';
      keyboard
        .text('ارسال و پین', prefix + 'pin')
        .text('فقط ارسال', prefix + 'send');
    } else {
      text = `📅 ${p.title.slice(0, 128)}\nهر روز ${p.localTime}\n${p.timezone}\n${p.pin ? 'ارسال و پین' : 'فقط ارسال'}\nتاریخ پیام فعلاً میلادی است. بعد از ذخیره، اگر ساعت امروز گذشته باشد پیام امروز ارسال می‌شود؛ روزهای قبلی جبران نمی‌شوند.`;
      keyboard.text('✅ ذخیره', prefix + 'save');
      keyboard.row().text('اصلاح تنظیمات', prefix + 'back');
    }
    keyboard.row().text('❌ لغو', prefix + 'cancel');
    await ctx.reply(text, { reply_markup: keyboard });
  }
  bot.command(
    'daily',
    guard(async (ctx) => {
      const draft = await repository.draft(owner, clock());
      if (draft) await view(ctx, draft);
      else await list(ctx);
    }),
  );
  bot.callbackQuery(
    /^dh:/,
    guard(async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery!.data!;
      if (data === 'dh:new') {
        await view(ctx, await repository.begin(owner, clock()));
        return;
      }
      let match = /^dh:list:(\d{1,4})$/.exec(data);
      if (match) {
        await list(ctx, Number(match[1]));
        return;
      }
      match = new RegExp(`^dh:show:(${uuid})$`).exec(data);
      if (match) {
        await detail(ctx, match[1]!);
        return;
      }
      match = new RegExp(`^dh:(edit|on|off):(${uuid}):(\\d{1,8})$`).exec(data);
      if (match) {
        if (match[1] === 'edit')
          await view(
            ctx,
            await repository.begin(owner, clock(), match[2], Number(match[3])),
          );
        else {
          if (match[1] === 'on') {
            const c = await repository.get(owner, match[2]!);
            if (!c) throw new HeaderConflict();
            await transport.check(owner, c.targetId, c.chatId, c.pin);
          }
          await repository.toggle(
            owner,
            match[2]!,
            Number(match[3]),
            match[1] === 'on',
            clock(),
          );
          await detail(ctx, match[2]!);
        }
        return;
      }
      match = /^dh:d:([0-9a-f]{12}):(\d{1,8}):(.+)$/.exec(data);
      const s = await repository.draft(owner, clock());
      if (
        !match ||
        !s ||
        s.token.replaceAll('-', '').slice(0, 12) !== match[1] ||
        s.revision !== Number(match[2])
      )
        throw new HeaderConflict();
      const action = match[3]!;
      if (action === 'cancel') {
        await repository.cancel(owner);
        await ctx.reply('پیش‌نویس تاریخ امروز لغو شد.');
        return;
      }
      const p = s.payload;
      if (p.step === 'TARGET' && /^page:\d{1,4}$/.test(action)) {
        await view(ctx, s, Number(action.slice(5)));
        return;
      }
      if (
        p.step === 'TARGET' &&
        (action === 'private' || new RegExp(`^t:${uuid}$`).test(action))
      ) {
        if (action !== 'private') {
          const t = await targets.revalidate(action.slice(2), ['text']);
          p.targetId = t.id;
          p.chatId = t.chatId;
          p.title = t.title;
        }
        p.step = 'TIME';
      } else if (p.step === 'TIME' && action === 'keep') p.step = 'TIMEZONE';
      else if (p.step === 'TIMEZONE' && action === 'keep') p.step = 'PIN';
      else if (p.step === 'PIN' && ['pin', 'send'].includes(action)) {
        p.pin = action === 'pin';
        p.step = 'CONFIRM';
      } else if (p.step === 'CONFIRM' && action === 'back') p.step = 'TIME';
      else if (p.step === 'CONFIRM' && action === 'save') {
        if (p.targetId) {
          const resolved = await targets.resolve(p.targetId);
          p.targetId = resolved.id;
          p.chatId = resolved.chatId;
          p.title = resolved.title;
        }
        const destination = await transport.check(
          owner,
          p.targetId,
          p.chatId,
          p.pin,
        );
        if (destination.chatId !== p.chatId)
          throw new HeaderConflict(
            'مقصد جابه‌جا شده است؛ /cancel و سپس /daily را بزنید.',
          );
        await repository.change(owner, ctx.update.update_id, s, clock(), true);
        await ctx.reply('تنظیمات تاریخ امروز ذخیره شد.');
        await list(ctx);
        return;
      } else throw new HeaderConflict();
      await repository.change(owner, ctx.update.update_id, s, clock());
      const updated = await repository.draft(owner, clock());
      if (updated) await view(ctx, updated);
    }),
  );
  // Keep two persisted conversations from interpreting the same input differently.
  bot.use(async (ctx, next) => {
    const s = await repository.draft(owner, clock());
    if (ctx.message?.text?.match(/^\/cancel(?:@\w+)?(?:\s|$)/)) {
      if (s) {
        await repository.cancel(owner);
        await ctx.reply('پیش‌نویس تاریخ امروز لغو شد.');
      }
      return next();
    }
    if (!s) return next();
    if (
      ctx.message?.text?.startsWith('/new') ||
      ctx.callbackQuery?.data?.startsWith('w:') ||
      ctx.callbackQuery?.data?.startsWith('m:edit:')
    ) {
      await ctx.reply(
        'ابتدا تنظیمات تاریخ امروز را با /daily ادامه دهید یا با /cancel لغو کنید.',
      );
      return;
    }
    if (!ctx.message || ctx.message.text?.startsWith('/')) return next();
    await guard(async (context) => {
      const value = normalizeDigits(context.message?.text ?? '').trim();
      if (s.payload.step === 'TIME') {
        const parsed = headerSettingsSchema.safeParse({
          ...s.payload,
          localTime: value,
        });
        if (!parsed.success) {
          await context.reply('ساعت را به شکل 08:00 بفرستید.');
          return;
        }
        s.payload.localTime = value;
        s.payload.step = 'TIMEZONE';
      } else if (s.payload.step === 'TIMEZONE') {
        if (!timezoneSchema.safeParse(value).success) {
          await context.reply(
            'منطقهٔ زمانی معتبر مانند Asia/Tehran را بفرستید.',
          );
          return;
        }
        s.payload.timezone = value;
        s.payload.step = 'PIN';
      } else {
        await view(context, s);
        return;
      }
      await repository.change(owner, context.update.update_id, s, clock());
      const updated = await repository.draft(owner, clock());
      if (updated) await view(context, updated);
    })(ctx);
  });
}
