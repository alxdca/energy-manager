import test from 'node:test';
import assert from 'node:assert/strict';
import { getCalendarDayBounds } from '../src/policy.js';
import { consumptionIntervals, estimateConsumption, loadConsumptionConfig } from '../src/consumption.js';

test('the configured baseline is the entire consumption estimate, excluding the car', () => {
  const { hourly, quarterHourly, ...daily } = estimateConsumption('2026-01-15', loadConsumptionConfig({}));
  assert.deepEqual(daily, {
    date: '2026-01-15', dayHours: 24, baselinePowerW: 1000, baselineKwh: 24,
    estimatedConsumptionKwh: 24, source: 'configured_baseline', excludesCar: true,
    hourlyMethod: 'baseline_only',
  });
  assert.equal(quarterHourly.length, 96);
  assert.ok(quarterHourly.every(slot => slot.estimatedConsumptionKwh === .25));
  assert.equal(hourly.length, 24);
  assert.ok(hourly.every(slot => slot.estimatedConsumptionKwh === 1));
});

test('hourly baseline totals and intervals follow actual Zurich days including DST', () => {
  for (const [date, hours] of [
    ['2026-03-29', 23], ['2026-10-25', 25], ['2026-12-31', 24],
    ['2027-01-01', 24], ['2028-02-29', 24],
  ] as const) {
    const result = estimateConsumption(date, loadConsumptionConfig({}));
    const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
    assert.equal(result.dayHours, hours);
    assert.equal(result.hourly.length, hours);
    assert.equal(result.baselineKwh, hours);
    assert.equal(result.estimatedConsumptionKwh, hours);
    assert.equal(result.hourly[0].start, bounds.start.toISOString());
    assert.equal(result.hourly.at(-1)?.end, bounds.end.toISOString());
    assert.equal(result.hourly.reduce((total, slot) => total + slot.estimatedConsumptionKwh, 0), result.estimatedConsumptionKwh);
    for (let index = 0; index < hours; index++) {
      assert.equal(Date.parse(result.hourly[index].end) - Date.parse(result.hourly[index].start), 3_600_000);
      if (index > 0) assert.equal(result.hourly[index].start, result.hourly[index - 1].end);
    }
  }
});

test('empty baseline settings use the default and zero and decimal settings remain valid', () => {
  for (const value of [undefined, '', '  ']) {
    assert.deepEqual(loadConsumptionConfig({ FORECAST_BASE_LOAD_W: value }), { baselinePowerW: 1000 });
  }
  const zero = estimateConsumption('2026-01-15', loadConsumptionConfig({ FORECAST_BASE_LOAD_W: '0' }));
  assert.equal(zero.estimatedConsumptionKwh, 0);
  assert.ok(zero.hourly.every(slot => slot.estimatedConsumptionKwh === 0));
  const config = loadConsumptionConfig({ FORECAST_BASE_LOAD_W: ' 425.5 ' });
  const result = estimateConsumption('2026-01-15', config);
  assert.equal(config.baselinePowerW, 425.5);
  assert.equal(result.estimatedConsumptionKwh, 10.212);
  assert.ok(Math.abs(result.hourly.reduce((total, slot) => total + slot.estimatedConsumptionKwh, 0) - result.estimatedConsumptionKwh) < 1e-10);
});

test('invalid numeric baseline settings are rejected', () => {
  for (const value of ['-1', 'NaN', 'Infinity', '0x10', '5kW', '1e3']) {
    assert.throws(() => loadConsumptionConfig({ FORECAST_BASE_LOAD_W: value }), /BASE_LOAD/);
  }
  for (const baselinePowerW of [-1, NaN, Infinity, '500' as unknown as number]) {
    assert.throws(() => estimateConsumption('2026-01-15', { baselinePowerW }), /BASE_LOAD/);
  }
});

test('invalid or normalized-away calendar dates are rejected', () => {
  for (const date of ['', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00',
    '2026-1-15', '26-01-15', '2026-01-15T00:00:00Z', '2026-01-15 ']) {
    assert.throws(() => estimateConsumption(date, loadConsumptionConfig({})), /date/);
  }
});

test('canonical consumption intervals preserve unequal quarter energies and real Zurich day lengths', () => {
  for (const [date, count] of [['2026-01-15', 96], ['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const data = estimateConsumption(date, { baselinePowerW: 1000 });
    assert.equal(consumptionIntervals(data), data.quarterHourly);
    data.quarterHourly = data.hourly.flatMap(hour => [0, .1, .3, .6].map((energy, index) => ({
      start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
      end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(), estimatedConsumptionKwh: energy,
    })));
    assert.equal(consumptionIntervals(data), data.quarterHourly);
    assert.equal(consumptionIntervals(data)!.length, count);
  }
});

test('malformed supplied consumption quarters fail closed instead of reverting to hourly averages', () => {
  const good = estimateConsumption('2026-10-25', { baselinePowerW: 1000 });
  good.quarterHourly = good.hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(), estimatedConsumptionKwh: .25,
  })));
  const changes: Array<(data: typeof good) => void> = [
    data => { Reflect.deleteProperty(data, 'quarterHourly'); },
    data => { data.quarterHourly!.pop(); },
    data => { data.quarterHourly![0].estimatedConsumptionKwh = -1; },
    data => { data.quarterHourly![0].estimatedConsumptionKwh = NaN; },
    data => { data.quarterHourly![0].estimatedConsumptionKwh = .5; },
    data => { data.quarterHourly![1] = { ...data.quarterHourly![0] }; },
    data => { data.hourly[0].estimatedConsumptionKwh = 99; },
    data => { data.estimatedConsumptionKwh = 99; },
    data => { data.date = '2026-02-30'; },
  ];
  for (const change of changes) {
    const data = structuredClone(good); change(data);
    assert.equal(consumptionIntervals(data), null);
  }
});
