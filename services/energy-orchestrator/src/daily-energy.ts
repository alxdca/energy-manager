export interface DailyEnergyMetric {
  energyKwh: number | null;
  coverageSeconds: number;
  firstCoveredAt: string | null;
  lastCoveredAt: string | null;
  /** Number and real timestamps of retained energy readings; no implied interval coverage. */
  sampleCount?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
}
export interface DailyEnergySummary {
  date: string;
  timeZone: 'Europe/Zurich';
  dayHours: number;
  expectedSeconds: number;
  status: 'unavailable' | 'partial' | 'collecting' | 'complete';
  solar: DailyEnergyMetric;
  household: DailyEnergyMetric;
  firstObservationAt: string | null;
  lastObservationAt: string | null;
  method: 'power_integration' | 'recorded_energy';
  solarSource: 'GEN24 P_PV (DC)' | 'GEN24 PV (DC)';
  householdSource: 'GEN24 -P_Load' | 'GEN24 household (AC)';
  householdIncludesCar: true;
  storageStatus: 'ready' | 'error';
  error: string | null;
}
export interface HourlyEnergySummary {
  date: string;
  timeZone: 'Europe/Zurich';
  dayHours: number;
  method: 'power_integration' | 'recorded_energy';
  solarSource: 'GEN24 P_PV (DC)' | 'GEN24 PV (DC)';
  householdSource: 'GEN24 -P_Load' | 'GEN24 household (AC)';
  householdIncludesCar: true;
  storageStatus: 'ready' | 'error';
  error: string | null;
  quarterHours?: HourlyEnergySummary['hours'];
  hours: Array<{
    start: string;
    end: string;
    status: DailyEnergySummary['status'];
    solar: DailyEnergyMetric;
    household: DailyEnergyMetric;
  }>;
}
export function observationTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) return null;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Date(value).toISOString();
}
