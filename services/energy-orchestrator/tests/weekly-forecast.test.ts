import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { summarizeForecast } from '../src/weekly-forecast.js';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast } from '../src/forecast.js';
import { getCalendarDayBounds } from '../src/policy.js';
import { predictHousehold } from '../src/household-model.js';
import { applyHouseholdFallback } from '../src/household-fallback.js';
import type { PublishedForecast } from '../src/forecast-publication.js';

function publication(date: string): PublishedForecast {
  const consumption = estimateConsumption(date, { baselinePowerW: 1000 });
  const { start, end } = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  return { calculatedAt: '2026-10-24T10:00:00.000Z', forecast: {
    ...emptySolarForecast(date, null), status: 'online', fetchedAt: '2026-10-24T10:00:00.000Z',
    estimatedProductionKwh: consumption.dayHours * 2,
    hourly: consumption.hourly.map(p => ({ ...p, estimatedProductionKwh: 2, temperatureC: null })),
    quarterHourly: consumption.quarterHourly.map(p => ({ ...p, estimatedProductionKwh: .5, temperatureC: null })),
    consumption, forecastPeriod: { start: start.toISOString(), end: end.toISOString(), from: start.toISOString() },
  }, projection: { status: 'available', reason: null, assumption: 'automatic_planning', observedAt: '2026-10-24T10:00:00.000Z',
    points: [{ at: start.toISOString(), socPercent: 60 }, { at: new Date(start.getTime() + 3600000).toISOString(), socPercent: 20 },
      { at: end.toISOString(), socPercent: 80 }] } };
}

test('weekly totals use complete Zurich calendar days, including spring and autumn DST', () => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25], ['2026-10-26', 24]] as const) {
    const saved = publication(date), original = structuredClone(saved);
    const day = summarizeForecast(date, saved, undefined, true);
    assert.equal(day.productionKwh, hours * 2);
    assert.equal(day.consumptionKwh, hours);
    assert.equal(day.batteryEndSocPercent, 80);
    assert.equal(day.batteryMinSocPercent, 20);
    assert.deepEqual(saved, original);
  }
});

test('missing quarters, stale data, zero energy, partial battery days and invalidated projections stay distinct', () => {
  const date = '2026-10-25', saved = publication(date);
  saved.forecast.status = 'stale';
  saved.forecast.quarterHourly!.forEach(p => { p.estimatedProductionKwh = 0; });
  assert.equal(summarizeForecast(date, saved, undefined, true).productionKwh, 0);
  saved.forecast.quarterHourly!.splice(4, 1);
  saved.projection.points.pop();
  const day = summarizeForecast(date, saved, undefined, true);
  assert.equal(day.productionKwh, null);
  assert.equal(day.consumptionKwh, 25);
  assert.equal(day.batteryEndSocPercent, null);
  assert.equal(day.batteryMinSocPercent, null);
  assert.equal(summarizeForecast(date, publication(date), undefined, false).batteryEndSocPercent, null);
  assert.equal(summarizeForecast(date, null, undefined, false).consumptionKwh, null);
});

test('weekly consumption uses saved household forecasts independently of solar and keeps missing model data unknown', () => {
  const date = '2026-10-25';
  const learned = applyHouseholdFallback(predictHousehold({ date, at: new Date('2026-10-24T10:00:00Z'), model: null }), [], { baselinePowerW: 2000, windowHours: 24 });
  assert.equal(summarizeForecast(date, null, learned, false).consumptionKwh, 50);
  assert.equal(summarizeForecast(date, publication(date), null, true).consumptionKwh, null);
  learned.slots[0].estimatedConsumptionKwh = null;
  assert.equal(summarizeForecast(date, null, learned, false).consumptionKwh, null);
});

test('week API reads seven future saved days without fetching providers and isolates individual read failures', async () => {
  const dates: string[] = [];
  const api = createApi({ now: () => new Date('2026-10-24T22:30:00Z'), forecast: { config: null,
    fetch: async () => { throw new Error('No provider calls on GET'); } },
    forecastStore: { async readForecast(date) { dates.push(date); if (date === '2026-10-27') throw new Error('offline'); return publication(date); } },
    estimates: { projection: () => publication('2026-10-26').projection, planner: () => null,
      status: () => ({ calculatedAt: '2026-10-24T10:00:00.000Z', nextEvaluationAt: '2026-10-25T12:15:00.000Z' }) } });
  const response = await api.request('/api/forecast/week');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const week = await response.json();
  assert.equal(week.timeZone, 'Europe/Zurich');
  assert.deepEqual(dates, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].batteryEndSocPercent, 80);
  assert.equal(week.days[1].productionKwh, null);
  assert.equal(week.days[2].productionKwh, 48);
});

test('week API suppresses battery estimates from a different committed batch', async () => {
  const api = createApi({ now: () => new Date('2026-10-24T10:00:00Z'), forecast: { config: null },
    forecastStore: { async readForecast(date) { return publication(date); } },
    estimates: { projection: () => publication('2026-10-25').projection, planner: () => null,
      status: () => ({ calculatedAt: '2026-10-24T10:15:00.000Z', nextEvaluationAt: '2026-10-24T10:30:00.000Z' }) } });
  const { days } = await (await api.request('/api/forecast/week')).json();
  assert.ok(days.every((day: any) => day.batteryEndSocPercent === null && day.productionKwh !== null));
});
