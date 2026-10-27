import { summarizeRecordedEnergy } from '../../src/recorded-energy.js';
import { getLocalDate } from '../../src/policy.js';
import type { ObservationPoint } from '../../src/observation-types.js';

/** API fixtures use the same retained-counter summaries as PostgreSQL. */
export function recordedEnergyReader(now: () => Date,
  points: { solar: ObservationPoint[]; household: ObservationPoint[] } = { solar: [], household: [] }) {
  return {
    summary: (date: string, at = now()) => summarizeRecordedEnergy(date, points, at).dailyEnergy,
    hourly: (date: string, at = now()) => summarizeRecordedEnergy(date, points, at).measurements,
    days: (limit = 30, at = now()) => [...new Set([...points.solar, ...points.household]
      .map(point => getLocalDate(new Date(point.at))))].sort().reverse().slice(0, limit)
      .map(date => summarizeRecordedEnergy(date, points, at).dailyEnergy),
  };
}
