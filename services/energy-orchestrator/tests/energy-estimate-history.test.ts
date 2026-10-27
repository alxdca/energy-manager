import test from 'node:test';
import assert from 'node:assert/strict';
import type { EnergyForecast } from '../src/automation-plan.js';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast, type SolarForecast } from '../src/forecast.js';
import { energyEstimatePoints, solarEstimatePoints, type EnergyEstimatePoint } from '../src/energy-estimate-history.js';
import { getCalendarDayBounds } from '../src/policy.js';

const hourMs = 3_600_000;
const quarterMs = 900_000;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} must equal ${expected}`);

function fixture(date = '2026-01-15') {
  const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  const hours = (bounds.end.getTime() - bounds.start.getTime()) / hourMs;
  const consumption = estimateConsumption(date, { baselinePowerW: 1000 });
  const forecast: EnergyForecast = { ...emptySolarForecast(date, null), status: 'online', error: null,
    fetchedAt: new Date(bounds.start.getTime() - hourMs).toISOString(), estimatedProductionKwh: hours * 2,
    hourly: Array.from({ length: hours }, (_, index) => ({
      start: new Date(bounds.start.getTime() + index * hourMs).toISOString(),
      end: new Date(bounds.start.getTime() + (index + 1) * hourMs).toISOString(),
      estimatedProductionKwh: 2, temperatureC: 10,
    })), consumption };
  forecast.quarterHourly = forecast.hourly!.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * quarterMs).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * quarterMs).toISOString(),
    estimatedProductionKwh: hour.estimatedProductionKwh / 4, temperatureC: hour.temperatureC,
  })));
  return { forecast, generatedAt: bounds.start, bounds };
}

function sum(points: EnergyEstimatePoint[]) {
  return points.reduce((total, point) => total + point.estimatedConsumptionKwh!, 0);
}

test('native consumption captures complete quarters without archiving production or changing inputs', () => {
  const { forecast, generatedAt } = fixture();
  const original = structuredClone(forecast);
  const points = energyEstimatePoints([forecast], generatedAt);
  assert.equal(points.length, 96);
  assert.deepEqual(points[0], { start: generatedAt.toISOString(), end: new Date(generatedAt.getTime() + quarterMs).toISOString(),
    estimatedConsumptionKwh: .25 });
  near(sum(points), forecast.consumption.estimatedConsumptionKwh);
  assert.ok(points.every(point => !('minConsumptionKwh' in point) && !('maxConsumptionKwh' in point)));
  assert.deepEqual(forecast, original);
  forecast.consumption.hourly[0].estimatedConsumptionKwh = 999;
  assert.equal('estimatedProductionKwh' in points[0], false);
  assert.equal(points[0].estimatedConsumptionKwh, .25);
});

test('consumption includes the full ongoing quarter and freezes only completed quarters', () => {
  const { forecast, generatedAt, bounds } = fixture();
  const exact = new Date(generatedAt.getTime() + quarterMs);
  assert.equal(energyEstimatePoints([forecast], exact).length, 95);
  assert.equal(energyEstimatePoints([forecast], exact)[0].start, exact.toISOString());
  const partial = new Date(exact.getTime() + 1);
  const points = energyEstimatePoints([forecast], partial);
  assert.equal(points.length, 95);
  assert.equal(points[0].start, exact.toISOString());
  assert.ok(points.every(point => Date.parse(point.end) > partial.getTime()));
  assert.equal(points[0].estimatedConsumptionKwh, .25, 'the current quarter is never prorated');
  assert.deepEqual(energyEstimatePoints([forecast], bounds.end), []);
  assert.deepEqual(energyEstimatePoints([forecast], new Date(NaN)), []);
});

test('zero consumption is stored and missing hourly consumption is not invented from a daily total', () => {
  const { forecast, generatedAt } = fixture();
  forecast.consumption.hourly[0].estimatedConsumptionKwh = 0;
  forecast.consumption.quarterHourly.slice(0, 4).forEach(point => { point.estimatedConsumptionKwh = 0; });
  forecast.consumption.estimatedConsumptionKwh -= 1;
  let points = energyEstimatePoints([forecast], generatedAt);
  assert.equal(points[0].estimatedConsumptionKwh, 0);
  forecast.consumption.hourly = [];
  points = energyEstimatePoints([forecast], generatedAt);
  assert.deepEqual(points, []);
});

test('canonical consumption quarters are archived directly without redistributing retained hourly totals', () => {
  const { forecast, generatedAt } = fixture();
  forecast.consumption.quarterHourly = forecast.consumption.hourly.flatMap(hour => [0, .2, .3, .5].map((energy, index) => ({
    start: new Date(Date.parse(hour.start) + index * quarterMs).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * quarterMs).toISOString(), estimatedConsumptionKwh: energy,
  })));
  Object.assign(forecast.consumption.quarterHourly[0], { generatedAt: generatedAt.toISOString() });
  const points = energyEstimatePoints([forecast], generatedAt);
  assert.deepEqual(points.slice(0, 4).map(point => point.estimatedConsumptionKwh), [0, .2, .3, .5]);
  assert.deepEqual(Object.keys(points[0]).sort(), ['end', 'estimatedConsumptionKwh', 'start']);
  const later = energyEstimatePoints([forecast], new Date(generatedAt.getTime() + quarterMs));
  assert.equal(later[0].estimatedConsumptionKwh, .2);
  forecast.consumption.quarterHourly[0].estimatedConsumptionKwh = 999;
  assert.deepEqual(energyEstimatePoints([forecast], generatedAt), [], 'invalid supplied quarters cannot silently fall back to hourly estimates');
});

test('solar production profiles are neither read nor recalculated during quarter-hour consumption capture', () => {
  const { forecast, generatedAt } = fixture();
  for (const key of ['hourly', 'estimatedProductionKwh']) {
    Object.defineProperty(forecast, key, { get() { throw new Error('solar processing belongs to the hourly batch'); } });
  }
  const points = energyEstimatePoints([forecast], generatedAt);
  assert.equal(points.length, 96);
  assert.equal(points[0].estimatedConsumptionKwh, .25);
  assert.ok(points.every(point => !('estimatedProductionKwh' in point)));
});

test('offline solar stays unknown while consumption survives and stale solar retains original provenance', () => {
  const { forecast, generatedAt } = fixture();
  forecast.status = 'offline';
  let points = energyEstimatePoints([forecast], generatedAt);
  assert.equal('solarFetchedAt' in points[0], false);
  assert.equal(points[0].estimatedConsumptionKwh, .25);
  forecast.status = 'stale';
  points = energyEstimatePoints([forecast], generatedAt);
  assert.equal('estimatedProductionKwh' in points[0], false);
  assert.equal('solarFetchedAt' in points[0], false);
  forecast.fetchedAt = new Date(generatedAt.getTime() + 6000).toISOString();
  assert.equal('solarFetchedAt' in energyEstimatePoints([forecast], generatedAt)[0], false);
});

test('missing, overlapping and invalid consumption profiles are rejected without inventing zero', () => {
  for (const mutate of [
    (value: EnergyForecast) => { Reflect.deleteProperty(value.consumption, 'quarterHourly'); },
    (value: EnergyForecast) => { value.consumption.quarterHourly.pop(); },
    (value: EnergyForecast) => { value.consumption.quarterHourly.push(structuredClone(value.consumption.quarterHourly[0])); },
    ...[-1, NaN, Infinity].map(invalid => (value: EnergyForecast) => { value.consumption.quarterHourly[0].estimatedConsumptionKwh = invalid; }),
  ]) {
    const { forecast, generatedAt } = fixture(); mutate(forecast);
    assert.deepEqual(energyEstimatePoints([forecast], generatedAt), []);
  }
});

test('timestamps and source dates must match the real hourly calendar', () => {
  const { forecast, generatedAt } = fixture();
  forecast.consumption.hourly[0].start = '2026-01-15T00:00:00';
  assert.deepEqual(energyEstimatePoints([forecast], generatedAt), []);
  forecast.consumption.date = '2026-01-16';
  assert.deepEqual(energyEstimatePoints([forecast], generatedAt), []);
  const invalidDate = { ...fixture().forecast, date: '2026-02-30' };
  assert.deepEqual(energyEstimatePoints([invalidDate], generatedAt), []);
  const shifted = fixture();
  shifted.forecast.consumption.hourly[0].end = new Date(shifted.generatedAt.getTime() + quarterMs).toISOString();
  assert.deepEqual(energyEstimatePoints([shifted.forecast], shifted.generatedAt), []);
});

test('duplicate forecast dates are rejected and distinct dates return chronological unique targets', () => {
  const first = fixture();
  const next = fixture('2026-01-16');
  assert.deepEqual(energyEstimatePoints([first.forecast, structuredClone(first.forecast)], first.generatedAt), []);
  const points = energyEstimatePoints([next.forecast, first.forecast], next.generatedAt);
  assert.equal(points.length, 96);
  assert.equal(new Set(points.map(point => point.start)).size, points.length);
  assert.ok(points.every(point => Date.parse(point.start) >= next.generatedAt.getTime()));
});

test('Zurich spring and autumn days retain 92 and 100 distinct UTC quarter-hour intervals', () => {
  for (const [date, expected] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const { forecast, generatedAt, bounds } = fixture(date);
    const points = energyEstimatePoints([forecast], generatedAt);
    assert.equal(points.length, expected);
    assert.equal(new Set(points.map(point => point.start)).size, expected);
    assert.equal(points[0].start, bounds.start.toISOString());
    assert.equal(points.at(-1)!.end, bounds.end.toISOString());
    for (const point of points) {
      assert.equal(Date.parse(point.end) - Date.parse(point.start), quarterMs);
      assert.equal(Date.parse(point.start) % quarterMs, 0);
    }
      near(sum(points), forecast.consumption.estimatedConsumptionKwh);
    if (date === '2026-10-25') {
      const repeated = points.filter(point => ['2026-10-25T00', '2026-10-25T01'].some(hour => point.start.startsWith(hour)));
      assert.equal(repeated.length, 8, 'both Zurich 02:00 hours remain separate UTC intervals');
    }
  }
});

test('native solar quarters preserve energy values with no archived generation metadata', () => {
  const { forecast, generatedAt } = fixture();
  const points = solarEstimatePoints([forecast], generatedAt);
  assert.equal(points.length, 96);
  assert.deepEqual(points.slice(0, 4).map(point => point.estimatedProductionKwh), [.5, .5, .5, .5]);
  near(points.reduce((sum, point) => sum + point.estimatedProductionKwh, 0), 48);
  assert.ok(points.every(point => Object.keys(point).sort().join(',') === 'end,estimatedProductionKwh,start'));
  assert.ok(energyEstimatePoints([forecast], generatedAt).every(point => !('generatedAt' in point)));
});

test('solar capture excludes completed quarters at the exact end boundary and never backfills them', () => {
  const { forecast, generatedAt, bounds } = fixture();
  const firstEnd = new Date(generatedAt.getTime() + hourMs);
  const during = solarEstimatePoints([forecast], new Date(firstEnd.getTime() - 1));
  assert.equal(during.length, 93, 'only the last quarter of the current hour can still be updated');
  for (const at of [firstEnd, new Date(firstEnd.getTime() + 1)]) {
    const points = solarEstimatePoints([forecast], at);
    assert.equal(points.length, 92);
    assert.equal(points[0].start, firstEnd.toISOString());
  }
  assert.deepEqual(solarEstimatePoints([forecast], bounds.end), []);
});

test('solar freeze treats the repeated Zurich autumn hours as distinct real hours', () => {
  const { forecast } = fixture('2026-10-25');
  const points = solarEstimatePoints([forecast], new Date('2026-10-25T01:00:00Z'));
  assert.equal(points[0].start, '2026-10-25T01:00:00.000Z');
  assert.equal(points.length, 88);
});

test('solar quarters keep zero, reject malformed or overlapping hours and retain DST slots', () => {
  for (const [date, count] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const { forecast, generatedAt } = fixture(date);
    const points = solarEstimatePoints([forecast], generatedAt);
    assert.equal(points.length, count);
    assert.equal(new Set(points.map(point => point.start)).size, count);
  }
  const { forecast, generatedAt } = fixture();
  forecast.hourly![0].estimatedProductionKwh = 0;
  forecast.quarterHourly!.slice(0, 4).forEach(point => { point.estimatedProductionKwh = 0; });
  forecast.estimatedProductionKwh! -= 2;
  assert.equal(solarEstimatePoints([forecast], generatedAt)[0].estimatedProductionKwh, 0);
  forecast.hourly!.push(structuredClone(forecast.hourly![0]));
  assert.deepEqual(solarEstimatePoints([forecast], generatedAt), []);
  forecast.hourly = [{ start: 'invalid', end: 'invalid', estimatedProductionKwh: 1, temperatureC: null }];
  assert.deepEqual(solarEstimatePoints([forecast], generatedAt), []);
});

function nativeSolarFixture(date = '2026-01-15') {
  const result = fixture(date);
  result.forecast.quarterHourly = result.forecast.hourly!.flatMap(hour => [1, 2, 3, 4].map((weight, index) => ({
    start: new Date(Date.parse(hour.start) + index * quarterMs).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * quarterMs).toISOString(),
    estimatedProductionKwh: hour.estimatedProductionKwh * weight / 10, temperatureC: hour.temperatureC,
  })));
  return result;
}

test('native solar capture keeps independent quarter values without metadata or hourly redistribution', () => {
  const { forecast, generatedAt } = nativeSolarFixture();
  const points = solarEstimatePoints([forecast], generatedAt);
  assert.deepEqual(points.slice(0, 4).map(point => point.estimatedProductionKwh), [.2, .4, .6, .8]);
  near(points.reduce((sum, point) => sum + point.estimatedProductionKwh, 0), 48);
  assert.ok(points.every(point => Object.keys(point).sort().join(',') === 'end,estimatedProductionKwh,start'));
  const current = new Date(generatedAt.getTime() + quarterMs);
  const later = solarEstimatePoints([forecast], current);
  assert.equal(later[0].start, current.toISOString(), 'completed native quarters stay frozen');
  assert.equal(later.length, 95);
});

test('invalid native solar is rejected instead of silently reverting to repeated hourly quarters', () => {
  for (const mutate of [
    (value: SolarForecast) => { value.quarterHourly!.pop(); },
    (value: SolarForecast) => { value.quarterHourly![0].estimatedProductionKwh = -1; },
    (value: SolarForecast) => { value.quarterHourly![0].estimatedProductionKwh = 123; },
    (value: SolarForecast) => { value.quarterHourly![1] = { ...value.quarterHourly![0] }; },
  ]) {
    const { forecast, generatedAt } = nativeSolarFixture(); mutate(forecast);
    assert.deepEqual(solarEstimatePoints([forecast], generatedAt), []);
  }
});

test('native solar capture preserves92 and100 distinct DST targets', () => {
  for (const [date, expected] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const { forecast, generatedAt } = nativeSolarFixture(date);
    const points = solarEstimatePoints([forecast], generatedAt);
    assert.equal(points.length, expected);
    assert.equal(new Set(points.map(point => point.start)).size, expected);
    assert.deepEqual(points.map(point => point.estimatedProductionKwh), forecast.quarterHourly!.map(point => point.estimatedProductionKwh));
  }
});

test('hourly-only solar profiles are not converted into native quarters', () => {
  const { forecast, generatedAt } = fixture();
  Reflect.deleteProperty(forecast, 'quarterHourly');
  assert.deepEqual(solarEstimatePoints([forecast], generatedAt), []);
});
