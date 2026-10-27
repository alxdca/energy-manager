import { getCalendarDayBounds, getLocalDate, timeZone } from './policy.js';
import type { HouseholdInterval, ObservationPoint } from './observation-types.js';
export type { HouseholdInterval } from './observation-types.js';

export const householdModelVersion = 'household-profile-v1';
const quarterMs = 900_000;
const hourMs = 3_600_000;
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const clockTime = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface HouseholdObservation extends ObservationPoint { interval?: HouseholdInterval }
export interface HouseholdWeather {
  kind: 'historical' | 'forecast'; source: 'Open-Meteo'; model: string;
  latitude: number; longitude: number; fetchedAt: string; availableAt: string; originalStepMinutes: 60;
  points: Array<{ at: string; temperatureC: number | null }>;
}
interface Sample { start: number; end: number; key: string; kwh: number; interval?: HouseholdInterval }
interface Day { date: string; samples: Sample[]; complete: boolean }
export interface ProfileSlot {
  kwh: number | null; observations: number; matchingWeekdays: number; weekdayFactor: 1 | 4; weekdayWeightShare: number | null;
  removedHeatingKwh: number;
}
export interface WeatherCalibration {
  slopeKwPerC: number; balancePointC: number; minTemperatureC: number; maxTemperatureC: number;
}
export interface HouseholdModel {
  id: string; version: typeof householdModelVersion; trainedAt: string; trainingDate: string; validUntil: string;
  scope: 'household_total'; mode: 'observation';
  training: { from: string; to: string; usableDays: number; completeSamplingDays: number; observations: number;
    weatherDays: number; halfLifeDays: 14; originalStepMinutes: 15; alignment: 'nominal_quarter_approximation' };
  profiles: Record<string, ProfileSlot>;
  weatherProfiles: Record<string, ProfileSlot>;
  calibration: WeatherCalibration | null;
  weatherLocation: { latitude: number; longitude: number } | null;
  weatherStatus: 'unavailable' | 'insufficient_history' | 'not_identifiable' | 'not_validated' | 'calibrated';
  validation: { kind: 'realized_weather_diagnostic'; selectionDays: 7; holdoutDays: 7 } | null;
}
export interface HouseholdForecastSlot {
  start: string; end: string; estimatedConsumptionKwh: number | null;
  observations: number; matchingWeekdays: number; weekdayFactor: 1 | 4; weekdayWeightShare: number | null;
  weatherAdjustmentKwh: number | null;
  source?: 'learned_profile' | 'recent_average' | 'configured_baseline';
}
export interface HouseholdForecast {
  date: string; issuedAt: string; modelId: string | null; trainedAt: string | null; modelVersion: typeof householdModelVersion;
  source: 'measured_history' | 'recent_average' | 'configured_baseline' | 'mixed';
  scope: 'household_total'; excludesCar: false; mode: 'observation'; stepMinutes: 15; unit: 'kWh';
  status: 'unavailable' | 'learning' | 'available' | 'fallback';
  method: 'weighted_profile' | 'weighted_profile_weather' | 'recent_average' | 'configured_baseline' | 'mixed';
  estimatedConsumptionKwh: number | null; fallbackReason: string | null; uncertainty: 'uncalibrated';
  slots: HouseholdForecastSlot[];
  hourly: Array<{ start: string; end: string; estimatedConsumptionKwh: number | null }>;
  training: HouseholdModel['training'] | null;
  fallback?: {
    windowHours: number; windowStart: string; windowEnd: string; minimumSamples: 4; samples: number; observedHours: number;
    averagePowerW: number | null; baselinePowerW: number; appliedSlots: number; source: 'recent_average' | 'configured_baseline' | null;
    alignment: 'observed_intervals' | 'nominal_quarter_approximation' | 'mixed' | null;
  };
  weather: { status: string; calibration: WeatherCalibration | null; fetchedAt: string | null;
    model: string | null;
    originalStepMinutes: 60 | null; alignment: 'linear_interpolation' | null; alignmentToleranceSeconds: 60;
    validation: HouseholdModel['validation'] };
  updatedTotal: { measuredKwh: number; futureKwh: number | null; estimatedConsumptionKwh: number | null;
    status: 'approximate' | 'incomplete'; measuredThrough: string } | null;
}

