import type { BatteryHistorySummary } from './battery-history.js';
import type { BatteryEstimateSummary } from './battery-estimate-history.js';
import type { BatteryProjection } from './battery-projection.js';
import { getCalendarDayBounds } from './policy.js';

export interface BatteryChartData {
  date: string;
  timeZone: 'Europe/Zurich';
  dayHours: 23 | 24 | 25;
  periodStart: string;
  periodEnd: string;
  observed: Pick<BatteryHistorySummary, 'status' | 'error' | 'points'>;
  estimated: BatteryProjection;
  historicalEstimated: BatteryEstimateSummary;
}

/** Compose committed forecast targets and measured observations without calculating or recording. */
export function buildBatteryChart(date: string, projection: BatteryProjection, observed: BatteryHistorySummary | null = null): Omit<BatteryChartData, 'historicalEstimated'> {
  const { start, end } = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  return {
    date, timeZone: 'Europe/Zurich', dayHours: (end.getTime() - start.getTime()) / 3_600_000 as 23 | 24 | 25,
    periodStart: start.toISOString(), periodEnd: end.toISOString(),
    observed: observed?.date === date ? { status: observed.status, error: observed.error, points: observed.points }
      : { status: 'error', error: 'Historique de batterie indisponible.', points: [] },
    estimated: { ...projection, points: projection.points.filter(point => Date.parse(point.at) >= start.getTime() && Date.parse(point.at) <= end.getTime()) },
  };
}
