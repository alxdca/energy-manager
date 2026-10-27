import type { CarChargingForecast } from './car-types.js';
import { validCarCharging } from './car-load.js';
import { getCalendarDayBounds } from './policy.js';

export interface CarEstimatePoint {
  start: string;
  end: string;
  estimatedChargingKwh: number;
}
const quarterMs = 900_000;

/** Archive the automatic allocation, integrating exact slot overlaps instead of rounding charge duration. */
export function carEstimatePoints(inputs: Array<{ date: string; carCharging?: CarChargingForecast }>, generatedAt: Date): CarEstimatePoint[] {
  const generated = generatedAt.getTime();
  if (!Number.isFinite(generated)) return [];
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.date, (counts.get(input.date) ?? 0) + 1);
  const result: CarEstimatePoint[] = [];
  for (const input of inputs) {
    const channel = input.carCharging;
    // Inactive includes manual/native Eco operation: no guaranteed charging forecast, not measured zero.
    if (counts.get(input.date) !== 1 || !channel || channel.date !== input.date || channel.status !== 'available'
      || !validCarCharging(channel) || Date.parse(channel.calculatedAt!) > generated + 5000
      || generated - Date.parse(channel.socObservedAt!) > 600_000) continue;
    const { start, end } = getCalendarDayBounds(new Date(`${input.date}T00:00:00Z`));
    const points: CarEstimatePoint[] = [];
    for (let at = Math.max(start.getTime(), Math.floor(generated / quarterMs) * quarterMs); at < end.getTime(); at += quarterMs) {
      const until = at + quarterMs;
      const energy = channel.slots.reduce((sum, slot) => sum + slot.powerKw
        * Math.max(0, Math.min(until, Date.parse(slot.end)) - Math.max(at, Date.parse(slot.start))) / 3_600_000, 0);
      if (!Number.isFinite(energy) || energy < 0) { points.length = 0; break; }
      points.push({ start: new Date(at).toISOString(), end: new Date(until).toISOString(), estimatedChargingKwh: energy });
    }
    result.push(...points);
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}
