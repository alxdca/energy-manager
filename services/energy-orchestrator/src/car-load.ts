import { forecastDayOffsets } from './forecast-horizon.js';
import { solarIntervals } from './solar-intervals.js';
import type { SolarForecast } from './forecast.js';
import { consumptionIntervals, type ConsumptionForecast } from './consumption.js';
import type { CarChargingForecast } from './car-types.js';
import { getCalendarDayBounds, getLocalDate, getSchedule, policy } from './policy.js';

const hourMs = 3_600_000;
type CarInput = { date: string; carCharging?: CarChargingForecast; carChargingContext?: CarChargingForecast[] };
type EnergyInput = CarInput & Pick<SolarForecast, 'hourly' | 'quarterHourly' | 'estimatedProductionKwh'> & {
  consumption: Pick<ConsumptionForecast, 'date' | 'hourly' | 'quarterHourly' | 'estimatedConsumptionKwh'>;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return finite(time) && new Date(time).toISOString() === value ? time : null;
}

/** A separate AC load channel; household forecasts and recorded consumption stay untouched. */
export function validCarCharging(value: CarChargingForecast): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !['inactive', 'available', 'unavailable'].includes(value.status)
    || !Array.isArray(value.slots)) return false;
  const day = new Date(`${value.date}T00:00:00Z`);
  if (!finite(day.getTime()) || day.toISOString().slice(0, 10) !== value.date) return false;
  if (value.status !== 'available') return value.slots.length === 0;
  const calculated = timestamp(value.calculatedAt), observed = timestamp(value.socObservedAt);
  if (calculated === null || observed === null || calculated - observed > 600_000 || observed - calculated > 5000) return false;
  const bounds = getCalendarDayBounds(day);
  let previousEnd = bounds.start.getTime();
  return value.slots.every(slot => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
    const start = timestamp(slot.start), end = timestamp(slot.end);
    if (start === null || end === null || start < previousEnd || end <= start || end > bounds.end.getTime()
      || !finite(slot.powerKw) || slot.powerKw <= 0 || !finite(slot.energyKwh) || slot.energyKwh <= 0
      || Math.abs(slot.energyKwh - slot.powerKw * (end - start) / hourMs) > 1e-6
      || !['grid', 'solar'].includes(slot.source) || typeof slot.required !== 'boolean'
      || typeof slot.batteryChargeAllowed !== 'boolean') return false;
    if (slot.batterySupply !== undefined && (!slot.batterySupply || typeof slot.batterySupply !== 'object'
      || slot.batteryChargeAllowed || !finite(slot.batterySupply.minimumSocPercent)
      || slot.batterySupply.minimumSocPercent < policy.homeBatteryReserveSocPercent || slot.batterySupply.minimumSocPercent >= 100
      || !finite(slot.batterySupply.maxDischargeKw) || slot.batterySupply.maxDischargeKw <= 0
      || slot.batterySupply.maxDischargeKw > policy.batteryPowerLimitKw)) return false;
    if (slot.source === 'grid') {
      const schedule = getSchedule(new Date(start)).charging;
      if (!schedule.allowed || Date.parse(schedule.nextWindow.end) < end) return false;
    }
    if (slot.batterySupply) {
      const schedule = getSchedule(new Date(start)).charging;
      if (!schedule.allowed || schedule.currentWindow !== 'night' || Date.parse(schedule.nextWindow.end) < end) return false;
    }
    previousEnd = end;
    return true;
  });
}

function channels(input: CarInput): Map<string, CarChargingForecast> | null {
  const values = input.carChargingContext ?? [];
  if (!Array.isArray(values) || values.length > forecastDayOffsets.length) return null;
  const result = new Map<string, CarChargingForecast>();
  for (const value of values) {
    if (!validCarCharging(value) || result.has(value.date)) return null;
    result.set(value.date, value);
  }
  if (input.carCharging) {
    if (input.carCharging.date !== input.date || !validCarCharging(input.carCharging)) return null;
    const existing = result.get(input.date);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input.carCharging)) return null;
    result.set(input.date, input.carCharging);
  }
  return result;
}

export function validCarLoad(input: CarInput): boolean {
  return channels(input) !== null;
}

