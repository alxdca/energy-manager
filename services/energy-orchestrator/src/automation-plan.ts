import { solarIntervals } from './solar-intervals.js';
import { consumptionIntervals, type ConsumptionForecast } from './consumption.js';
import { hasUsableForecast, type SolarForecast } from './forecast.js';
import { getCalendarDayBounds, getCarTarget, getLocalDate, getNightTariffEnd, getSchedule, policy } from './policy.js';
import { batteryChargeAllowanceKw } from './site-power.js';
import type { Telemetry } from './status.js';
import type { CarChargingForecast } from './car-types.js';
import { carAllowsBatteryCharge, carBatterySupply, carEnergyBetween, carLoadBoundaries, forecastLoadSegments, validCarLoad } from './car-load.js';

export interface AutomationConfig {
  enabled: boolean;
  /** Stored energy represented by 100% of the inverter's reported SOC. */
  socCapacityKwh: number;
  reserveSocPercent: number;
  /** Percentage of the next high-tariff net battery needs, above protected reserve. */
  energyBufferPercent: number;
  minimumEnergyBufferKwh: number;
  /** Preferred SOC at the afternoon charging cutoff, after crediting useful daytime solar. */
  afternoonTargetSocPercent: number;
}

export interface AutomationLimits {
  maxPowerKw: number;
  maxSocPercent: number;
  reserveSocPercent?: number | null;
  revertTimeoutSeconds?: number;
}

export type EnergyForecast = SolarForecast & { consumption: ConsumptionForecast;
  carCharging?: CarChargingForecast; carChargingContext?: CarChargingForecast[] };

export interface AutomationPlan {
  action: 'charge' | 'hold' | 'blocked';
  window: 'night' | 'afternoon' | null;
  targetSocPercent: number | null;
  afternoonTargetSocPercent: number | null;
  afternoonTargetAt: string | null;
  requiredStoredKwh: number | null;
  energyBufferKwh: number | null;
  storedKwh: number | null;
  shortfallKwh: number | null;
  unmetKwh: number;
  /** Stored-energy deficit during the next high tariff, excluding SOC goals and forecast cushions. */
  nextHighTariffUnmetKwh: number | null;
  /** Next-period deficit without scheduled grid charging; absent on older saved plans. */
  nextHighTariffChargeNeededKwh?: number | null;
  powerKw: number;
  windowEndsAt: string | null;
  forecastDate: string | null;
  reason: string;
}

const hourMs = 3_600_000;
// Split the configured round-trip efficiency evenly over charge and discharge.
const efficiency = Math.sqrt(policy.storageRoundTripEfficiency);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;

function validConfig(config: AutomationConfig): boolean {
  return typeof config.enabled === 'boolean' && finite(config.socCapacityKwh) && config.socCapacityKwh > 0
    && finite(config.reserveSocPercent) && config.reserveSocPercent >= 0 && config.reserveSocPercent < 100
    && nonnegative(config.energyBufferPercent) && config.energyBufferPercent <= 100
    && nonnegative(config.minimumEnergyBufferKwh) && config.minimumEnergyBufferKwh <= config.socCapacityKwh
    && nonnegative(config.afternoonTargetSocPercent) && config.afternoonTargetSocPercent <= 100;
}

/** Missing, shifted, overlapping or duplicate hours must never become zero demand. */
function validHours(forecast: EnergyForecast): boolean {
  return solarIntervals(forecast) !== null && consumptionIntervals(forecast.consumption) !== null;
}

/** Minimum initial energy, respecting time order and limited storage for intervening sunshine. */
function chronologicalRequirement(forecast: EnergyForecast, start: number, end: number, capacity: number, chargePowerKw: number,
  dischargePowerKw: number = policy.batteryPowerLimitKw) {
  let required = 0;
  let unavoidable = 0;
  const segments = forecastLoadSegments(forecast, start, end)!;
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const overlap = segment.hours;
    // A later deficit above capacity cannot be solved by storing more before an earlier surplus.
    if (required > capacity) {
      unavoidable += required - capacity;
      required = capacity;
    }
    const load = segment.loadKwh;
    const production = segment.solarKwh;
    const net = load - production;
    let storedChange: number;
    if (net >= 0) {
      const demand = net / efficiency;
      storedChange = Math.min(demand, dischargePowerKw * overlap);
      unavoidable += demand - storedChange;
    } else {
      storedChange = -Math.min(-net, chargePowerKw * overlap) * efficiency;
    }
    required = Math.max(0, required + storedChange);
  }
  return { required, unavoidable };
}

