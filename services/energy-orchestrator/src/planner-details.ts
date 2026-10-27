import { solarIntervals } from './solar-intervals.js';
import { consumptionIntervals } from './consumption.js';
import { planBatteryCharge, type AutomationConfig, type AutomationPlan, type EnergyForecast } from './automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from './automation.js';
import { projectBatterySoc, type BatteryProjection } from './battery-projection.js';
import { getCalendarDayBounds, getLocalDate, getSchedule, policy } from './policy.js';
import type { Telemetry } from './status.js';
import { hasUsableForecast } from './forecast.js';
import { carEnergyBetween } from './car-load.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const validSoc = (value: unknown): value is number => nonnegative(value) && value <= 100;

/** Read-only view of the current expensive period, or the next one during cheap hours. */
export function getUpcomingHighTariff(now: Date) {
  const date = getLocalDate(now);
  const day = new Date(`${date}T00:00:00Z`);
  const bounds = getCalendarDayBounds(day);
  // Reuse policy wall-time conversion, including 23/25-hour Zurich calendar days.
  const morningStart = getSchedule(bounds.start).tariff.nextChangeAt;
  const morningEnd = getSchedule(new Date(morningStart)).tariff.nextChangeAt;
  const eveningStart = getSchedule(new Date(morningEnd)).tariff.nextChangeAt;
  const eveningEnd = getSchedule(new Date(eveningStart)).tariff.nextChangeAt;
  const periods = [
    { start: morningStart, end: morningEnd, date },
    { start: eveningStart, end: eveningEnd, date },
  ];
  const selected = periods.find(period => now.getTime() < Date.parse(period.end));
  if (selected) return { ...selected, isCurrent: now.getTime() >= Date.parse(selected.start) };
  const nextStart = getSchedule(bounds.end).tariff.nextChangeAt;
  return {
    start: nextStart, end: getSchedule(new Date(nextStart)).tariff.nextChangeAt,
    date: getLocalDate(bounds.end), isCurrent: false,
  };
}

type Hour = { start: string; end: string };
type ConsumptionMethod = EnergyForecast['consumption']['hourlyMethod'];
export interface PlannerDetails {
  calculation?: { charging: ReturnType<typeof getSchedule>['charging']; plan: AutomationPlan | null };
  upcomingPlan: { start: string; end: string; estimatedSocPercent: number | null;
    estimatedCompletionAt: string | null; plan: AutomationPlan } | null;
  afternoonEstimate: { at: string; socPercent: number | null } | null;
  chargeBreakdown: {
    start: string;
    end: string;
    /** Stored energy captured when this estimate was calculated. */
    storedKwh: number;
    gapKwh: number | null;
    consumptionKwh: number | null;
    solarKwh: number | null;
    gridKwh: number | null;
    unmetKwh: number | null;
  } | null;
  battery: {
    socPercent: number | null;
    capacityKwh: number;
    storedKwh: number | null;
    reserveSocPercent: number | null;
    reserveKwh: number | null;
    availableKwh: number | null;
    targetSocPercent: number | null;
    targetStoredKwh: number | null;
    gapKwh: number | null;
    powerKw: number | null;
    mode: 'manual' | 'auto' | 'unknown';
    automated: boolean;
    targetSource: 'controller' | 'planner' | null;
  };
  highTariff: ReturnType<typeof getUpcomingHighTariff> & {
    forecastStatus: EnergyForecast['status'];
    estimatedConsumptionKwh: number | null;
    estimatedProductionKwh: number | null;
    netDemandKwh: number | null;
    remainingConsumptionKwh: number | null;
    remainingProductionKwh: number | null;
    remainingNetDemandKwh: number | null;
    consumptionMethod: ConsumptionMethod | null;
  };
  assumptions: { coveragePercent: 100; chargePowerKw: 6; roundTripEfficiencyPercent: 95 };
}

