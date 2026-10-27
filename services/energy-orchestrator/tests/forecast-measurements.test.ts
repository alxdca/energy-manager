import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { recordedEnergyReader } from './helpers/recorded-energy.js';
import type { BatteryProjection } from '../src/battery-projection.js';
import { emptySolarForecast } from '../src/forecast.js';

test('forecast responses include recorded readings without weather, and future hours stay unknown', async () => {
  const now = () => new Date('2026-10-24T14:00:10.000Z');
  const points = { solar: [{ at: '2026-10-24T13:59:50.000Z', value: 10 }, { at: '2026-10-24T14:00:10.000Z', value: 20 }],
    household: [{ at: '2026-10-24T13:59:50.000Z', value: 20 }, { at: '2026-10-24T14:00:10.000Z', value: 40 }] };
  const store = recordedEnergyReader(now, points);
  const original = store.summary('2026-10-24', now());
  const calls: string[] = [];
  const api = createApi({ controllerUrl: null, now, forecast: { config: null },
    fetch: async () => { throw new Error('Measurements must not trigger device commands or weather requests'); },
    dailyEnergyStore: { summary: store.summary, days: store.days,
      hourly(date, at) { calls.push(date); return store.hourly(date, at); } },
  });
  const response = await api.request('/api/forecast/today');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const today = await response.json();
  assert.equal(today.status, 'not_configured');
  assert.equal(today.measurements.date, today.date);
  assert.equal(today.measurements.hours.length, 24);
  assert.equal(today.consumption, null, 'measurements cannot trigger a forecast calculation');
  assert.equal(today.estimatedProductionKwh, null);
  const measured = today.measurements.hours.filter((hour: any) => hour.solar.energyKwh !== null);
  assert.equal(measured.length, 2);
  assert.deepEqual(measured.map((hour: any) => hour.solar.sampleCount), [1, 1]);
  assert.deepEqual(measured.map((hour: any) => hour.solar.coverageSeconds), [0, 0]);
  assert.equal(measured.reduce((sum: number, hour: any) => sum + hour.solar.energyKwh, 0), .03);
  assert.equal(measured.reduce((sum: number, hour: any) => sum + hour.household.energyKwh, 0), .06);
  assert.equal(today.measurements.solarSource, 'GEN24 PV (DC)');
  assert.equal(today.measurements.householdIncludesCar, false);
  assert.ok(measured.some((hour: { end: string }) => Date.parse(hour.end) < now().getTime()),
    'past observations must not be removed with past predictions');
  const tomorrow = await (await api.request('/api/forecast')).json();
  assert.equal(tomorrow.measurements.date, '2026-10-25');
  assert.equal(tomorrow.measurements.hours.length, 25);
  assert.ok(tomorrow.measurements.hours.every((hour: any) => hour.solar.energyKwh === null && hour.household.energyKwh === null));
  assert.deepEqual(calls, ['2026-10-24', '2026-10-25']);
  assert.deepEqual(store.summary('2026-10-24', now()), original, 'Reading charts must not record or alter energy');
  assert.equal((await api.request('/api/forecast/today', { method: 'POST' })).status, 404);
});

test('missing hourly collector support remains explicitly unknown and keeps existing forecasts readable', async () => {
  const api = createApi({ controllerUrl: null, forecast: { config: null } });
  for (const path of ['/api/forecast/today', '/api/forecast']) {
    const response = await api.request(path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.measurements, null);
    assert.equal(body.consumption, null);
  }
});

test('forecast API serves committed manual charging targets and preserves specific unavailable reasons', async () => {
  const at = '2026-10-24T12:00:00.000Z';
  const committed: BatteryProjection = { status: 'available', reason: null, assumption: 'manual_charging', observedAt: at,
    points: [{ at: '2026-10-24T12:15:00.000Z', socPercent: 41 }] };
  let runtime = structuredClone(committed);
  const api = createApi({ controllerUrl: null, now: () => new Date(at), forecast: { config: null },
    estimates: { planner: () => null, projection: () => runtime,
      status: () => ({ calculatedAt: at, nextEvaluationAt: '2026-10-24T12:15:00.000Z' }) },
    forecastStore: { async readForecast(date) {
      return { calculatedAt: at, projection: committed,
        forecast: { ...emptySolarForecast(date, null), consumption: null,
          forecastPeriod: { start: '2026-10-23T22:00:00.000Z', end: '2026-10-24T22:00:00.000Z', from: at } } };
    } },
  });
  const shown = await (await api.request('/api/forecast/today')).json();
  assert.deepEqual(shown.battery.estimated, committed);
  runtime = { status: 'unavailable', reason: 'manual_charge_invalid', assumption: 'manual_charging', observedAt: null, points: [] };
  const invalid = await (await api.request('/api/forecast/today')).json();
  assert.equal(invalid.battery.estimated.reason, 'manual_charge_invalid');
  assert.equal(invalid.battery.estimated.assumption, 'manual_charging');
  assert.deepEqual(invalid.battery.estimated.points, [], 'stale committed targets cannot override runtime invalidation');
});
