import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextOccurrence,
  nextOccurrences,
  preview,
  localInstant,
  endOfLocalDate,
} from '../src/domain/schedule/recurrence.js';
import {
  ruleSchema,
  validateNewRule,
  type Rule,
} from '../src/domain/schedule/rule.js';
import { normalizeDigits } from '../src/ui/fa/normalize.js';

const utc = { timezone: 'UTC', calendarSystem: 'gregorian' } as const;
const ny = { ...utc, timezone: 'America/New_York' };
const unlimited = { type: 'UNLIMITED' } as const;
const daily: Rule = {
  type: 'EVERY_N_DAYS',
  anchorDate: '2026-01-01',
  localTime: '18:00',
  every: 1,
  end: unlimited,
};
const monthly: Rule = {
  type: 'MONTHLY',
  anchorDate: '2026-01-01',
  localTime: '18:00',
  every: 1,
  pattern: { type: 'DAY', day: 31 },
  end: unlimited,
};
const weekly: Rule = {
  type: 'WEEKLY',
  anchorDate: '2026-10-09',
  localTime: '18:00',
  every: 2,
  weekdays: [5],
  end: unlimited,
};
const yearly: Rule = {
  type: 'YEARLY',
  anchorDate: '2026-01-01',
  localTime: '18:00',
  month: 2,
  day: 29,
  end: unlimited,
};
const interval: Rule = {
  type: 'INTERVAL',
  anchorAt: '2026-01-01T18:00:00Z',
  amount: 2,
  unit: 'HOURS',
  end: unlimited,
};
test('one-time future validates and past or equal is rejected', () => {
  const rule = { type: 'ONE_TIME', at: '2026-01-02T00:00:00Z' } as const;
  assert.deepEqual(validateNewRule(rule, '2026-01-01T00:00Z'), rule);
  assert.throws(() => validateNewRule(rule, rule.at));
  assert.throws(() => validateNewRule(rule, '2026-01-03T00:00Z'));
  assert.deepEqual(nextOccurrences(rule, '2026-01-01T00:00Z', utc), [rule.at]);
  assert.equal(nextOccurrence(rule, rule.at, utc), null);
  assert.equal(nextOccurrence(rule, '2026-01-01T00:00Z', utc, 1), null);
});
for (const every of [1, 2, 17])
  test(`daily ${every} preserves anchor`, () => {
    assert.equal(
      nextOccurrence({ ...daily, every }, '2026-01-01T18:00Z', utc),
      `2026-01-${String(every + 1).padStart(2, '0')}T18:00:00Z`,
    );
  });
test('Tehran timezone and lower anchor bound', () => {
  assert.equal(
    nextOccurrence(daily, '2025-01-01T00:00Z', {
      ...utc,
      timezone: 'Asia/Tehran',
    }),
    '2026-01-01T14:30:00Z',
  );
});
test('DST spring gap shifts forward deterministically', () => {
  assert.equal(
    localInstant('2026-03-08', '02:30', ny.timezone),
    '2026-03-08T07:30:00Z',
  );
  assert.deepEqual(
    nextOccurrences(
      { ...daily, anchorDate: '2026-03-07', localTime: '02:30' },
      '2026-03-07T00:00Z',
      ny,
      3,
    ),
    ['2026-03-07T07:30:00Z', '2026-03-08T07:30:00Z', '2026-03-09T06:30:00Z'],
  );
});
test('DST overlap picks first occurrence, never sends twice', () => {
  const rule = { ...daily, anchorDate: '2026-11-01', localTime: '01:30' };
  assert.equal(
    nextOccurrence(rule, '2026-11-01T00:00Z', ny),
    '2026-11-01T05:30:00Z',
  );
  assert.equal(
    nextOccurrence(rule, '2026-11-01T05:45:00Z', ny),
    '2026-11-02T06:30:00Z',
  );
});
test('weekly parity and strict resume keep original anchor', () => {
  assert.deepEqual(nextOccurrences(weekly, '2026-10-01T00:00Z', utc, 3), [
    '2026-10-09T18:00:00Z',
    '2026-10-23T18:00:00Z',
    '2026-11-06T18:00:00Z',
  ]);
  assert.equal(
    nextOccurrence(weekly, '2026-10-24T00:00Z', utc),
    '2026-11-06T18:00:00Z',
  );
});
test('weekly multiple weekdays sorted; week starts Monday; no occurrence before anchor', () => {
  assert.deepEqual(
    nextOccurrences(
      { ...weekly, weekdays: [7, 1, 5] },
      '2026-10-01T00:00Z',
      utc,
      4,
    ),
    [
      '2026-10-09T18:00:00Z',
      '2026-10-11T18:00:00Z',
      '2026-10-19T18:00:00Z',
      '2026-10-23T18:00:00Z',
    ],
  );
});
test('weekly cross-year does not reset parity', () => {
  assert.deepEqual(
    nextOccurrences(
      { ...weekly, anchorDate: '2026-12-25' },
      '2026-12-24T00:00Z',
      utc,
      2,
    ),
    ['2026-12-25T18:00:00Z', '2027-01-08T18:00:00Z'],
  );
});
for (const day of [1, 28, 29, 30, 31])
  test(`monthly day ${day} skips missing dates`, () => {
    const values = nextOccurrences(
      { ...monthly, pattern: { type: 'DAY', day } },
      '2026-02-01T00:00Z',
      utc,
      2,
    );
    assert.equal(
      values[0],
      `2026-${day <= 28 ? '02' : '03'}-${String(day).padStart(2, '0')}T18:00:00Z`,
    );
  });
