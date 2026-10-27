import type { EnergyForecast } from './automation-plan.js';
import type { BatteryProjection } from './battery-projection.js';
import type { CarEstimatePoint } from './car-forecast-history.js';
import type { ConsumptionForecast } from './consumption.js';
import type { SolarForecast } from './forecast.js';

/** The scheduled forecast loop publishes all numerical estimates as one transaction. */
export interface ForecastBatch {
  calculatedAt: string;
  forecasts: EnergyForecast[];
  projection: BatteryProjection;
}

export interface PublishedForecast {
  calculatedAt: string;
  forecast: SolarForecast & {
    consumption: ConsumptionForecast | null;
    carEstimates?: CarEstimatePoint[];
    forecastPeriod: { start: string; end: string; from: string };
  };
  projection: BatteryProjection;
}

export interface ForecastStore {
  publishForecasts(batch: ForecastBatch): Promise<void>;
  readForecast(date: string): Promise<PublishedForecast | null>;
}
