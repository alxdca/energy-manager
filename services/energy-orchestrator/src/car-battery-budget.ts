import { nextNightHighTariffReserve, type AutomationConfig, type EnergyForecast, type AutomationLimits } from './automation-plan.js';
import { getLocalDate, getNightTariffEnd } from './policy.js';
import type { BatteryOriginSnapshot } from './battery-origin.js';
import type { SolarBatterySupport } from './car-types.js';
import type { Telemetry } from './status.js';
import type { WattpilotTelemetry } from './wattpilot.js';

/** Permission is a source-accounting lower bound, never the whole measured SOC. */
export function carSolarBatteryBudget(input: {
  now: Date;
  origin: BatteryOriginSnapshot;
  telemetry: Telemetry;
  charger: WattpilotTelemetry;
  forecasts: EnergyForecast[];
  config: AutomationConfig;
  limits: AutomationLimits;
  supplySupported: boolean;
}): SolarBatterySupport {
  const { now, origin, telemetry, charger, config } = input;
  const result: SolarBatterySupport = { available: false, solarStoredKwh: origin.solarStoredKwh,
    protectedStoredKwh: null, usableStoredKwh: 0, minimumSocPercent: null, maxDischargeKw: 0 };
  const soc = telemetry.batterySocPercent;
  const observed = telemetry.observedAt === null ? NaN : Date.parse(telemetry.observedAt);
  const nightEnd = getNightTariffEnd(now);
  const night = origin.night;
  if (!nightEnd || !night?.valid || night.id !== nightEnd || !origin.available || origin.error || origin.solarStoredKwh === null || origin.storedKwh === null
    || ![night.solarAtStartKwh, night.storedAtStartKwh, night.dischargedKwh].every(value => Number.isFinite(value) && value >= 0)
    || night.solarAtStartKwh > night.storedAtStartKwh || night.storedAtStartKwh > config.socCapacityKwh
    || !Number.isFinite(origin.solarStoredKwh) || origin.solarStoredKwh < 0
    || !Number.isFinite(origin.storedKwh) || origin.storedKwh < 0 || origin.solarStoredKwh > origin.storedKwh
    || !input.supplySupported || telemetry.status !== 'online' || !Number.isFinite(observed)
    || now.getTime() - observed > 10_000 || observed > now.getTime() + 5000
    || soc === null || !Number.isFinite(soc) || soc < 0 || soc > 100) return result;
  const date = getLocalDate(new Date(nightEnd));
  const forecast = input.forecasts.find(value => value.date === date);
  if (!forecast) return result;
  const protectedStoredKwh = nextNightHighTariffReserve(now, forecast, config, input.limits);
  if (protectedStoredKwh === null) return result;
  const measuredStored = soc / 100 * config.socCapacityKwh;
  // Cover one SOC percentage point and the bounded source-age/raw-transition
  // drift (at most 130s at the installation's7kW limit, below0.3kWh).
  const margin = Math.max(.3, config.socCapacityKwh * .01);
  // Night grid charging cannot free reserved solar for a later car discharge.
  // Authorize against the pre-charge night baseline and consume that fixed cap.
  const wholeNight = Math.max(0, Math.min(night.solarAtStartKwh, night.storedAtStartKwh - protectedStoredKwh) - margin);
  const remainingNight = Math.max(0, wholeNight - night.dischargedKwh);
  const usableStoredKwh = Math.max(0, Math.min(remainingNight, origin.solarStoredKwh - margin,
    Math.min(origin.storedKwh, measuredStored) - protectedStoredKwh - margin));
  // Anchor to CURRENT measured energy: an unexplained positive SOC jump is
  // unknown energy and must not turn into an extra discharge allowance.
  const minimumSocPercent = Math.min(100, Math.ceil((measuredStored - usableStoredKwh) / config.socCapacityKwh * 1000 - 1e-9) / 10);
  const roundedUsable = Math.max(0, measuredStored - minimumSocPercent / 100 * config.socCapacityKwh);
  const powerAt = charger.powerObservedAt === null ? NaN : Date.parse(charger.powerObservedAt);
  const actual = charger.powerWatts;
  const synchronized = charger.status === 'online' && charger.ready && !charger.stale && charger.charging === true
    && Number.isFinite(powerAt) && Math.abs(powerAt - observed) <= 3000
    && powerAt <= now.getTime() + 5000 && now.getTime() - powerAt <= 30_000;
  const maxDischargeKw = roundedUsable > 0 && synchronized && actual !== null && Number.isFinite(actual) && actual >= 100
    ? Math.floor(Math.min(actual / 1000, input.limits.maxPowerKw, 7) * 1000) / 1000 : 0;
  return { available: true, solarStoredKwh: origin.solarStoredKwh, protectedStoredKwh,
    usableStoredKwh: roundedUsable, minimumSocPercent, maxDischargeKw,
    authorizationExpiresAt: new Date(observed + 10_000).toISOString() };
}
