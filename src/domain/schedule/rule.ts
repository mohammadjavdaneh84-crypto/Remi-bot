import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const instantSchema = z.string().refine((v) => {
  try {
    Temporal.Instant.from(v);
    return true;
  } catch {
    return false;
  }
}, 'Expected an ISO instant with offset');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      Temporal.PlainDate.from(v, { overflow: 'reject' });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid Gregorian date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const positive = z.number().int().positive().max(10000);
const weekday = z.number().int().min(1).max(7); // ISO Monday=1
export const timezoneSchema = z.string().refine((v) => {
  try {
    return !/^[+-]/.test(v) && !!Temporal.Now.instant().toZonedDateTimeISO(v);
  } catch {
    return false;
  }
}, 'Expected an IANA timezone');
export const endSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('UNLIMITED') }),
  z.strictObject({ type: z.literal('UNTIL_DATE'), at: instantSchema }),
  z.strictObject({ type: z.literal('AFTER_N_EXECUTIONS'), count: positive }),
]);
const calendar = { anchorDate: date, localTime: time };
export const ruleSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ONE_TIME'), at: instantSchema }),
    z.strictObject({
      type: z.literal('EVERY_N_DAYS'),
      ...calendar,
      every: positive,
      end: endSchema,
    }),
    z.strictObject({
      type: z.literal('WEEKLY'),
      ...calendar,
      every: positive,
      weekdays: z
        .array(weekday)
        .min(1)
        .max(7)
        .refine((v) => new Set(v).size === v.length),
      end: endSchema,
    }),
    z.strictObject({
      type: z.literal('MONTHLY'),
      ...calendar,
      every: positive,
      pattern: z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('DAY'),
          day: z.number().int().min(1).max(31),
        }),
        z.strictObject({
          type: z.literal('NTH_WEEKDAY'),
          weekday,
          nth: z.union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(-1),
          ]),
        }),
      ]),
      end: endSchema,
    }),
    z.strictObject({
      type: z.literal('YEARLY'),
      ...calendar,
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      end: endSchema,
    }),
    z.strictObject({
      type: z.literal('INTERVAL'),
      anchorAt: instantSchema,
      amount: positive,
      unit: z.enum(['HOURS', 'DAYS', 'WEEKS']),
      end: endSchema,
    }),
  ])
  .superRefine((rule, ctx) => {
    if (rule.type === 'YEARLY') {
      try {
        Temporal.PlainDate.from(
          { year: 2000, month: rule.month, day: rule.day },
          { overflow: 'reject' },
        );
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Date never exists in Gregorian calendar',
        });
      }
    }
  });
export type Rule = z.infer<typeof ruleSchema>;
export interface ScheduleRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly config: Rule;
}
export interface ScheduleContext {
  readonly timezone: string;
  readonly calendarSystem: 'gregorian';
}

/** Creation-time validation is separate: persisted one-time rules naturally become past. */
export function validateNewRule(input: unknown, now: string): Rule {
  const rule = ruleSchema.parse(input);
  if (rule.type === 'ONE_TIME' && Temporal.Instant.compare(rule.at, now) <= 0) {
    throw new RangeError('One-time occurrence must be in the future');
  }
  return rule;
}