/** Passive daytime operation: cheap-tariff household demand stays on the grid while held. */
function daytimeSteps(forecast: EnergyForecast, start: number, end: number, afternoonStart: number, chargePowerKw: number, gridChargeEndsAt: number) {
  const steps: Array<{ hours: number; chargeKwh: number; demandKwh: number; powerGapKwh: number; afternoon: boolean; chargePowerKw: number }> = [];
  const morningEnd = afternoonStart - 5 * 60_000;
  for (const segment of forecastLoadSegments(forecast, start, end)!) {
    const a = segment.start, b = segment.end;
    const boundaries = [a, ...[...new Set([morningEnd, afternoonStart, gridChargeEndsAt])]
      .filter(value => value > a && value < b).sort((x, y) => x - y), b];
    for (let part = 0; part < boundaries.length - 1; part++) {
      const from = boundaries[part];
      const hours = (boundaries[part + 1] - from) / hourMs;
      const net = (segment.solarKwh - segment.loadKwh) / segment.hours * hours;
      const allowedChargePower = batteryChargeAllowanceKw(segment.loadKwh / segment.hours, chargePowerKw);
      const demand = from < morningEnd ? Math.max(0, -net) / efficiency : 0;
      const demandKwh = Math.min(demand, policy.batteryPowerLimitKw * hours);
      steps.push({ hours, chargeKwh: segment.batterySupply ? 0 : Math.min(Math.max(0, net), allowedChargePower * hours) * efficiency,
        demandKwh, powerGapKwh: demand - demandKwh, afternoon: from >= afternoonStart && from < gridChargeEndsAt
          && segment.batteryChargeAllowed && allowedChargePower > 0, chargePowerKw: allowedChargePower });
    }
  }
  return steps;
}

/** Work backwards from the afternoon goal without assuming an afternoon grid top-up. */
function daytimeRequirement(steps: ReturnType<typeof daytimeSteps>, goal: number, reserve: number, maximum: number) {
  let required = Math.min(goal, maximum);
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    required = Math.max(reserve, Math.min(required, maximum) + step.demandKwh - step.chargeKwh);
  }
  return required;
}

/** Maximum feasible outcome counts both cheap windows, plus actual solar headroom and power caps. */
function daytimeReachable(steps: ReturnType<typeof daytimeSteps>, stored: number, reserve: number, maximum: number, chargeTarget = maximum) {
  let energy = stored;
  let missed = 0;
  for (const step of steps) {
    missed += step.powerGapKwh + Math.max(0, step.demandKwh - Math.max(0, energy - reserve));
    energy = Math.max(Math.min(energy, reserve), energy - step.demandKwh);
    // Forced charging replaces the solar input during that time; after the SOC target
    // stops it, only the remaining fraction of this interval can contribute passive PV.
    const chargingHours = step.afternoon
      ? Math.min(step.hours, Math.max(0, chargeTarget - energy) / (step.chargePowerKw * efficiency)) : 0;
    const gain = step.chargePowerKw * chargingHours * efficiency + step.chargeKwh * (1 - chargingHours / step.hours);
    energy = Math.max(energy, Math.min(maximum, energy + gain));
  }
  return { energy, missed };
}

