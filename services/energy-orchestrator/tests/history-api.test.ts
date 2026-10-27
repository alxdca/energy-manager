import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { recordedEnergyReader } from './helpers/recorded-energy.js';
import type { HistoryDay } from '../src/history-reader.js';

const current = new Date('2026-10-25T12:00:00.000Z');
const now = () => current;

async function fixture() {
  const energy = recordedEnergyReader(now);
  const day: HistoryDay = {
    date: '2026-10-25', timeZone: 'Europe/Zurich', periodStart: '2026-10-24T22:00:00.000Z', periodEnd: '2026-10-25T23:00:00.000Z',
    dailyEnergy: energy.summary('2026-10-25'), measurements: energy.hourly('2026-10-25'),
    battery: { date: '2026-10-25', timeZone: 'Europe/Zurich', dayHours: 25,
      periodStart: '2026-10-24T22:00:00.000Z', periodEnd: '2026-10-25T23:00:00.000Z',
      status: 'ready', error: null, points: [] }, historicalEstimated: { status: 'ready', error: null, points: [] },
    solarEstimates: [],
    energyEstimates: [],
    observations: { method: 'counter_differences', solar: [], household: [] },
  };
  return { energy, day };
}

test('historical day metadata preserves exact Zurich bounds', async () => {
  const { day } = await fixture();
  const api = createApi({ controllerUrl: null, now, historyReader: {
    async day(date) { assert.equal(date, day.date); return day; },
  } });
  const response = await api.request('/api/history/day?date=2026-10-25');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.date, '2026-10-25');
  assert.equal(body.timeZone, 'Europe/Zurich');
  assert.equal(body.periodStart, '2026-10-24T22:00:00.000Z');
  assert.equal(body.periodEnd, '2026-10-25T23:00:00.000Z');
  assert.equal((Date.parse(body.periodEnd) - Date.parse(body.periodStart)) / 3_600_000, 25);
});

test('dashboard and forecast APIs serialize resolved asynchronous energy readers', async () => {
  const { energy } = await fixture();
  const dates: string[] = [];
  const api = createApi({ controllerUrl: null, forecast: { config: null }, now,
    dailyEnergyStore: {
      async summary(date, at) { dates.push(date); return energy.summary(date, at); },
      async hourly(date, at) { return energy.hourly(date, at); },
      async days(limit, at) { return energy.days(limit, at); },
    },
  });
  for (const path of ['/api/status', '/api/energy/today', '/api/forecast/today', '/api/forecast']) {
    const response = await api.request(path);
    assert.equal(response.status, 200, path);
    const body = await response.json();
    const summary = path === '/api/energy/today' ? body : body.dailyEnergy;
    assert.equal(summary.timeZone, 'Europe/Zurich', path);
    assert.equal(summary.status, 'unavailable', path);
    if (path.startsWith('/api/forecast')) assert.equal(body.measurements.hours.length, path.endsWith('today') ? 25 : 24);
  }
  assert.deepEqual(dates, ['2026-10-25', '2026-10-25', '2026-10-25', '2026-10-26']);
});

test('daily history pagination passes an exclusive date cursor and exposes the next cursor', async () => {
  const { energy } = await fixture();
  const calls: Array<{ limit: number | undefined; before: string | undefined }> = [];
  const api = createApi({ controllerUrl: null, now,
    dailyEnergyStore: {
      summary: energy.summary,
      async days(limit, _at, before) {
        calls.push({ limit, before });
        return before === undefined ? [energy.summary('2020-01-02')] : [];
      },
    },
  });
  const page = await (await api.request('/api/energy/days?limit=1')).json();
  assert.equal(page.days[0].date, '2020-01-02');
  assert.equal(page.nextBefore, '2020-01-02');
  const last = await (await api.request('/api/energy/days?limit=1&before=2020-01-02')).json();
  assert.deepEqual(last.days, []);
  assert.equal(last.nextBefore, null);
  assert.deepEqual(calls, [{ limit: 1, before: undefined }, { limit: 1, before: '2020-01-02' }]);
  for (const invalid of ['', '2026-02-30', '2026-1-01', 'garbage']) {
    assert.equal((await api.request(`/api/energy/days?before=${encodeURIComponent(invalid)}`)).status, 400);
  }
  assert.equal(calls.length, 2, 'invalid cursors never reach the reader');
});