test('monthly every N months stays anchored when invalid months skipped', () => {
  assert.deepEqual(
    nextOccurrences({ ...monthly, every: 2 }, '2026-07-31T18:00Z', utc, 2),
    ['2027-01-31T18:00:00Z', '2027-03-31T18:00:00Z'],
  );
});
for (const [nth, weekday, expected] of [
  [1, 1, '05'],
  [2, 1, '12'],
  [3, 1, '19'],
  [4, 1, '26'],
  [-1, 5, '30'],
] as const) {
  test(`monthly nth ${nth}, weekday ${weekday}`, () => {
    assert.equal(
      nextOccurrence(
        { ...monthly, pattern: { type: 'NTH_WEEKDAY', nth, weekday } },
        '2026-01-01T00:00Z',
        utc,
      ),
      `2026-01-${expected}T18:00:00Z`,
    );
  });
}
test('last Friday follows changing month layout', () => {
  assert.deepEqual(
    nextOccurrences(
      { ...monthly, pattern: { type: 'NTH_WEEKDAY', nth: -1, weekday: 5 } },
      '2026-02-01T00:00Z',
      utc,
      2,
    ),
    ['2026-02-27T18:00:00Z', '2026-03-27T18:00:00Z'],
  );
});
test('impossible anchored monthly cycle terminates', () => {
  assert.equal(
    nextOccurrence(
      { ...monthly, anchorDate: '2026-02-01', every: 12 },
      '2026-01-01T00:00Z',
      utc,
    ),
    null,
  );
});
test('yearly leap dates skip nonleap years including 2100', () => {
  assert.equal(
    nextOccurrence(yearly, '2026-01-01T00:00Z', utc),
    '2028-02-29T18:00:00Z',
  );
  assert.equal(
    nextOccurrence(yearly, '2096-02-29T18:00Z', utc),
    '2104-02-29T18:00:00Z',
  );
});
test('yearly normal date and anchor lower bound', () => {
  assert.equal(
    nextOccurrence(
      { ...yearly, month: 1, day: 3, anchorDate: '2026-02-01' },
      '2025-01-01T00:00Z',
      utc,
    ),
    '2027-01-03T18:00:00Z',
  );
});
for (const [unit, expected] of [
  ['HOURS', '2026-01-01T20:00:00Z'],
  ['DAYS', '2026-01-03T18:00:00Z'],
  ['WEEKS', '2026-01-15T18:00:00Z'],
] as const)
  test(`elapsed interval ${unit}`, () => {
    assert.equal(
      nextOccurrence({ ...interval, unit }, interval.anchorAt, utc),
      expected,
    );
    assert.equal(
      nextOccurrence({ ...interval, unit }, '2025-01-01T00:00Z', utc),
      interval.anchorAt,
    );
  });
