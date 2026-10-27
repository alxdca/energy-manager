import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecordedEnergy } from '../src/recorded-energy.js';
import { getCalendarDayBounds } from '../src/policy.js';

test('recorded energy sums whole Wh values by their actual timestamps without inventing coverage', () => {
  const points = { solar: [{ at: '2026-01-15T12:14:29.000Z', value: 125 }, { at: '2026-01-15T12:44:31.000Z', value: 375 }],
    household: [{ at: '2026-01-15T12:29:30.000Z', value: 0 }] };
  const before = structuredClone(points);
  const { dailyEnergy, measurements } = summarizeRecordedEnergy('2026-01-15', points, new Date('2026-01-15T13:00:00Z'));
  assert.equal(dailyEnergy.method, 'recorded_energy');
  assert.equal(dailyEnergy.status, 'partial');
  assert.equal(dailyEnergy.solar.energyKwh, .5);
  assert.equal(dailyEnergy.household.energyKwh, 0);
  assert.equal(dailyEnergy.solar.sampleCount, 2);
  assert.equal(dailyEnergy.solar.coverageSeconds, 0);
  assert.equal(dailyEnergy.solar.firstCoveredAt, null);
  assert.equal(dailyEnergy.solar.firstObservedAt, points.solar[0].at);
  assert.equal(dailyEnergy.solar.lastObservedAt, points.solar[1].at);
  assert.equal(measurements.hours[13].solar.energyKwh, .5);
  assert.equal(measurements.hours[13].household.energyKwh, 0);
  assert.equal(measurements.hours[12].solar.energyKwh, null);
  assert.equal(measurements.quarterHours!.length, 96);
  assert.deepEqual(measurements.quarterHours!.slice(52, 56).map(row => row.solar.energyKwh), [.125, null, .375, null]);
  assert.equal(measurements.quarterHours![53].household.energyKwh, 0);
  assert.deepEqual(points, before);
});

test('readings are never proportionally distributed across hour or midnight boundaries', () => {
  const points = { solar: [{ at: '2026-01-15T12:59:30.000Z', value: 200 }, { at: '2026-01-15T13:14:30.000Z', value: 300 },
    { at: '2026-01-15T22:59:30.000Z', value: 400 }, { at: '2026-01-15T23:14:30.000Z', value: 500 }], household: [] };
  const now = new Date('2026-01-16T00:00:00Z');
  const day = summarizeRecordedEnergy('2026-01-15', points, now);
  assert.equal(day.dailyEnergy.solar.energyKwh, .9);
  assert.equal(day.measurements.hours[13].solar.energyKwh, .2);
  assert.equal(day.measurements.hours[14].solar.energyKwh, .3);
  assert.equal(day.measurements.hours[23].solar.energyKwh, .4);
  const next = summarizeRecordedEnergy('2026-01-16', points, now);
  assert.equal(next.dailyEnergy.solar.energyKwh, .5);
  assert.equal(next.measurements.hours[0].solar.energyKwh, .5);
});

test('duplicate finalized readings count once and empty channels stay unknown', () => {
  const point = { at: '2026-01-15T12:29:30.000Z', value: 500 };
  const result = summarizeRecordedEnergy('2026-01-15', { solar: [point, point], household: [] }, new Date('2026-01-15T14:00:00Z'));
  assert.equal(result.dailyEnergy.solar.energyKwh, .5);
  assert.equal(result.dailyEnergy.solar.coverageSeconds, 0);
  assert.equal(result.dailyEnergy.solar.sampleCount, 1);
  assert.equal(result.dailyEnergy.solar.lastObservedAt, point.at);
  assert.equal(result.dailyEnergy.household.energyKwh, null);
});

test('future, invalid and missing readings remain unknown, while zero stays known', () => {
  const result = summarizeRecordedEnergy('2026-01-15', { solar: [
    { at: '2026-01-15T12:14:30.000Z', value: 0 }, { at: '2026-01-15T13:14:30.000Z', value: 50 },
    { at: 'bad', value: 100 }, { at: '2026-01-15T12:44:30.000Z', value: -1 },
  ], household: [] }, new Date('2026-01-15T13:00:00Z'));
  assert.equal(result.dailyEnergy.solar.energyKwh, 0);
  assert.equal(result.dailyEnergy.solar.sampleCount, 1);
  assert.equal(result.dailyEnergy.household.energyKwh, null);
  assert.equal(result.measurements.hours[14].solar.energyKwh, null);
});

test('recorded summaries use real Zurich DST days and keep repeated hours distinct', () => {
  for (const [date, count] of [['2026-03-29', 23], ['2026-10-25', 25]] as const) {
    const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
    const solar = Array.from({ length: count }, (_, index) => ({ at: new Date(bounds.start.getTime() + index * 3600000 + 3590000).toISOString(), value: index + 1 }));
    const result = summarizeRecordedEnergy(date, { solar, household: [] }, bounds.end);
    assert.equal(result.measurements.hours.length, count);
    assert.equal(result.measurements.quarterHours!.length, count * 4);
    assert.equal(result.measurements.quarterHours!.filter(row => row.solar.energyKwh !== null).length, count);
    assert.deepEqual(result.measurements.hours.map(hour => hour.solar.energyKwh), solar.map(point => point.value / 1000));
    assert.equal(result.dailyEnergy.expectedSeconds, count * 3600);
    assert.equal(result.dailyEnergy.solar.coverageSeconds, 0);
  }
  assert.throws(() => summarizeRecordedEnergy('2026-02-30', { solar: [], household: [] }, new Date()), /Date/);
});
