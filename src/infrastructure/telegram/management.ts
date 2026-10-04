import type { Bot, Context } from 'grammy';
import type { CreationWizard } from '../../app/wizard/service.js';
import {
  ManagementConflict,
  type ManagementRepository,
  type ManagementAction,
  type ReminderSummary,
} from '../../app/management/model.js';
import { respond } from './wizard.js';
import { formatInstant } from '../../ui/fa/rule-form.js';
import { deliveryUnits } from '../../app/delivery/model.js';
import { copyUnit } from './delivery.js';
import type { View } from '../../app/wizard/model.js';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function action(r: ReminderSummary, label: string, name: string) {
  return { text: label, data: `m:${name}:${r.id}:${r.revision}` };
}
function details(r: ReminderSummary, notice = ''): View {
  return {
    text: `${notice ? notice + '\n\n' : ''}${r.name}\n${r.status === 'ACTIVE' ? '🟢 فعال' : '⏸ متوقف'}\nاجرای بعدی: ${r.nextDue ? formatInstant(r.nextDue, r.timezone) : 'ندارد'}\n${r.rules} زمان‌بندی، ${r.targets} مقصد`,
    buttons: [
      [
        action(r, '✏️ ویرایش', 'edit'),
        action(r, '📦 نمایش محتوا در پیوی', 'preview'),
      ],
      [
        action(
          r,
          r.status === 'ACTIVE' ? '⏸ توقف' : '▶️ ادامه',
          r.status === 'ACTIVE' ? 'pause' : 'resume',
        ),
        action(r, '▶️ اجرای الآن', 'askrun'),
      ],
      [
        action(r, '📄 تکثیر متوقف', 'duplicate'),
        { text: '📜 تاریخچه', data: `h:r:${r.id}:0` },
      ],
      [
        action(r, '🗑 حذف', 'askdelete'),
        { text: 'فهرست یادآورها', data: 'm:list:0' },
      ],
    ],
  };
}
export function registerManagement(
  bot: Bot,
  repository: ManagementRepository,
  owner: string,
  wizard: CreationWizard,
  clock = () => new Date().toISOString(),
  onError = () => {},
) {
  async function list(ctx: Context, page: number) {
    const result = await repository.list(owner, page);
    const buttons: View['buttons'] = result.rows.map((r) => [
      {
        text: `${r.status === 'ACTIVE' ? '🟢' : '⏸'} ${r.name.slice(0, 70)}`,
        data: `m:show:${r.id}`,
      },
    ]);
    if (page) buttons.push([{ text: 'قبلی', data: `m:list:${page - 1}` }]);
    if (result.hasNext)
      buttons.push([{ text: 'بعدی', data: `m:list:${page + 1}` }]);
    await respond(ctx, {
      text: result.rows.length
        ? '📋 یادآورها\n' +
          result.rows
            .map(
              (r) =>
                `${r.name}: ${r.status === 'PAUSED' ? 'متوقف' : r.nextDue ? formatInstant(r.nextDue, r.timezone) : 'اجرای آینده ندارد'}`,
            )
            .join('\n')
        : 'یادآوری ندارید؛ با /new شروع کنید.',
      buttons,
    });
  }
  bot.command('reminders', (ctx) => list(ctx, 0));
  bot.callbackQuery(/^m:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const page = /^m:list:(\d{1,5})$/.exec(ctx.callbackQuery.data);
      if (page) {
        if (Number(page[1]) <= 10000) await list(ctx, Number(page[1]));
        return;
      }
      const match = new RegExp(`^m:([a-z]+):(${uuid})(?::(\\d{1,9}))?$`).exec(
        ctx.callbackQuery.data,
      );
      if (!match) return;
      const name = match[1]!,
        id = match[2]!,
        revision = Number(match[3]);
      const r = await repository.get(owner, id);
      if (!r) {
        await ctx.reply('یادآور در دسترس نیست؛ /reminders را بزنید.');
        return;
      }
      if (name === 'show') {
        await respond(ctx, details(r));
        return;
      }
      if (r.revision !== revision) {
        await respond(
          ctx,
          details(r, 'این دکمه قدیمی است؛ از دکمه‌های تازه استفاده کنید.'),
        );
        return;
      }
      if (name === 'edit') {
        await respond(
          ctx,
          await wizard.handle(ctx.update.update_id, {
            type: 'edit',
            reminderId: id,
          }),
        );
        return;
      }
      if (name === 'askrun' || name === 'askdelete') {
        await respond(ctx, {
          text:
            name === 'askrun'
              ? `«${r.name}» همین الآن به ${r.targets} مقصد ارسال شود؟ شمارندهٔ زمان‌بندی تغییر نمی‌کند.`
              : `«${r.name}» حذف شود؟ تاریخچه حفظ می‌شود؛ ارسالِ ازقبل‌شروع‌شده می‌تواند تمام شود.`,
          buttons: [
            [
              action(
                r,
                name === 'askrun' ? '✅ بله، ارسال کن' : '✅ بله، حذف کن',
                name === 'askrun' ? 'run' : 'delete',
              ),
            ],
            [{ text: 'انصراف', data: `m:show:${id}` }],
          ],
        });
        return;
      }
      if (
        !['pause', 'resume', 'run', 'duplicate', 'delete', 'preview'].includes(
          name,
        )
      )
        return;
      const result = await repository.act(
        owner,
        id,
        revision,
        name as ManagementAction,
        ctx.update.update_id,
        clock(),
      );
      if (!result) {
        await ctx.reply('این درخواست قبلاً ثبت شده است؛ /reminders را بزنید.');
        return;
      }
      if (name === 'preview') {
        // Receipt commits before any copy: replayed updates never repeat an uncertain private preview.
        const units = deliveryUnits(await repository.content(owner, id));
        try {
          for (const [index, unit] of units.entries())
            await copyUnit(bot.api, String(ctx.chat!.id), {
              ...unit,
              id: String(index),
            });
        } catch {
          await ctx.reply(
            'پیش‌نمایش کامل نشد؛ برای جلوگیری از تکرار احتمالی، خودکار تلاش دوباره نمی‌کنم.',
          );
          return;
        }
        await ctx.reply(
          'پیش‌نمایش فقط در پیوی بود؛ شمارنده‌ها و مقصدها تغییری نکردند.',
        );
        return;
      }
      if (name === 'delete') {
        await ctx.reply('یادآور حذف شد؛ تاریخچه و محتوای ذخیره‌شده حفظ شدند.');
        await list(ctx, 0);
        return;
      }
      const updated = await repository.get(owner, result);
      if (updated)
        await respond(
          ctx,
          details(
            updated,
            name === 'duplicate'
              ? 'کپی تازه متوقف است؛ پیش از ادامه می‌توانید آن را ویرایش کنید.'
              : name === 'run'
                ? 'اجرای دستی در صف ثبت شد؛ نتیجه در تاریخچه نمایش داده می‌شود.'
                : name === 'resume'
                  ? 'ادامه یافت؛ زمان‌های دورهٔ توقف جبران نمی‌شوند.'
                  : 'متوقف شد؛ ارسال ازقبل‌شروع‌شده می‌تواند تمام شود.',
          ),
        );
    } catch (error) {
      if (!(error instanceof ManagementConflict)) onError();
      await ctx.reply(
        error instanceof ManagementConflict
          ? error.message
          : 'عملیات انجام نشد؛ /reminders را تازه کنید و دوباره تلاش کنید.',
      );
    }
  });
}
