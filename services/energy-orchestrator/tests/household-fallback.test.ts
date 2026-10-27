import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHouseholdFallback, loadHouseholdFallbackConfig } from '../src/household-fallback.js';
import { householdDaySlots, predictHousehold, trainHouseholdModel, type HouseholdObservation } from '../src/household-model.js';

const at = new Date('2026-10-27T11:00:00Z');
const config = { baselinePowerW: 1000, windowHours: 24 };
const empty = (date = '2026-10-28', time = at) => predictHousehold({ date, at: time, model: null });
const readings = (count = 4, value = 500): HouseholdObservation[] => Array.from({ length: count }, (_, i) => ({
  at: new Date(at.getTime() - i * 900_000 - 30_000).toISOString(), value,
}));
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('missing slots prefer the recent measured average and disclose sampled hours rather than treating gaps as zero', () => {
  const samples = readings(); samples[3].at = new Date(at.getTime() - 20 * 3_600_000 - 30_000).toISOString();
  const forecast = applyHouseholdFallback(empty(), samples, config);
  assert.equal(forecast.source, 'recent_average'); assert.equal(forecast.status, 'fallback');
  assert.equal(forecast.fallback!.samples, 4); near(forecast.fallback!.observedHours, 1);
  near(forecast.fallback!.averagePowerW, 2000); near(forecast.estimatedConsumptionKwh, 48);
  assert.ok(forecast.slots.every(s => s.source === 'recent_average' && s.estimatedConsumptionKwh === .5));
  assert.equal(forecast.training, null);
});

test('insufficient, stale or missing observations use the configured baseline, including a valid zero baseline', () => {
  for (const samples of [[], readings(3), readings().map(p => ({ ...p, at: new Date(Date.parse(p.at) - 2 * 3_600_000).toISOString() }))]) {
    const forecast = applyHouseholdFallback(empty(), samples, { ...config, baselinePowerW: 800 });
    assert.equal(forecast.source, 'configured_baseline'); assert.equal(forecast.fallback!.averagePowerW, null);
    near(forecast.estimatedConsumptionKwh, 19.2);
  }
  near(applyHouseholdFallback(empty(), [], { ...config, baselinePowerW: 0 }).estimatedConsumptionKwh, 0);
});

test('future, duplicate, nonfinalized and invalid readings cannot supply an average; validated zeros can', () => {
  const samples = readings();
  samples.push({ ...samples[0] }, { at: '2026-10-27T11:00:01Z', value: 10000 },
    { at: '2026-10-27T10:00:00Z', value: NaN }, { at: '2026-10-27T10:14:30Z', value: -1 },
    { at: '2026-10-25T10:14:30Z', value: 10000 });
  assert.equal(applyHouseholdFallback(empty(), samples, config).source, 'configured_baseline');
  const zeros = applyHouseholdFallback(empty(), readings(4, 0), config);
  assert.equal(zeros.source, 'recent_average'); near(zeros.estimatedConsumptionKwh, 0);
  const time = new Date('2026-10-27T11:05:00Z');
  const active = { at: '2026-10-27T11:04:30Z', value: 500 };
  assert.equal(applyHouseholdFallback(empty('2026-10-28', time), [...readings(3), active], config).source, 'configured_baseline');
});

test('only missing slots are filled; learned zeroes, training profiles and coefficients stay unchanged', () => {
  const model = trainHouseholdModel({ id: 'mixed', at, observations: [
    { at: '2026-10-26T07:14:30Z', value: 0 }, { at: '2026-10-26T07:29:30Z', value: 1250 },
  ] });
  const original = structuredClone(model), prediction = predictHousehold({ date: '2026-10-28', at, model });
  const result = applyHouseholdFallback(prediction, readings(), config);
  assert.equal(result.source, 'mixed'); assert.equal(result.fallback!.appliedSlots, 94);
  assert.equal(result.slots.find(s => s.start === '2026-10-28T07:00:00.000Z')!.estimatedConsumptionKwh, 0);
  assert.equal(result.slots.find(s => s.start === '2026-10-28T07:15:00.000Z')!.estimatedConsumptionKwh, 1.25);
  assert.deepEqual(model, original); assert.equal(prediction.estimatedConsumptionKwh, null);
  assert.equal(prediction.slots.filter(s => s.estimatedConsumptionKwh === null).length, 94);
});

test('each observation contributes exactly fifteen minutes despite timestamp jitter and missing quarters', () => {
  const samples = readings();
  samples[0].at = '2026-10-27T10:59:50Z';
  samples[3].at = '2026-10-27T08:14:00Z';
  const result = applyHouseholdFallback(empty(), samples, config);
  near(result.fallback!.observedHours, 1);
  near(result.fallback!.averagePowerW, 2000);
  assert.equal(result.fallback!.alignment, 'nominal_quarter_approximation');
});

test('fallback totals preserve 23/24/25-hour days and use kW × interval duration', () => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-28', 24], ['2026-10-25', 25]] as const) {
    const prediction = applyHouseholdFallback(empty(date), [], { ...config, baselinePowerW: 1600 });
    near(prediction.estimatedConsumptionKwh, hours * 1.6);
    assert.equal(prediction.slots.length, hours * 4);
    assert.ok(prediction.slots.every(s => s.estimatedConsumptionKwh === .4));
    near(prediction.hourly.reduce((sum, h) => sum + h.estimatedConsumptionKwh!, 0), prediction.estimatedConsumptionKwh!);
  }
});

test('an available learned profile wins over the fallback and missing actuals remain gaps', () => {
  const observations = householdDaySlots('2026-10-26').map(s => ({ at: new Date(Date.parse(s.end) - 30000).toISOString(), value: 250 }));
  const model = trainHouseholdModel({ id: 'learned', at, observations });
  const learned = applyHouseholdFallback(predictHousehold({ date: '2026-10-28', at, model }), readings(), config);
  assert.equal(learned.source, 'measured_history'); assert.equal(learned.fallback!.appliedSlots, 0);
  near(learned.estimatedConsumptionKwh, 24);
  const today = applyHouseholdFallback(empty('2026-10-27'), readings(), config);
  near(today.updatedTotal!.futureKwh, 24);
  assert.equal(today.updatedTotal!.estimatedConsumptionKwh, null);
  assert.equal(today.updatedTotal!.status, 'incomplete');
});

test('the averaging window is configurable and invalid configuration fails explicitly', () => {
  assert.deepEqual(loadHouseholdFallbackConfig({}), config);
  assert.deepEqual(loadHouseholdFallbackConfig({ FORECAST_BASE_LOAD_W: '750', FORECAST_FALLBACK_WINDOW_HOURS: '6' }), { baselinePowerW: 750, windowHours: 6 });
  const samples = readings(); samples[3].at = new Date(at.getTime() - 12 * 3_600_000).toISOString();
  assert.equal(applyHouseholdFallback(empty(), samples, config).source, 'recent_average');
  assert.equal(applyHouseholdFallback(empty(), samples, { ...config, windowHours: 6 }).source, 'configured_baseline');
  for (const value of ['0', '-1', '1.5', '169', 'oops']) assert.throws(() => loadHouseholdFallbackConfig({ FORECAST_FALLBACK_WINDOW_HOURS: value }));
});
