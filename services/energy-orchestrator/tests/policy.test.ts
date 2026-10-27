import test from 'node:test';
import assert from 'node:assert/strict';
import { getCarTarget, getSchedule } from '../src/policy.js';

test('reused calendar boundaries remain independent dates across DST and cache eviction', async () => {
  const { getCalendarDayBounds } = await import('../src/policy.js');
  const day = new Date('2026-10-25T00:00:00Z');
  const original = getCalendarDayBounds(day);
  assert.equal(original.end.getTime() - original.start.getTime(), 25 * 3600000);
  original.start.setTime(0); original.end.setTime(0);
  for (let offset = 0; offset < 600; offset++) getCalendarDayBounds(new Date(Date.UTC(2026, 0, 1 + offset)));
  const restored = getCalendarDayBounds(day);
  assert.equal(restored.start.toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(restored.end.toISOString(), '2026-10-25T23:00:00.000Z');
});

// These ISO strings carry Zurich's winter offset explicitly.
const winter = (time: string) => new Date(`2026-01-15T${time}+01:00`);
const cases = [
  ['00:00:00', 'low', 'open', 'night'],
  ['06:44:59', 'low', 'open', 'night'],
  ['06:45:00', 'low', 'open', 'night'],
  ['06:54:59', 'low', 'open', 'night'],
  ['06:55:00', 'low', 'buffer', null],
  ['06:59:59', 'low', 'buffer', null],
  ['07:00:00', 'high', 'high_tariff', null],
  ['11:59:59', 'high', 'high_tariff', null],
  ['12:00:00', 'low', 'buffer', null],
  ['12:04:59', 'low', 'buffer', null],
  ['12:05:00', 'low', 'open', 'afternoon'],
  ['16:44:59', 'low', 'open', 'afternoon'],
  ['16:45:00', 'low', 'open', 'afternoon'],
  ['16:54:59', 'low', 'open', 'afternoon'],
  ['16:55:00', 'low', 'buffer', null],
  ['16:59:59', 'low', 'buffer', null],
  ['17:00:00', 'high', 'high_tariff', null],
  ['22:59:59', 'high', 'high_tariff', null],
  ['23:00:00', 'low', 'buffer', null],
  ['23:04:59', 'low', 'buffer', null],
  ['23:05:00', 'low', 'open', 'night'],
] as const;

for (const [time, tariff, phase, currentWindow] of cases) {
  test(`Zurich tariff and charging boundaries at ${time}`, () => {
    const result = getSchedule(winter(time));
    assert.equal(result.tariff.kind, tariff);
    assert.equal(result.tariff.priceCts, tariff === 'low' ? 17.1 : 28.29);
    assert.equal(result.charging.phase, phase);
    assert.equal(result.charging.allowed, phase === 'open');
    assert.equal(result.charging.currentWindow, currentWindow);
    assert.ok(new Date(result.tariff.nextChangeAt).getTime() > winter(time).getTime());
  });
}

test('next window names the active window or the next future window', () => {
  assert.deepEqual(getSchedule(winter('02:00:00')).charging.nextWindow, {
    label: 'Nuit', start: '2026-01-14T22:05:00.000Z', end: '2026-01-15T05:55:00.000Z',
  });
  assert.deepEqual(getSchedule(winter('06:55:00')).charging.nextWindow, {
    label: 'Secours de l’après-midi', start: '2026-01-15T11:05:00.000Z', end: '2026-01-15T15:55:00.000Z',
  });
  assert.equal(getSchedule(winter('16:55:00')).charging.nextWindow.start, '2026-01-15T22:05:00.000Z');
  assert.equal(getSchedule(winter('07:00:00')).tariff.nextChangeAt, '2026-01-15T11:00:00.000Z');
  assert.equal(getSchedule(winter('23:00:00')).tariff.nextChangeAt, '2026-01-16T06:00:00.000Z');
});

test('normal windows allow 7 hours 50 minutes overnight and 4 hours 50 minutes in the afternoon', () => {
  for (const [time, minutes] of [['02:00:00', 470], ['13:00:00', 290]] as const) {
    const window = getSchedule(winter(time)).charging.nextWindow;
    assert.equal(Date.parse(window.end) - Date.parse(window.start), minutes * 60_000);
  }
});

test('spring DST night has 6 hours 50 minutes of charging and ends at 06:55 local', () => {
  const window = getSchedule(new Date('2026-03-28T23:30:00+01:00')).charging.nextWindow;
  assert.equal(window.start, '2026-03-28T22:05:00.000Z');
  assert.equal(window.end, '2026-03-29T04:55:00.000Z');
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 410 * 60_000);
  for (const time of ['2026-03-29T01:59:59+01:00', '2026-03-29T03:00:00+02:00']) {
    assert.equal(getSchedule(new Date(time)).charging.allowed, true);
  }
  assert.equal(getSchedule(new Date('2026-03-29T06:45:00+02:00')).charging.allowed, true);
  assert.equal(getSchedule(new Date('2026-03-29T06:54:59+02:00')).charging.allowed, true);
  assert.equal(getSchedule(new Date('2026-03-29T06:55:00+02:00')).charging.phase, 'buffer');
  assert.equal(getSchedule(new Date('2026-03-29T07:00:00+02:00')).tariff.kind, 'high');
});

