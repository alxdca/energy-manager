import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, type ApiOptions } from '../src/api.js';
import { emptySolarForecast } from '../src/forecast.js';
import { estimateConsumption } from '../src/consumption.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { BatteryProjection } from '../src/battery-projection.js';

function fixture() {
  let clock = new Date('2026-10-25T12:07:00Z');
  const date = '2026-10-25';
  const consumption = estimateConsumption(date, { baselinePowerW: 1000 });
  const { start, end } = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  const projection: BatteryProjection = { status: 'available', reason: null, assumption: 'automatic_planning',
    observedAt: clock.toISOString(), points: [{ at: '2026-10-25T12:15:00.000Z', socPercent: 55 }] };
  const publication = { calculatedAt: clock.toISOString(), projection,
    forecast: { ...emptySolarForecast(date, null), status: 'online' as const, fetchedAt: clock.toISOString(),
      estimatedProductionKwh: 2,
      hourly: [{ start: '2026-10-25T12:00:00.000Z', end: '2026-10-25T13:00:00.000Z', estimatedProductionKwh: 2, temperatureC: 10 }],
      quarterHourly: [{ start: '2026-10-25T12:00:00.000Z', end: '2026-10-25T12:15:00.000Z', estimatedProductionKwh: .5, temperatureC: 10 }],
      consumption, forecastPeriod: { start: start.toISOString(), end: end.toISOString(), from: '2026-10-25T12:00:00.000Z' } } };
  let available = true, published = true, failed = false;
  const reads: string[] = [];
  const options = { controllerUrl: null, now: () => clock,
    forecastStore: { async readForecast(requested: string) {
      reads.push(requested);
      if (failed) throw new Error('secret postgres connection');
      return published && requested === date ? structuredClone(publication) : null;
    } },
    estimates: { planner: () => null, status: () => ({ calculatedAt: publication.calculatedAt, nextEvaluationAt: '2026-10-25T12:15:00.000Z' }),
      projection: (): BatteryProjection => available ? structuredClone(projection)
        : { status: 'unavailable', reason: 'awaiting_evaluation', assumption: 'automatic_planning', observedAt: null, points: [] } },
    batteryHistory: { async summary(requested: string) { return { date: requested, timeZone: 'Europe/Zurich' as const, dayHours: 25 as const,
      periodStart: start.toISOString(), periodEnd: end.toISOString(), status: 'ready' as const, error: null,
      points: [{ at: clock.toISOString(), socPercent: 40 }] }; } },
    telemetryReader: async () => { throw new Error('forecast GET must not recapture inputs'); },
    fetch: async () => { throw new Error('forecast GET must not fetch weather or control'); },
  };
  const app = createApi(options as ApiOptions);
  return { app, publication, reads, options,
    advance: () => { clock = new Date('2026-10-25T12:12:00Z'); },
    invalidate: () => { available = false; }, unpublish: () => { published = false; }, fail: () => { failed = true; } };
}

test('forecast GETs use committed rows without prorating or changing estimates between batches', async () => {
  const f = fixture();
  const firstResponse = await f.app.request('/api/forecast/today');
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
  const first = await firstResponse.json();
  assert.deepEqual(first.quarterHourly, f.publication.forecast.quarterHourly);
  assert.deepEqual(first.consumption, f.publication.forecast.consumption);
  assert.deepEqual(first.battery.estimated, f.publication.projection);
  assert.equal(first.estimates.calculatedAt, f.publication.calculatedAt);
  assert.equal(first.forecastPeriod.from, '2026-10-25T12:00:00.000Z');
  f.advance();
  const later = await (await f.app.request('/api/forecast/today')).json();
  assert.deepEqual(later.quarterHourly, first.quarterHourly);
  assert.deepEqual(later.hourly, first.hourly);
  assert.deepEqual(later.consumption, first.consumption);
  assert.deepEqual(later.battery.estimated, first.battery.estimated);
  assert.notDeepEqual(later.battery.observed, first.battery.observed, 'observations can refresh independently');
  assert.deepEqual(f.reads, ['2026-10-25', '2026-10-25']);
});

test('unpublished forecasts remain unknown and cannot start a calculation', async () => {
  const f = fixture(); f.unpublish();
  const result = await (await f.app.request('/api/forecast/today')).json();
  assert.equal(result.consumption, null);
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.estimates.calculatedAt, null);
  assert.equal(result.battery.estimated.status, 'unavailable');
});

test('manual invalidation hides saved SOC while preserving committed energy', async () => {
  const f = fixture(); f.invalidate();
  const result = await (await f.app.request('/api/forecast/today')).json();
  assert.deepEqual(result.quarterHourly, f.publication.forecast.quarterHourly);
  assert.equal(result.battery.estimated.status, 'unavailable');
  assert.deepEqual(result.battery.estimated.points, []);
});

test('restart cannot display persisted automatic SOC before a valid runtime batch', async () => {
  const f = fixture();
  const app = createApi({ ...f.options, estimates: undefined } as ApiOptions);
  const result = await (await app.request('/api/forecast/today')).json();
  assert.deepEqual(result.quarterHourly, f.publication.forecast.quarterHourly);
  assert.equal(result.battery.estimated.status, 'unavailable');
  assert.deepEqual(result.battery.estimated.points, []);
});

test('database read failures return sanitized unavailable feedback without fallbacks', async () => {
  const f = fixture(); f.fail();
  const response = await f.app.request('/api/forecast/today');
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /indisponibles/);
  assert.doesNotMatch(text, /secret|postgres/);
});
