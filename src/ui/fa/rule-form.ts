import { Temporal } from '@js-temporal/polyfill';
import type { Builder } from '../../app/wizard/model.js';
import {
  validateNewRule,
  ruleSchema,
  type Rule,
} from '../../domain/schedule/rule.js';
import {
  localInstant,
  endOfLocalDate,
  nextOccurrence,
} from '../../domain/schedule/recurrence.js';
import { normalizeDigits } from './normalize.js';

export const weekdays = [
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
  'شنبه',
  'یکشنبه',
];
export const ruleNames = {
  ONE_TIME: 'فقط یک بار',
  EVERY_N_DAYS: 'هر چند روز',
  WEEKLY: 'هفتگی',
  MONTHLY: 'ماهانه',
  YEARLY: 'سالانه',
  INTERVAL: 'فاصله‌ای',
};
export function builderFromRule(rule: Rule, timezone: string): Builder {
  const b: Builder = { type: rule.type, values: {}, weekdays: [], index: 0 };
  if (rule.type === 'ONE_TIME' || rule.type === 'INTERVAL') {
    const local = Temporal.Instant.from(
      rule.type === 'ONE_TIME' ? rule.at : rule.anchorAt,
    ).toZonedDateTimeISO(timezone);
    b.values.date = local.toPlainDate().toString();
    b.values.time = local.toPlainTime().toString({ smallestUnit: 'minute' });
    if (rule.type === 'INTERVAL') {
      b.values.unit = rule.unit;
      b.values.amount = String(rule.amount);
    }
  } else {
    b.values.date = rule.anchorDate;
    b.values.time = rule.localTime;
    if (rule.type === 'YEARLY') {
      b.values.year = rule.anchorDate.slice(0, 4);
      b.values.month = String(rule.month);
      b.values.day = String(rule.day);
    } else b.values.every = String(rule.every);
    if (rule.type === 'WEEKLY') b.weekdays = [...rule.weekdays];
    if (rule.type === 'MONTHLY') {
      b.values.pattern = rule.pattern.type;
      if (rule.pattern.type === 'DAY') b.values.day = String(rule.pattern.day);
      else {
        b.values.nth = String(rule.pattern.nth);
        b.values.weekday = String(rule.pattern.weekday);
      }
    }
  }
  if (rule.type !== 'ONE_TIME') {
    b.values.end = rule.end.type;
    if (rule.end.type === 'AFTER_N_EXECUTIONS')
      b.values.count = String(rule.end.count);
    if (rule.end.type === 'UNTIL_DATE')
      b.values.until = Temporal.Instant.from(rule.end.at)
        .toZonedDateTimeISO(timezone)
        .toPlainDate()
        .toString();
  }
  return b;
}
export type Field =
  | 'date'
  | 'time'
  | 'every'
  | 'weekdays'
  | 'pattern'
  | 'day'
  | 'nth'
  | 'weekday'
  | 'month'
  | 'year'
  | 'unit'
  | 'amount'
  | 'end'
  | 'until'
  | 'count';
