import type { DailyEnergySummary, HourlyEnergySummary } from './daily-energy.js';
import type { BatteryHistorySummary } from './battery-history.js';
import type { BatteryEstimateSummary } from './battery-estimate-history.js';
import type { EnergyEstimatePoint } from './energy-estimate-history.js';
import type { ObservationPoint } from './observation-types.js';

type MaybePromise<Value> = Value | Promise<Value>;

/** Readers may query durable history without loading it all into the working cache. */
export interface AsyncDailyEnergyReader {
  summary(date: string, now?: Date): MaybePromise<DailyEnergySummary>;
  hourly?(date: string, now?: Date): MaybePromise<HourlyEnergySummary>;
  days(limit?: number, now?: Date, before?: string): MaybePromise<DailyEnergySummary[]>;
}

export interface HistoryDay {
  date: string;
  timeZone: 'Europe/Zurich';
  periodStart: string;
  periodEnd: string;
  dailyEnergy: DailyEnergySummary;
  measurements: HourlyEnergySummary;
  observations: { method: 'counter_differences'; solar: ObservationPoint[]; household: ObservationPoint[] };
  battery: BatteryHistorySummary;
  historicalEstimated: BatteryEstimateSummary;
  solarEstimates: Array<{ start: string; end: string; estimatedProductionKwh: number }>;
  energyEstimates: EnergyEstimatePoint[];
  householdPredictions?: EnergyEstimatePoint[];
}

export interface HistoryReader {
  day(date: string, now?: Date): Promise<HistoryDay>;
}
