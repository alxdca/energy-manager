import { getCalendarDayBounds, getCarTarget, getLocalDate, getNightTariffEnd, getSchedule, policy, timeZone } from './policy.js';
import type { CarChargingSlot, CarPlan, CarPlanInput, CarTargetOverride, SolarBatterySupport } from './car-types.js';

const hour = 3_600_000;
const energyTolerance = 0.000004; // Less than one millisecond at nominal11.04kW.
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const percent = (value: unknown): value is number => nonnegative(value) && value <= 100;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (time: number) => new Date(time).toISOString();
const canonical = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
const localHour = new Intl.DateTimeFormat('en', { timeZone, hour: '2-digit', hourCycle: 'h23' });
const fresh = (observed: string | null, now: number, maxAge: number) => {
  const at = observed === null ? NaN : Date.parse(observed);
  if (typeof observed !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(observed)) return false;
  const [year, month, day] = observed.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
    && Number.isFinite(at) && at <= now + 5000 && now - at <= maxAge;
};

export function getCarForceWindow(now: Date): 'night' | 'afternoon' | null {
  const charging = getSchedule(now).charging;
  return charging.allowed ? charging.currentWindow : null;
}

export function validateCarTargetOverride(value: unknown, now: Date): CarTargetOverride | null {
  if (value === null) return null;
  const target = getCarTarget(now);
  if (!object(value) || Object.keys(value).length !== 2 || !canonical(value.deadline)
    || Date.parse(value.deadline) <= now.getTime() || Date.parse(value.deadline) > Date.parse(target.deadline)
    || getLocalDate(new Date(value.deadline)) !== target.date || !percent(value.targetSocPercent)
    || value.targetSocPercent < target.minimumSocPercent) throw new Error('Choisissez un objectif au moins égal au minimum du prochain matin et un départ futur au plus tard à 06:55.');
  return { deadline: value.deadline, targetSocPercent: value.targetSocPercent };
}

function targetFor(input: CarPlanInput): { target: CarPlan['target']; invalidOverride: boolean } {
  const hourInZurich = Number(localHour.format(input.now));
  if (hourInZurich >= 12 && hourInZurich < 17) {
    const date = getLocalDate(input.now);
    // Fourteen elapsed hours after local midnight is always in the afternoon
    // window, including the23/25-hour daylight-saving transition days.
    const probe = new Date(+getCalendarDayBounds(new Date(`${date}T00:00:00.000Z`)).start + 14 * hour);
    const end = getSchedule(probe).charging.nextWindow.end;
    return { target: { date, minimumSocPercent: 30, deadline: end, gridChargingEndsAt: end, kind: 'afternoon' }, invalidOverride: false };
  }
  const morning = getCarTarget(input.now);
  let target: CarPlan['target'] = { date: morning.date, minimumSocPercent: morning.minimumSocPercent,
    deadline: morning.deadline, gridChargingEndsAt: morning.gridChargingEndsAt, kind: 'morning' };
  let invalidOverride = false;
  if (input.override) {
    const override = input.override;
    if (canonical(override.deadline) && getLocalDate(new Date(override.deadline)) === target.date
      && Date.parse(override.deadline) <= Date.parse(target.deadline) && percent(override.targetSocPercent)
      && override.targetSocPercent >= target.minimumSocPercent) {
      target = { ...target, minimumSocPercent: override.targetSocPercent, deadline: override.deadline,
        gridChargingEndsAt: iso(Math.min(Date.parse(target.gridChargingEndsAt), Date.parse(override.deadline))) };
    } else if (!canonical(override.deadline) || Date.parse(override.deadline) > input.now.getTime()) invalidOverride = true;
  }
  return { target, invalidOverride };
}

