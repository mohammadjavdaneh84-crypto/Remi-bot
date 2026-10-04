import type { Session, View } from '../../app/wizard/model.js';
import {
  buildRule,
  describeRule,
  formatInstant,
  question,
  ruleNames,
  fields,
  weekdays,
} from './rule-form.js';
import { preview } from '../../domain/schedule/recurrence.js';

export function button(s: Session, text: string, action: string, arg = '') {
  return {
    text,
    data: `w:${s.token}:${s.revision}:${action}${arg ? `:${arg}` : ''}`,
  };
}
export function wizardView(s: Session, now: string, notice = ''): View {
  const buttons: View['buttons'] = [];
  let text = '';
  switch (s.step) {
    case 'NAME':
      text = 'نام یادآور را بفرستید (حداکثر ۱۰۰ نویسه).';
      break;
    case 'CONTENT':
      text = `📦 محتوا: ${s.draft.archives.reduce((n, a) => n + a.count, 0)} آیتم ذخیره‌شده، ${s.draft.pending.length} پیام در انتظار.\nپیام‌ها و آلبوم‌ها را به ترتیب بفرستید؛ بعد از پایان ارسال، دکمهٔ زیر را بزنید.`;
      buttons.push([button(s, '✅ محتوای من تمام شد', 'content_done')]);
      {
        const page = Math.min(
          s.work.contentPage ?? 0,
          Math.max(0, Math.ceil(s.draft.archives.length / 10) - 1),
        );
        s.draft.archives
          .slice(page * 10, page * 10 + 10)
          .forEach((a, index) => {
            const i = page * 10 + index;
            text += `\n${i + 1}. ${a.count > 1 ? `آلبوم ${a.count} پیام` : 'پیام'} (${a.kinds.map((kind) => ({ text: 'متن', photo: 'عکس', video: 'ویدئو', animation: 'انیمیشن', document: 'فایل', audio: 'صدا', voice: 'پیام صوتی', video_note: 'ویدئوی گرد', sticker: 'استیکر' })[kind]).join('، ')})`;
            if (s.work.replacingContent == null)
              buttons.push([
                button(s, `↑ ${i + 1}`, 'content_up', String(i)),
                button(s, `↓ ${i + 1}`, 'content_down', String(i)),
                button(s, `حذف ${i + 1}`, 'content_remove', String(i)),
                button(s, `جایگزینی ${i + 1}`, 'content_replace', String(i)),
                button(s, `متن/کپشن ${i + 1}`, 'content_caption', String(i)),
              ]);
          });
        if (page > 0)
          buttons.push([
            button(s, 'بخش‌های قبل', 'content_page', String(page - 1)),
          ]);
        if ((page + 1) * 10 < s.draft.archives.length)
          buttons.push([
            button(s, 'بخش‌های بعد', 'content_page', String(page + 1)),
          ]);
        if (s.work.replacingContent != null) {
          text += `\nدر انتظار جایگزین بخش ${s.work.replacingContent + 1}؛ پیام یا آلبوم کامل را بفرستید.`;
          buttons.push([button(s, 'لغو جایگزینی', 'content_abort')]);
        }
      }
      if (s.draft.pending.some((p) => p.failed))
        buttons.push([
          button(s, 'حذف موارد ناموفق از پیش‌نویس', 'drop_failed'),
        ]);
      if (s.draft.archives.length || s.draft.pending.length)
        buttons.push([
          button(
            s,
            'حذف همهٔ محتوای پیش‌نویس و دریافت دوباره',
            'reset_content',
          ),
        ]);
      break;
    case 'RULE_TYPE':
      text = 'این زمان‌بندی چطور تکرار شود؟';
      for (const [kind, label] of Object.entries(ruleNames))
        buttons.push([button(s, label, 'type', kind)]);
      break;
    case 'RULE_FIELDS': {
      const q = question(s.work.builder!);
      text = `${q.text}\nمنطقهٔ زمانی: ${s.draft.timezone}`;
      {
        const b = s.work.builder!,
          field = fields(b)[b.index]!;
        const value =
          field === 'weekdays'
            ? b.weekdays.map((d) => weekdays[d - 1]).join('، ')
            : b.values[field];
        if (value) {
          text += `\nمقدار فعلی: ${value}`;
          buttons.push([button(s, 'حفظ مقدار فعلی', 'keep')]);
        }
      }
      for (const [label, value] of q.options)
        buttons.push([button(s, label, 'answer', value)]);
      if (s.work.builder!.index > 0)
        buttons.push([button(s, 'بازگشت به سؤال قبل', 'field_back')]);
      break;
    }
    case 'RULE_REVIEW':
      try {
        text = describeRule(
          buildRule(
            s.work.builder!,
            s.draft.timezone,
            now,
            !!s.editing && s.work.editingRule != null,
          ),
          s.draft.timezone,
        );
      } catch {
        text = 'زمان‌بندی نیاز به اصلاح دارد؛ تاریخ آن ممکن است گذشته باشد.';
      }
      buttons.push([
        button(s, '✅ ذخیرهٔ زمان‌بندی', 'rule_save'),
        button(s, '✏️ اصلاح', 'rule_edit'),
      ]);
      break;
    case 'RULE_LIST':
      text =
        '🕓 زمان‌بندی‌ها\n' +
        s.draft.rules
          .map(
            (r, i) =>
              `${i + 1}. ${r.enabled === false ? '⏸ ' : ''}${describeRule(r.config, s.draft.timezone)}`,
          )
          .join('\n');
      buttons.push(
        [button(s, '➕ زمان‌بندی دیگر', 'rule_add')],
        [button(s, 'انتخاب مقصدها', 'targets')],
      );
      s.draft.rules.forEach((r, i) =>
        buttons.push([
          button(s, `ویرایش ${i + 1}`, 'rule_change', String(i)),
          button(s, `کپی ${i + 1}`, 'rule_duplicate', String(i)),
          button(
            s,
            `${r.enabled === false ? 'فعال' : 'توقف'} ${i + 1}`,
            'rule_toggle',
            String(i),
          ),
          button(s, `حذف زمان‌بندی ${i + 1}`, 'rule_remove', String(i)),
        ]),
      );
      break;
    case 'TIMEZONE':
      text =
        'نام منطقهٔ زمانی را بفرستید؛ مثلاً Asia/Tehran یا Europe/Berlin. زمان‌های تقویمی با این منطقه تفسیر می‌شوند.';
      break;
    case 'POLICY':
      text = 'پس از قطع سرویس با زمان‌های ازدست‌رفته چه کنیم؟';
      buttons.push(
        [button(s, 'فقط آخرین نوبت', 'policy', 'LATEST_ONLY')],
        [button(s, 'رد کردن زمان‌های گذشته', 'policy', 'SKIP')],
        [button(s, 'جبران به‌ترتیب با سقف ایمنی', 'policy', 'CATCH_UP')],
      );
      break;
    case 'TARGETS':
      text =
        '📍 مقصدها را انتخاب کنید.\n' +
        (s.work.targetOptions.length
          ? 'مقصد انتخاب‌شده با ☑ مشخص می‌شود.'
          : 'مقصدی ثبت نشده؛ bot را به گروه/کانال اضافه کنید و فهرست را تازه کنید.');
      s.work.targetOptions.forEach((t, i) =>
        buttons.push([
          button(
            s,
            `${s.draft.targets.some((v) => v.id === t.id) ? '☑' : '☐'} ${t.title.slice(0, 80)}`,
            'target',
            String(i),
          ),
        ]),
      );
      if (s.work.page > 0)
        buttons.push([button(s, 'صفحهٔ قبل', 'page', String(s.work.page - 1))]);
      if (s.work.hasNext)
        buttons.push([button(s, 'صفحهٔ بعد', 'page', String(s.work.page + 1))]);
      buttons.push(
        [button(s, 'تازه‌کردن فهرست', 'page', String(s.work.page))],
        [button(s, 'پیش‌نمایش نهایی', 'preview')],
      );
      break;
    case 'PREVIEW': {
      const next = preview(
        s.draft.rules.map((r) => ({ ...r, enabled: r.enabled !== false })),
        now,
        { timezone: s.draft.timezone, calendarSystem: 'gregorian' },
        5,
        Object.fromEntries(
          s.draft.rules.map((r) => [r.id, r.consumedCount ?? 0]),
        ),
      );
      text = `✅ پیش‌نمایش یادآور\n${s.draft.name}\nمنطقهٔ زمانی: ${s.draft.timezone}\nمحتوا: ${s.draft.archives.reduce((n, a) => n + a.count, 0)} آیتم در ${s.draft.archives.length} بخش\n\nزمان‌بندی‌ها:\n${s.draft.rules.map((r, i) => `${i + 1}. ${describeRule(r.config, s.draft.timezone)}`).join('\n')}\n\nمقصدها: ${s.draft.targets.map((t) => t.title).join('، ')}\n\nاجراهای آینده (میلادی):\n${next.map((o) => formatInstant(o.scheduledFor, s.draft.timezone)).join('\n')}\n\nبا تأیید، یادآور فعال می‌شود و ارسال طبق زمان‌بندی انجام خواهد شد.`;
      buttons.push(
        [
          button(
            s,
            s.editing ? '✅ ذخیرهٔ تغییرات' : '✅ ساخت یادآور',
            'confirm',
          ),
        ],
        [
          button(s, '✏️ نام', 'edit_name'),
          button(s, '📦 محتوا', 'edit_content'),
        ],
        [
          button(s, '🕓 زمان‌بندی‌ها', 'edit_rules'),
          button(s, '📍 مقصدها', 'targets'),
        ],
      );
      text += `\nرفتار زمان‌های ازدست‌رفته: ${{ LATEST_ONLY: 'فقط آخرین نوبت', SKIP: 'رد کردن', CATCH_UP: 'جبران محدود' }[s.draft.missedPolicy ?? 'LATEST_ONLY']}`;
      if (s.editing)
        text = text.replace(
          'با تأیید، یادآور فعال می‌شود و ارسال طبق زمان‌بندی انجام خواهد شد.',
          'با ذخیره، تغییرات اعمال می‌شود و وضعیت توقف/فعالیت حفظ خواهد شد.',
        );
      if (s.editing)
        text +=
          '\nاین یک پیش‌نویس ویرایش است؛ ذخیره، وضعیت توقف/فعالیت را تغییر نمی‌دهد. شمارندهٔ زمان‌بندی‌های بدون تغییر حفظ می‌شود؛ زمان‌بندی جدید یا اصلاح‌شده شمارش تازه دارد.';
      buttons.push([
        button(s, 'منطقهٔ زمانی', 'timezone'),
        button(s, 'زمان‌های ازدست‌رفته', 'missed_policy'),
      ]);
      break;
    }
  }
  buttons.push([button(s, '❌ لغو', 'cancel')]);
  return {
    text: `${notice ? notice + '\n\n' : ''}${text}\n\n/cancel برای لغو`,
    buttons,
  };
}