/** Split at day/slot edges so a short EV session is not smeared over a whole hour. */
export function carLoadBoundaries(input: CarInput, start: number, end: number): number[] | null {
  const map = channels(input);
  if (!map || !finite(start) || !finite(end) || end < start) return null;
  const boundaries = new Set([start, end]);
  for (let cursor = start; cursor < end;) {
    const date = getLocalDate(new Date(cursor));
    const dayEnd = getCalendarDayBounds(new Date(`${date}T00:00:00Z`)).end.getTime();
    const until = Math.min(end, dayEnd);
    if (until <= cursor) return null;
    boundaries.add(until);
    const value = map.get(date);
    if (value?.status === 'unavailable') return null;
    // A supplied active context must cover each date whose capacity is used.
    if (!value && map.size > 0 && [...map.values()].some(channel => channel.status !== 'inactive')) return null;
    for (const slot of value?.slots ?? []) {
      const a = Date.parse(slot.start), b = Date.parse(slot.end);
      if (a > cursor && a < until) boundaries.add(a);
      if (b > cursor && b < until) boundaries.add(b);
    }
    cursor = until;
  }
  return [...boundaries].sort((a, b) => a - b);
}

export function carEnergyBetween(input: CarInput, start: number, end: number): number | null {
  if (!carLoadBoundaries(input, start, end)) return null;
  const map = channels(input)!;
  let energy = 0;
  for (const value of map.values()) for (const slot of value.slots) {
    energy += slot.powerKw * Math.max(0, Math.min(end, Date.parse(slot.end)) - Math.max(start, Date.parse(slot.start))) / hourMs;
  }
  return energy;
}

export function carAllowsBatteryCharge(input: CarInput, start: number, end: number): boolean | null {
  if (!carLoadBoundaries(input, start, end)) return null;
  for (const value of channels(input)!.values()) for (const slot of value.slots) {
    if (!slot.batteryChargeAllowed && Date.parse(slot.start) < end && Date.parse(slot.end) > start) return false;
  }
  return true;
}

/** Undefined means no supply window; null means its allocation cannot be established. */
export function carBatterySupply(input: CarInput, start: number, end: number): { minimumSocPercent: number; maxDischargeKw: number } | null | undefined {
  if (!carLoadBoundaries(input, start, end)) return null;
  let supply: { minimumSocPercent: number; maxDischargeKw: number } | undefined;
  for (const value of channels(input)!.values()) for (const slot of value.slots) {
    if (slot.batterySupply && Date.parse(slot.start) < end && Date.parse(slot.end) > start) {
      supply = supply ? { minimumSocPercent: Math.max(supply.minimumSocPercent, slot.batterySupply.minimumSocPercent),
        maxDischargeKw: Math.min(supply.maxDischargeKw, slot.batterySupply.maxDischargeKw) } : { ...slot.batterySupply };
    }
  }
  return supply;
}

export function forecastLoadSegments(input: EnergyInput, start: number, end: number) {
  if (!finite(start) || !finite(end)) return null;
  const result: Array<{ start: number; end: number; hours: number; loadKwh: number; solarKwh: number; batteryChargeAllowed: boolean;
    batterySupply?: { minimumSocPercent: number; maxDischargeKw: number } }> = [];
  const production = solarIntervals(input);
  const consumption = consumptionIntervals(input.consumption);
  if (!production || !consumption || input.consumption.date !== input.date) return null;
  let solarIndex = 0, loadIndex = 0;
  let from = Math.max(start, Date.parse(production[0].start));
  const until = Math.min(end, Date.parse(production.at(-1)!.end));
  while (from < until) {
    while (Date.parse(production[solarIndex].end) <= from) solarIndex++;
    while (Date.parse(consumption[loadIndex].end) <= from) loadIndex++;
    const solar = production[solarIndex], load = consumption[loadIndex];
    const solarHours = (Date.parse(solar.end) - Date.parse(solar.start)) / hourMs;
    const loadHours = (Date.parse(load.end) - Date.parse(load.start)) / hourMs;
    const intervalEnd = Math.min(until, Date.parse(solar.end), Date.parse(load.end));
    const boundaries = carLoadBoundaries(input, from, intervalEnd);
    if (!boundaries) return null;
    for (let part = 0; part < boundaries.length - 1; part++) {
      const a = boundaries[part], b = boundaries[part + 1], hours = (b - a) / hourMs;
      const carKwh = carEnergyBetween(input, a, b), allowed = carAllowsBatteryCharge(input, a, b);
      const batterySupply = carBatterySupply(input, a, b);
      if (carKwh === null || allowed === null || batterySupply === null) return null;
      result.push({ start: a, end: b, hours, loadKwh: load.estimatedConsumptionKwh * hours / loadHours + carKwh,
        solarKwh: solar.estimatedProductionKwh * hours / solarHours, batteryChargeAllowed: allowed,
        ...(batterySupply ? { batterySupply } : {}) });
    }
    from = intervalEnd;
  }
  return result;
}