function boundedSupport(input: CarPlanInput, actualCarKw: number): SolarBatterySupport | undefined {
  if (getNightTariffEnd(input.now) === null) return undefined;
  const support = input.battery.solarSupport;
  if (!support || !support.available || !nonnegative(support.solarStoredKwh) || !nonnegative(support.protectedStoredKwh)
    || !nonnegative(support.usableStoredKwh) || support.usableStoredKwh > support.solarStoredKwh
    || !percent(support.minimumSocPercent) || support.minimumSocPercent >= 100
    || !percent(input.battery.socPercent) || input.battery.socPercent <= support.minimumSocPercent
    || !nonnegative(support.maxDischargeKw)) {
    return { available: false, solarStoredKwh: support && nonnegative(support.solarStoredKwh) ? support.solarStoredKwh : null,
      protectedStoredKwh: support && nonnegative(support.protectedStoredKwh) ? support.protectedStoredKwh : null,
      usableStoredKwh: 0, minimumSocPercent: null, maxDischargeKw: 0 };
  }
  const capacity = input.battery.capacityKwh ?? policy.homeBatteryCapacityKwh;
  const stored = input.battery.socPercent / 100 * capacity;
  const aboveFloor = (input.battery.socPercent - support.minimumSocPercent) / 100 * capacity;
  return { ...support, usableStoredKwh: Math.max(0, Math.min(support.usableStoredKwh, aboveFloor, stored - support.protectedStoredKwh)),
    maxDischargeKw: Math.min(support.maxDischargeKw, actualCarKw, policy.batteryPowerLimitKw) };
}

function addSlot(slots: CarChargingSlot[], start: number, end: number, amps: number, remaining: number,
  batteryChargeAllowed: boolean): number {
  const powerKw = amps * 3 * .230;
  if (remaining <= energyTolerance || powerKw <= 0 || end <= start) return 0;
  const finish = Math.min(end, Math.floor(start + remaining / powerKw * hour));
  if (finish <= start) return 0;
  const energyKwh = (finish - start) / hour * powerKw;
  slots.push({ start: iso(start), end: iso(finish), powerKw, energyKwh, source: 'grid', required: true, batteryChargeAllowed });
  return energyKwh;
}