/** Include the cutoff bridge in SOC, but count only demand missed during the high tariff. */
function highTariffUnmet(forecast: EnergyForecast, cutoff: number, end: number, stored: number, reserve: number, maximum: number, chargePowerKw: number) {
  const highStart = cutoff + 5 * 60_000;
  let energy = stored;
  let missed = 0;
  for (const segment of forecastLoadSegments(forecast, cutoff, end)!) {
    const from = segment.start, hours = segment.hours;
    const net = segment.loadKwh - segment.solarKwh;
    if (net >= 0) {
      const demand = net / efficiency;
      const supplied = Math.min(demand, policy.batteryPowerLimitKw * hours, Math.max(0, energy - reserve));
      energy -= supplied;
      if (from >= highStart) missed += demand - supplied;
    } else {
      energy = Math.max(energy, Math.min(maximum, energy + Math.min(-net, batteryChargeAllowanceKw(segment.loadKwh / hours, chargePowerKw) * hours) * efficiency));
    }
  }
  return missed;
}

function afternoonCommandTarget(steps: ReturnType<typeof daytimeSteps>, stored: number, goal: number, reserve: number, maximum: number) {
  const passive = daytimeRequirement(steps, goal, reserve, maximum);
  if (stored >= passive) return passive;
  let low = Math.max(stored, passive);
  let high = Math.min(goal, maximum);
  // A command cannot fund a physically unreachable final goal, but must keep charging
  // until its safety deadline instead of stopping early on optimistic solar credit.
  if (daytimeReachable(steps, stored, reserve, maximum, high).energy < goal) return high;
  // Monotone charge-then-hold trajectories give a bounded solve, including partial
  // hours and headroom gaps through the exact charging cutoff.
  for (let iteration = 0; iteration < 40; iteration++) {
    const middle = (low + high) / 2;
    if (daytimeReachable(steps, stored, reserve, maximum, middle).energy >= goal) high = middle;
    else low = middle;
  }
  return high;
}

function overnightStoredChange(forecast: EnergyForecast, start: number, end: number, chargePowerKw: number, gridChargeEndsAt: number,
  stored: number, reserve: number, maximum: number, capacity: number, dischargePowerKw: number) {
  if (end <= start) return 0;
  // Before midnight the next-day forecast has no slot; the runner still checks actual grid headroom.
  const dayStart = Date.parse(forecast.hourly![0].start);
  let energy = stored;
  const gain = (value: number) => { energy = Math.max(energy, Math.min(maximum, energy + value)); };
  const supply = (from: number, until: number, netKwh?: number) => {
    const settings = carBatterySupply(forecast, from, until);
    if (!settings) return false;
    const floor = Math.max(reserve, settings.minimumSocPercent / 100 * capacity);
    const maximumDischarge = Math.min(settings.maxDischargeKw, dischargePowerKw) * (until - from) / hourMs;
    energy -= Math.min(netKwh === undefined ? maximumDischarge : Math.max(0, netKwh) / efficiency,
      maximumDischarge, Math.max(0, energy - floor));
    return true;
  };
  const beforeEnd = Math.min(end, dayStart, gridChargeEndsAt);
  if (beforeEnd > start) {
    const boundaries = carLoadBoundaries(forecast, start, beforeEnd);
    if (!boundaries) return NaN;
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index], until = boundaries[index + 1];
      if (supply(from, until)) continue;
      if (carAllowsBatteryCharge(forecast, from, until)) {
        const hours = (until - from) / hourMs;
        const carPower = (carEnergyBetween(forecast, from, until) ?? Infinity) / hours;
        // Use the first household forecast before midnight; actual meter limiting remains independent.
        const household = consumptionIntervals(forecast.consumption)![0];
        const householdPower = household.estimatedConsumptionKwh * hourMs / (Date.parse(household.end) - Date.parse(household.start));
        gain(batteryChargeAllowanceKw(householdPower + carPower, chargePowerKw) * hours * efficiency);
      }
    }
  }
  for (const segment of forecastLoadSegments(forecast, start, end)!) {
    const from = segment.start, until = segment.end, hours = segment.hours;
    const net = (segment.loadKwh - segment.solarKwh) / hours;
    if (supply(from, until, segment.loadKwh - segment.solarKwh)) continue;
    const allowedChargePower = batteryChargeAllowanceKw(segment.loadKwh / hours, chargePowerKw);
    const solarPower = Math.min(Math.max(0, -net), allowedChargePower);
    const chargingHours = Math.max(0, Math.min(until, gridChargeEndsAt) - from) / hourMs;
    gain(((segment.batteryChargeAllowed ? allowedChargePower : solarPower) * chargingHours
      + solarPower * (hours - chargingHours)) * efficiency);
  }
  return energy - stored;
}

