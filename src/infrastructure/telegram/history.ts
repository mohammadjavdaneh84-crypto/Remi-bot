import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { HistoryRepository } from '../../app/delivery/history.js';
import { formatInstant } from '../../ui/fa/rule-form.js';
const states: Record<string, string> = {
  PENDING: 'در انتظار',
  PROCESSING: 'در حال ارسال',
  SUCCEEDED: 'موفق',
  FAILED: 'ناموفق',
  PARTIAL_FAILED: 'بخشی ناموفق',
  CANCELLED: 'لغوشده',
  FAILED_RETRYABLE: 'تلاش مجدد زمان‌بندی شده',
  FAILED_PERMANENT: 'ارسال متوقف شد',
  UNKNOWN: 'نتیجه نامعلوم؛ تکرار خودکار متوقف است',
};
const errors: Record<string, string> = {
  TARGET_UNAVAILABLE: 'دسترسی به مقصد وجود ندارد',
  RATE_LIMIT: 'محدودیت سرعت تلگرام',
  TELEGRAM_SERVER: 'خطای موقت تلگرام',
  COPY_REJECTED: 'تلگرام این محتوا را نپذیرفت',
  NETWORK_UNKNOWN: 'پاسخ ارسال دریافت نشد',
  PARTIAL_RESPONSE: 'پاسخ کپی ناقص بود',
  INTERRUPTED_SEND: 'ارسال قطع شد و نتیجه مشخص نیست',
  PREFLIGHT_TEMPORARY: 'بررسی مقصد موقتاً ناموفق بود',
  ATTEMPTS_EXHAUSTED: 'سقف تلاش‌ها تمام شد',
  EMPTY_PACKAGE: 'محتوایی برای ارسال پیدا نشد',
  INACTIVE_DEFINITION: 'یادآور دیگر فعال نیست',
  MERGED_TARGET: 'این مقصد با مقصد دیگری ادغام شده است',
};
export function registerHistory(
  bot: Bot,
  repository: HistoryRepository,
  owner: string,
) {
  async function show(ctx: Context, page: number, reminder?: string) {
    const result = await repository.page(owner, page, reminder);
    const keyboard = new InlineKeyboard();
    const prefix = reminder ? `h:r:${reminder}:` : 'h:a:';
    if (page) keyboard.text('قبلی', prefix + (page - 1));
    if (result.hasNext) keyboard.text('بعدی', prefix + (page + 1));
    if (reminder) keyboard.row().text('همهٔ یادآورها', 'h:a:0');
    else
      for (const entry of result.entries)
        keyboard
          .row()
          .text(
            `تاریخچهٔ ${entry.name.slice(0, 40)}`,
            `h:r:${entry.reminderId}:0`,
          );
    const text = result.entries.length
      ? '📜 تاریخچهٔ ارسال\n\n' +
        result.entries
          .map(
            (e) =>
              `${e.name}\n${formatInstant(e.scheduledFor, e.timezone)} (${e.timezone}) · ${e.trigger === 'MANUAL' ? 'دستی' : 'زمان‌بندی‌شده'}\n${states[e.state] ?? 'نامشخص'}\n` +
              e.deliveries
                .map(
                  (d) =>
                    `• ${d.title.slice(0, 128)}: ${states[d.state] ?? 'نامشخص'}${d.total ? ` (${d.sent}/${d.total} بخش ارسال‌شده)` : ''}${d.error ? ` — ${errors[d.error] ?? 'خطای ارسال'}` : ''}${d.nextAttempt ? `؛ تلاش بعد: ${formatInstant(d.nextAttempt, e.timezone)}` : ''}`,
                )
                .join('\n'),
          )
          .join('\n\n')
      : 'هنوز اجرایی برای نمایش وجود ندارد.';
    const chunks: string[] = [];
    let chunk = '';
    for (const line of text.split('\n')) {
      if (chunk.length + line.length > 3400) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) chunks.push(chunk);
    for (const [index, part] of chunks.entries())
      await ctx.reply(part, {
        reply_markup:
          index === chunks.length - 1 ? keyboard : new InlineKeyboard(),
      });
  }
  bot.command('history', (ctx) => show(ctx, 0));
  bot.callbackQuery(
    /^h:(?:a:(\d{1,5})|r:([0-9a-f-]{36}):(\d{1,5}))$/,
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const page = Number(ctx.match[1] ?? ctx.match[3]);
      if (page > 10000) return;
      await show(ctx, page, ctx.match[2]);
    },
  );
}
