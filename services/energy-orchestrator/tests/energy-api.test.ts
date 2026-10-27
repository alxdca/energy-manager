import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { recordedEnergyReader } from './helpers/recorded-energy.js';
import { emptySolarForecast } from '../src/forecast.js';
import { getCalendarDayBounds } from '../src/policy.js';
test('daily energy without a runtime store is explicitly unconfigured and read-only', async () => {
  const api = createApi({ controllerUrl: null, now: () => new Date('2026-10-24T12:00:00Z'), forecast: { config: null } });
  const result = await (await api.request('/api/energy/today')).json();
  assert.equal(result.status, 'not_configured');
  assert.equal(result.date, '2026-10-24');
  assert.equal((await (await api.request('/api/status')).json()).dailyEnergy, null);
  assert.deepEqual((await (await api.request('/api/energy/days')).json()).days, []);
  assert.equal((await api.request('/api/energy/today', { method: 'POST' })).status, 404);
  assert.equal((await api.request('/api/energy/days', { method: 'POST' })).status, 404);
  for (const path of ['/api/forecast/today', '/api/forecast']) {
    const forecast = await (await api.request(path)).json();
    assert.equal(forecast.dailyEnergy, null);
    assert.equal(forecast.measurements, null);
  }
});

test('forecast daily totals include recorded readings even when weather fails', async () => {
  const clock = new Date('2026-10-24T12:00:15Z');
  const points = { solar: [{ at: '2026-10-24T12:00:10.000Z', value: 30 }, { at: '2026-10-24T12:00:15.000Z', value: 20 }],
    household: [{ at: '2026-10-24T12:00:10.000Z', value: 20 }, { at: '2026-10-24T12:00:15.000Z', value: 15 }] };
  const original = structuredClone(points);
  const store = recordedEnergyReader(() => clock, points);
  let controllerCalls = 0;
  let weatherCalls = 0;
  const api = createApi({ controllerUrl: 'http://controller.test', now: () => clock, dailyEnergyStore: store,
    fetch: async () => { controllerCalls++; throw new Error('Forecasts must not query devices'); },
    forecast: { config: { latitude: 0, longitude: 0, locationName: 'Installation de démonstration', arrayPowerKw: 8.5, performanceRatio: 0.85 },
      fetch: async () => { weatherCalls++; throw new Error('Weather unavailable'); } },
  });
  const response = await api.request('/api/forecast/today');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.status, 'offline');
  assert.deepEqual(result.dailyEnergy, store.summary('2026-10-24', clock));
  assert.equal(result.dailyEnergy.status, 'partial');
  assert.equal(result.dailyEnergy.solar.sampleCount, 2);
  assert.equal(result.dailyEnergy.solar.coverageSeconds, 0);
  assert.equal(result.dailyEnergy.household.sampleCount, 2);
  assert.equal(result.dailyEnergy.solar.energyKwh, .05);
  assert.equal(result.dailyEnergy.household.energyKwh, .035);
  assert.equal(result.measurements.hours.reduce((sum: number, hour: { solar: { sampleCount: number } }) => sum + hour.solar.sampleCount, 0), 2);
  assert.equal(controllerCalls, 0);
  assert.equal(weatherCalls, 0, 'forecast readers never invoke the provider');
  assert.deepEqual(points, original, 'forecast reads do not mutate recorded observations');
});

