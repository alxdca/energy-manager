import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatteryChart } from '../src/battery-chart.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { BatteryProjection } from '../src/battery-projection.js';

const projection: BatteryProjection = { status: 'available', reason: null, assumption: 'automatic_planning',
  observedAt: '2026-10-25T12:07:00.000Z', points: [
    { at: '2026-10-24T22:00:00.000Z', socPercent: 60 },
    { at: '2026-10-25T12:15:00.000Z', socPercent: 55 },
    { at: '2026-10-25T23:00:00.000Z', socPercent: 40 },
    { at: '2026-10-25T23:15:00.000Z', socPercent: 39 },
  ] };

test('battery chart composes recorded observations and committed SOC without recalculation', () => {
  const observed = { date: '2026-10-25', timeZone: 'Europe/Zurich' as const, dayHours: 25 as const,
    periodStart: '2026-10-24T22:00:00.000Z', periodEnd: '2026-10-25T23:00:00.000Z',
    status: 'ready' as const, error: null, points: [{ at: '2026-10-25T12:05:00.000Z', socPercent: 56 }] };
  const before = structuredClone({ projection, observed });
  const chart = buildBatteryChart(observed.date, projection, observed);
  assert.equal(chart.dayHours, 25);
  assert.deepEqual(chart.observed, { status: 'ready', error: null, points: observed.points });
  assert.deepEqual(chart.estimated.points, projection.points.slice(0, 3));
  assert.deepEqual({ projection, observed }, before);
  assert.equal(Object.hasOwn(chart, 'historicalEstimated'), false);
});

test('chart calendar boundaries cover real 23,24,25-hour Zurich days', () => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-24', 24], ['2026-10-25', 25]] as const) {
    const chart = buildBatteryChart(date, projection);
    const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
    assert.equal(chart.dayHours, hours);
    assert.equal(chart.periodStart, bounds.start.toISOString());
    assert.equal(chart.periodEnd, bounds.end.toISOString());
  }
});

test('missing or mismatched observations stay explicitly unavailable', () => {
  const chart = buildBatteryChart('2026-10-25', projection);
  assert.equal(chart.observed.status, 'error');
  assert.deepEqual(chart.observed.points, []);
  const mismatched = buildBatteryChart('2026-10-24', projection, {
    date: '2026-10-25', timeZone: 'Europe/Zurich', dayHours: 25,
    periodStart: chart.periodStart, periodEnd: chart.periodEnd, status: 'ready', error: null,
    points: [{ at: '2026-10-25T12:00:00Z', socPercent: 56 }],
  });
  assert.equal(mismatched.observed.status, 'error');
  assert.deepEqual(mismatched.observed.points, []);
});