/** Pure policy: forced minima in their windows, otherwise nativeEco. */
export function planCarCharge(input: CarPlanInput): CarPlan {
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error('Date de planification voiture invalide.');
  const { target, invalidOverride } = targetFor(input);
  const { config, car, charger, telemetry, battery } = input;
  const plan: CarPlan = { status: 'available', action: 'eco', reason: 'eco_default', calculatedAt: iso(now), target,
    socPercent: null, observedAt: null, requiredStoredKwh: null, requiredAcKwh: null,
    solarKwh: null, gridKwh: null, unmetKwh: null, estimatedCompletionAt: null, feasible: null,
    currentAmps: null, phases: null, source: 'eco', requiresBatteryHold: false, allowBatteryCharge: true,
    windowEndsAt: getNightTariffEnd(input.now) ?? iso(now + 120_000), slots: [] };
  const block = (reason: string) => ({ ...plan, status: 'blocked' as const, action: 'pause' as const, source: null, reason });
  const batteryCapacity = battery.capacityKwh ?? policy.homeBatteryCapacityKwh;
  if (!finite(config.capacityKwh) || config.capacityKwh <= 0 || !finite(config.chargingEfficiency) || config.chargingEfficiency <= 0
    || config.chargingEfficiency > 1 || !Number.isInteger(config.maxCurrentAmps) || config.maxCurrentAmps < 6 || config.maxCurrentAmps > 16
    || !finite(config.socFreshnessMs) || config.socFreshnessMs <= 0 || config.socFreshnessMs > 600_000
    || !finite(batteryCapacity) || batteryCapacity <= 0) return block('config_invalid');
  if (charger.status !== 'online' || !charger.ready || !charger.connected || charger.stale || !charger.controlEnabled
    || !fresh(charger.observedAt, now, 30_000)) return block('charger_unavailable');
  const knownCurrentLimit = Number.isInteger(charger.limits.maxCurrentAmps) && charger.limits.maxCurrentAmps! >= 6;
  const validObservedCurrent = Number.isInteger(charger.currentAmps) && charger.currentAmps! >= 6 && charger.currentAmps! <= 32;
  if (!knownCurrentLimit && charger.limits.maxCurrentAmps !== null) return block('current_limits_unavailable');
  if (!knownCurrentLimit && (!validObservedCurrent || charger.currentAmps! > config.maxCurrentAmps)) return block('current_limits_unavailable');
  const maximum = Math.min(config.maxCurrentAmps, knownCurrentLimit ? charger.limits.maxCurrentAmps! : config.maxCurrentAmps, 16);
  const observedAmps = validObservedCurrent ? charger.currentAmps! : 6;
  let ecoAmps = Math.min(observedAmps, maximum);
  const validSite = telemetry.status === 'online' && fresh(telemetry.observedAt, now, 10_000)
    && [telemetry.householdKw, telemetry.batteryChargeKw].every(nonnegative);
  const synchronized = validSite && fresh(charger.powerObservedAt, now, 30_000)
    && Math.abs(Date.parse(charger.powerObservedAt!) - Date.parse(telemetry.observedAt!)) <= 3000;
  const actualCarKw = synchronized && nonnegative(charger.powerWatts) ? charger.powerWatts / 1000 : 0;
  const support = boundedSupport(input, actualCarKw);
  if (support) plan.batterySupport = support;
  const supplying = Boolean(support?.available && support.usableStoredKwh > energyTolerance
    && support.minimumSocPercent !== null && support.maxDischargeKw > 0);
  plan.allowBatteryCharge = !supplying;
  const ampsFor = (availableKw: number) => {
    const amps = Math.min(maximum, Math.floor((availableKw + 1e-8) / (3 * .253)));
    return amps >= 6 ? amps : 0;
  };
  const baseHouseholdKw = validSite ? Math.max(0, telemetry.householdKw! - actualCarKw) : null;
  let ecoGridBlocked = false;
  if (charger.carConnected !== false) {
    if (!validSite) return block('site_unavailable');
    const reservedBatteryKw = supplying ? 0 : Math.max(battery.requestedPowerKw,
      telemetry.batteryChargeKw! + (nonnegative(battery.pendingChargeKw) ? battery.pendingChargeKw : 0));
    ecoAmps = Math.min(ecoAmps, ampsFor(policy.totalConsumptionLimitKw - baseHouseholdKw! - reservedBatteryKw));
    if (!knownCurrentLimit && ecoAmps !== observedAmps) return block('current_limits_unavailable');
    ecoGridBlocked = ecoAmps < 6;
  }
  plan.currentAmps = ecoGridBlocked ? null : ecoAmps;
  const eco = () => ecoGridBlocked ? block('grid_limit') : plan;
  const measured = car.status === 'online' && percent(car.socPercent) && fresh(car.observedAt, now, config.socFreshnessMs);
  if (measured) {
    plan.socPercent = car.socPercent; plan.observedAt = car.observedAt;
    plan.requiredStoredKwh = Math.max(0, target.minimumSocPercent - car.socPercent!) / 100 * config.capacityKwh;
    plan.requiredAcKwh = plan.requiredStoredKwh / config.chargingEfficiency;
    if (plan.requiredAcKwh <= energyTolerance) {
      plan.requiredAcKwh = 0; plan.requiredStoredKwh = 0; plan.unmetKwh = 0; plan.feasible = true;
      plan.estimatedCompletionAt = iso(now); plan.solarKwh = 0; plan.gridKwh = 0; plan.reason = 'eco_target_reached';
    }
  } else plan.reason = 'eco_soc_unavailable';
  if (charger.carConnected !== true) { plan.reason = charger.carConnected === false ? 'eco_car_unplugged' : 'eco_connection_unknown'; return eco(); }
  const window = getCarForceWindow(input.now);
  const forcing = window === 'night' && target.kind === 'morning' || window === 'afternoon' && target.kind === 'afternoon';
  if (!measured || !forcing || plan.requiredAcKwh! <= energyTolerance) return eco();
  if (invalidOverride) { plan.reason = 'target_override_invalid'; return eco(); }
  if (car.chargingState === 'Disconnected') { plan.reason = 'eco_tesla_disconnected'; return eco(); }
  if (!['Charging', 'Complete', 'Stopped', 'NoPower', 'Starting'].includes(car.chargingState ?? '')) { plan.reason = 'eco_soc_unavailable'; return eco(); }
  if (percent(car.chargeLimitPercent) && car.chargeLimitPercent < target.minimumSocPercent) {
    plan.reason = 'vehicle_charge_limit'; plan.feasible = false; plan.unmetKwh = plan.requiredAcKwh;
    return eco();
  }
  if (!knownCurrentLimit) { plan.reason = 'current_limits_unavailable'; return eco(); }
  if (!charger.phaseSwitchingSupported) { plan.reason = 'phase_control_unavailable'; return eco(); }
  const cutoff = Math.min(Date.parse(target.gridChargingEndsAt), Date.parse(getSchedule(input.now).charging.nextWindow.end));
  if (cutoff <= now) {
    plan.reason = 'eco_deadline_passed'; plan.feasible = false; plan.unmetKwh = plan.requiredAcKwh;
    return eco();
  }
  if (!battery.available || !battery.automatic) { plan.reason = 'battery_coordination_unavailable'; return eco(); }
  // Required car charging owns its full configured three-phase rate. Only the
  // home battery yields to changing household demand; never chase it with EV
  // setpoint changes, since those require a physical stop of the charger.
  const carReserveKw = maximum * 3 * .253;
  if (baseHouseholdKw! + carReserveKw > policy.totalConsumptionLimitKw) return block('grid_limit');
  plan.maxBatteryChargePowerKw = supplying ? 0
    : Math.max(0, Math.min(6, Math.floor((policy.totalConsumptionLimitKw - baseHouseholdKw! - carReserveKw) * 10 + 1e-8) / 10));
  let remaining = plan.requiredAcKwh!;
  remaining -= addSlot(plan.slots, now, cutoff, maximum, remaining, !supplying);
  if (!plan.slots.length) { plan.reason = 'grid_limit'; plan.feasible = false; plan.unmetKwh = remaining; return eco(); }
  if (supplying && support) {
    let solarAcLeft = support.usableStoredKwh * Math.sqrt(policy.storageRoundTripEfficiency);
    const supplied: CarChargingSlot[] = [];
    for (const slot of plan.slots) {
      const start = Date.parse(slot.start), end = Date.parse(slot.end);
      const cap = Math.min(support.maxDischargeKw, slot.powerKw);
      const supplyEnd = Math.min(end, Math.floor(start + solarAcLeft / cap * hour));
      if (supplyEnd > start && solarAcLeft > energyTolerance) {
        const used = cap * (supplyEnd - start) / hour;
        solarAcLeft -= used;
        supplied.push({ ...slot, end: iso(supplyEnd), energyKwh: slot.powerKw * (supplyEnd - start) / hour,
          batteryChargeAllowed: false, batterySupply: { minimumSocPercent: support.minimumSocPercent!, maxDischargeKw: cap } });
      }
      if (supplyEnd < end) supplied.push({ ...slot, start: iso(Math.max(start, supplyEnd)),
        energyKwh: slot.powerKw * (end - Math.max(start, supplyEnd)) / hour, batteryChargeAllowed: false });
    }
    plan.slots = supplied;
    plan.solarKwh = support.usableStoredKwh * Math.sqrt(policy.storageRoundTripEfficiency) - solarAcLeft;
  } else plan.solarKwh = 0;
  const first = plan.slots[0]!;
  const allocated = plan.slots.reduce((sum, slot) => sum + slot.energyKwh, 0);
  plan.gridKwh = Math.max(0, allocated - plan.solarKwh!);
  plan.action = 'charge'; plan.source = 'grid'; plan.phases = 3;
  plan.currentAmps = Math.round(first.powerKw / (3 * .230)); plan.windowEndsAt = iso(cutoff);
  plan.requiresBatteryHold = true; plan.allowBatteryCharge = first.batteryChargeAllowed;
  plan.feasible = remaining <= energyTolerance; plan.unmetKwh = plan.feasible ? 0 : Math.max(0, remaining);
  plan.estimatedCompletionAt = plan.feasible ? plan.slots[plan.slots.length - 1]!.end : null;
  plan.reason = !plan.feasible ? 'deadline_infeasible' : window === 'afternoon' ? 'afternoon_minimum'
    : supplying ? 'night_charge_solar_support' : 'night_minimum';
  return plan;
}
