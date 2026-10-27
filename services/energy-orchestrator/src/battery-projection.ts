import { solarIntervals } from './solar-intervals.js';
import { consumptionIntervals } from './consumption.js';
import { batteryChargeAllowanceKw } from './site-power.js';
import { planBatteryCharge, type AutomationConfig, type EnergyForecast } from './automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from './automation.js';
import { getCalendarDayBounds, getLocalDate, getSchedule, policy } from './policy.js';
import type { Telemetry } from './status.js';
import { hasUsableForecast } from './forecast.js';
import { carAllowsBatteryCharge, carBatterySupply, carEnergyBetween, carLoadBoundaries, validCarLoad } from './car-load.js';

export interface BatteryProjection {
  status: 'available' | 'unavailable';
  reason: string | null;
  assumption: 'automatic_planning' | 'passive_operation' | 'manual_charging';
  observedAt: string | null;
  points: Array<{ at: string; socPercent: number }>;
  /** Stored-energy flows through an explicitly requested deadline, including conversion losses. */
  energyBalance?: { solarKwh: number; gridKwh: number; consumptionKwh: number };
}

const hourMs = 3_600_000;
const stepMs = 5 * 60_000;
const quarterMs = 15 * 60_000;
const efficiency = Math.sqrt(policy.storageRoundTripEfficiency);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;

/** Validate the snapshot once against real time, never against a simulated future clock. */
function validForecast(forecast: EnergyForecast, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forecast.date)) return false;
  const day = new Date(`${forecast.date}T00:00:00Z`);
  if (!finite(day.getTime()) || day.toISOString().slice(0, 10) !== forecast.date) return false;
  if (!hasUsableForecast(forecast, now)
    || forecast.consumption?.date !== forecast.date || forecast.consumption.excludesCar !== true || !validCarLoad(forecast)) return false;
  const { start, end } = getCalendarDayBounds(day);
  const count = (end.getTime() - start.getTime()) / hourMs;
  return [23, 24, 25].includes(count) && forecast.consumption.dayHours === count
    && solarIntervals(forecast) !== null && consumptionIntervals(forecast.consumption) !== null;
}

/**
 * Illustrative SOC trajectory, anchored exclusively to measured SOC.
 * Unavailable control uses passive solar/load operation without scheduled charging or holding.
 * Household energy follows retained source intervals; explicit car allocations retain exact slot edges.
 * This has no timers, persistence or controller side effects and is not a charging guarantee.
 */
