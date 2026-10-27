import test from 'node:test';
import assert from 'node:assert/strict';
import { carEstimatePoints } from '../src/car-forecast-history.js';
import type { CarChargingForecast } from '../src/car-types.js';
import { getCalendarDayBounds } from '../src/policy.js';

const date = '2026-01-15', at = new Date('2026-01-15T12:00:00.000Z');
function channel(overrides: Partial<CarChargingForecast> = {}): CarChargingForecast {
  return { date, status: 'available', calculatedAt: at.toISOString(), socObservedAt: at.toISOString(),
    slots: [{ start: '2026-01-15T12:07:00.000Z', end: '2026-01-15T12:22:00.000Z',
      powerKw: 6, energyKwh: 1.5, source: 'solar', required: true, batteryChargeAllowed: false }], ...overrides };
}
const capture = (carCharging: CarChargingForecast, now = at) => carEstimatePoints([{ date: carCharging.date, carCharging }], now);

test('charging slots integrate their exact overlap with each quarter, preserving zeros outside the allocation', () => {
  const points = capture(channel());
  assert.equal(points[0].start, at.toISOString()); assert.equal(points[0].end, '2026-01-15T12:15:00.000Z');
  assert.equal(points[0].estimatedChargingKwh, .8); assert.equal(points[1].estimatedChargingKwh, .7);
  assert.equal(points[2].estimatedChargingKwh, 0);
  assert.equal(points.reduce((sum, point) => sum + point.estimatedChargingKwh, 0), 1.5);
});

test('unavailable, manual/inactive, absent and malformed channels never invent zero forecasts', () => {
  for (const candidate of [channel({ status: 'inactive', slots: [] }), channel({ status: 'unavailable', slots: [] }),
    channel({ slots: [{ ...channel().slots[0], energyKwh: 900 }] }), channel({ calculatedAt: 'bad' }),
    channel({ socObservedAt: '2026-01-15T11:00:00.000Z' })]) assert.deepEqual(capture(candidate), []);
  assert.deepEqual(carEstimatePoints([{ date }], at), []);
  assert.deepEqual(carEstimatePoints([{ date, carCharging: channel({ date: '2026-01-16' }) }], at), []);
  assert.deepEqual(carEstimatePoints([{ date, carCharging: channel() }, { date, carCharging: channel() }], at), []);
  assert.deepEqual(capture(channel(), new Date('invalid')), []);
  assert.equal(capture(channel({ slots: [] }))[0].estimatedChargingKwh, 0, 'a known empty automatic allocation is distinct');
});

test('completed quarters are never backfilled and partial charge slots are never expanded', () => {
  const later = new Date('2026-01-15T12:15:00.000Z');
  const points = capture(channel({ calculatedAt: later.toISOString(), socObservedAt: later.toISOString() }), later);
  assert.equal(points[0].start, later.toISOString()); assert.equal(points[0].estimatedChargingKwh, .7);
  const midQuarter = new Date('2026-01-15T12:08:00.000Z');
  assert.equal(capture(channel(), midQuarter)[0].estimatedChargingKwh, .8);
  assert.deepEqual(capture(channel(), new Date('2026-01-16T00:00:00Z')), []);
});

test('several slots in a quarter add without rounding their start/end times', () => {
  const original = channel();
  original.slots = [
    { ...original.slots[0], start: '2026-01-15T12:01:00.000Z', end: '2026-01-15T12:02:00.000Z', energyKwh: .1 },
    { ...original.slots[0], start: '2026-01-15T12:03:00.000Z', end: '2026-01-15T12:04:00.000Z', energyKwh: .1 },
  ];
  const copy = structuredClone(original);
  assert.equal(capture(original)[0].estimatedChargingKwh, .2); assert.deepEqual(original, copy);
  original.slots[1].start = original.slots[0].start;
  assert.deepEqual(capture(original), [], 'overlapping slots are ambiguous');
});

test('Zurich DST days retain 92 or 100 distinct UTC quarters', () => {
  for (const [day, count] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const bounds = getCalendarDayBounds(new Date(`${day}T00:00:00Z`));
    const points = capture(channel({ date: day, calculatedAt: bounds.start.toISOString(), socObservedAt: bounds.start.toISOString(), slots: [] }), bounds.start);
    assert.equal(points.length, count); assert.equal(new Set(points.map(point => point.start)).size, count);
    assert.equal(points[0].start, bounds.start.toISOString()); assert.equal(points.at(-1)!.end, bounds.end.toISOString());
  }
});