test('forecast totals and hourly measurements use each forecast date and one clock sampled after its read', async () => {
  let clock = new Date('2026-10-24T21:59:10Z');
  const store = recordedEnergyReader(() => clock, {
    solar: [{ at: clock.toISOString(), value: 10 }], household: [{ at: clock.toISOString(), value: 20 }],
  });
  const reads: Array<{ kind: string; date: string; current: Date | undefined }> = [];

  const api = createApi({ controllerUrl: null, now: () => clock,
    dailyEnergyStore: {
      days: store.days,
      summary: (date, current) => { reads.push({ kind: 'daily', date, current }); return store.summary(date, current); },
      hourly: (date, current) => { reads.push({ kind: 'hourly', date, current }); return store.hourly(date, current); },
    },
    forecastStore: { async readForecast(date) {
      const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
      clock = new Date('2026-10-24T22:00:00Z');
      return { calculatedAt: '2026-10-24T21:45:00.000Z',
        forecast: { ...emptySolarForecast(date, null), consumption: null,
          forecastPeriod: { start: bounds.start.toISOString(), end: bounds.end.toISOString(), from: bounds.start.toISOString() } },
        projection: { status: 'unavailable', reason: 'disabled', assumption: 'automatic_planning', observedAt: null, points: [] } };
    } },
  });
  const previousDay = await (await api.request('/api/forecast/today')).json();
  assert.equal(previousDay.date, '2026-10-24');
  assert.equal(previousDay.dailyEnergy.date, previousDay.date, 'rollover never relabels the returned forecast date');
  assert.equal(previousDay.measurements.date, previousDay.date);
  assert.equal(previousDay.dailyEnergy.solar.sampleCount, 1);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].kind, 'hourly');
  assert.equal(reads[1].kind, 'daily');
  assert.equal(reads[0].current, clock, 'measurement clock is captured after awaiting the forecast');
  assert.equal(reads[0].current, reads[1].current, 'daily and hourly summaries share the exact same instant');
  const nextDay = await (await api.request('/api/forecast')).json();
  assert.equal(nextDay.date, '2026-10-26');
  assert.equal(nextDay.dailyEnergy.date, nextDay.date);
  assert.equal(nextDay.measurements.date, nextDay.date);
  assert.equal(nextDay.dailyEnergy.solar.energyKwh, null, 'future dates never borrow current-day totals');
  assert.equal(nextDay.dailyEnergy.household.energyKwh, null);
  assert.equal(reads[2].current, reads[3].current);
  assert.equal(reads[2].date, nextDay.date);
  assert.equal(reads[3].date, nextDay.date);
});

test('daily energy API exposes recorded readings and never invokes weather', async () => {
  let clock = new Date('2026-10-24T12:00:10Z');
  const points = { solar: [{ at: clock.toISOString(), value: 30 }], household: [{ at: clock.toISOString(), value: 20 }] };
  const original = structuredClone(points);
  const store = recordedEnergyReader(() => clock, points);
  const api = createApi({ controllerUrl: null, now: () => clock, dailyEnergyStore: store,
    forecast: { config: null, fetch: async () => { throw new Error('Daily reads must not invoke weather'); } },
  });
  const response = await api.request('/api/energy/today');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const day = await response.json();
  assert.equal(day.status, 'partial');
  assert.equal(day.date, '2026-10-24');
  assert.equal(day.solar.coverageSeconds, 0);
  assert.equal(day.solar.sampleCount, 1);
  assert.equal(day.solar.energyKwh, .03);
  assert.equal(day.household.energyKwh, .02);
  assert.equal(day.solarSource, 'GEN24 PV (DC)');
  assert.equal(day.householdIncludesCar, true);
  assert.deepEqual((await (await api.request('/api/status')).json()).dailyEnergy, day);
  assert.deepEqual((await (await api.request('/api/energy/days?limit=1')).json()).days, [day]);
  assert.deepEqual(points, original, 'read routes do not mutate recorded observations');
  clock = new Date('2026-10-24T22:00:00Z');
  const newDay = await (await api.request('/api/energy/today')).json();
  assert.equal(newDay.date, '2026-10-25');
  assert.equal(newDay.dayHours, 25);
  assert.equal(newDay.status, 'unavailable');
  assert.equal(newDay.solar.energyKwh, null, 'yesterday is never relabeled as today');
  assert.equal((await (await api.request('/api/energy/days')).json()).days[0].date, '2026-10-24');
});

test('history list validates its bound without querying devices or exposing local files', async () => {
  const api = createApi({ controllerUrl: null, forecast: { config: null } });
  for (const limit of ['0', '-1', '367', '1.5', 'NaN', '../data']) {
    assert.equal((await api.request(`/api/energy/days?limit=${encodeURIComponent(limit)}`)).status, 400);
  }
  assert.equal((await api.request('/api/energy/days?limit=366')).status, 200);
  assert.equal((await api.request('/data/daily-energy.json')).status, 404);
});