export function projectBatterySoc(
  now: Date, telemetry: Telemetry, control: AutomationControllerState & { automated?: boolean; minimumSocPercent?: number | null },
  automation: AutomationStatus, forecasts: EnergyForecast[], config: AutomationConfig,
  until?: Date,
): BatteryProjection {
  const unavailable = (reason: string): BatteryProjection => ({
    status: 'unavailable', reason, assumption: 'automatic_planning', observedAt: null, points: [],
  });
  const timestamp = now.getTime();
  if (!finite(timestamp)) return unavailable('invalid_clock');
  const manual = control.mode === 'manual' && control.automated !== true
    && !control.automationOwner && !control.automationMode;
  if (!manual && (!config.enabled || !automation.enabled || automation.status === 'disabled')) return unavailable('disabled');
  if (!manual && automation.status === 'manual_override') return unavailable('manual_override');
  if (!finite(config.socCapacityKwh) || config.socCapacityKwh <= 0
    || !nonnegative(config.reserveSocPercent) || config.reserveSocPercent >= 100
    || !nonnegative(config.energyBufferPercent) || config.energyBufferPercent > 100
    || !nonnegative(config.minimumEnergyBufferKwh) || config.minimumEnergyBufferKwh > config.socCapacityKwh
    || !nonnegative(config.afternoonTargetSocPercent) || config.afternoonTargetSocPercent > 100) {
    return unavailable('invalid_configuration');
  }
  const observed = Date.parse(telemetry.observedAt ?? '');
  if (telemetry.status !== 'online' || !finite(observed) || timestamp - observed > 30_000 || observed - timestamp > 5000
    || !finite(telemetry.batterySocPercent) || telemetry.batterySocPercent < 0 || telemetry.batterySocPercent > 100) {
    return unavailable('soc_unavailable');
  }
  if (!manual && control.mode === 'manual' && (control.automated !== true || !control.automationOwner
    || !['charge', 'hold', 'supply'].includes(control.automationMode ?? ''))) return unavailable('manual_override');
  if (manual && (!control.available || control.error)) return unavailable('controller_unavailable');
  const passive = !manual && (automation.status === 'error' || automation.status === 'blocked' || Boolean(automation.error)
    || !control.available || control.mode === 'unknown' || Boolean(control.error));
  const assumption = manual ? 'manual_charging' : passive ? 'passive_operation' : 'automatic_planning';
  const controllerReserve = control.limits.reserveSocPercent;
  const reservePercent = Math.max(policy.homeBatteryReserveSocPercent, config.reserveSocPercent,
    passive && (!nonnegative(controllerReserve) || controllerReserve > 100) ? 0 : controllerReserve ?? NaN);
  const maximumPercent = passive && (!finite(control.limits.maxSocPercent) || control.limits.maxSocPercent <= reservePercent
    || control.limits.maxSocPercent > 100) ? 100 : control.limits.maxSocPercent;
  const solarChargePower = (passive || manual) && nonnegative(control.limits.maxPowerKw) ? Math.min(6, control.limits.maxPowerKw) : 6;
  const fallback = control.revertTimeoutSeconds;
  if (!nonnegative(reservePercent) || !finite(maximumPercent) || maximumPercent <= reservePercent || maximumPercent > 100
    || (manual && (!finite(control.limits.maxPowerKw) || control.limits.maxPowerKw <= 0))
    || (!passive && !manual && (!finite(control.limits.maxPowerKw) || control.limits.maxPowerKw < 6
      || !finite(fallback) || fallback < 10 || fallback > 120))) return unavailable('controller_limits');
  const manualExpiresAt = control.expiresAt == null ? Infinity : Date.parse(control.expiresAt);
  const manualPowerKw = control.requestedPowerKw === undefined ? control.powerKw : control.requestedPowerKw;
  // The controller's no-custom-target session explicitly permits full charge above its custom-target ceiling.
  const manualMaximumPercent = manual && control.targetSocPercent === 100 ? 100 : maximumPercent;
  if (manual && (!finite(manualPowerKw) || manualPowerKw <= 0 || manualPowerKw > control.limits.maxPowerKw
    || !finite(control.powerKw) || control.powerKw < 0 || control.powerKw > manualPowerKw
    || !finite(control.targetSocPercent) || control.targetSocPercent <= 0 || control.targetSocPercent > manualMaximumPercent
    || (control.expiresAt != null && (!finite(manualExpiresAt) || manualExpiresAt <= timestamp)))) {
    return unavailable('manual_charge_invalid');
  }
  const owned = !passive && control.mode === 'manual' && control.automated === true;
  const ownedMode = control.automationMode as 'charge' | 'hold' | 'supply' | undefined;
  if (owned && ((control.automationMode === 'charge' && (control.powerKw !== 6
    || !finite(control.targetSocPercent) || control.targetSocPercent <= 0 || control.targetSocPercent > maximumPercent))
    || (control.automationMode === 'hold' && control.powerKw !== 0)
    || (ownedMode === 'supply' && (!finite(control.powerKw) || control.powerKw >= 0
      || Math.abs(control.powerKw) > Math.min(policy.batteryPowerLimitKw, control.limits.maxPowerKw)
      || !nonnegative(control.minimumSocPercent) || control.minimumSocPercent < reservePercent
      || control.minimumSocPercent >= 100)))) return unavailable('owned_charge_invalid');

  const currentDate = getLocalDate(now);
  const nextDate = new Date(Date.parse(`${currentDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const lookaheadDate = new Date(Date.parse(`${currentDate}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  const days = new Map<string, EnergyForecast>();
  for (const forecast of forecasts) {
    if ((forecast.date === currentDate || forecast.date === nextDate || forecast.date === lookaheadDate) && validForecast(forecast, timestamp)
      && !days.has(forecast.date)) days.set(forecast.date, forecast);
  }
  if (!days.has(currentDate)) return unavailable('forecast_unavailable');
  const production = new Map([...days].map(([date, forecast]) => [date, solarIntervals(forecast)!]));
  const consumption = new Map([...days].map(([date, forecast]) => [date, consumptionIntervals(forecast.consumption)!]));
  // The third day funds tomorrow's 23:05 planner decision only, never a third chart day.
  const finalDate = days.has(nextDate) ? nextDate : currentDate;
  const horizon = Math.min(getCalendarDayBounds(new Date(`${finalDate}T00:00:00Z`)).end.getTime(), until?.getTime() ?? Infinity);
  const capacity = config.socCapacityKwh;
  const reserve = reservePercent / 100 * capacity;
  const maximum = maximumPercent / 100 * capacity;
  const chargeMaximum = manual ? manualMaximumPercent / 100 * capacity : maximum;
  const settings = { ...config, reserveSocPercent: reservePercent };
  let energy = telemetry.batterySocPercent / 100 * capacity;
  // An in-flight confirmed command remains authoritative until the runner's next evaluation.
  let manualCharging = manual && energy < control.targetSocPercent! / 100 * capacity;
  let mode: 'normal' | 'charge' | 'hold' | 'supply' = manualCharging ? 'charge' : owned ? ownedMode! : 'normal';
  let supplySettings = ownedMode === 'supply' ? { minimumSocPercent: control.minimumSocPercent!,
    maxDischargeKw: Math.abs(control.powerKw!) } : null;
  let targetEnergy = manual || owned && control.automationMode === 'charge' ? control.targetSocPercent! / 100 * capacity : energy;
  const scheduledEvaluation = Date.parse(automation.nextEvaluationAt ?? '');
  let nextEvaluation = manual ? Infinity : owned ? finite(scheduledEvaluation) ? Math.max(timestamp, scheduledEvaluation)
    : (Math.floor(timestamp / quarterMs) + 1) * quarterMs : timestamp;
  const points = [{ at: now.toISOString(), socPercent: telemetry.batterySocPercent }];
  const energyBalance = { solarKwh: 0, gridKwh: 0, consumptionKwh: 0 };
  let reason: string | null = null;
  let previousCarHold = false;
  for (let at = timestamp; at < horizon;) {
    const instant = new Date(at);
    const forecast = days.get(getLocalDate(instant));
    if (!forecast) { reason = 'forecast_unavailable'; break; }
    const schedule = getSchedule(instant);
    const carEdges = carLoadBoundaries(forecast, at, Math.min(horizon,
      getCalendarDayBounds(new Date(`${forecast.date}T00:00:00Z`)).end.getTime()));
    if (!carEdges) { reason = 'car_forecast_unavailable'; break; }
    const allocatedSupply = carBatterySupply(forecast, at, at + 1);
    if (allocatedSupply === null) { reason = 'car_forecast_unavailable'; break; }
    const carConstrained = carAllowsBatteryCharge(forecast, at, at + 1) === false;
    const carHold = carConstrained && !allocatedSupply;
    if (carConstrained && (passive || manual)) { reason = 'car_coordination_unavailable'; break; }
    if (previousCarHold && !carConstrained) nextEvaluation = at;
    previousCarHold = carConstrained;
    const untilStart = Date.parse(schedule.charging.nextWindow.start) - at;
    const preserving = schedule.charging.allowed || (schedule.tariff.kind === 'low' && untilStart > 0 && untilStart <= quarterMs);
    if (manual) {
      // A manual command survives tariff boundaries, but never restarts after its target or expiry.
      if (at >= manualExpiresAt || energy >= targetEnergy) manualCharging = false;
      mode = manualCharging ? 'charge' : 'normal';
    }
    else if (allocatedSupply) { mode = 'supply'; supplySettings = allocatedSupply; }
    else if (carHold) mode = 'hold';
    else if (passive || !preserving) mode = 'normal';
    else if (!schedule.charging.allowed) mode = 'hold';
    else if (at >= nextEvaluation) {
      const targetDate = schedule.charging.currentWindow === 'night'
        ? getLocalDate(new Date(schedule.charging.nextWindow.end)) : getLocalDate(instant);
      const targetForecast = days.get(targetDate);
      if (!targetForecast) { reason = 'forecast_unavailable'; break; }
      // Snapshot freshness was checked at real now; only the pure planner's simulated clock moves.
      const plan = planBatteryCharge(instant,
        { ...telemetry, observedAt: instant.toISOString(), batterySocPercent: energy / capacity * 100 },
        { ...targetForecast, fetchedAt: instant.toISOString() }, settings,
        { ...control.limits, revertTimeoutSeconds: fallback });
      if (plan.action === 'blocked' || !finite(plan.targetSocPercent)) { reason = plan.reason; break; }
      targetEnergy = plan.targetSocPercent / 100 * capacity;
      mode = plan.action === 'charge' ? 'charge' : 'hold';
      nextEvaluation = (Math.floor(at / quarterMs) + 1) * quarterMs;
    }
    const solar = production.get(forecast.date)!.find(interval => Date.parse(interval.start) <= at && Date.parse(interval.end) > at)!;
    const household = consumption.get(forecast.date)!.find(interval => Date.parse(interval.start) <= at && Date.parse(interval.end) > at)!;
    // Renewing a technical lease does not shorten the charging window.
    const chargeCutoff = manual ? manualExpiresAt : Date.parse(schedule.charging.nextWindow.end);
    if (mode === 'charge' && at >= chargeCutoff) mode = 'normal';
    const end = Math.min(horizon, Date.parse(solar.end), Date.parse(household.end), (Math.floor(at / stepMs) + 1) * stepMs,
      nextEvaluation > at ? nextEvaluation : Infinity,
      carEdges.find(edge => edge > at) ?? Infinity,
      mode === 'charge' && chargeCutoff > at ? chargeCutoff : Infinity);
    const duration = (end - at) / hourMs;
    const carKwh = carEnergyBetween(forecast, at, end);
    if (carKwh === null) { reason = 'car_forecast_unavailable'; break; }
    const householdPower = household.estimatedConsumptionKwh * hourMs / (Date.parse(household.end) - Date.parse(household.start)) + carKwh / duration;
    const solarPower = solar.estimatedProductionKwh * hourMs / (Date.parse(solar.end) - Date.parse(solar.start));
    const netPower = householdPower - solarPower;
    const chargePower = batteryChargeAllowanceKw(householdPower, manual ? manualPowerKw! : 6);
    const passiveChargePower = batteryChargeAllowanceKw(householdPower, solarChargePower);
    if (mode === 'charge' && (manual ? energy >= targetEnergy : energy >= targetEnergy - capacity * .0002)) {
      mode = manual ? 'normal' : 'hold';
      manualCharging = false;
    }
    if (mode === 'supply' && supplySettings) {
      const floor = Math.max(reserve, supplySettings.minimumSocPercent / 100 * capacity);
      const consumption = Math.min(Math.max(0, netPower) / efficiency * duration,
        Math.min(supplySettings.maxDischargeKw, policy.batteryPowerLimitKw, control.limits.maxPowerKw) * duration,
        Math.max(0, energy - floor));
      energy -= consumption;
      energyBalance.consumptionKwh += consumption;
      if (energy <= floor + capacity * .0002) mode = 'hold';
    } else if (mode === 'charge' && chargePower > 0) {
      const gain = Math.min(chargePower * efficiency * duration, Math.max(0, targetEnergy - energy), Math.max(0, chargeMaximum - energy));
      energy += gain;
      const solarGain = gain * Math.min(Math.max(0, -netPower), chargePower) / chargePower;
      energyBalance.solarKwh += solarGain;
      energyBalance.gridKwh += gain - solarGain;
      if (manual ? energy >= targetEnergy : energy >= targetEnergy - capacity * .0002) {
        mode = manual ? 'normal' : 'hold';
        manualCharging = false;
        // Reaching an intermediate target stops forced charging, while surplus solar can continue.
        const heldHours = Math.max(0, duration - gain / (chargePower * efficiency));
        const heldGain = Math.min(Math.min(Math.max(0, -netPower), passiveChargePower) * efficiency * heldHours, Math.max(0, maximum - energy));
        energy += heldGain;
        energyBalance.solarKwh += heldGain;
        if (manual && netPower > 0) {
          const consumed = Math.min(netPower / efficiency * heldHours, policy.batteryPowerLimitKw * heldHours,
            Math.max(0, energy - reserve));
          energy -= consumed;
          energyBalance.consumptionKwh += consumed;
        }
      }
    } else if (netPower < 0) {
      const gain = Math.min(Math.min(-netPower, passiveChargePower) * efficiency * duration, Math.max(0, maximum - energy));
      energy += gain;
      energyBalance.solarKwh += gain;
    } else if (mode === 'normal') {
      const consumption = Math.min(netPower / efficiency * duration, policy.batteryPowerLimitKw * duration, Math.max(0, energy - reserve));
      energy -= consumption;
      energyBalance.consumptionKwh += consumption;
    }
    energy = Math.max(0, Math.min(capacity, energy));
    points.push({ at: new Date(end).toISOString(), socPercent: energy / capacity * 100 });
    at = end;
  }
  if (points.length < 2) return unavailable(reason ?? 'forecast_unavailable');
  return { status: 'available', reason, assumption, observedAt: new Date(observed).toISOString(), points,
    ...(until ? { energyBalance } : {}) };
}