function peakBuffer(forecast: EnergyForecast, start: number, end: number, config: AutomationConfig) {
  const net = forecastLoadSegments(forecast, start, end)!.reduce((sum, segment) => sum + segment.loadKwh - segment.solarKwh, 0);
  return Math.max(config.minimumEnergyBufferKwh, Math.max(0, net) / efficiency * config.energyBufferPercent / 100);
}

/** Protected stored energy for the next morning only; no afternoon SOC preference or EV load. */
export function nextNightHighTariffReserve(now: Date, forecast: EnergyForecast, config: AutomationConfig,
  limits?: AutomationLimits): number | null {
  const time = now.getTime();
  if (!finite(time) || !validConfig(config)) return null;
  const nightEnd = getNightTariffEnd(now);
  const highStart = nightEnd === null ? Date.parse(getCarTarget(now).deadline) + 5 * 60_000 : Date.parse(nightEnd);
  const morningDate = getLocalDate(new Date(highStart));
  if (forecast.date !== morningDate || forecast.consumption?.date !== morningDate || !hasUsableForecast(forecast, time)
    || forecast.consumption.excludesCar !== true || !validHours(forecast)) return null;
  const installedReserve = limits?.reserveSocPercent === undefined ? config.reserveSocPercent : limits.reserveSocPercent;
  const maxPowerKw = limits?.maxPowerKw ?? policy.batteryPowerLimitKw;
  const maxSocPercent = limits?.maxSocPercent ?? 100;
  if (!nonnegative(installedReserve) || installedReserve >= 100 || !finite(maxPowerKw) || maxPowerKw <= 0
    || !finite(maxSocPercent) || maxSocPercent <= 0 || maxSocPercent > 100) return null;
  const reservePercent = Math.max(policy.homeBatteryReserveSocPercent, config.reserveSocPercent, installedReserve);
  if (reservePercent >= maxSocPercent) return null;
  const reserve = config.socCapacityKwh * reservePercent / 100;
  const maximum = config.socCapacityKwh * maxSocPercent / 100;
  // Household/PV only: existing car allocations must neither reduce nor inflate this reserve.
  const household = { ...forecast, carCharging: undefined, carChargingContext: undefined };
  const start = highStart;
  const end = Date.parse(getSchedule(new Date(start)).tariff.nextChangeAt);
  const needs = chronologicalRequirement(household, start, end, maximum - reserve,
    Math.min(6, maxPowerKw), Math.min(policy.batteryPowerLimitKw, maxPowerKw));
  const protectedKwh = reserve + needs.required + peakBuffer(household, start, end, config);
  if (needs.unavoidable > 1e-6 || !finite(protectedKwh) || protectedKwh > maximum + 1e-6) return null;
  return Math.min(maximum, protectedKwh);
}