test('historical day reads accept old dates and DST days without contacting device readers', async () => {
  const { day } = await fixture();
  const calls: string[] = [];
  const api = createApi({ controllerUrl: null, now,
    telemetryReader: async () => { throw new Error('history must not poll devices'); },
    historyReader: {
      async day(date, at) { calls.push(date); assert.equal(at, current); return day; },
    },
  });
  const response = await api.request('/api/history/day?date=2020-02-29');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), day);
  for (const date of ['', '2026-02-29', '2026-04-31', '2026-10-25T00:00:00Z']) {
    assert.equal((await api.request(`/api/history/day?date=${encodeURIComponent(date)}`)).status, 400);
  }
  assert.deepEqual(calls, ['2020-02-29']);
});

test('historical energy exposes real timestamps, measured zero and missing channels without polling devices', async () => {
  const { day } = await fixture();
  day.observations = { method: 'counter_differences', solar: [{ at: '2026-10-25T11:59:30.000Z', value: 0 }], household: [] };
  const api = createApi({ controllerUrl: null, now,
    telemetryReader: async () => { throw new Error('history must not poll devices'); },
    historyReader: { async day() { return day; } },
  });
  const response = await api.request('/api/history/day?date=2026-10-25');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.observations, day.observations);
  assert.equal(Object.hasOwn(body, 'intervalMeasurements'), false);
});

test('removed telemetry history endpoint returns404 without reading history or devices', async () => {
  const { day } = await fixture();
  let reads = 0;
  const configured = createApi({ controllerUrl: null,
    telemetryReader: async () => { throw new Error('removed archive must not poll devices'); },
    historyReader: { async day() { reads++; return day; } },
  });
  for (const api of [configured, createApi({ controllerUrl: null })]) {
    for (const method of ['GET', 'POST']) {
      const response = await api.request('/api/history/telemetry?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z', { method });
      assert.equal(response.status, 404);
    }
  }
  assert.equal(reads, 0, 'removed diagnostics cannot invoke the remaining history reader');
  const response = await configured.request(`/api/history/day?date=${day.date}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), day);
  assert.equal(reads, 1);
});

test('history failures and missing configuration produce sanitized no-store 503 responses', async () => {
  const unconfigured = createApi({ controllerUrl: null });
  const broken = createApi({ controllerUrl: null, historyReader: {
    async day() { throw new Error('postgres://user:secret@private-host/db'); },
  } });
  for (const api of [unconfigured, broken]) {
    for (const path of ['/api/history/day?date=2020-01-01']) {
      const response = await api.request(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await response.text(), /secret|private-host|postgres:/);
    }
  }
});

test('forecast battery observations await database history and isolate asynchronous failures', async () => {
  const { day } = await fixture();
  const api = createApi({ controllerUrl: null, now,
    batteryHistory: { async summary() { return { ...day.battery, points: [{ at: current.toISOString(), socPercent: 42 }] }; } },
  });
  const response = await api.request('/api/forecast/today');
  const result = await response.json();
  assert.equal(result.battery.dayHours, 25);
  assert.deepEqual(result.battery.observed.points, [{ at: current.toISOString(), socPercent: 42 }]);
  assert.equal(result.battery.estimated.status, 'unavailable');
  const failing = createApi({ controllerUrl: null, now,
    batteryHistory: { async summary() { throw new Error('database unavailable'); } },
  });
  const unavailable = await (await failing.request('/api/forecast/today')).json();
  assert.equal(unavailable.battery.observed.status, 'error');
  assert.deepEqual(unavailable.battery.observed.points, []);
});

test('history allows the seventh future Zurich day and blocks later dates before reading storage', async () => {
  const { day } = await fixture();
  for (const [timestamp, limit, blocked] of [
    ['2026-03-28T23:30:00Z', '2026-04-05', '2026-04-06'],
    ['2026-10-24T22:30:00Z', '2026-11-01', '2026-11-02'],
    ['2026-12-31T23:30:00Z', '2027-01-08', '2027-01-09'],
  ]) {
    const reads: string[] = [];
    const api = createApi({ now: () => new Date(timestamp), historyReader: {
      async day(date) { reads.push(date); return { ...day, date }; },
    } });
    assert.equal((await api.request(`/api/history/day?date=${limit}`)).status, 200);
    const response = await api.request(`/api/history/day?date=${blocked}`);
    assert.equal(response.status, 400); assert.equal((await response.json()).maxDate, limit);
    assert.equal((await api.request('/api/history/day?date=2030-01-01')).status, 400);
    assert.equal((await api.request('/api/history/day?date=2020-01-01')).status, 200);
    assert.deepEqual(reads, [limit, '2020-01-01']);
    assert.equal((await api.request('/api/forecast/week')).status, 404);
  }
});