export function householdDaySlots(date: string) {
  const day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !finite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error('Invalid household date.');
  const { start, end } = getCalendarDayBounds(day);
  return Array.from({ length: (end.getTime() - start.getTime()) / quarterMs }, (_, i) => ({
    start: new Date(start.getTime() + i * quarterMs).toISOString(), end: new Date(start.getTime() + (i + 1) * quarterMs).toISOString(),
  }));
}

/** Eligibility comes from finalized household deltas, independently of solar and aggregate coverage. */
function prepare(observations: HouseholdObservation[], at: Date): Day[] {
  const buckets = new Map<number, HouseholdObservation[]>();
  for (const point of observations) {
    const observed = Date.parse(point.at);
    if (!finite(observed) || observed > at.getTime() || !finite(point.value) || point.value < 0
      || point.interval && (!finite(Date.parse(point.interval.availableAt)) || Date.parse(point.interval.availableAt) > at.getTime())) continue;
    const start = Math.floor(observed / quarterMs) * quarterMs;
    const bucket = buckets.get(start) ?? []; bucket.push(point); buckets.set(start, bucket);
  }
  const days = new Map<string, Day>();
  for (const [start, points] of buckets) {
    if (points.length !== 1) continue; // Duplicates are ambiguous, even if their energy matches.
    const point = points[0], date = getLocalDate(new Date(start));
    const day = days.get(date) ?? { date, samples: [], complete: false };
    day.samples.push({ start, end: start + quarterMs, key: clockTime.format(new Date(start)), kwh: point.value / 1000, interval: point.interval });
    days.set(date, day);
  }
  for (const day of days.values()) {
    day.samples.sort((a, b) => a.start - b.start);
    const slots = householdDaySlots(day.date);
    day.complete = slots.length === day.samples.length && day.samples.every((s, i) => s.start === Date.parse(slots[i].start));
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Integrate max(0, threshold − T) across hourly linear segments, with no extrapolation. */
export function coldDegreeHours(weather: HouseholdWeather | undefined, start: number, end: number, threshold: number): number | null {
  if (!weather || !finite(start) || !finite(end) || end <= start) return null;
  const points = weather.points;
  let low = 0, high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(points[middle].at) <= start) low = middle + 1; else high = middle;
  }
  let cursor = start, sum = 0;
  for (let i = Math.max(1, low); i < points.length && cursor < end; i++) {
    const a = Date.parse(points[i - 1].at), b = Date.parse(points[i].at);
    const left = points[i - 1].temperatureC, right = points[i].temperatureC;
    if (a > cursor || b <= cursor || b - a !== hourMs || !finite(left) || !finite(right)) return null;
    const until = Math.min(end, b), hours = (until - cursor) / hourMs;
    const x = threshold - (left + (right - left) * (cursor - a) / hourMs);
    const y = threshold - (left + (right - left) * (until - a) / hourMs);
    sum += x >= 0 && y >= 0 ? (x + y) / 2 * hours
      : x > 0 ? x * x / (2 * (x - y)) * hours : y > 0 ? y * y / (2 * (y - x)) * hours : 0;
    cursor = until;
  }
  return cursor === end ? sum : null;
}
function aligned(s: Sample): boolean {
  const x = s.interval;
  if (!x || !x.source.trim() || x.at !== x.end) return false;
  const a = Date.parse(x.start), b = Date.parse(x.end);
  return finite(a) && finite(b) && b > a && b >= s.start && b < s.end
    && Date.parse(x.nominalStart) === s.start && Date.parse(x.nominalEnd) === s.end
    && s.start - a > 0 && s.start - a <= 60_000 && s.end - b > 0 && s.end - b <= 60_000;
}
function weatherCovered(day: Day): boolean {
  return day.complete && day.samples.every((s, i) => aligned(s) && (i === 0
    || s.interval!.start === day.samples[i - 1].interval!.end && s.interval!.source === day.samples[i - 1].interval!.source));
}
const degrees = (s: Sample, weather: HouseholdWeather, threshold: number) =>
  coldDegreeHours(weather, Date.parse(s.interval!.start), Date.parse(s.interval!.end), threshold);