/** Pure, conservative planning only. Command ownership and grid safety belong to the runner. */
export function planBatteryCharge(
  now: Date, telemetry: Telemetry, forecast: EnergyForecast, config: AutomationConfig,
  limits: AutomationLimits,
): AutomationPlan {
  const base: AutomationPlan = {
    action: 'hold', window: null, targetSocPercent: null, afternoonTargetSocPercent: null, afternoonTargetAt: null,
    requiredStoredKwh: null, energyBufferKwh: null, storedKwh: null,
    shortfallKwh: null, unmetKwh: 0, nextHighTariffUnmetKwh: null, nextHighTariffChargeNeededKwh: null,
    powerKw: 6, windowEndsAt: null, forecastDate: null, reason: 'disabled',
  };
  const blocked = (reason: string): AutomationPlan => ({ ...base, action: 'blocked', reason });
  if (!finite(now.getTime())) return blocked('invalid_clock');
  if (!validConfig(config)) return blocked('invalid_configuration');
  if (!config.enabled) return base;
  const schedule = getSchedule(now);
  if (!schedule.charging.allowed) return { ...base, reason: 'outside_charging_window' };
  base.window = schedule.charging.currentWindow;
  base.windowEndsAt = schedule.charging.nextWindow.end;
  const localDate = getLocalDate(now);
  const windowEndDate = getLocalDate(new Date(base.windowEndsAt));
  base.forecastDate = base.window === 'night' ? windowEndDate : localDate;
  const reserveSocPercent = Math.max(policy.homeBatteryReserveSocPercent, config.reserveSocPercent);
  if (!finite(limits.maxPowerKw) || limits.maxPowerKw < 6
    || !finite(limits.maxSocPercent) || limits.maxSocPercent <= reserveSocPercent || limits.maxSocPercent > 100
    || (limits.revertTimeoutSeconds !== undefined && !nonnegative(limits.revertTimeoutSeconds))) {
    return blocked('controller_limits');
  }
  const observed = typeof telemetry.observedAt === 'string' ? Date.parse(telemetry.observedAt) : NaN;
  if (telemetry.status !== 'online' || !finite(observed) || now.getTime() - observed > 30_000 || observed - now.getTime() > 5000) {
    return blocked('telemetry_unavailable');
  }
  const soc = telemetry.batterySocPercent;
  if (!finite(soc) || soc < 0 || soc > 100) return blocked('soc_unavailable');
  base.storedKwh = soc / 100 * config.socCapacityKwh;
  if (!hasUsableForecast(forecast, now.getTime())) {
    return blocked('forecast_unavailable');
  }
  if (forecast.date !== base.forecastDate || forecast.consumption.date !== base.forecastDate) return blocked('forecast_wrong_date');
  if (!nonnegative(forecast.consumption.estimatedConsumptionKwh)
    || forecast.consumption.excludesCar !== true) return blocked('consumption_unavailable');
  const carBounds = getCalendarDayBounds(new Date(`${forecast.date}T00:00:00Z`));
  if (!validCarLoad(forecast) || carEnergyBetween(forecast, carBounds.start.getTime(), carBounds.end.getTime()) === null) {
    return blocked('car_forecast_unavailable');
  }
  const reserve = config.socCapacityKwh * reserveSocPercent / 100;
  const maximum = config.socCapacityKwh * limits.maxSocPercent / 100;
  if (!validHours(forecast)) return blocked('hourly_forecast_unavailable');
  // 16:00 is safely after Zurich's DST transition, so the policy resolves all wall times.
  const dayEnd = getCalendarDayBounds(new Date(`${forecast.date}T00:00:00Z`)).end.getTime();
  const afternoonWindow = getSchedule(new Date(dayEnd - 8 * hourMs)).charging.nextWindow;
  const afternoonStart = Date.parse(afternoonWindow.start);
  const afternoonEnd = Date.parse(afternoonWindow.end);
  const eveningEnd = dayEnd - hourMs;
  const chargePowerKw = Math.min(6, limits.maxPowerKw);
  const eveningBuffer = peakBuffer(forecast, afternoonEnd + 5 * 60_000, eveningEnd, config);
  const evening = chronologicalRequirement(forecast, afternoonEnd, eveningEnd, maximum - reserve, chargePowerKw);
  // The preferred SOC is at 16:55 itself; do not add a five-minute bridge on top of 80%.
  const afternoonGoal = Math.max(config.socCapacityKwh * config.afternoonTargetSocPercent / 100,
    reserve + evening.required + eveningBuffer);
  base.afternoonTargetAt = new Date(afternoonEnd).toISOString();
  base.afternoonTargetSocPercent = Math.min(100,
    Math.ceil(afternoonGoal / config.socCapacityKwh * 1000 - 1e-9) / 10);
  const startsAt = base.window === 'night' ? Date.parse(base.windowEndsAt) : now.getTime();
  const steps = daytimeSteps(forecast, startsAt, afternoonEnd, afternoonStart, chargePowerKw, afternoonEnd);
  let required = daytimeRequirement(steps, afternoonGoal, reserve, maximum);
  let energyBufferKwh = eveningBuffer;
  if (base.window === 'night') {
    const morningEnd = afternoonStart - 5 * 60_000;
    const morningBuffer = peakBuffer(forecast, startsAt + 5 * 60_000, morningEnd, config);
    const morning = chronologicalRequirement(forecast, startsAt, morningEnd, maximum - reserve, chargePowerKw);
    // Afternoon solar must never be used to justify an underfunded morning high tariff.
    required = Math.max(required, reserve + morning.required + morningBuffer);
    energyBufferKwh = Math.max(morningBuffer, eveningBuffer);
  } else {
    required = afternoonCommandTarget(steps, base.storedKwh, afternoonGoal, reserve, maximum);
  }
  if (!finite(required) || !finite(afternoonGoal)) return blocked('forecast_invalid');
  base.energyBufferKwh = energyBufferKwh;
  base.requiredStoredKwh = required;
  base.targetSocPercent = Math.max(0, Math.min(limits.maxSocPercent, Math.ceil(required / config.socCapacityKwh * 1000 - 1e-9) / 10));
  const cappedEnergy = base.targetSocPercent / 100 * config.socCapacityKwh;
  base.shortfallKwh = Math.max(0, cappedEnergy - base.storedKwh);
  const nightCharge = base.window === 'night'
    ? overnightStoredChange(forecast, now.getTime(), Date.parse(base.windowEndsAt), chargePowerKw,
      Date.parse(base.windowEndsAt), base.storedKwh, reserve, maximum, config.socCapacityKwh,
      Math.min(policy.batteryPowerLimitKw, limits.maxPowerKw)) : 0;
  if (!finite(nightCharge)) return blocked('car_forecast_unavailable');
  const afterNightCharge = Math.min(Math.max(maximum, base.storedKwh), base.storedKwh + nightCharge);
  const reachable = daytimeReachable(steps, afterNightCharge, reserve, maximum);
  base.unmetKwh = evening.unavoidable + reachable.missed + Math.max(0, afternoonGoal - reachable.energy);
  const nextPeakCutoff = base.window === 'night' ? startsAt : afternoonEnd;
  const nextPeakEnd = base.window === 'night' ? afternoonStart - 5 * 60_000 : eveningEnd;
  base.nextHighTariffUnmetKwh = highTariffUnmet(forecast, nextPeakCutoff, nextPeakEnd,
    base.window === 'night' ? afterNightCharge : reachable.energy, reserve, maximum, chargePowerKw);
  // Assess necessity before adding grid energy, retaining passive solar and the reserve.
  // Disabling forced charging leaves the existing 80% goal and command unchanged.
  const passiveStored = base.window === 'night'
    ? Math.min(Math.max(maximum, base.storedKwh), base.storedKwh
      + overnightStoredChange(forecast, now.getTime(), startsAt, chargePowerKw, now.getTime(),
        base.storedKwh, reserve, maximum, config.socCapacityKwh, Math.min(policy.batteryPowerLimitKw, limits.maxPowerKw)))
    : daytimeReachable(steps, base.storedKwh, reserve, maximum, 0).energy;
  base.nextHighTariffChargeNeededKwh = highTariffUnmet(forecast, nextPeakCutoff, nextPeakEnd,
    passiveStored, reserve, maximum, chargePowerKw);
  const limitedCoverage = base.nextHighTariffUnmetKwh > 1e-6;
  if (carAllowsBatteryCharge(forecast, now.getTime(), now.getTime() + 1) === false) return { ...base, reason: 'car_priority' };
  if (soc >= base.targetSocPercent - 0.02) return { ...base, reason: limitedCoverage ? 'target_reached_capacity_limited' : 'target_reached' };
  return { ...base, action: 'charge', reason: limitedCoverage ? 'charging_insufficient_capacity_or_time' : 'energy_shortfall' };
}