test('fall DST night has 8 hours 50 minutes of charging including both repeated hours', () => {
  const window = getSchedule(new Date('2026-10-24T23:30:00+02:00')).charging.nextWindow;
  assert.equal(window.start, '2026-10-24T21:05:00.000Z');
  assert.equal(window.end, '2026-10-25T05:55:00.000Z');
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 530 * 60_000);
  for (const time of ['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00']) {
    assert.equal(getSchedule(new Date(time)).charging.currentWindow, 'night');
  }
  assert.equal(getSchedule(new Date('2026-10-25T06:45:00+01:00')).charging.allowed, true);
  assert.equal(getSchedule(new Date('2026-10-25T06:54:59+01:00')).charging.allowed, true);
  assert.equal(getSchedule(new Date('2026-10-25T06:55:00+01:00')).charging.phase, 'buffer');
  assert.equal(getSchedule(new Date('2026-10-25T07:00:00+01:00')).tariff.kind, 'high');
});

test('every local morning has the requested weekly car minimum', () => {
  for (const [date, weekday, minimum] of [
    ['2026-10-19', 'Monday', 60], ['2026-10-20', 'Tuesday', 50],
    ['2026-10-21', 'Wednesday', 50], ['2026-10-22', 'Thursday', 60],
    ['2026-10-23', 'Friday', 50], ['2026-10-24', 'Saturday', 60],
    ['2026-10-25', 'Sunday', 60],
  ] as const) {
    const target = getCarTarget(new Date(`${date}T06:00:00+02:00`));
    assert.equal(target.date, date);
    assert.equal(target.weekday, weekday);
    assert.equal(target.minimumSocPercent, minimum);
  }
});

test('overnight targets follow the destination morning rather than the charging weekday or UTC date', () => {
  for (const [instant, date, minimum] of [
    ['2026-10-18T23:05:00+02:00', '2026-10-19', 60],
    ['2026-10-19T23:05:00+02:00', '2026-10-20', 50],
    ['2026-10-20T00:30:00+02:00', '2026-10-20', 50],
    ['2026-10-21T23:05:00+02:00', '2026-10-22', 60],
    ['2026-10-23T23:05:00+02:00', '2026-10-24', 60],
    ['2026-10-24T23:05:00+02:00', '2026-10-25', 60],
    ['2026-10-25T23:05:00+01:00', '2026-10-26', 60],
  ] as const) {
    const target = getCarTarget(new Date(instant));
    assert.equal(target.date, date, instant);
    assert.equal(target.minimumSocPercent, minimum, instant);
  }
});

test('morning target rolls forward at the checkpoint while keeping the 06:55 charging cutoff', () => {
  const before = getCarTarget(new Date('2026-10-19T06:54:59+02:00'));
  assert.equal(before.minimumSocPercent, 60);
  assert.equal(before.deadline, '2026-10-19T04:55:00.000Z');
  assert.equal(before.gridChargingEndsAt, '2026-10-19T04:55:00.000Z');
  const after = getCarTarget(new Date('2026-10-19T06:55:00+02:00'));
  assert.equal(after.date, '2026-10-20');
  assert.equal(after.minimumSocPercent, 50);
});

test('next-morning deadlines use the correct DST offset and year rollover', () => {
  for (const [instant, date, deadline, cutoff] of [
    ['2026-03-28T23:30:00+01:00', '2026-03-29', '2026-03-29T04:55:00.000Z', '2026-03-29T04:55:00.000Z'],
    ['2026-10-24T23:30:00+02:00', '2026-10-25', '2026-10-25T05:55:00.000Z', '2026-10-25T05:55:00.000Z'],
    ['2026-12-31T23:30:00+01:00', '2027-01-01', '2027-01-01T05:55:00.000Z', '2027-01-01T05:55:00.000Z'],
  ] as const) {
    const target = getCarTarget(new Date(instant));
    assert.equal(target.date, date);
    assert.equal(target.deadline, deadline);
    assert.equal(target.gridChargingEndsAt, cutoff);
  }
  assert.match(getCarTarget(new Date('2026-10-21T23:30:00+02:00')).reason, /Minimum quotidien/);
  assert.equal(getCarTarget(new Date('2026-10-23T23:30:00+02:00')).reason, 'Week-end');
});
