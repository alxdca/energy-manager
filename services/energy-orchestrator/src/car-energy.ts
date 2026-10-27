import { createObservationSampler } from './observation-sampler.js';
import type { ObservationSample } from './observation-types.js';
import type { WattpilotTelemetry } from './wattpilot.js';

// The meters update independently. Match within the charger's existing 30-second
// freshness bound instead of requiring their independent update clocks to coincide.
const counterFreshnessMs = 30_000;

/** The authenticated live charger state contains a cumulative AC meter, never vehicle SOC estimates. */
export function carEnergyCounter(charger: WattpilotTelemetry): ObservationSample['car'] {
  if (charger.status !== 'online' || !charger.ready || charger.stale || !charger.observedAt
    || !charger.energyCounterSource || charger.totalEnergyWh === null) return null;
  return { at: charger.observedAt, value: charger.totalEnergyWh, source: charger.energyCounterSource };
}

/** Record charging independently; subtract fresh counter pairs within 30 seconds at both ends. */
export function createCarEnergySampler(options: Parameters<typeof createObservationSampler>[0] = {}) {
  const sampler = createObservationSampler(options);
  const clock = options.now ?? (() => new Date());
  return {
    ...sampler,
    record(sample: ObservationSample, now?: Date) {
      const current = (now ?? clock()).getTime();
      const house = sample.household, car = sample.car;
      const validCar = car && Number.isFinite(car.value) && car.value >= 0
        && typeof car.source === 'string' && car.source.trim().length > 0
        && Date.parse(car.at) >= current - counterFreshnessMs && Date.parse(car.at) <= current + 5000;
      const aligned = house && validCar && Number.isFinite(house.value)
        && typeof house.source === 'string' && house.source.trim().length > 0
        && Math.abs(Date.parse(house.at) - Date.parse(car.at)) <= counterFreshnessMs;
      const source = aligned ? JSON.stringify([house.source, car.source]) : '';
      sampler.record({ battery: null,
        solar: validCar ? car : null,
        household: aligned ? { at: house.at, value: house.value - car.value, source,
          components: { ...(house.components ?? {}), carWh: car.value } } : null,
      }, now ?? new Date(current));
    },
  };
}
