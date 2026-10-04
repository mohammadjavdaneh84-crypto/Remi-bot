import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { Targets } from '../services/targets.js';
import type { Archive } from '../../domain/content/archive.js';
import { validateNewRule, timezoneSchema } from '../../domain/schedule/rule.js';
import { isDeepStrictEqual } from 'node:util';
import { nextOccurrence } from '../../domain/schedule/recurrence.js';
import {
  answer,
  buildRule,
  fields,
  ruleNames,
  builderFromRule,
} from '../../ui/fa/rule-form.js';
import { wizardView } from '../../ui/fa/wizard-view.js';
import type { Session, View, WizardInput, WizardRepository } from './model.js';

export interface WizardCapture {
  archive(
    payloads: readonly unknown[],
  ): Promise<{ ok: true; archive: Archive } | { ok: false; message: string }>;
}
const plain = (text: string): View => ({ text, buttons: [] });
const numericIndex = (value: string, length: number) =>
  /^\d+$/.test(value) && Number(value) < length ? Number(value) : -1;

export class CreationWizard {
  constructor(
    private readonly ownerId: string,
    private readonly repository: WizardRepository,
    private readonly targets: Targets,
    private readonly capture: WizardCapture,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly onError: () => void = () => {},
  ) {}

  async handle(updateId: number, input: WizardInput): Promise<View | null> {
    try {
      return await this.repository.run(this.ownerId, updateId, async (tx) => {
        const now = this.clock();
        let s = await tx.current(now);
        if (input.type === 'edit') {
          if (s)
            return wizardView(
              s,
              now,
              'یک پیش‌نویس باز دارید؛ آن را کامل یا با /cancel لغو کنید.',
            );
          if (!tx.edit) throw new Error('Editing unavailable');
          s = await tx.edit(input.reminderId, now);
          return wizardView(
            s,
            now,
            'ویرایش پیش‌نویس؛ یادآور فعلی تا ذخیره تغییر نمی‌کند.',
          );
        }
        if (input.type === 'start') {
          if (!s) s = await tx.create(now);
          return wizardView(
            s,
            now,
            s.editing
              ? 'ادامهٔ ویرایش؛ یادآور فعلی تا ذخیره تغییر نمی‌کند.'
              : 'ساخت یادآور؛ تاریخ‌ها فعلاً میلادی هستند.',
          );
        }
        if (!s)
          return plain(
            input.type === 'cancel'
              ? 'پیش‌نویس فعالی وجود ندارد.'
              : 'این مرحله پایان یافته یا منقضی شده است؛ برای ساخت یا ادامه /new را بزنید.',
          );
        if (input.type === 'message') {
          if (s.step === 'CONTENT') input = { ...input, type: 'content' };
          else if (input.text !== null)
            input = { type: 'text', text: input.text };
          else
            return wizardView(
              s,
              now,
              'در این مرحله پاسخ متنی یا دکمه لازم است؛ دریافت محتوا پایان یافته است.',
            );
        }
        let action = '',
          arg = '';
        if (input.type === 'callback') {
          const parsed =
            /^w:([A-Za-z0-9_-]{8}):(\d+):([a-z_]+)(?::([A-Za-z0-9_-]+))?$/.exec(
              input.data,
            );
          if (
            !parsed ||
            parsed[1] !== s.token ||
            Number(parsed[2]) !== s.revision
          )
            return wizardView(
              s,
              now,
              'این دکمه قدیمی یا نامعتبر است؛ از دکمه‌های زیر استفاده کنید.',
            );
          action = parsed[3]!;
          arg = parsed[4] ?? '';
        }
        if (input.type === 'cancel' || action === 'cancel') {
          s.status = 'CANCELLED';
          s.revision++;
          await tx.save(s);
          return plain('پیش‌نویس لغو شد؛ یادآورهای فعال تغییری نکردند.');
        }
        let notice = '';
        if (input.type === 'content') {
          const content = input;
          if (s.step !== 'CONTENT')
            return wizardView(s, now, 'اکنون مرحلهٔ دریافت محتوا نیست.');
          if (s.draft.pending.some((p) => p.messageId === content.messageId))
            return null;
          if (
            s.draft.pending.length +
              s.draft.archives.reduce((n, a) => n + a.count, 0) -
              (s.work.replacingContent != null
                ? (s.draft.archives[s.work.replacingContent]?.count ?? 0)
                : 0) >=
            100
          )
            return wizardView(
              s,
              now,
              'حداکثر ۱۰۰ آیتم در این نسخه قابل دریافت است.',
            );
          s.draft.pending.push({
            messageId: input.messageId,
            groupKey: input.groupKey,
            payload: input.payload,
            receivedAt: now,
            failed: false,
          });
          await tx.save(s); // no revision bump: the content-done button remains usable while collecting an album.
          if (
            content.groupKey &&
            s.draft.pending.filter((p) => p.groupKey === content.groupKey)
              .length > 1
          )
            return null;
          return wizardView(s, now, 'پیام دریافت شد.');
        }
        if (input.type === 'text') {
          if (s.step === 'NAME') {
            const name = input.text.trim();
            if (!name || name.length > 100)
              return wizardView(s, now, 'نام باید بین ۱ تا ۱۰۰ نویسه باشد.');
            s.draft.name = name;
            s.step = s.work.nameReturn ? 'PREVIEW' : 'CONTENT';
            s.work.nameReturn = false;
          } else if (s.step === 'TIMEZONE') {
            const zone = timezoneSchema.safeParse(input.text.trim());
            if (!zone.success)
              return wizardView(
                s,
                now,
                'نام منطقهٔ زمانی معتبر لازم است؛ مثلاً Asia/Tehran.',
              );
            s.draft.timezone = zone.data;
            s.step = 'PREVIEW';
          } else if (s.step === 'RULE_FIELDS') {
            try {
              s.work.builder = answer(s.work.builder!, input.text, false);
            } catch (error) {
              return wizardView(s, now, (error as Error).message);
            }
            if (s.work.builder.index >= fields(s.work.builder).length)
              s.step = 'RULE_REVIEW';
          } else
            return wizardView(
              s,
              now,
              'برای این مرحله از دکمه‌ها استفاده کنید.',
            );
        } else if (input.type === 'callback') {
          const allowed: Record<Session['step'], string[]> = {
            NAME: [],
            CONTENT: [
              'content_done',
              'drop_failed',
              'reset_content',
              'content_remove',
              'content_up',
              'content_down',
              'content_replace',
              'content_caption',
              'content_page',
              'content_abort',
            ],
            RULE_TYPE: ['type'],
            RULE_FIELDS: ['answer', 'field_back', 'keep'],
            RULE_REVIEW: ['rule_save', 'rule_edit'],
            RULE_LIST: [
              'rule_add',
              'rule_remove',
              'targets',
              'rule_change',
              'rule_duplicate',
              'rule_toggle',
            ],
            TIMEZONE: [],
            POLICY: ['policy'],
            TARGETS: ['target', 'page', 'preview'],
            PREVIEW: [
              'confirm',
              'edit_name',
              'edit_content',
              'edit_rules',
              'targets',
              'timezone',
              'missed_policy',
            ],
          };
          if (!allowed[s.step].includes(action))
            return wizardView(s, now, 'این دکمه برای مرحلهٔ فعلی معتبر نیست.');
          switch (action) {
            case 'content_page':
              if (!/^\d+$/.test(arg) || Number(arg) > 9)
                return wizardView(s, now, 'صفحه نامعتبر است.');
              s.work.contentPage = Number(arg);
              break;
            case 'content_abort':
              s.work.replacingContent = null;
              s.draft.pending = [];
              notice = 'دریافت جایگزین لغو شد؛ محتوای قبلی محفوظ است.';
              break;
            case 'timezone':
              s.step = 'TIMEZONE';
              break;
            case 'missed_policy':
              s.step = 'POLICY';
              break;
            case 'policy':
              if (!['LATEST_ONLY', 'SKIP', 'CATCH_UP'].includes(arg))
                return wizardView(s, now, 'گزینه نامعتبر است.');
              s.draft.missedPolicy = arg as NonNullable<
                Session['draft']['missedPolicy']
              >;
              s.step = 'PREVIEW';
              break;
            case 'content_remove':
            case 'content_up':
            case 'content_down':
            case 'content_replace':
            case 'content_caption': {
              const i = numericIndex(arg, s.draft.archives.length);
              if (
                i < 0 ||
                s.draft.pending.length ||
                s.work.replacingContent != null
              )
                return wizardView(
                  s,
                  now,
                  'ابتدا دریافت محتوای فعلی را تمام کنید.',
                );
              if (action === 'content_remove') s.draft.archives.splice(i, 1);
              else if (
                action === 'content_replace' ||
                action === 'content_caption'
              ) {
                s.work.replacingContent = i;
                notice =
                  action === 'content_caption'
                    ? 'پیام را با متن یا کپشن اصلاح‌شده دوباره بفرستید؛ برای آلبوم همهٔ اعضا را دوباره بفرستید. سپس پایان محتوا را بزنید. محتوای قبلی تا دریافت موفق حفظ می‌شود.'
                    : 'یک پیام جایگزین یا آلبوم کامل را بفرستید و پایان محتوا را بزنید. محتوای قبلی تا دریافت موفق حفظ می‌شود.';
              } else {
                const next = i + (action === 'content_up' ? -1 : 1);
                if (next >= 0 && next < s.draft.archives.length)
                  [s.draft.archives[i], s.draft.archives[next]] = [
                    s.draft.archives[next]!,
                    s.draft.archives[i]!,
                  ];
              }
              break;
            }
            case 'reset_content':
              s.work.replacingContent = null;
              s.draft.archives = [];
              s.draft.pending = [];
              notice = 'محتوای پیش‌نویس خالی شد؛ محتوای جایگزین را بفرستید.';
              break;
            case 'drop_failed':
              s.draft.pending = s.draft.pending.filter((p) => !p.failed);
              notice = 'موارد ناموفق از پیش‌نویس حذف شدند.';
              break;
            case 'content_done': {
              if (
                s.draft.pending.some(
                  (p) =>
                    p.groupKey &&
                    Temporal.Instant.from(now).epochMilliseconds -
                      Temporal.Instant.from(p.receivedAt).epochMilliseconds <
                      1500,
                )
              )
                return wizardView(
                  s,
                  now,
                  'آلبوم هنوز در حال دریافت است؛ چند لحظه بعد دوباره دکمهٔ پایان را بزنید.',
                );
              while (s.draft.pending.length) {
                s.draft.pending.sort((a, b) => a.messageId - b.messageId);
                const first = s.draft.pending[0]!;
                if (first.failed) {
                  notice =
                    'ابتدا موارد ناموفق را حذف و در صورت نیاز دوباره ارسال کنید.';
                  break;
                }
                const unit = first.groupKey
                  ? s.draft.pending.filter((p) => p.groupKey === first.groupKey)
                  : [first];
                const result = await this.capture.archive(
                  unit.map((p) => p.payload),
                );
                if (!result.ok) {
                  unit.forEach((p) => (p.failed = true));
                  notice = result.message;
                  break;
                }
                if (
                  result.archive.ownerId !== this.ownerId ||
                  result.archive.state !== 'READY' ||
                  result.archive.items.length !== unit.length
                )
                  throw new Error('Invalid archive result');
                const archived = {
                  id: result.archive.id,
                  count: result.archive.items.length,
                  kinds: [...new Set(result.archive.items.map((i) => i.kind))],
                };
                if (s.work.replacingContent != null) {
                  s.draft.archives.splice(s.work.replacingContent, 1, archived);
                  s.work.replacingContent = null;
                } else s.draft.archives.push(archived);
                const ids = new Set(unit.map((p) => p.messageId));
                s.draft.pending = s.draft.pending.filter(
                  (p) => !ids.has(p.messageId),
                );
              }
              if (s.work.replacingContent != null)
                notice ||= 'هنوز پیام جایگزین دریافت نشده است.';
              else if (!s.draft.pending.length && s.draft.archives.length)
                s.step = s.draft.rules.length ? 'RULE_LIST' : 'RULE_TYPE';
              else if (!notice) notice = 'حداقل یک پیام یا مدیا لازم است.';
              break;
            }
            case 'type':
              if (!Object.hasOwn(ruleNames, arg))
                return wizardView(s, now, 'نوع زمان‌بندی نامعتبر است.');
              s.work.builder = {
                type: arg as keyof typeof ruleNames,
                values: {},
                weekdays: [],
                index: 0,
              };
              s.step = 'RULE_FIELDS';
              break;
            case 'answer':
              try {
                s.work.builder = answer(s.work.builder!, arg, true);
              } catch (error) {
                return wizardView(s, now, (error as Error).message);
              }
              if (s.work.builder.index >= fields(s.work.builder).length)
                s.step = 'RULE_REVIEW';
              break;
            case 'keep': {
              const b = s.work.builder!;
              const field = fields(b)[b.index]!;
              const value = field === 'weekdays' ? 'done' : b.values[field];
              if (!value)
                return wizardView(s, now, 'برای این سؤال هنوز مقداری ندارید.');
              b.index++;
              if (b.index >= fields(b).length) s.step = 'RULE_REVIEW';
              break;
            }
            case 'field_back':
              s.work.builder!.index = Math.max(0, s.work.builder!.index - 1);
              break;
            case 'rule_edit':
              s.work.builder!.index = 0;
              s.step = 'RULE_FIELDS';
              break;
            case 'rule_save': {
              if (s.draft.rules.length >= 20 && s.work.editingRule == null)
                return wizardView(s, now, 'حداکثر ۲۰ زمان‌بندی قابل ساخت است.');
              try {
                const config = buildRule(
                  s.work.builder!,
                  s.draft.timezone,
                  now,
                  !!s.editing && s.work.editingRule != null,
                );
                if (
                  s.work.editingRule != null &&
                  !isDeepStrictEqual(
                    s.draft.rules[s.work.editingRule]!.config,
                    config,
                  )
                ) {
                  validateNewRule(config, now);
                  if (
                    !nextOccurrence(config, now, {
                      timezone: s.draft.timezone,
                      calendarSystem: 'gregorian',
                    })
                  )
                    throw new Error(
                      'زمان‌بندی اصلاح‌شده باید اجرای آینده داشته باشد.',
                    );
                }
                if (s.work.editingRule != null) {
                  const old = s.draft.rules[s.work.editingRule]!;
                  s.draft.rules[s.work.editingRule] = isDeepStrictEqual(
                    old.config,
                    config,
                  )
                    ? { ...old, config }
                    : { id: old.id, config, enabled: old.enabled !== false };
                } else s.draft.rules.push({ id: randomUUID(), config });
              } catch (error) {
                return wizardView(s, now, (error as Error).message);
              }
              s.work.builder = null;
              s.work.editingRule = null;
              s.step = 'RULE_LIST';
              break;
            }
            case 'rule_add':
              if (s.draft.rules.length >= 20)
                return wizardView(
                  s,
                  now,
                  'برای افزودن زمان‌بندی تازه، ابتدا یکی از ۲۰ زمان‌بندی موجود را حذف کنید.',
                );
              s.work.builder = null;
              s.work.editingRule = null;
              s.step = 'RULE_TYPE';
              break;
            case 'rule_change':
            case 'rule_duplicate':
            case 'rule_toggle': {
              const i = numericIndex(arg, s.draft.rules.length);
              if (i < 0) return wizardView(s, now, 'زمان‌بندی نامعتبر است.');
              const rule = s.draft.rules[i]!;
              if (action === 'rule_change') {
                s.work.editingRule = i;
                s.work.builder = builderFromRule(rule.config, s.draft.timezone);
                s.step = 'RULE_FIELDS';
              } else if (action === 'rule_toggle')
                rule.enabled = rule.enabled === false;
              else {
                if (s.draft.rules.length >= 20)
                  return wizardView(
                    s,
                    now,
                    'حداکثر ۲۰ زمان‌بندی قابل ساخت است.',
                  );
                s.draft.rules.push({
                  id: randomUUID(),
                  config: structuredClone(rule.config),
                  enabled: rule.enabled !== false,
                });
              }
              break;
            }
            case 'rule_remove': {
              const index = numericIndex(arg, s.draft.rules.length);
              if (index < 0)
                return wizardView(s, now, 'زمان‌بندی نامعتبر است.');
              s.draft.rules.splice(index, 1);
              break;
            }
            case 'edit_name':
              s.step = 'NAME';
              s.work.nameReturn = true;
              break;
            case 'edit_content':
              s.step = 'CONTENT';
              break;
            case 'edit_rules':
              s.step = 'RULE_LIST';
              break;
            case 'targets':
              if (!s.draft.rules.length)
                return wizardView(s, now, 'حداقل یک زمان‌بندی لازم است.');
              await this.targetPage(s, 0);
              s.step = 'TARGETS';
              break;
            case 'page':
              if (!/^\d+$/.test(arg) || Number(arg) > 10000)
                return wizardView(s, now, 'صفحه نامعتبر است.');
              await this.targetPage(s, Number(arg));
              break;
            case 'target': {
              const index = numericIndex(arg, s.work.targetOptions.length);
              if (index < 0) return wizardView(s, now, 'مقصد نامعتبر است.');
              const option = s.work.targetOptions[index]!;
              if (s.draft.targets.some((t) => t.id === option.id))
                s.draft.targets = s.draft.targets.filter(
                  (t) => t.id !== option.id,
                );
              else {
                if (s.draft.targets.length >= 20)
                  return wizardView(s, now, 'حداکثر ۲۰ مقصد قابل انتخاب است.');
                try {
                  const t = await this.targets.revalidate(
                    option.id,
                    s.draft.archives.flatMap((a) => a.kinds),
                  );
                  s.draft.targets.push({ id: t.id, title: t.title });
                } catch {
                  return wizardView(
                    s,
                    now,
                    'دسترسی ارسال این محتوا به مقصد تأیید نشد؛ مجوزها را بررسی کنید.',
                  );
                }
              }
              break;
            }
            case 'preview':
            case 'confirm': {
              try {
                await this.validate(s, now);
              } catch {
                return wizardView(
                  s,
                  now,
                  'پیش‌نویس قابل تأیید نیست؛ محتوا، زمان‌های آینده و دسترسی مقصدها را بررسی و اصلاح کنید.',
                );
              }
              if (action === 'confirm') {
                await tx.commit(s, this.clock());
                return plain(
                  s.editing
                    ? '✅ تغییرات ذخیره شد. وضعیت توقف یا فعالیت یادآور حفظ شد؛ برای مدیریت /reminders را بزنید.'
                    : '✅ یادآور ساخته و ذخیره شد.\nارسال طبق زمان‌بندی انجام می‌شود. نتیجه‌ها را با /history ببینید.',
                );
              }
              s.step = 'PREVIEW';
              break;
            }
          }
        }
        s.revision++;
        s.expiresAt = Temporal.Instant.from(now).add({ hours: 24 }).toString();
        await tx.save(s);
        return wizardView(s, now, notice);
      });
    } catch {
      this.onError();
      return plain(
        'عملیات موقتاً ناموفق بود؛ پیش‌نویس حفظ شده است. برای ادامه /new را بزنید.',
      );
    }
  }
  private async targetPage(s: Session, page: number) {
    const selected = [];
    for (const target of s.draft.targets) {
      const current = await this.targets.resolve(target.id);
      selected.push({ id: current.id, title: current.title });
    }
    s.draft.targets = [
      ...new Map(selected.map((target) => [target.id, target])).values(),
    ];
    const rows = await this.targets.list(page);
    s.work.page = page;
    s.work.hasNext = rows.length > 10;
    s.work.targetOptions = rows
      .slice(0, 10)
      .map((t) => ({ id: t.id, title: t.title }));
  }
  private async validate(s: Session, now: string) {
    if (
      !s.draft.name.trim() ||
      !s.draft.archives.length ||
      s.draft.pending.length ||
      !s.draft.rules.length ||
      !s.draft.targets.length
    )
      throw new Error('Incomplete');
    for (const rule of s.draft.rules) {
      if (
        rule.enabled === false ||
        (s.editing && rule.consumedCount !== undefined)
      )
        continue;
      validateNewRule(rule.config, now);
      if (
        !nextOccurrence(rule.config, now, {
          timezone: s.draft.timezone,
          calendarSystem: 'gregorian',
        })
      )
        throw new Error('No future occurrence');
    }
    const targets = [];
    for (const selected of s.draft.targets) {
      const t = await this.targets.revalidate(
        selected.id,
        s.draft.archives.flatMap((a) => a.kinds),
      );
      targets.push({ id: t.id, title: t.title });
    }
    s.draft.targets = [...new Map(targets.map((t) => [t.id, t])).values()];
  }
}
