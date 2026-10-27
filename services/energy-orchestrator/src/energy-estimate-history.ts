import type { EnergyForecast } from './automation-plan.js';
import { hasUsableForecast, type SolarForecast } from './forecast.js';
import { solarIntervals } from './solar-intervals.js';
import { consumptionIntervals } from './consumption.js';

export interface EnergyEstimatePoint {
  start: string;
  end: string;
  estimatedConsumptionKwh: number | null;
  excludesCar?: boolean;
  source?: 'learned_profile' | 'recent_average' | 'configured_baseline';
}

/** Capture complete ongoing and future quarters; persistence freezes started intervals. */
export function energyEstimatePoints(forecasts: EnergyForecast[], generatedAt: Date): EnergyEstimatePoint[] {
  const generated = generatedAt.getTime();
  if (!Number.isFinite(generated)) return [];
  const dateCounts = new Map<string, number>();
  for (const forecast of forecasts) dateCounts.set(forecast.date, (dateCounts.get(forecast.date) ?? 0) + 1);
  const points: EnergyEstimatePoint[] = [];
  for (const forecast of forecasts) {
    if (dateCounts.get(forecast.date) !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(forecast.date)) continue;
    if (forecast.consumption?.date !== forecast.date) continue;
    const intervals = consumptionIntervals(forecast.consumption);
    if (intervals) for (const point of intervals) {
      if (Date.parse(point.end) > generated) points.push({ start: point.start, end: point.end,
        estimatedConsumptionKwh: point.estimatedConsumptionKwh });
    }
  }
  return points.sort((a, b) => a.start.localeCompare(b.start));
}

export interface SolarEstimatePoint { start: string; end: string; estimatedProductionKwh: number }

/** Persist native provider quarters while the store keeps started targets frozen. */
export function solarEstimatePoints(forecasts: SolarForecast[], now: Date): SolarEstimatePoint[] {
  const points = new Map<string, SolarEstimatePoint>();
  for (const forecast of forecasts) {
    if (!hasUsableForecast(forecast, now.getTime())) continue;
    const intervals = solarIntervals(forecast);
    if (intervals) for (const point of intervals) {
      if (Date.parse(point.end) > now.getTime()) points.set(point.start, {
        start: point.start, end: point.end, estimatedProductionKwh: point.estimatedProductionKwh,
      });
    }
  }
  return [...points.values()].sort((a, b) => a.start.localeCompare(b.start));
}