function integrate<T extends Hour>(hours: T[], start: number, end: number, value: (hour: T) => number) {
  return hours.reduce((sum, hour) => sum + value(hour)
    * Math.max(0, Math.min(end, Date.parse(hour.end)) - Math.max(start, Date.parse(hour.start))) / (Date.parse(hour.end) - Date.parse(hour.start)), 0);
}

/** Stored energy needed through the afternoon deadline, including intervening discharge. */
function estimateChargeBreakdown(
  now: Date, deadline: Date, targetSocPercent: number, capacityKwh: number, storedKwh: number,
  projection: BatteryProjection,
): NonNullable<PlannerDetails['chargeBreakdown']> {
  const result = { start: now.toISOString(), end: deadline.toISOString(), storedKwh,
    gapKwh: null, consumptionKwh: null, solarKwh: null, gridKwh: null, unmetKwh: null };
  const points = projection.points;
  const first = points[0], last = points.at(-1);
  // A partial or passive trajectory cannot explain the automatic charging requirement.
  if (projection.status !== 'available' || projection.reason !== null || projection.assumption !== 'automatic_planning'
    || first?.at !== result.start || last?.at !== result.end) return result;
  const balance = projection.energyBalance;
  if (!balance || ![balance.solarKwh, balance.gridKwh, balance.consumptionKwh].every(nonnegative)) return result;
  let { solarKwh, gridKwh } = balance;
  const { consumptionKwh } = balance;
  const targetKwh = targetSocPercent / 100 * capacityKwh;
  const gapKwh = Math.max(0, targetKwh - storedKwh + consumptionKwh);
  // Do not attribute energy left above the goal to the requirement. Exclude excess
  // solar first so later sunshine never promises a reduction in earlier grid charging.
  const excess = Math.max(0, solarKwh + gridKwh - gapKwh);
  const excludedSolar = Math.min(solarKwh, excess);
  solarKwh -= excludedSolar;
  gridKwh = Math.max(0, gridKwh - (excess - excludedSolar));
  return { ...result, gapKwh, consumptionKwh, solarKwh, gridKwh,
    unmetKwh: Math.max(0, gapKwh - solarKwh - gridKwh) };
}

/** Fresh measured battery state and confirmed control; no forecast or projection work. */
export function buildPlannerBattery(
  now: Date, telemetry: Telemetry, control: AutomationControllerState & { automated?: boolean },
  automation: AutomationStatus, config: AutomationConfig,
): PlannerDetails['battery'] {
  const time = now.getTime();
  const observedAt = typeof telemetry.observedAt === 'string' ? Date.parse(telemetry.observedAt) : NaN;
  const fresh = telemetry.status === 'online' && finite(observedAt) && time - observedAt <= 30_000 && observedAt - time <= 5000;
  const socPercent = fresh && validSoc(telemetry.batterySocPercent) ? telemetry.batterySocPercent : null;
  const storedKwh = socPercent === null ? null : socPercent / 100 * config.socCapacityKwh;
  const unexpired = control.expiresAt === undefined || control.expiresAt === null
    || (finite(Date.parse(control.expiresAt)) && Date.parse(control.expiresAt) > time);
  const confirmed = control.available && !control.error && control.mode !== 'unknown' && unexpired;
  const reserveSocPercent = confirmed && validSoc(control.limits.reserveSocPercent)
    ? Math.max(policy.homeBatteryReserveSocPercent, control.limits.reserveSocPercent, config.reserveSocPercent) : null;
  const reserveKwh = reserveSocPercent === null ? null : reserveSocPercent / 100 * config.socCapacityKwh;
  const powerKw = confirmed && control.mode === 'manual' && finite(control.powerKw) ? control.powerKw : null;
  const automated = confirmed && control.automated === true;
  const controllerTarget = confirmed && control.mode === 'manual' && powerKw !== null && powerKw > 0
    && validSoc(control.targetSocPercent) ? control.targetSocPercent : null;
  const plannerTarget = config.enabled && automation.enabled && !['disabled', 'manual_override'].includes(automation.status)
    && (control.mode !== 'manual' || automated) && validSoc(automation.targetSocPercent) ? automation.targetSocPercent : null;
  const targetSocPercent = controllerTarget ?? plannerTarget;
  const targetStoredKwh = targetSocPercent === null ? null : targetSocPercent / 100 * config.socCapacityKwh;
  const gapKwh = targetStoredKwh === null || storedKwh === null ? null : Math.max(0, targetStoredKwh - storedKwh);
  return {
    socPercent, capacityKwh: config.socCapacityKwh, storedKwh, reserveSocPercent, reserveKwh,
    availableKwh: storedKwh === null || reserveKwh === null ? null : Math.max(0, storedKwh - reserveKwh),
    targetSocPercent, targetStoredKwh,
    gapKwh,
    powerKw, mode: confirmed ? control.mode : 'unknown', automated,
    targetSource: controllerTarget !== null ? 'controller' : plannerTarget !== null ? 'planner' : null,
  };
}

