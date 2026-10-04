import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDue } from '../src/domain/schedule/production.js';
import type { Rule } from '../src/domain/schedule/rule.js';
import { startScheduler } from '../src/app/scheduler/loop.js';
const context = { timezone: 'UTC', calendarSystem: 'gregorian' as const };
const daily: Rule = {
  type: 'EVERY_N_DAYS',
  anchorDate: '2026-10-01',
  localTime: '12:00',
  every: 1,
  end: { type: 'UNLIMITED' },
};
const first = '2026-10-01T12:00:00Z';
test('latest skips old dates without consuming them and retains anchor', () => {
  assert.deepEqual(
    planDue(
      daily,
      context,
      first,
      2,
      '2026-10-05T12:00:10Z',
      'LATEST_ONLY',
      10,
    ),
    {
      occurrences: ['2026-10-05T12:00:00Z'],
      consumedCount: 3,
      nextDueAt: '2026-10-06T12:00:00Z',
      blocked: false,
    },
  );
});
test('skip discards older minutes but emits current-minute occurrence with polling delay', () => {
  const skipped = planDue(
    daily,
    context,
    first,
    0,
    '2026-10-05T11:00:00Z',
    'SKIP',
    10,
  );
  assert.deepEqual(skipped.occurrences, []);
  assert.equal(skipped.consumedCount, 0);
  assert.equal(skipped.nextDueAt, '2026-10-05T12:00:00Z');
  assert.deepEqual(
    planDue(daily, context, first, 0, '2026-10-05T12:00:59.999Z', 'SKIP', 10)
      .occurrences,
    ['2026-10-05T12:00:00Z'],
  );
  assert.deepEqual(
    planDue(daily, context, first, 0, '2026-10-05T12:01:00Z', 'SKIP', 10)
      .occurrences,
    [],
  );
});
test('catch-up ordered, capped, retains backlog and count counts actual executions', () => {
  const plan = planDue(
    daily,
    context,
    first,
    0,
    '2026-10-05T12:00:00Z',
    'CATCH_UP',
    2,
  );
  assert.deepEqual(plan.occurrences, [first, '2026-10-02T12:00:00Z']);
  assert.equal(plan.nextDueAt, '2026-10-03T12:00:00Z');
  assert.equal(plan.blocked, true);
  assert.equal(plan.consumedCount, 2);
  assert.equal(
    planDue(daily, context, first, 0, '2026-10-02T12:00:00Z', 'CATCH_UP', 2)
      .blocked,
    false,
  );
});
test('count exhaustion and expired until conditions', () => {
  const counted: Rule = {
    ...daily,
    end: { type: 'AFTER_N_EXECUTIONS', count: 3 },
  };
  const plan = planDue(
    counted,
    context,
    first,
    2,
    '2026-10-10T12:00:00Z',
    'LATEST_ONLY',
    10,
  );
  assert.equal(plan.nextDueAt, null);
  assert.equal(plan.consumedCount, 3);
  assert.equal(plan.occurrences[0], '2026-10-10T12:00:00Z');
  const until: Rule = {
    ...daily,
    end: { type: 'UNTIL_DATE', at: '2026-10-03T12:00:00Z' },
  };
  assert.deepEqual(
    planDue(until, context, first, 0, '2026-10-10T12:00:00Z', 'LATEST_ONLY', 10)
      .occurrences,
    ['2026-10-03T12:00:00Z'],
  );
});
test('latest handles decades of interval backlog without enumerating it', () => {
  const interval: Rule = {
    type: 'INTERVAL',
    anchorAt: '1970-01-01T00:00:00Z',
    amount: 1,
    unit: 'HOURS',
    end: { type: 'UNLIMITED' },
  };
  const plan = planDue(
    interval,
    context,
    interval.anchorAt,
    0,
    '2026-10-03T12:34:56Z',
    'LATEST_ONLY',
    10,
  );
  assert.deepEqual(plan.occurrences, ['2026-10-03T12:00:00Z']);
});
test('latest respects monthly invalid dates, timezone and DST', () => {
  const monthly: Rule = {
    type: 'MONTHLY',
    anchorDate: '2026-01-01',
    localTime: '12:00',
    every: 1,
    pattern: { type: 'DAY', day: 31 },
    end: { type: 'UNLIMITED' },
  };
  assert.deepEqual(
    planDue(
      monthly,
      context,
      '2026-01-31T12:00:00Z',
      0,
      '2026-04-30T12:00:00Z',
      'LATEST_ONLY',
      10,
    ).occurrences,
    ['2026-03-31T12:00:00Z'],
  );
  const dst: Rule = { ...daily, anchorDate: '2026-03-01', localTime: '02:30' };
  assert.deepEqual(
    planDue(
      dst,
      { ...context, timezone: 'America/New_York' },
      '2026-03-01T07:30:00Z',
      0,
      '2026-03-08T08:00:00Z',
      'LATEST_ONLY',
      10,
    ).occurrences,
    ['2026-03-08T07:30:00Z'],
  );
});
test('one-time skip/exhaustion, future and null cursor', () => {
  const once: Rule = { type: 'ONE_TIME', at: first };
  assert.equal(
    planDue(once, context, first, 0, '2026-10-03T00:00:00Z', 'SKIP', 10)
      .nextDueAt,
    null,
  );
  assert.equal(
    planDue(once, context, first, 0, first, 'LATEST_ONLY', 10).nextDueAt,
    null,
  );
  assert.equal(
    planDue(once, context, first, 0, '2026-09-01T00:00:00Z', 'LATEST_ONLY', 10)
      .consumedCount,
    0,
  );
  assert.deepEqual(
    planDue(once, context, null, 1, first, 'CATCH_UP', 10).occurrences,
    [],
  );
  assert.throws(() => planDue(once, context, first, 0, first, 'CATCH_UP', 0));
});
test('loop drains in-flight tick on stop without overlapping another tick', async () => {
  let release!: () => void,
    calls = 0,
    stopped = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = startScheduler(
    {
      tick: async () => {
        calls++;
        await pending;
        return { reminders: 1, executions: 1, blockedRules: 0 };
      },
    },
    1,
    () => {},
  );
  const stop = loop.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  assert.equal(calls, 1);
});
test('loop reports failure and catch-up hold, then can stop while waiting', async () => {
  let calls = 0,
    finish!: () => void;
  const reported = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const loop = startScheduler(
    {
      tick: async () => {
        if (++calls === 1) throw new Error('private DB error');
        return { reminders: 1, executions: 1, blockedRules: 1 };
      },
    },
    1,
    (event) => {
      events.push(event);
      if (events.length === 2) finish();
    },
  );
  await reported;
  await loop.stop();
  assert.deepEqual(events, ['scheduler.failed', 'scheduler.catch_up_blocked']);
});