test('interval days mean 24 hours across DST, unlike calendar days', () => {
  const rule = {
    ...interval,
    anchorAt: '2026-03-07T17:00:00Z',
    unit: 'DAYS' as const,
    amount: 1,
  };
  assert.equal(nextOccurrence(rule, rule.anchorAt, ny), '2026-03-08T17:00:00Z');
  assert.equal(
    nextOccurrence(
      { ...daily, anchorDate: '2026-03-07', localTime: '12:00' },
      rule.anchorAt,
      ny,
    ),
    '2026-03-08T16:00:00Z',
  );
});
test('until boundary inclusive and exact nanosecond precision', () => {
  const rule = {
    ...daily,
    end: { type: 'UNTIL_DATE' as const, at: '2026-01-02T18:00:00Z' },
  };
  assert.deepEqual(nextOccurrences(rule, '2026-01-01T18:00Z', utc), [
    '2026-01-02T18:00:00Z',
  ]);
  assert.equal(nextOccurrence(rule, rule.end.at, utc), null);
  assert.equal(
    nextOccurrence(
      { ...rule, end: { ...rule.end, at: '2026-01-02T17:59:59.999999999Z' } },
      '2026-01-01T18:00Z',
      utc,
    ),
    null,
  );
});
test('local date end boundary handles 23-hour DST day', () => {
  assert.equal(
    endOfLocalDate('2026-03-08', ny.timezone),
    '2026-03-09T03:59:59.999999999Z',
  );
});
test('count counts executions, not elapsed or skipped dates', () => {
  const rule = {
    ...daily,
    end: { type: 'AFTER_N_EXECUTIONS' as const, count: 3 },
  };
  assert.equal(nextOccurrences(rule, '2030-01-01T00:00Z', utc, 5).length, 3);
  assert.equal(nextOccurrences(rule, '2030-01-01T00:00Z', utc, 5, 2).length, 1);
  assert.equal(nextOccurrence(rule, '2030-01-01T00:00Z', utc, 3), null);
});
test('preview merges equivalent instants and preserves contributing IDs and counts', () => {
  const rules = [
    {
      id: 'a',
      enabled: true,
      config: {
        ...daily,
        end: { type: 'AFTER_N_EXECUTIONS' as const, count: 1 },
      },
    },
    {
      id: 'b',
      enabled: true,
      config: { type: 'ONE_TIME' as const, at: '2026-01-01T21:30:00+03:30' },
    },
    {
      id: 'c',
      enabled: true,
      config: { type: 'ONE_TIME' as const, at: '2026-01-01T18:01:00Z' },
    },
    { id: 'disabled', enabled: false, config: daily },
  ];
  const snapshot = JSON.stringify(rules);
  assert.deepEqual(preview(rules, '2026-01-01T00:00Z', utc), [
    { scheduledFor: '2026-01-01T18:00:00Z', ruleIds: ['a', 'b'] },
    { scheduledFor: '2026-01-01T18:01:00Z', ruleIds: ['c'] },
  ]);
  assert.equal(JSON.stringify(rules), snapshot);
  assert.deepEqual(
    preview(rules, '2026-01-01T00:00Z', utc, 5, { a: 1 })[0]?.ruleIds,
    ['b'],
  );
  assert.throws(() =>
    preview([rules[0]!, rules[0]!], '2026-01-01T00:00Z', utc),
  );
});
test('preview global limit and sorting', () => {
  assert.equal(
    preview(
      [
        { id: 'a', config: daily, enabled: true },
        { id: 'b', config: { ...daily, localTime: '19:00' }, enabled: true },
      ],
      '2026-01-01T00:00Z',
      utc,
      5,
    ).length,
    5,
  );
});
for (const invalid of [
  { ...daily, every: 0 },
  { ...daily, every: 1.5 },
  { ...daily, localTime: '24:00' },
  { ...daily, anchorDate: '2026-02-30' },
  { ...weekly, weekdays: [] },
  { ...weekly, weekdays: [5, 5] },
  { ...weekly, weekdays: [0] },
  { ...yearly, month: 2, day: 30 },
  { ...interval, anchorAt: '2026-01-01T18:00' },
  { ...daily, end: { type: 'AFTER_N_EXECUTIONS', count: 0 } },
  { ...daily, cron: '*' },
])
  test(`invalid rule rejected ${JSON.stringify(invalid)}`, () =>
    assert.equal(ruleSchema.safeParse(invalid).success, false));
test('invalid timezone, count, and preview bounds fail', () => {
  assert.throws(() => preview([], '2026-01-01T00:00Z', utc, -1));
  assert.throws(() =>
    nextOccurrence(daily, '2026-01-01T00:00Z', {
      ...utc,
      timezone: 'Invalid/Zone',
    }),
  );
  assert.throws(() => nextOccurrence(daily, '2026-01-01T00:00Z', utc, -1));
  assert.throws(() => nextOccurrences(daily, '2026-01-01T00:00Z', utc, 1001));
  assert.deepEqual(nextOccurrences(daily, '2026-01-01T00:00Z', utc, 0), []);
});
test('Persian and Arabic digits normalize outside domain', () =>
  assert.equal(normalizeDigits('۱۴۰۵/٠٧/۰۳ ۱۸:٣٠'), '1405/07/03 18:30'));