/** Explanatory data only: never starts the automation runner or issues controller commands. */
export function buildPlannerDetails(
  now: Date, telemetry: Telemetry, control: AutomationControllerState & { automated?: boolean },
  automation: AutomationStatus, forecast: EnergyForecast, config: AutomationConfig,
  upcomingForecasts: EnergyForecast[] = [forecast],
  previewNextWindow = false,
): PlannerDetails {
  const time = now.getTime();
  const period = getUpcomingHighTariff(now);
  const battery = buildPlannerBattery(now, telemetry, control, automation, config);
  const { storedKwh, reserveSocPercent, automated } = battery;
  const confirmed = battery.mode !== 'unknown';
  const schedule = getSchedule(now);
  // Prepare the next period with this batch's inputs, even while charging is open.
  // The projection still starts now and includes the remainder of the active window.
  const charging = previewNextWindow && schedule.charging.allowed
    ? getSchedule(new Date(schedule.charging.nextWindow.end)).charging : schedule.charging;
  let upcomingPlan: PlannerDetails['upcomingPlan'] = null;
  if (!charging.allowed && confirmed && config.enabled && automation.enabled
    && !['disabled', 'manual_override'].includes(automation.status) && (control.mode !== 'manual' || automated)) {
    const { start, end } = charging.nextWindow;
    const planningAt = new Date(start);
    const projection = projectBatterySoc(now, telemetry, control, automation, upcomingForecasts, config, planningAt);
    const estimatedSocPercent = projection.points.find(point => point.at === start)?.socPercent ?? null;
    const forecastDate = getLocalDate(new Date(end));
    const upcomingForecast = upcomingForecasts.find(data => data.date === forecastDate) ?? forecast;
    const offset = planningAt.getTime() - time;
    // Shift the simulation clock and input timestamps together, preserving their real
    // age: missing/future forecasts and stale telemetry still fail the planner's checks.
    const shift = (value: string | null) => value !== null && finite(Date.parse(value))
      ? new Date(Date.parse(value) + offset).toISOString() : value;
    const plan = planBatteryCharge(planningAt,
      { ...telemetry, observedAt: shift(telemetry.observedAt), batterySocPercent: estimatedSocPercent },
      { ...upcomingForecast, fetchedAt: shift(upcomingForecast.fetchedAt) },
      { ...config, reserveSocPercent: reserveSocPercent ?? config.reserveSocPercent },
      { ...control.limits, revertTimeoutSeconds: control.revertTimeoutSeconds });
    upcomingPlan = { start, end, estimatedSocPercent, estimatedCompletionAt: null, plan: estimatedSocPercent === null
      ? { ...plan, reason: projection.reason ?? 'soc_unavailable' } : plan };
  }
  const displayedPlan = upcomingPlan?.plan ?? automation.plan;
  const afternoonAt = Date.parse(displayedPlan?.afternoonTargetAt ?? '');
  let afternoonEstimate: PlannerDetails['afternoonEstimate'] = null;
  let chargeBreakdown: PlannerDetails['chargeBreakdown'] = null;
  if (finite(afternoonAt) && afternoonAt >= time && validSoc(displayedPlan?.afternoonTargetSocPercent)) {
    const deadline = new Date(afternoonAt);
    const projection = projectBatterySoc(now, telemetry, control, automation, upcomingForecasts, config, deadline);
    afternoonEstimate = { at: deadline.toISOString(),
      socPercent: projection.points.find(point => Date.parse(point.at) === afternoonAt)?.socPercent ?? null };
    if (upcomingPlan?.plan.action === 'charge' && validSoc(upcomingPlan.plan.targetSocPercent)
      && projection.status === 'available' && projection.assumption === 'automatic_planning') {
      const start = Date.parse(upcomingPlan.start), end = Date.parse(upcomingPlan.end);
      const target = upcomingPlan.plan.targetSocPercent;
      // Reuse the chronological trajectory (power limits, car allocation and losses).
      // Its first point reaching the command's SOC tolerance gives a five-minute estimate.
      upcomingPlan.estimatedCompletionAt = projection.points.find(point => Date.parse(point.at) >= start
        && Date.parse(point.at) <= end && point.socPercent >= target - .02)?.at ?? null;
    }
    if (confirmed && storedKwh !== null && config.enabled && automation.enabled
      && !['disabled', 'manual_override'].includes(automation.status) && (control.mode !== 'manual' || automated)) {
      chargeBreakdown = estimateChargeBreakdown(now, deadline, displayedPlan!.afternoonTargetSocPercent!,
        config.socCapacityKwh, storedKwh, projection);
    }
  }
  const sameDate = forecast.date === period.date;
  const weatherAvailable = sameDate && hasUsableForecast(forecast, time);
  const forecastStatus = sameDate && (weatherAvailable || ['offline', 'not_configured'].includes(forecast.status))
    ? forecast.status : 'offline';
  const consumption = forecast.consumption;
  const consumptionProfile = consumption ? consumptionIntervals(consumption) : null;
  // Household baseline consumption is independent of weather availability.
  const consumptionAvailable = sameDate && consumption?.date === period.date && consumption.excludesCar === true
    && consumption.source === 'configured_baseline'
    && consumptionProfile !== null;
  const production = weatherAvailable ? solarIntervals(forecast) : null;
  const solarAvailable = production !== null;
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  const remainingStart = Math.max(start, time);
  const carDemand = carEnergyBetween(forecast, start, end);
  const remainingCarDemand = carEnergyBetween(forecast, remainingStart, end);
  const estimatedConsumptionKwh = consumptionAvailable && carDemand !== null
    ? integrate(consumptionProfile!, start, end, hour => hour.estimatedConsumptionKwh) + carDemand : null;
  const remainingConsumptionKwh = consumptionAvailable && remainingCarDemand !== null
    ? integrate(consumptionProfile!, remainingStart, end, hour => hour.estimatedConsumptionKwh) + remainingCarDemand : null;
  const estimatedProductionKwh = solarAvailable
    ? integrate(production!, start, end, hour => hour.estimatedProductionKwh) : null;
  const remainingProductionKwh = solarAvailable
    ? integrate(production!, remainingStart, end, hour => hour.estimatedProductionKwh) : null;
  const net = (demand: number | null, solar: number | null) => demand === null || solar === null ? null : Math.max(0, demand - solar);
  const consumptionMethod = consumptionAvailable && consumption.hourlyMethod === 'baseline_only'
    ? consumption.hourlyMethod : null;
  return {
    calculation: { charging, plan: automation.plan ? { ...automation.plan } : null },
    upcomingPlan,
    afternoonEstimate,
    chargeBreakdown,
    battery,
    highTariff: {
      ...period, forecastStatus, estimatedConsumptionKwh, estimatedProductionKwh,
      netDemandKwh: net(estimatedConsumptionKwh, estimatedProductionKwh),
      remainingConsumptionKwh, remainingProductionKwh, remainingNetDemandKwh: net(remainingConsumptionKwh, remainingProductionKwh),
      consumptionMethod,
    },
    assumptions: { coveragePercent: 100, chargePowerKw: 6, roundTripEfficiencyPercent: policy.storageRoundTripEfficiency * 100 as 95 },
  };
}
