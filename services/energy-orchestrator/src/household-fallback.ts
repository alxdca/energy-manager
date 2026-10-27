import { loadConsumptionConfig } from './consumption.js';
import type { HouseholdForecast, HouseholdObservation } from './household-model.js';

export interface HouseholdFallbackConfig { baselinePowerW: number; windowHours: number }
const hourMs = 3_600_000, quarterMs = 900_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validate(config: HouseholdFallbackConfig): HouseholdFallbackConfig {
  if (!finite(config.baselinePowerW) || config.baselinePowerW < 0
    || !Number.isInteger(config.windowHours) || config.windowHours < 1 || config.windowHours > 168) {
    throw new Error('Invalid household fallback configuration (baseline >= 0 W, window 1–168 hours).');
  }
  return { ...config };
}
export function loadHouseholdFallbackConfig(env: Record<string, string | undefined> = process.env): HouseholdFallbackConfig {
  const value = env.FORECAST_FALLBACK_WINDOW_HOURS?.trim();
  return validate({ ...loadConsumptionConfig(env), windowHours: !value ? 24 : /^\d+$/.test(value) ? Number(value) : NaN });
}

/** Fallback predictions are never training observations and never replace an available learned slot. */
export function applyHouseholdFallback(forecast: HouseholdForecast, observations: HouseholdObservation[], config: HouseholdFallbackConfig): HouseholdForecast {
  validate(config);
  const at = Date.parse(forecast.issuedAt), start = at - config.windowHours * hourMs;
  const buckets = new Map<number, HouseholdObservation[]>();
  for (const point of observations) {
    const observed = Date.parse(point.at);
    if (!finite(observed) || observed < start || observed > at || !finite(point.value) || point.value < 0) continue;
    const bucket = Math.floor(observed / quarterMs) * quarterMs;
    // An interval still in progress cannot supply a finalized rolling-average reading.
    if (bucket + quarterMs > at) continue;
    const values = buckets.get(bucket) ?? []; values.push(point); buckets.set(bucket, values);
  }
  let energyKwh = 0, observedHours = 0, samples = 0, last = -Infinity;
  for (const values of buckets.values()) {
    if (values.length !== 1) continue;
    const point = values[0];
    energyKwh += point.value / 1000; observedHours += quarterMs / hourMs; samples++;
    last = Math.max(last, Date.parse(point.at));
  }
  // At least four distinct finalized quarters and a reading within the last hour.
  const average = samples >= 4 && at - last <= hourMs && observedHours > 0 ? energyKwh / observedHours * 1000 : null;
  const averagePowerW = finite(average) && average >= 0 ? average : null;
  const powerW = averagePowerW ?? config.baselinePowerW;
  const source = averagePowerW !== null ? 'recent_average' as const : 'configured_baseline' as const;
  let appliedSlots = 0;
  const slots = forecast.slots.map(slot => {
    if (slot.estimatedConsumptionKwh !== null) return { ...slot, source: 'learned_profile' as const };
    appliedSlots++;
    return { ...slot, source, estimatedConsumptionKwh: powerW / 1000 * (Date.parse(slot.end) - Date.parse(slot.start)) / hourMs,
      weatherAdjustmentKwh: null };
  });
  const sum = (values: typeof slots) => values.reduce((total, slot) => total + slot.estimatedConsumptionKwh!, 0);
  const updatedTotal = forecast.updatedTotal ? { ...forecast.updatedTotal } : null;
  if (updatedTotal) {
    updatedTotal.futureKwh = slots.reduce((total, slot) => total + slot.estimatedConsumptionKwh!
      * Math.max(0, Date.parse(slot.end) - Math.max(at, Date.parse(slot.start))) / (Date.parse(slot.end) - Date.parse(slot.start)), 0);
    updatedTotal.estimatedConsumptionKwh = updatedTotal.status === 'incomplete' ? null : updatedTotal.measuredKwh + updatedTotal.futureKwh;
  }
  const mixed = appliedSlots > 0 && appliedSlots < slots.length;
  return { ...forecast, slots, hourly: forecast.hourly.map((hour, i) => ({ ...hour, estimatedConsumptionKwh: sum(slots.slice(i * 4, i * 4 + 4)) })),
    estimatedConsumptionKwh: sum(slots), updatedTotal,
    source: appliedSlots === 0 ? forecast.source : mixed ? 'mixed' : source,
    method: appliedSlots === 0 ? forecast.method : mixed ? 'mixed' : source,
    status: appliedSlots === 0 ? forecast.status : 'fallback',
    fallback: { windowHours: config.windowHours, windowStart: new Date(start).toISOString(), windowEnd: forecast.issuedAt,
      minimumSamples: 4, samples, observedHours, averagePowerW, baselinePowerW: config.baselinePowerW, appliedSlots,
      source: appliedSlots > 0 ? source : null, alignment: samples === 0 ? null : 'nominal_quarter_approximation' } };
}
