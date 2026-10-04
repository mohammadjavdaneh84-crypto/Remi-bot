import { Temporal } from '@js-temporal/polyfill';
import {
  ruleSchema,
  timezoneSchema,
  type Rule,
  type ScheduleContext,
  type ScheduleRule,
} from './rule.js';

const compare = Temporal.Instant.compare;
const maxDate = (a: Temporal.PlainDate, b: Temporal.PlainDate) =>
  Temporal.PlainDate.compare(a, b) >= 0 ? a : b;

/** DST policy: earlier offset on overlap; shift forward by the gap on nonexistent time. */
export function localInstant(
  date: string,
  time: string,
  timezone: string,
): string {
  timezoneSchema.parse(timezone);
  return Temporal.PlainDate.from(date)
    .toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}

export function endOfLocalDate(date: string, timezone: string): string {
  timezoneSchema.parse(timezone);
  return Temporal.PlainDate.from(date)
    .add({ days: 1 })
    .toZonedDateTime(timezone)
    .toInstant()
    .subtract({ nanoseconds: 1 })
    .toString();
}

function candidate(
  rule: Rule,
  after: Temporal.Instant,
  zone: string,
): Temporal.Instant | null {
  if (rule.type === 'ONE_TIME')
    return compare(rule.at, after) > 0 ? Temporal.Instant.from(rule.at) : null;
  if (rule.type === 'INTERVAL') {
    const anchor = Temporal.Instant.from(rule.anchorAt);
    const step =
      BigInt(rule.amount) *
      BigInt({ HOURS: 3600, DAYS: 86400, WEEKS: 604800 }[rule.unit]) *
      1_000_000_000n;
    const delta = after.epochNanoseconds - anchor.epochNanoseconds;
    const n = delta < 0n ? 0n : delta / step + 1n;
    return Temporal.Instant.fromEpochNanoseconds(
      anchor.epochNanoseconds + n * step,
    );
  }
  const anchor = Temporal.PlainDate.from(rule.anchorDate);
  // Include yesterday: a full-day timezone gap can shift an occurrence into today.
  const search = maxDate(
    anchor,
    after.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 }),
  );
  const toInstant = (d: Temporal.PlainDate) =>
    Temporal.Instant.from(localInstant(d.toString(), rule.localTime, zone));
  let period = 0;
  if (rule.type === 'EVERY_N_DAYS')
    period = Math.max(0, Math.floor(anchor.until(search).days / rule.every));
  if (rule.type === 'WEEKLY') {
    const start = anchor.subtract({ days: anchor.dayOfWeek - 1 });
    period = Math.max(
      0,
      Math.floor(start.until(search).days / (7 * rule.every)),
    );
  }
  if (rule.type === 'MONTHLY')
    period = Math.max(
      0,
      Math.floor(
        ((search.year - anchor.year) * 12 + search.month - anchor.month) /
          rule.every,
      ),
    );
  if (rule.type === 'YEARLY') period = Math.max(0, search.year - anchor.year);
  // Gregorian patterns repeat within 4800 months (400 years), including sparse anchors.
  for (let tries = 0; tries < 4802; tries++, period++) {
    let dates: Temporal.PlainDate[] = [];
    switch (rule.type) {
      case 'EVERY_N_DAYS':
        dates = [anchor.add({ days: period * rule.every })];
        break;
      case 'WEEKLY': {
        const start = anchor
          .subtract({ days: anchor.dayOfWeek - 1 })
          .add({ weeks: period * rule.every });
        dates = [...rule.weekdays]
          .sort((a, b) => a - b)
          .map((day) => start.add({ days: day - 1 }));
        break;
      }
      case 'MONTHLY': {
        const first = anchor
          .with({ day: 1 })
          .add({ months: period * rule.every });
        const p = rule.pattern;
        let day: number;
        if (p.type === 'DAY') day = p.day;
        else if (p.nth === -1) {
          const last = first.with({ day: first.daysInMonth });
          day = last.day - ((last.dayOfWeek - p.weekday + 7) % 7);
        } else
          day = 1 + ((p.weekday - first.dayOfWeek + 7) % 7) + (p.nth - 1) * 7;
        if (day <= first.daysInMonth) dates = [first.with({ day })];
        break;
      }
      case 'YEARLY': {
        const first = Temporal.PlainDate.from({
          year: anchor.year + period,
          month: rule.month,
          day: 1,
        });
        if (rule.day <= first.daysInMonth)
          dates = [first.with({ day: rule.day })];
        break;
      }
    }
    for (const date of dates) {
      if (Temporal.PlainDate.compare(date, anchor) < 0) continue;
      const value = toInstant(date);
      if (compare(value, after) > 0) return value;
    }
  }
  return null; // e.g. every 12 months on February 31: no valid date in the cycle.
}

/** Strictly after `after`. consumedCount counts committed scheduled executions only. */
export function nextOccurrence(
  input: Rule,
  after: string,
  context: ScheduleContext,
  consumedCount = 0,
): string | null {
  const rule = ruleSchema.parse(input);
  timezoneSchema.parse(context.timezone);
  if (context.calendarSystem !== 'gregorian')
    throw new RangeError('Unsupported calendar');
  if (!Number.isSafeInteger(consumedCount) || consumedCount < 0)
    throw new RangeError('Invalid consumed count');
  const instant = Temporal.Instant.from(after);
  if (rule.type === 'ONE_TIME' && consumedCount > 0) return null;
  if (rule.type !== 'ONE_TIME') {
    if (
      rule.end.type === 'AFTER_N_EXECUTIONS' &&
      consumedCount >= rule.end.count
    )
      return null;
    if (rule.end.type === 'UNTIL_DATE' && compare(instant, rule.end.at) >= 0)
      return null;
  }
  const next = candidate(rule, instant, context.timezone);
  if (!next) return null;
  if (
    rule.type !== 'ONE_TIME' &&
    rule.end.type === 'UNTIL_DATE' &&
    compare(next, rule.end.at) > 0
  )
    return null;
  return next.toString();
}

export function nextOccurrences(
  rule: Rule,
  after: string,
  context: ScheduleContext,
  limit = 5,
  consumedCount = 0,
): string[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
    throw new RangeError('Limit must be 0..1000');
  const result: string[] = [];
  for (let i = 0; i < limit; i++) {
    const next = nextOccurrence(rule, after, context, consumedCount + i);
    if (!next) break;
    result.push(next);
    after = next;
  }
  return result;
}

export function preview(
  rules: readonly ScheduleRule[],
  after: string,
  context: ScheduleContext,
  limit = 5,
  counts: Readonly<Record<string, number>> = {},
): { scheduledFor: string; ruleIds: string[] }[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
    throw new RangeError('Limit must be 0..1000');
  if (new Set(rules.map((r) => r.id)).size !== rules.length)
    throw new RangeError('Duplicate rule IDs');
  const merged = new Map<string, string[]>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const at of nextOccurrences(
      rule.config,
      after,
      context,
      limit,
      counts[rule.id] ?? 0,
    )) {
      merged.set(at, [...(merged.get(at) ?? []), rule.id]);
    }
  }
  return [...merged]
    .sort(([a], [b]) => compare(a, b))
    .slice(0, limit)
    .map(([scheduledFor, ruleIds]) => ({ scheduledFor, ruleIds }));
}
