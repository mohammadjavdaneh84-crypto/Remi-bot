import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Message } from 'grammy/types';
import type { CreationWizard } from '../../app/wizard/service.js';
import type { View } from '../../app/wizard/model.js';
import { captureItem } from './storage/capture.js';

/** Whitelist only fields needed to copy/describe content, excluding unrelated forwarded-user data. */
export function captureEnvelope(message: Message): Message {
  const keys = [
    'message_id',
    'date',
    'chat',
    'from',
    'text',
    'entities',
    'caption',
    'caption_entities',
    'media_group_id',
    'animation',
    'photo',
    'video',
    'document',
    'audio',
    'voice',
    'video_note',
    'sticker',
    'edit_date',
    'show_caption_above_media',
    'has_media_spoiler',
    'has_protected_content',
  ] as const;
  return Object.fromEntries(
    keys
      .filter((k) => k in message)
      .map((k) => [k, message[k as keyof Message]]),
  ) as unknown as Message;
}
export async function respond(ctx: Context, view: View | null) {
  if (!view) return;
  const keyboard = new InlineKeyboard();
  for (const row of view.buttons) {
    for (const b of row) keyboard.text(b.text, b.data);
    keyboard.row();
  }
  // Long summaries remain readable and below Telegram's per-message text limit.
  const parts: string[] = [];
  let current = '';
  for (const line of view.text.split('\n')) {
    if (current.length + line.length + 1 > 3500) {
      parts.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) parts.push(current);
  for (const [index, part] of parts.entries())
    await ctx.reply(part, {
      reply_markup:
        index === parts.length - 1 ? keyboard : new InlineKeyboard(),
    });
}
export function registerWizard(bot: Bot, wizard: CreationWizard) {
  bot.command('new', async (ctx) =>
    respond(ctx, await wizard.handle(ctx.update.update_id, { type: 'start' })),
  );
  bot.command('cancel', async (ctx) =>
    respond(ctx, await wizard.handle(ctx.update.update_id, { type: 'cancel' })),
  );
  bot.command('help', (ctx) =>
    ctx.reply(
      'برای ساخت یا ادامهٔ پیش‌نویس /new، مدیریت یادآورها /reminders، مشاهدهٔ مقصدها /targets، تاریخچهٔ ارسال /history، تاریخ امروز /daily و لغو پیش‌نویس /cancel را بزنید. تاریخ‌ها فعلاً میلادی هستند.',
    ),
  );
  bot.callbackQuery(/^w:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await respond(
      ctx,
      await wizard.handle(ctx.update.update_id, {
        type: 'callback',
        data: ctx.callbackQuery.data,
      }),
    );
  });
  bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) {
      await ctx.reply('برای ساخت یا ادامه /new و برای لغو /cancel را بزنید.');
      return;
    }
    // The application decides whether text is a field answer or content based on the persisted step.
    const item = captureItem(ctx.message);
    if (!item) {
      await ctx.reply(
        'این نوع پیام فعلاً پشتیبانی نمی‌شود؛ محتوای قبلی محفوظ است.',
      );
      return;
    }
    await respond(
      ctx,
      await wizard.handle(ctx.update.update_id, {
        type: 'message',
        text: ctx.message.text ?? null,
        messageId: ctx.message.message_id,
        groupKey: item.mediaGroupKey,
        payload: captureEnvelope(ctx.message),
      }),
    );
  });
}