export function fields(b: Builder): Field[] {
  const base: Record<Rule['type'], Field[]> = {
    ONE_TIME: ['date', 'time'],
    EVERY_N_DAYS: ['every', 'time', 'date'],
    WEEKLY: ['weekdays', 'every', 'time', 'date'],
    MONTHLY: [
      'pattern',
      ...(b.values.pattern === 'NTH_WEEKDAY'
        ? (['nth', 'weekday'] as Field[])
        : (['day'] as Field[])),
      'every',
      'time',
      'date',
    ],
    YEARLY: ['month', 'day', 'time', 'year'],
    INTERVAL: ['unit', 'amount', 'date', 'time'],
  };
  return [
    ...base[b.type],
    ...(b.type === 'ONE_TIME' ? [] : (['end'] as Field[])),
    ...(b.values.end === 'UNTIL_DATE'
      ? (['until'] as Field[])
      : b.values.end === 'AFTER_N_EXECUTIONS'
        ? (['count'] as Field[])
        : []),
  ];
}
export function question(b: Builder): {
  text: string;
  options: [string, string][];
} {
  const field = fields(b)[b.index];
  const prompts: Record<Field, string> = {
    date:
      b.type === 'WEEKLY'
        ? 'این چرخه از کدام تاریخ حساب شود؟ تاریخ میلادی YYYY-MM-DD'
        : 'تاریخ شروع/اولین اجرا؟ تاریخ میلادی YYYY-MM-DD (مثلاً 2026-10-09)',
    time: 'چه ساعتی؟ با قالب HH:mm، مثلاً 18:30 (به وقت انتخاب‌شده)',
    every:
      b.type === 'WEEKLY'
        ? 'هر چند هفته؟'
        : b.type === 'MONTHLY'
          ? 'هر چند ماه؟'
          : 'هر چند روز؟',
    weekdays: 'چه روزهایی؟ انتخاب کنید و «ادامه» را بزنید.',
    pattern: 'کدام الگوی ماهانه؟',
    day: 'روز چندم ماه؟',
    nth: 'کدام نوبت از روز هفته؟',
    weekday: 'کدام روز هفته؟',
    month: 'ماه چندم میلادی؟ (۱ تا ۱۲)',
    year: 'شروع از کدام سال میلادی؟ (مثلاً 2026)',
    unit: 'فاصله بر حسب چه واحدی؟',
    amount: 'هر چند واحد؟',
    end: 'تا چه زمانی تکرار شود؟',
    until: 'تا چه تاریخی؟ میلادی YYYY-MM-DD؛ پایان همان روز شامل می‌شود.',
    count: 'بعد از چند اجرا پایان یابد؟',
  };
  const options: Partial<Record<Field, [string, string][]>> = {
    pattern: [
      ['روز عددی ماه', 'DAY'],
      ['موقعیت روز هفته', 'NTH_WEEKDAY'],
    ],
    nth: [
      ['اول', '1'],
      ['دوم', '2'],
      ['سوم', '3'],
      ['چهارم', '4'],
      ['آخر', '-1'],
    ],
    weekday: weekdays.map((w, i) => [w, String(i + 1)]),
    weekdays: [
      ...weekdays.map((w, i): [string, string] => [
        `${b.weekdays.includes(i + 1) ? '☑' : '☐'} ${w}`,
        String(i + 1),
      ]),
      ['ادامه', 'done'],
    ],
    unit: [
      ['ساعت', 'HOURS'],
      ['روز', 'DAYS'],
      ['هفته', 'WEEKS'],
    ],
    end: [
      ['نامحدود', 'UNLIMITED'],
      ['تا تاریخ', 'UNTIL_DATE'],
      ['بعد از چند اجرا', 'AFTER_N_EXECUTIONS'],
    ],
  };
  if (!field) throw new Error('Form complete');
  return { text: prompts[field], options: options[field] ?? [] };
}
export function answer(b: Builder, raw: string, choice: boolean): Builder {
  const next = structuredClone(b);
  const field = fields(next)[next.index];
  if (!field) throw new Error('فرم کامل شده است.');
  const value = normalizeDigits(raw.trim());
  const options = question(next).options;
  if (options.length && (!choice || !options.some(([, v]) => v === value)))
    throw new Error('لطفاً از دکمه‌های همین مرحله انتخاب کنید.');
  if (!options.length && choice)
    throw new Error('پاسخ را به‌صورت متن بفرستید.');
  if (field === 'weekdays') {
    if (value === 'done') {
      if (!next.weekdays.length) throw new Error('حداقل یک روز انتخاب کنید.');
      next.index++;
    } else {
      const day = Number(value);
      next.weekdays = next.weekdays.includes(day)
        ? next.weekdays.filter((d) => d !== day)
        : [...next.weekdays, day].sort((a, b) => a - b);
    }
    return next;
  }
  if (field === 'date' || field === 'until') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error('تاریخ میلادی را با قالب YYYY-MM-DD وارد کنید.');
    try {
      Temporal.PlainDate.from(value, { overflow: 'reject' });
    } catch {
      throw new Error('این تاریخ معتبر نیست.');
    }
  } else if (field === 'time') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
      throw new Error('ساعت معتبر با قالب HH:mm وارد کنید.');
  } else if (!options.length) {
    const number = Number(value);
    const max =
      field === 'month'
        ? 12
        : field === 'day'
          ? 31
          : field === 'year'
            ? 9999
            : 10000;
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < (field === 'year' ? 1900 : 1) ||
      number > max
    )
      throw new Error(`عدد معتبر تا ${max} وارد کنید.`);
    if (field === 'day' && next.type === 'YEARLY') {
      try {
        Temporal.PlainDate.from(
          { year: 2000, month: Number(next.values.month), day: number },
          { overflow: 'reject' },
        );
      } catch {
        throw new Error('این روز در ماه انتخاب‌شده وجود ندارد.');
      }
    }
  }
  next.values[field] = value;
  next.index++;
  return next;
}
export function buildRule(
  b: Builder,
  timezone: string,
  now: string,
  allowExpired = false,
): Rule {
  const v = b.values;
  const end =
    v.end === 'UNTIL_DATE'
      ? { type: v.end, at: endOfLocalDate(v.until!, timezone) }
      : v.end === 'AFTER_N_EXECUTIONS'
        ? { type: v.end, count: Number(v.count) }
        : { type: 'UNLIMITED' };
  const calendar = { anchorDate: v.date, localTime: v.time, end };
  const variants = {
    ONE_TIME: () => ({
      type: b.type,
      at: localInstant(v.date!, v.time!, timezone),
    }),
    EVERY_N_DAYS: () => ({ type: b.type, ...calendar, every: Number(v.every) }),
    WEEKLY: () => ({
      type: b.type,
      ...calendar,
      every: Number(v.every),
      weekdays: b.weekdays,
    }),
    MONTHLY: () => ({
      type: b.type,
      ...calendar,
      every: Number(v.every),
      pattern:
        v.pattern === 'DAY'
          ? { type: 'DAY', day: Number(v.day) }
          : {
              type: 'NTH_WEEKDAY',
              nth: Number(v.nth),
              weekday: Number(v.weekday),
            },
    }),
    YEARLY: () => ({
      type: b.type,
      ...calendar,
      anchorDate: `${v.year}-01-01`,
      month: Number(v.month),
      day: Number(v.day),
    }),
    INTERVAL: () => ({
      type: b.type,
      anchorAt: localInstant(v.date!, v.time!, timezone),
      unit: v.unit,
      amount: Number(v.amount),
      end,
    }),
  };
  try {
    const rule = allowExpired
      ? ruleSchema.parse(variants[b.type]())
      : validateNewRule(variants[b.type](), now);
    if (
      !allowExpired &&
      !nextOccurrence(rule, now, { timezone, calendarSystem: 'gregorian' })
    )
      throw new Error('No upcoming occurrence');
    return rule;
  } catch {
    throw new Error(
      'این زمان‌بندی اجرای آیندهٔ معتبری ندارد؛ تاریخ، ساعت و پایان را اصلاح کنید.',
    );
  }
}
export function formatInstant(at: string, timezone: string): string {
  return Temporal.Instant.from(at)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' })
    .replace('T', ' ');
}
export function describeRule(rule: Rule, timezone: string): string {
  let text: string;
  switch (rule.type) {
    case 'ONE_TIME':
      return `یک بار: ${formatInstant(rule.at, timezone)}`;
    case 'EVERY_N_DAYS':
      text = `هر ${rule.every} روز، ${rule.localTime}، از ${rule.anchorDate}`;
      break;
    case 'WEEKLY':
      text = `${rule.weekdays.map((d) => weekdays[d - 1]).join('، ')}، هر ${rule.every} هفته، ${rule.localTime}، از ${rule.anchorDate}`;
      break;
    case 'MONTHLY':
      text = `${rule.pattern.type === 'DAY' ? `روز ${rule.pattern.day}` : `${rule.pattern.nth === -1 ? 'آخرین' : ['', 'اولین', 'دومین', 'سومین', 'چهارمین'][rule.pattern.nth]} ${weekdays[rule.pattern.weekday - 1]}`}، هر ${rule.every} ماه، ${rule.localTime}، از ${rule.anchorDate}`;
      break;
    case 'YEARLY':
      text = `سالانه ${rule.month}/${rule.day}، ${rule.localTime}، از ${rule.anchorDate}`;
      break;
    case 'INTERVAL':
      text = `هر ${rule.amount} ${{ HOURS: 'ساعت', DAYS: 'روز', WEEKS: 'هفته' }[rule.unit]}، از ${formatInstant(rule.anchorAt, timezone)}`;
      break;
  }
  return `${text}؛ ${rule.end.type === 'UNLIMITED' ? 'نامحدود' : rule.end.type === 'AFTER_N_EXECUTIONS' ? `بعد از ${rule.end.count} اجرا پایان` : `تا ${formatInstant(rule.end.at, timezone)}`}`;
}
