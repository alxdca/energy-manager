import type { DailyEnergyMetric, DailyEnergySummary, HourlyEnergySummary } from './daily-energy.js';
import type { ObservationPoint } from './observation-types.js';
import { getCalendarDayBounds, timeZone } from './policy.js';

const hourMs = 3_600_000;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const blank = (): DailyEnergyMetric => ({ energyKwh: null, coverageSeconds: 0, firstCoveredAt: null,
  lastCoveredAt: null, sampleCount: 0, firstObservedAt: null, lastObservedAt: null });
const earliest = (before: string | null | undefined, at: string) => before === null || before === undefined || at < before ? at : before;
const latest = (before: string | null | undefined, at: string) => before === null || before === undefined || at > before ? at : before;

/** Sum retained energy readings whole, by their real timestamps, without reconstructing coverage. */
export function summarizeRecordedEnergy(date: string, points: { solar: ObservationPoint[]; household: ObservationPoint[] },
  now: Date): { dailyEnergy: DailyEnergySummary; measurements: HourlyEnergySummary } {
  const day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
    throw new Error('Date de relevé invalide.');
  }
  const { start, end } = getCalendarDayBounds(day);
  const from = start.getTime(), until = end.getTime(), current = now.getTime();
  const hours: HourlyEnergySummary['hours'] = Array.from({ length: (until - from) / hourMs }, (_, index) => ({
    start: new Date(from + index * hourMs).toISOString(), end: new Date(from + (index + 1) * hourMs).toISOString(),
    status: 'unavailable', solar: blank(), household: blank(),
  }));
  const quarterHours: HourlyEnergySummary['hours'] = Array.from({ length: hours.length * 4 }, (_, index) => ({
    start: new Date(from + index * 900_000).toISOString(), end: new Date(from + (index + 1) * 900_000).toISOString(),
    status: 'unavailable', solar: blank(), household: blank(),
  }));
  const totals = { solar: blank(), household: blank() };
  function add(channel: 'solar' | 'household', at: number, energyKwh: number, observedAt: string) {
    const hour = hours[Math.floor((at - from) / hourMs)];
    if (!hour || !nonnegative(energyKwh) || !Number.isFinite((totals[channel].energyKwh ?? 0) + energyKwh)) return;
    const quarter = quarterHours[Math.floor((at - from) / 900_000)];
    for (const metric of [hour[channel], quarter[channel], totals[channel]]) {
      metric.energyKwh = (metric.energyKwh ?? 0) + energyKwh;
      metric.sampleCount = (metric.sampleCount ?? 0) + 1;
      metric.firstObservedAt = earliest(metric.firstObservedAt, observedAt);
      metric.lastObservedAt = latest(metric.lastObservedAt, observedAt);
    }
    hour.status = quarter.status = 'partial';
  }
  if (Number.isFinite(current)) {
    for (const channel of ['solar', 'household'] as const) {
      const unique = new Map<number, ObservationPoint>();
      for (const point of points[channel]) {
        const at = Date.parse(point.at);
        if (Number.isFinite(at) && at >= from && at < until && at <= current && nonnegative(point.value)) unique.set(at, point);
      }
      for (const [at, point] of unique) add(channel, at, point.value / 1000, new Date(at).toISOString());
    }
  }
  const first = [totals.solar.firstObservedAt, totals.household.firstObservedAt].filter((at): at is string => typeof at === 'string').sort();
  const last = [totals.solar.lastObservedAt, totals.household.lastObservedAt].filter((at): at is string => typeof at === 'string').sort();
  const metadata = { date, timeZone, dayHours: hours.length, method: 'recorded_energy' as const,
    solarSource: 'GEN24 PV (DC)' as const, householdSource: 'GEN24 household (AC)' as const,
    householdIncludesCar: true as const, storageStatus: 'ready' as const, error: null } as const;
  return { dailyEnergy: { ...metadata, expectedSeconds: (until - from) / 1000,
    status: totals.solar.energyKwh !== null || totals.household.energyKwh !== null ? 'partial' : 'unavailable', ...totals,
    firstObservationAt: first[0] ?? null, lastObservationAt: last.at(-1) ?? null },
    measurements: { ...metadata, dayHours: hours.length as 23 | 24 | 25, hours, quarterHours } };
}
