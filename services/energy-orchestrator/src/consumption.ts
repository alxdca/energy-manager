import { getCalendarDayBounds, getCalendarDayHours } from './policy.js';

export interface ConsumptionConfig {
  baselinePowerW: number;
}

export interface ConsumptionForecast {
  date: string;
  dayHours: number;
  baselinePowerW: number;
  baselineKwh: number;
  estimatedConsumptionKwh: number;
  source: 'configured_baseline';
  excludesCar: true;
  hourlyMethod: 'baseline_only';
  hourly: Array<{ start: string; end: string; estimatedConsumptionKwh: number }>;
  quarterHourly: ConsumptionForecast['hourly'];
}

/** Validate the complete quarter-hour profile and its hourly display totals. */
export function consumptionIntervals(forecast: Pick<ConsumptionForecast, 'date' | 'hourly' | 'quarterHourly' | 'estimatedConsumptionKwh'>): ConsumptionForecast['hourly'] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forecast.date)) return null;
  const day = new Date(`${forecast.date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== forecast.date) return null;
  const { start, end } = getCalendarDayBounds(day);
  const energy = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const instant = (value: string, expected: number) => /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Date.parse(value) === expected;
  const complete = (values: ConsumptionForecast['hourly'] | undefined, step: number): values is ConsumptionForecast['hourly'] =>
    Array.isArray(values) && values.length === (end.getTime() - start.getTime()) / step
      && values.every((value, index) => value && instant(value.start, start.getTime() + index * step)
        && instant(value.end, start.getTime() + (index + 1) * step) && energy(value.estimatedConsumptionKwh));
  if (!complete(forecast.hourly, 3_600_000) || !energy(forecast.estimatedConsumptionKwh)) return null;
  const hourlyTotal = forecast.hourly.reduce((sum, interval) => sum + interval.estimatedConsumptionKwh, 0);
  if (!Number.isFinite(hourlyTotal) || Math.abs(hourlyTotal - forecast.estimatedConsumptionKwh) > 1e-6) return null;
  if (!complete(forecast.quarterHourly, 900_000)) return null;
  for (let index = 0; index < forecast.hourly.length; index++) {
    const total = forecast.quarterHourly.slice(index * 4, index * 4 + 4).reduce((sum, interval) => sum + interval.estimatedConsumptionKwh, 0);
    if (!Number.isFinite(total) || Math.abs(total - forecast.hourly[index].estimatedConsumptionKwh) > 1e-6) return null;
  }
  return forecast.quarterHourly;
}

function validateConfig(config: ConsumptionConfig): ConsumptionConfig {
  if (typeof config.baselinePowerW !== 'number' || !Number.isFinite(config.baselinePowerW) || config.baselinePowerW < 0) {
    throw new Error('FORECAST_BASE_LOAD_W doit être un nombre positif ou nul.');
  }
  return { baselinePowerW: config.baselinePowerW };
}

function decimal(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const trimmed = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : NaN;
}

export function loadConsumptionConfig(env: Record<string, string | undefined> = process.env): ConsumptionConfig {
  return validateConfig({ baselinePowerW: decimal(env.FORECAST_BASE_LOAD_W, 1000) });
}

export function estimateConsumption(date: string, config: ConsumptionConfig): ConsumptionForecast {
  validateConfig(config);
  const day = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day.getTime())
    || day.toISOString().slice(0, 10) !== date) {
    throw new Error('La date de consommation doit être une date valide au format AAAA-MM-JJ.');
  }
  const dayHours = getCalendarDayHours(day);
  const baselineKwh = config.baselinePowerW / 1000 * dayHours;
  const bounds = getCalendarDayBounds(day);
  const hourly = Array.from({ length: dayHours }, (_, index) => ({
    start: new Date(bounds.start.getTime() + index * 3_600_000).toISOString(),
    end: new Date(bounds.start.getTime() + (index + 1) * 3_600_000).toISOString(),
    estimatedConsumptionKwh: config.baselinePowerW / 1000,
  }));
  return {
    date, dayHours, baselinePowerW: config.baselinePowerW, baselineKwh,
    estimatedConsumptionKwh: baselineKwh,
    source: 'configured_baseline', excludesCar: true,
    hourly, hourlyMethod: 'baseline_only',
    quarterHourly: Array.from({ length: dayHours * 4 }, (_, index) => ({
      start: new Date(bounds.start.getTime() + index * 900_000).toISOString(),
      end: new Date(bounds.start.getTime() + (index + 1) * 900_000).toISOString(),
      estimatedConsumptionKwh: config.baselinePowerW / 1000 / 4,
    })),
  };
}
