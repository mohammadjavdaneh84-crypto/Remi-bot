import { Temporal } from '@js-temporal/polyfill';
import { nextOccurrence } from './recurrence.js';
import type { Rule, ScheduleContext } from './rule.js';

export type MissedPolicy = 'SKIP' | 'LATEST_ONLY' | 'CATCH_UP';
export interface CursorPlan {
  occurrences: string[];
  nextDueAt: string | null;
  consumedCount: number;
  blocked: boolean;
}

/** Finds the last occurrence without walking an arbitrarily long outage. */
function latest(
  rule: Rule,
  first: string,
  now: string,
  context: ScheduleContext,
  count: number,
): string {
  let low = Temporal.Instant.from(first).epochNanoseconds;
  let high = Temporal.Instant.from(now).epochNanoseconds;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    const candidate = nextOccurrence(
      rule,
      Temporal.Instant.fromEpochNanoseconds(middle).toString(),
      context,
      count,
    );
    if (candidate && Temporal.Instant.compare(candidate, now) <= 0) {
      low = Temporal.Instant.from(candidate).epochNanoseconds;
    } else high = middle;
  }
  return Temporal.Instant.fromEpochNanoseconds(low).toString();
}

/** Current UTC minute is on-time; older minutes use the version's missed policy. */
export function planDue(
  rule: Rule,
  context: ScheduleContext,
  nextDueAt: string | null,
  consumedCount: number,
  now: string,
  policy: MissedPolicy,
  catchUpLimit: number,
): CursorPlan {
  if (
    !Number.isInteger(catchUpLimit) ||
    catchUpLimit < 1 ||
    catchUpLimit > 1000
  )
    throw new RangeError('Catch-up limit must be 1..1000');
  if (!['SKIP', 'LATEST_ONLY', 'CATCH_UP'].includes(policy))
    throw new RangeError('Invalid missed policy');
  const result: CursorPlan = {
    occurrences: [],
    nextDueAt,
    consumedCount,
    blocked: false,
  };
  if (!nextDueAt || Temporal.Instant.compare(nextDueAt, now) > 0) return result;
  const currentMinute = Temporal.Instant.from(now).round({
    smallestUnit: 'minute',
    roundingMode: 'floor',
  });
  if (
    policy === 'SKIP' &&
    Temporal.Instant.compare(nextDueAt, currentMinute) < 0
  ) {
    nextDueAt = nextOccurrence(
      rule,
      currentMinute.subtract({ nanoseconds: 1 }).toString(),
      context,
      consumedCount,
    );
  }
  if (policy === 'LATEST_ONLY' && nextDueAt)
    nextDueAt = latest(rule, nextDueAt, now, context, consumedCount);
  while (nextDueAt && Temporal.Instant.compare(nextDueAt, now) <= 0) {
    result.occurrences.push(Temporal.Instant.from(nextDueAt).toString());
    result.consumedCount++;
    nextDueAt = nextOccurrence(rule, nextDueAt, context, result.consumedCount);
    if (
      policy === 'CATCH_UP' &&
      result.occurrences.length >= catchUpLimit &&
      nextDueAt &&
      Temporal.Instant.compare(nextDueAt, now) <= 0
    ) {
      result.blocked = true;
      break;
    }
  }
  result.nextDueAt = nextDueAt;
  return result;
}