function profiles(days: Day[], reference: string, weather?: HouseholdWeather, calibration?: WeatherCalibration): Record<string, ProfileSlot> {
  const grouped = new Map<string, Array<{ date: string; kwh: number; heating: number }>>();
  for (const day of days) {
    const times = new Map<string, Array<{ kwh: number; heating: number }>>();
    for (const sample of day.samples) {
      const g = calibration ? aligned(sample) ? degrees(sample, weather!, calibration.balancePointC) : null : 0;
      if (g === null) continue;
      const values = times.get(sample.key) ?? [];
      values.push({ kwh: sample.kwh, heating: (calibration?.slopeKwPerC ?? 0) * g }); times.set(sample.key, values);
    }
    for (const [key, values] of times) {
      // Autumn's repeated local quarter contributes one mean per historical date.
      const items = grouped.get(key) ?? [];
      items.push({ date: day.date, kwh: values.reduce((n, v) => n + v.kwh, 0) / values.length,
        heating: values.reduce((n, v) => n + v.heating, 0) / values.length }); grouped.set(key, items);
    }
  }
  const result: Record<string, ProfileSlot> = {};
  const completeDays = days.filter(d => d.complete).length;
  for (let dow = 0; dow < 7; dow++) for (const [key, items] of grouped) {
    const matching = items.filter(x => weekday(x.date) === dow).length;
    const bonus = completeDays >= 14 && matching >= 4 ? 4 : 1;
    let numerator = 0, denominator = 0, sameDay = 0, removed = 0;
    for (const item of items) {
      const same = weekday(item.date) === dow;
      const w = 2 ** (-daysApart(reference, item.date) / 14) * (same ? bonus : 1);
      numerator += (item.kwh - item.heating) * w; removed += item.heating * w;
      denominator += w; if (same) sameDay += w;
    }
    result[`${dow}/${key}`] = { kwh: denominator > 0 ? numerator / denominator : null, observations: items.length,
      matchingWeekdays: matching, weekdayFactor: bonus, weekdayWeightShare: denominator > 0 ? sameDay / denominator : null,
      removedHeatingKwh: denominator > 0 ? removed / denominator : 0 };
  }
  return result;
}
function fit(days: Day[], weather: HouseholdWeather, threshold: number): WeatherCalibration | null {
  const rows = days.map(day => {
    const start = Date.parse(day.samples[0].interval!.start), end = Date.parse(day.samples.at(-1)!.interval!.end);
    const hours = (end - start) / hourMs;
    const g = coldDegreeHours(weather, start, end, threshold), t = coldDegreeHours(weather, start, end, 100);
    return g === null || t === null ? null : { x: g / hours, temperature: 100 - t / hours,
      y: day.samples.reduce((n, s) => n + s.kwh, 0) / hours, dow: weekday(day.date),
      w: 2 ** (-daysApart(days.at(-1)!.date, day.date) / 14) };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  if (rows.length < 28) return null;
  const cold = rows.filter(r => r.temperature < threshold), warm = rows.filter(r => r.temperature >= threshold);
  if (cold.length < 7 || warm.length < 7 || warm.reduce((n, r) => n + r.temperature, 0) / warm.length
    - cold.reduce((n, r) => n + r.temperature, 0) / cold.length < 3) return null;
  const means = new Map<number, { x: number; y: number; w: number }>();
  for (const row of rows) {
    const m = means.get(row.dow) ?? { x: 0, y: 0, w: 0 };
    m.x += row.x * row.w; m.y += row.y * row.w; m.w += row.w; means.set(row.dow, m);
  }
  let xy = 0, xx = 0;
  for (const row of rows) {
    const m = means.get(row.dow)!, x = row.x - m.x / m.w;
    xy += row.w * x * (row.y - m.y / m.w); xx += row.w * x * x;
  }
  if (xx < 1e-8 || xy <= 0) return null;
  return { slopeKwPerC: xy / xx, balancePointC: threshold,
    minTemperatureC: Math.min(...rows.map(r => r.temperature)), maxTemperatureC: Math.max(...rows.map(r => r.temperature)) };
}
function score(training: Day[], testing: Day[], weather: HouseholdWeather, calibration?: WeatherCalibration) {
  const p = profiles(training, testing[0].date, weather, calibration);
  let daily = 0, slot = 0, tariff = 0;
  for (const day of testing) {
    let bias = 0, morning = 0, evening = 0;
    for (const sample of day.samples) {
      const value = p[`${weekday(day.date)}/${sample.key}`]?.kwh;
      const g = calibration ? degrees(sample, weather, calibration.balancePointC) : 0;
      if (value == null || g === null) return { daily: Infinity, slot: Infinity, tariff: Infinity };
      const error = Math.max(0, value + g * (calibration?.slopeKwPerC ?? 0)) - sample.kwh;
      bias += error; slot += Math.abs(error);
      if (sample.key >= '07:00' && sample.key < '12:00') morning += error;
      if (sample.key >= '17:00' && sample.key < '23:00') evening += error;
    }
    daily += Math.abs(bias); tariff += Math.abs(morning) + Math.abs(evening);
  }
  return { daily: daily / testing.length, slot: slot / testing.reduce((n, d) => n + d.samples.length, 0), tariff: tariff / testing.length / 2 };
}
function learnWeather(days: Day[], weather?: HouseholdWeather): { calibration: WeatherCalibration | null; status: HouseholdModel['weatherStatus']; days: number } {
  if (!weather) return { calibration: null, status: 'unavailable', days: 0 };
  const eligible = days.filter(d => weatherCovered(d) && d.samples.every(s => degrees(s, weather, 100) !== null));
  // 28 calibration days plus separate seven-day selection and final diagnostic holdouts.
  if (eligible.length < 42) return { calibration: null, status: 'insufficient_history', days: eligible.length };
  const training = eligible.slice(0, -14), selection = eligible.slice(-14, -7), holdout = eligible.slice(-7);
  const temperatures = training.map(d => {
    const a = Date.parse(d.samples[0].interval!.start), b = Date.parse(d.samples.at(-1)!.interval!.end);
    return 100 - coldDegreeHours(weather, a, b, 100)! / ((b - a) / hourMs);
  }).sort((a, b) => a - b);
  const candidates = [...new Set(Array.from({ length: 9 }, (_, i) => temperatures[Math.floor((temperatures.length - 1) * (i + 1) / 10)]))]
    .map(t => fit(training, weather, t)).filter((c): c is WeatherCalibration => c !== null);
  if (!candidates.length) return { calibration: null, status: 'not_identifiable', days: eligible.length };
  const candidate = candidates.sort((a, b) => score(training, selection, weather, a).daily - score(training, selection, weather, b).daily)[0];
  const improves = (train: Day[], test: Day[], c: WeatherCalibration) => {
    const baseline = score(train, test, weather), adjusted = score(train, test, weather, c);
    return adjusted.daily < baseline.daily * .9 && adjusted.slot <= baseline.slot * 1.05 && adjusted.tariff <= baseline.tariff * 1.05;
  };
  const extended = eligible.slice(0, -7), check = fit(extended, weather, candidate.balancePointC);
  const final = fit(eligible, weather, candidate.balancePointC);
  if (!check || !final || !improves(training, selection, candidate) || !improves(extended, holdout, check)
    || Math.abs(final.slopeKwPerC - candidate.slopeKwPerC) / candidate.slopeKwPerC > .5) {
    return { calibration: null, status: 'not_validated', days: eligible.length };
  }
  return { calibration: final, status: 'calibrated', days: eligible.length };
}

export function trainHouseholdModel(input: { id: string; at: Date; observations: HouseholdObservation[]; weather?: HouseholdWeather }): HouseholdModel {
  const today = getLocalDate(input.at), from = shiftDate(today, -84);
  // Finalized readings from the current partial day contribute only to their observed slots.
  const days = prepare(input.observations, input.at).filter(d => d.date >= from && d.date <= today);
  const weather = input.weather?.kind === 'historical' && Date.parse(input.weather.availableAt) <= input.at.getTime()
    && Date.parse(input.weather.fetchedAt) <= input.at.getTime() ? input.weather : undefined;
  const learned = learnWeather(days, weather);
  return { id: input.id, version: householdModelVersion, trainedAt: input.at.toISOString(), trainingDate: today,
    validUntil: getCalendarDayBounds(new Date(`${shiftDate(today, 1)}T00:00:00Z`)).start.toISOString(),
    scope: 'household_total', mode: 'observation', training: { from, to: today, usableDays: days.length,
      completeSamplingDays: days.filter(d => d.complete).length, observations: days.reduce((n, d) => n + d.samples.length, 0),
      weatherDays: learned.days, halfLifeDays: 14, originalStepMinutes: 15, alignment: 'nominal_quarter_approximation' },
    profiles: profiles(days, today), weatherProfiles: learned.calibration ? profiles(days, today, weather, learned.calibration) : {},
    calibration: learned.calibration, weatherLocation: weather ? { latitude: weather.latitude, longitude: weather.longitude } : null,
    weatherStatus: learned.status,
    validation: learned.calibration ? { kind: 'realized_weather_diagnostic', selectionDays: 7, holdoutDays: 7 } : null };
}

export function predictHousehold(input: { date: string; at: Date; model: HouseholdModel | null; weather?: HouseholdWeather;
  observations?: HouseholdObservation[]; unavailableReason?: string }): HouseholdForecast {
  const { date, at, model } = input;
  const valid = model && model.version === householdModelVersion && model.scope === 'household_total'
    && Date.parse(model.trainedAt) <= at.getTime() && at.getTime() < Date.parse(model.validUntil);
  const bounds = householdDaySlots(date);
  const weather = input.weather?.kind === 'forecast' && Date.parse(input.weather.availableAt) <= at.getTime()
    && Date.parse(input.weather.fetchedAt) <= at.getTime() && at.getTime() - Date.parse(input.weather.fetchedAt) <= 2 * hourMs ? input.weather : undefined;
  let calibration = valid ? model.calibration : null, weatherStatus: string = valid ? model.weatherStatus : 'unavailable';
  if (calibration && weather && (weather.latitude !== model!.weatherLocation?.latitude || weather.longitude !== model!.weatherLocation?.longitude)) {
    calibration = null; weatherStatus = 'location_changed';
  }
  if (calibration && (!weather || bounds.some(s => coldDegreeHours(weather, Date.parse(s.start), Date.parse(s.end), calibration!.balancePointC) === null))) {
    calibration = null; weatherStatus = 'unavailable';
  }
  if (calibration && bounds.some(s => {
    const t = 100 - coldDegreeHours(weather, Date.parse(s.start), Date.parse(s.end), 100)! * 4;
    return t < calibration!.minTemperatureC - 3 || t > calibration!.maxTemperatureC + 3;
  })) { calibration = null; weatherStatus = 'extrapolation'; }
  const slots = bounds.map(s => {
    const key = `${weekday(date)}/${clockTime.format(new Date(s.start))}`;
    const p = valid ? (calibration ? model.weatherProfiles : model.profiles)[key] : undefined;
    const added = calibration ? coldDegreeHours(weather, Date.parse(s.start), Date.parse(s.end), calibration.balancePointC)! * calibration.slopeKwPerC : 0;
    return { ...s, estimatedConsumptionKwh: p?.kwh == null ? null : Math.max(0, p.kwh + added),
      observations: p?.observations ?? 0, matchingWeekdays: p?.matchingWeekdays ?? 0, weekdayFactor: p?.weekdayFactor ?? 1,
      weekdayWeightShare: p?.weekdayWeightShare ?? null, weatherAdjustmentKwh: calibration && p ? added - p.removedHeatingKwh : null };
  });
  const sum = (values: Array<{ estimatedConsumptionKwh: number | null }>) => values.some(s => s.estimatedConsumptionKwh === null)
    ? null : values.reduce((n, s) => n + s.estimatedConsumptionKwh!, 0);
  const total = sum(slots);
  let updatedTotal: HouseholdForecast['updatedTotal'] = null;
  if (date === getLocalDate(at)) {
    const current = prepare(input.observations ?? [], at).find(d => d.date === date);
    const measured = new Map(current?.samples.map(s => [s.start, s.kwh]) ?? []);
    const past = slots.filter(s => Date.parse(s.start) < at.getTime());
    const complete = at.getTime() % quarterMs === 0 && past.every(s => measured.has(Date.parse(s.start)));
    const measuredKwh = past.reduce((n, s) => n + (measured.get(Date.parse(s.start)) ?? 0), 0);
    const future = slots.filter(s => Date.parse(s.end) > at.getTime());
    const futureKwh = future.some(s => s.estimatedConsumptionKwh === null) ? null : future.reduce((n, s) => n + s.estimatedConsumptionKwh!
      * (Date.parse(s.end) - Math.max(at.getTime(), Date.parse(s.start))) / quarterMs, 0);
    updatedTotal = { measuredKwh, futureKwh, estimatedConsumptionKwh: complete && futureKwh !== null ? measuredKwh + futureKwh : null,
      status: complete ? 'approximate' : 'incomplete', measuredThrough: new Date(Math.floor(at.getTime() / quarterMs) * quarterMs).toISOString() };
  }
  return { date, issuedAt: at.toISOString(), modelId: valid ? model.id : null, trainedAt: valid ? model.trainedAt : null,
    modelVersion: householdModelVersion, source: 'measured_history', scope: 'household_total', excludesCar: false,
    mode: 'observation', stepMinutes: 15, unit: 'kWh', status: total === null ? 'unavailable'
      : model!.training.completeSamplingDays < 14 || slots.some(s => s.weekdayFactor === 1) ? 'learning' : 'available',
    method: calibration ? 'weighted_profile_weather' : 'weighted_profile', estimatedConsumptionKwh: total,
    fallbackReason: input.unavailableReason ?? (!valid ? 'model_unavailable' : total === null ? 'missing_historical_slots'
      : !calibration ? `weather_${weatherStatus}` : null), uncertainty: 'uncalibrated', slots,
    hourly: Array.from({ length: slots.length / 4 }, (_, i) => ({ start: slots[i * 4].start, end: slots[i * 4 + 3].end,
      estimatedConsumptionKwh: sum(slots.slice(i * 4, i * 4 + 4)) })),
    training: valid ? model.training : null,
    weather: { status: weatherStatus, calibration, fetchedAt: weather?.fetchedAt ?? null, model: weather?.model ?? null, originalStepMinutes: weather ? 60 : null,
      alignment: weather ? 'linear_interpolation' : null, alignmentToleranceSeconds: 60, validation: valid ? model.validation : null }, updatedTotal };
}
