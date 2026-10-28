import { createObservationSampler } from './observation-sampler.js';
import type { BatteryHistoryPoint, BatteryHistorySummary } from './battery-history.js';
import type { ObservationPoint } from './observation-types.js';
import type { CarTelemetry } from './tesla.js';

export interface CarSocHistorySummary extends BatteryHistorySummary {
  /** Actual last reading before this day, used only to seed the display. */
  previous: BatteryHistoryPoint | null;
}

/** Cached Tesla readings retain their actual timestamps, including while asleep. */
export function carSocObservation(car: CarTelemetry): ObservationPoint | null {
  return typeof car.socPercent === 'number' && Number.isFinite(car.socPercent)
    && car.socPercent >= 0 && car.socPercent <= 100 && car.observedAt !== null
    ? { at: car.observedAt, value: car.socPercent } : null;
}

/** Same pre-quarter selection as the home battery, allowing Tesla's slower polling. */
export function createCarSocSampler(options: { now?: () => Date; state?: unknown } = {}) {
  const sampler = createObservationSampler({ ...options, sampleFreshnessMs: 600_000 });
  return {
    ...sampler,
    record(point: ObservationPoint | null, now?: Date) {
      sampler.record({ battery: point, solar: null, household: null }, now);
    },
  };
}
