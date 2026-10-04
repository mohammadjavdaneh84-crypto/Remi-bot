import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Builder } from '../src/app/wizard/model.js';
import {
  answer,
  buildRule,
  fields,
  question,
  describeRule,
} from '../src/ui/fa/rule-form.js';

const now = '2026-10-03T00:00:00Z';
function fill(type: Builder['type'], values: string[]) {
  let builder: Builder = { type, index: 0, weekdays: [], values: {} };
  for (const value of values)
    builder = answer(builder, value, question(builder).options.length > 0);
  return builder;
}
const examples: [Builder['type'], string[]][] = [
  ['ONE_TIME', ['2026-10-09', '18:00']],
  ['EVERY_N_DAYS', ['۲', '۱۸:۳۰', '۲۰۲۶-۱۰-۰۹', 'UNLIMITED']],
  [
    'WEEKLY',
    ['5', '1', 'done', '2', '18:00', '2026-10-09', 'AFTER_N_EXECUTIONS', '3'],
  ],
  [
    'MONTHLY',
    ['DAY', '31', '1', '18:00', '2026-10-09', 'UNTIL_DATE', '2027-12-31'],
  ],
  [
    'MONTHLY',
    ['NTH_WEEKDAY', '-1', '5', '2', '18:00', '2026-10-09', 'UNLIMITED'],
  ],
  ['YEARLY', ['2', '29', '18:00', '2026', 'UNLIMITED']],
  [
    'INTERVAL',
    ['HOURS', '۲', '2026-10-09', '18:00', 'AFTER_N_EXECUTIONS', '5'],
  ],
];
for (const [type, values] of examples)
  test(`decision-tree builds ${type}: ${values.join(',')}`, () => {
    const builder = fill(type, values);
    assert.equal(builder.index, fields(builder).length);
    const rule = buildRule(builder, 'Asia/Tehran', now);
    assert.equal(rule.type, type);
    assert.ok(describeRule(rule, 'Asia/Tehran').length > 10);
    assert.doesNotMatch(
      describeRule(rule, 'Asia/Tehran'),
      /anchor|UNLIMITED|AFTER_N/,
    );
  });
test('one-time has no recurrence or end questions', () =>
  assert.deepEqual(
    fields({ type: 'ONE_TIME', index: 0, values: {}, weekdays: [] }),
    ['date', 'time'],
  ));
for (const bad of ['2026-02-30', '۱۴۰۵/۰۷/۰۳', '2026-1-1'])
  test(`invalid date rejected: ${bad}`, () => {
    assert.throws(() =>
      answer(
        { type: 'ONE_TIME', index: 0, values: {}, weekdays: [] },
        bad,
        false,
      ),
    );
  });
test('numeric/time boundaries reject invalid inputs', () => {
  for (const value of ['0', '1.5', '10001', '-2'])
    assert.throws(() =>
      answer(
        { type: 'EVERY_N_DAYS', index: 0, values: {}, weekdays: [] },
        value,
        false,
      ),
    );
  for (const value of ['24:00', '18:60', '8pm'])
    assert.throws(() =>
      answer(
        {
          type: 'ONE_TIME',
          index: 1,
          values: { date: '2026-10-09' },
          weekdays: [],
        },
        value,
        false,
      ),
    );
});
test('weekly day selection toggles without advancing until confirmed', () => {
  let b: Builder = { type: 'WEEKLY', index: 0, values: {}, weekdays: [] };
  assert.throws(() => answer(b, 'done', true));
  b = answer(b, '5', true);
  assert.equal(b.index, 0);
  assert.deepEqual(b.weekdays, [5]);
  b = answer(b, '5', true);
  assert.deepEqual(b.weekdays, []);
  assert.throws(() => answer(b, '5', false));
});
test('yearly impossible month/day rejected at day question', () => {
  assert.throws(() =>
    answer(
      { type: 'YEARLY', index: 1, values: { month: '2' }, weekdays: [] },
      '30',
      false,
    ),
  );
});
test('past one-time, expired end date and impossible anchored recurrence rejected', () => {
  for (const builder of [
    fill('ONE_TIME', ['2026-01-01', '18:00']),
    fill('EVERY_N_DAYS', [
      '1',
      '18:00',
      '2026-01-01',
      'UNTIL_DATE',
      '2026-02-01',
    ]),
    fill('MONTHLY', ['DAY', '31', '12', '18:00', '2026-02-01', 'UNLIMITED']),
  ])
    assert.throws(() => buildRule(builder, 'UTC', now));
});
test('changing conditional pattern/end uses new branch without stale fields', () => {
  const b = fill('MONTHLY', [
    'DAY',
    '31',
    '1',
    '18:00',
    '2026-10-09',
    'UNTIL_DATE',
    '2027-12-31',
  ]);
  b.index = 0;
  const changed = answer(b, 'NTH_WEEKDAY', true);
  assert.equal(fields(changed)[changed.index], 'nth');
  const end = fill('EVERY_N_DAYS', [
    '1',
    '18:00',
    '2026-10-09',
    'UNTIL_DATE',
    '2027-12-31',
  ]);
  end.index = 3;
  const unlimited = answer(end, 'UNLIMITED', true);
  assert.equal(unlimited.index, fields(unlimited).length);
  assert.equal(buildRule(unlimited, 'UTC', now).type, 'EVERY_N_DAYS');
});
