import test from 'node:test';
import assert from 'node:assert/strict';
import { coldDegreeHours, householdDaySlots, predictHousehold, shiftDate, trainHouseholdModel,
  type HouseholdObservation, type HouseholdWeather } from '../src/household-model.js';

const at = new Date('2026-10-27T11:00:00Z');
const near = (actual: number | null, expected: number, tolerance = 1e-8) => assert.ok(actual !== null
  && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function history(today: string, count: number, energy: (date: string, index: number) => number = () => .25): HouseholdObservation[] {
  return Array.from({ length: count }, (_, i) => shiftDate(today, i - count)).flatMap(date => householdDaySlots(date).map((slot, i) => {
    const end = new Date(Date.parse(slot.end) - 30_000).toISOString();
    return { at: end, value: energy(date, i) * 1000 };
  }));
}
function weather(start: string, hours: number, temperature: (hour: number) => number, kind: 'historical' | 'forecast' = 'historical'): HouseholdWeather {
  return { kind, source: 'Open-Meteo', model: kind === 'historical' ? 'era5_land' : 'best_match', latitude: 47, longitude: 8,
    fetchedAt: at.toISOString(), availableAt: at.toISOString(), originalStepMinutes: 60,
    points: Array.from({ length: hours + 1 }, (_, i) => ({ at: new Date(Date.parse(start) + i * 3_600_000).toISOString(), temperatureC: temperature(i) })) };
}

test('household weights recency, converts Wh to kWh, and never invents missing slots', () => {
  const observations = [
    { at: '2026-10-26T07:14:30Z', value: 1000 },
    { at: '2026-10-12T06:14:30Z', value: 2000 },
    { at: '2026-10-26T07:29:30Z', value: 0 },
  ];
  const model = trainHouseholdModel({ id: 'test', at, observations });
  const forecast = predictHousehold({ date: '2026-10-28', at, model });
  near(forecast.slots.find(s => s.start === '2026-10-28T07:00:00.000Z')!.estimatedConsumptionKwh, 4 / 3);
  near(forecast.slots.find(s => s.start === '2026-10-28T07:15:00.000Z')!.estimatedConsumptionKwh, 0);
  assert.equal(forecast.estimatedConsumptionKwh, null);
  assert.equal(forecast.status, 'unavailable');
  assert.equal(forecast.scope, 'household_excluding_car'); assert.equal(forecast.excludesCar, true);
  assert.equal(forecast.training!.completeSamplingDays, 0);
});

test('weekday bonus waits for four matching days and enough complete sampling', () => {
  const observations = history('2026-10-27', 28, date => new Date(`${date}T00:00:00Z`).getUTCDay() === 2 ? 1 : .1);
  const model = trainHouseholdModel({ id: 'test', at, observations });
  const forecast = predictHousehold({ date: '2026-10-27', at, model });
  const slot = forecast.slots[40];
  assert.equal(slot.weekdayFactor, 4); assert.equal(slot.matchingWeekdays, 4);
  const weights = Array.from({ length: 28 }, (_, i) => {
    const date = shiftDate('2026-10-27', -i - 1), matching = new Date(`${date}T00:00:00Z`).getUTCDay() === 2;
    return { w: 2 ** (-(i + 1) / 14) * (matching ? 4 : 1), kwh: matching ? 1 : .1, matching };
  });
  near(slot.estimatedConsumptionKwh, weights.reduce((n, x) => n + x.w * x.kwh, 0) / weights.reduce((n, x) => n + x.w, 0));
  near(slot.weekdayWeightShare, weights.filter(x => x.matching).reduce((n, x) => n + x.w, 0) / weights.reduce((n, x) => n + x.w, 0));
  const short = trainHouseholdModel({ id: 'short', at, observations: history('2026-10-27', 13) });
  assert.equal(predictHousehold({ date: '2026-10-27', at, model: short }).slots[0].weekdayFactor, 1);
});

test('today contributes to training while duplicate slots, future data and older than 84 days stay excluded', () => {
  const observations = history('2026-10-27', 1);
  observations.push({ ...observations[0] }, { at: '2026-10-27T07:14:30Z', value: 999999 },
    { at: '2026-10-27T11:00:01Z', value: 999999 },
    { at: '2026-10-28T07:14:30Z', value: 999999 }, { at: '2026-01-01T07:14:30Z', value: 999999 });
  const model = trainHouseholdModel({ id: 'test', at, observations });
  assert.equal(model.training.observations, 96); assert.equal(model.training.usableDays, 2);
  assert.equal(model.training.completeSamplingDays, 0); assert.equal(model.training.to, '2026-10-27');
  assert.equal(predictHousehold({ date: '2026-10-28', at, model }).slots[0].estimatedConsumptionKwh, null);
});

test('elapsed readings from today update matching slots without completing or extrapolating the day', () => {
  const today = history('2026-10-28', 1, () => .5)
    .filter(p => Math.floor(Date.parse(p.at) / 900_000) * 900_000 + 900_000 <= at.getTime());
  const active = { at: '2026-10-27T11:04:30Z', value: 999999 };
  const trainingAt = new Date('2026-10-27T11:05:00Z');
  const observations = [...history('2026-10-27', 1), ...today, active];
  const model = trainHouseholdModel({ id: 'partial-today', at: trainingAt, observations });
  assert.equal(today.length, 48);
  assert.equal(model.training.observations, 144);
  assert.equal(model.training.completeSamplingDays, 1);
  const forecast = predictHousehold({ date: '2026-10-28', at: trainingAt, model });
  const weight = 2 ** (-1 / 14);
  near(forecast.slots[0].estimatedConsumptionKwh, (.5 + .25 * weight) / (1 + weight));
  assert.equal(forecast.slots[0].observations, 2);
  near(forecast.slots[48].estimatedConsumptionKwh, .25);
  assert.equal(forecast.slots[48].observations, 1);
  const onlyToday = trainHouseholdModel({ id: 'only-today', at, observations: today });
  assert.equal(onlyToday.training.completeSamplingDays, 0);
  const incomplete = predictHousehold({ date: '2026-10-28', at, model: onlyToday });
  near(incomplete.slots[0].estimatedConsumptionKwh, .5);
  assert.equal(incomplete.slots[48].estimatedConsumptionKwh, null);
  assert.equal(incomplete.estimatedConsumptionKwh, null);
});

test('today uses Zurich calendar dates at midnight and both DST offsets', () => {
  for (const timestamp of ['2026-01-14T23:15:00Z', '2026-03-29T00:15:00Z', '2026-03-29T01:15:00Z',
    '2026-10-25T00:15:00Z', '2026-10-25T01:15:00Z']) {
    const time = new Date(timestamp);
    const model = trainHouseholdModel({ id: timestamp, at: time,
      observations: [{ at: new Date(time.getTime() - 30_000).toISOString(), value: 0 }] });
    assert.equal(model.training.observations, 1);
    assert.equal(model.training.usableDays, 1);
    assert.equal(model.training.completeSamplingDays, 0);
    assert.equal(model.training.to, model.trainingDate);
    const forecast = predictHousehold({ date: shiftDate(model.trainingDate, 1), at: time, model });
    assert.ok(forecast.slots.some(s => s.estimatedConsumptionKwh === 0));
  }
});

test('daylight saving produces 92/96/100 contiguous quarters, hourly sums and exact daily sums', () => {
  for (const [date, length] of [['2026-03-29', 92], ['2026-10-25', 100], ['2026-10-27', 96]] as const) {
    const time = new Date(`${date}T10:00:00Z`);
    const model = trainHouseholdModel({ id: date, at: time, observations: history(date, 2) });
    const forecast = predictHousehold({ date, at: time, model });
    assert.equal(forecast.slots.length, length); assert.equal(forecast.hourly.length, length / 4);
    assert.equal(new Set(forecast.slots.map(s => s.start)).size, length);
    assert.ok(forecast.slots.every((s, i) => Date.parse(s.end) - Date.parse(s.start) === 900_000
      && (i === 0 || s.start === forecast.slots[i - 1].end)));
    near(forecast.estimatedConsumptionKwh, length * .25);
    near(forecast.hourly.reduce((n, s) => n + s.estimatedConsumptionKwh!, 0), forecast.estimatedConsumptionKwh!);
  }
});

test('temperature integration handles threshold crossings, missing values and no extrapolation', () => {
  const input = weather('2026-10-27T00:00:00Z', 1, i => i * 20);
  near(coldDegreeHours(input, Date.parse(input.points[0].at), Date.parse(input.points[1].at), 10), 2.5);
  near(coldDegreeHours(input, Date.parse(input.points[0].at), Date.parse(input.points[0].at) + 900_000, 10), 1.875);
  assert.equal(coldDegreeHours(input, Date.parse(input.points[0].at) - 1, Date.parse(input.points[1].at), 10), null);
  assert.equal(coldDegreeHours(input, Date.parse(input.points[0].at), Date.parse(input.points[1].at) + 1, 10), null);
  input.points[1].temperatureC = null;
  assert.equal(coldDegreeHours(input, Date.parse(input.points[0].at), Date.parse(input.points[1].at), 10), null);
});

test('weather eligibility uses fixed quarters from plain observations and excludes days with gaps or missing weather', () => {
  const input = weather('2026-08-01T00:00:00Z', 90 * 24, i => 10 + 10 * Math.sin(i / 80));
  const observations = history('2026-10-27', 28);
  const model = trainHouseholdModel({ id: 'test', at, observations, weather: input });
  assert.equal(model.training.completeSamplingDays, 28); assert.equal(model.training.weatherDays, 28);
  assert.equal(model.calibration, null); assert.equal(model.weatherStatus, 'insufficient_history');
  const gapped = trainHouseholdModel({ id: 'gapped', at, observations: observations.slice(1), weather: input });
  assert.equal(gapped.training.completeSamplingDays, 27); assert.equal(gapped.training.weatherDays, 27);
  input.points.find(p => p.at === '2026-10-26T10:00:00.000Z')!.temperatureC = null;
  const missingWeather = trainHouseholdModel({ id: 'missing-weather', at, observations, weather: input });
  assert.equal(missingWeather.training.completeSamplingDays, 28); assert.equal(missingWeather.training.weatherDays, 27);
});

test('learned weather correction removes historical heating before adding future heating', () => {
  const input = weather('2026-08-01T00:00:00Z', 90 * 24, i => 14 + 12 * Math.sin(i / 41) + 2 * Math.cos(i / 13));
  const observations = history('2026-10-27', 70, () => .2);
  for (const observation of observations) {
    const start = Math.floor(Date.parse(observation.at) / 900_000) * 900_000;
    observation.value += .12 * coldDegreeHours(input, start, start + 900_000, 15)! * 1000;
  }
  const model = trainHouseholdModel({ id: 'weather', at, observations, weather: input });
  assert.equal(model.weatherStatus, 'calibrated'); assert.ok(model.calibration);
  near(model.calibration.slopeKwPerC, .12, .03); near(model.calibration.balancePointC, 15, 3);
  const future = weather('2026-10-26T00:00:00Z', 96, () => 10, 'forecast');
  const forecast = predictHousehold({ date: '2026-10-28', at, model, weather: future });
  assert.equal(forecast.method, 'weighted_profile_weather'); near(forecast.estimatedConsumptionKwh, 33.6, 3);
  assert.equal(forecast.weather.validation!.kind, 'realized_weather_diagnostic');
  future.fetchedAt = '2026-10-26T00:00:00Z';
  const stale = predictHousehold({ date: '2026-10-28', at, model, weather: future });
  assert.equal(stale.method, 'weighted_profile'); assert.equal(stale.weather.status, 'unavailable');
});

test('constant temperatures, unavailable weather and expired models never invent coefficients or baseline energy', () => {
  const input = weather('2026-08-01T00:00:00Z', 90 * 24, () => 5);
  const model = trainHouseholdModel({ id: 'constant', at, observations: history('2026-10-27', 60, () => .3), weather: input });
  assert.equal(model.calibration, null); assert.equal(model.weatherStatus, 'not_identifiable');
  near(predictHousehold({ date: '2026-10-28', at, model }).estimatedConsumptionKwh, 28.8);
  const expired = predictHousehold({ date: '2026-10-28', at: new Date('2026-10-28T08:00:00Z'), model });
  assert.equal(expired.estimatedConsumptionKwh, null);
  const empty = trainHouseholdModel({ id: 'empty', at, observations: [] });
  assert.equal(predictHousehold({ date: '2026-10-28', at, model: empty }).estimatedConsumptionKwh, null);
});

test('today separates actuals and future fractions without filling historical or active-quarter gaps', () => {
  const model = trainHouseholdModel({ id: 'today', at, observations: history('2026-10-27', 2) });
  const actual = history('2026-10-28', 1, () => .5).filter(p => Date.parse(p.at) < at.getTime());
  const result = predictHousehold({ date: '2026-10-27', at, model, observations: actual });
  near(result.updatedTotal!.measuredKwh, 24); near(result.updatedTotal!.futureKwh, 12);
  near(result.updatedTotal!.estimatedConsumptionKwh, 36);
  const partial = predictHousehold({ date: '2026-10-27', at: new Date(at.getTime() + 300_000), model, observations: actual });
  assert.equal(partial.updatedTotal!.estimatedConsumptionKwh, null);
  near(partial.updatedTotal!.futureKwh, 12 - 1 / 12);
  assert.equal(predictHousehold({ date: '2026-10-27', at, model, observations: actual.slice(1) }).updatedTotal!.estimatedConsumptionKwh, null);
});
