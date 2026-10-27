import type { SolarForecast } from './forecast.js';
import { getCalendarDayBounds } from './policy.js';

export interface SolarProductionInterval { start: string; end: string; estimatedProductionKwh: number }
type SolarInput = Pick<SolarForecast, 'date' | 'hourly' | 'quarterHourly' | 'estimatedProductionKwh'>;
const hourMs = 3_600_000;
const quarterMs = 900_000;
const energy = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function instant(value: unknown, expected: number): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Date.parse(value) !== expected) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Validate native quarter-hour production and its hourly display totals. */
export function solarIntervals(forecast: SolarInput): SolarProductionInterval[] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forecast.date)) return null;
  const day = new Date(`${forecast.date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== forecast.date) return null;
  const { start, end } = getCalendarDayBounds(day);
  const complete = (values: SolarProductionInterval[] | null | undefined, step: number): values is SolarProductionInterval[] =>
    Array.isArray(values) && values.length === (end.getTime() - start.getTime()) / step
      && values.every((value, index) => value && instant(value.start, start.getTime() + index * step)
        && instant(value.end, start.getTime() + (index + 1) * step) && energy(value.estimatedProductionKwh));
  if (!complete(forecast.hourly, hourMs) || !energy(forecast.estimatedProductionKwh)) return null;
  const hourlyTotal = forecast.hourly.reduce((sum, interval) => sum + interval.estimatedProductionKwh, 0);
  if (!Number.isFinite(hourlyTotal) || Math.abs(hourlyTotal - forecast.estimatedProductionKwh) > .051) return null;
  if (!complete(forecast.quarterHourly, quarterMs)) return null;
  for (let index = 0; index < forecast.hourly.length; index++) {
    const total = forecast.quarterHourly.slice(index * 4, index * 4 + 4).reduce((sum, interval) => sum + interval.estimatedProductionKwh, 0);
    if (!Number.isFinite(total) || Math.abs(total - forecast.hourly[index].estimatedProductionKwh) > 1e-6) return null;
  }
  return forecast.quarterHourly;
}
