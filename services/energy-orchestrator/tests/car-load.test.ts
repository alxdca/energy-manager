import test from 'node:test';
import assert from 'node:assert/strict';
import { carAllowsBatteryCharge, carBatterySupply, carEnergyBetween, forecastLoadSegments, validCarCharging, validCarLoad } from '../src/car-load.js';
import { nextNightHighTariffReserve, planBatteryCharge, type AutomationConfig, type EnergyForecast } from '../src/automation-plan.js';
import { projectBatterySoc } from '../src/battery-projection.js';
import { buildPlannerDetails } from '../src/planner-details.js';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast } from '../src/forecast.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { CarChargingForecast, CarChargingSlot } from '../src/car-types.js';
import type { AutomationControllerState, AutomationStatus } from '../src/automation.js';
import type { Telemetry } from '../src/status.js';

const at = new Date('2026-10-25T12:00:00.000Z');
const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5,
  energyBufferPercent: 0, minimumEnergyBufferKwh: 0, afternoonTargetSocPercent: 80 };
const controller: AutomationControllerState & { automated?: boolean } = { available: true, mode: 'auto',
  powerKw: null, targetSocPercent: null, limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 },
  revertTimeoutSeconds: 30, error: null };
const automation: AutomationStatus = { enabled: true, status: 'idle', lastEvaluatedAt: null,
  nextEvaluationAt: null, targetSocPercent: null, holdUntil: null, reason: 'awaiting_evaluation', plan: null, error: null };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const slot = (start: string, end: string, powerKw = 6, source: 'grid' | 'solar' = 'grid', batteryChargeAllowed = true): CarChargingSlot =>
  ({ start, end, powerKw, energyKwh: powerKw * (Date.parse(end) - Date.parse(start)) / 3_600_000,
    source, required: true, batteryChargeAllowed });
function channel(date: string, slots: CarChargingSlot[] = [], now = at): CarChargingForecast {
  return { status: 'available', date, calculatedAt: now.toISOString(), socObservedAt: now.toISOString(), slots };
}
function forecast(date = '2026-10-25', now = at, load = 1, solar = 0): EnergyForecast {
  const consumption = estimateConsumption(date, { baselinePowerW: load * 1000 });
  return { ...emptySolarForecast(date, null), status: 'online', fetchedAt: now.toISOString(), error: null,
    estimatedProductionKwh: solar * consumption.dayHours, consumption,
    quarterHourly: consumption.quarterHourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: solar / 4, temperatureC: null })),
    hourly: consumption.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: solar, temperatureC: null })) };
}
function telemetry(now = at, soc = 20): Telemetry {
  return { status: 'online', observedAt: now.toISOString(), error: null, solarKw: 0, householdKw: 1,
    gridImportKw: 1, gridExportKw: 0, batterySocPercent: soc, batteryChargeKw: 0, batteryDischargeKw: 0 };
}

test('car AC energy is prorated within exact slots without changing household totals', () => {
  const data = forecast();
  const house = structuredClone(data.consumption);
  data.carCharging = channel(data.date, [slot('2026-10-25T12:15:00.000Z', '2026-10-25T12:45:00.000Z')]);
  close(carEnergyBetween(data, Date.parse('2026-10-25T12:30:00Z'), Date.parse('2026-10-25T13:00:00Z'))!, 1.5);
  const segments = forecastLoadSegments(data, +at, +at + 3_600_000)!;
  assert.deepEqual(segments.map(value => value.hours), [.25, .25, .25, .25]);
  close(segments.reduce((sum, value) => sum + value.loadKwh, 0), 4);
  assert.equal(data.consumption.excludesCar, true);
  assert.deepEqual(data.consumption, house);
});

test('retained consumption quarters determine future demand without smearing earlier energy across the hour', () => {
  const now = new Date('2026-10-25T17:30:00.000Z');
  const data = forecast('2026-10-25', now);
  const house = data.consumption;
  house.hourly.find(hour => hour.start === '2026-10-25T17:00:00.000Z')!.estimatedConsumptionKwh = 2;
  house.estimatedConsumptionKwh++;
  house.quarterHourly = house.hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedConsumptionKwh: hour.start === '2026-10-25T17:00:00.000Z' ? [.1, .2, .8, .9][index] : .25,
  })));
  data.carCharging = channel(data.date, [slot('2026-10-25T17:42:00.000Z', '2026-10-25T17:48:00.000Z', 1, 'solar')], now);
  const end = new Date('2026-10-25T18:00:00.000Z');
  const segments = forecastLoadSegments(data, +now, +end)!;
  assert.deepEqual(segments.map(segment => new Date(segment.start).toISOString()), [
    now.toISOString(), '2026-10-25T17:42:00.000Z', '2026-10-25T17:45:00.000Z', '2026-10-25T17:48:00.000Z',
  ]);
  close(segments.reduce((sum, segment) => sum + segment.loadKwh, 0), 1.8);
  const result = projectBatterySoc(now, telemetry(now, 50), controller, automation, [data], config, end);
  assert.equal(result.status, 'available');
  close(result.energyBalance!.consumptionKwh, 1.8 / Math.sqrt(.95));
  close(result.points.at(-1)!.socPercent, 50 - 1.8 / Math.sqrt(.95) / 60 * 100);
  const details = buildPlannerDetails(now, telemetry(now, 50), controller, automation, data, config);
  close(details.highTariff.remainingConsumptionKwh!, 5.8);
});

test('malformed supplied consumption quarters block planning, load integration and battery projections', () => {
  const data = forecast();
  data.consumption.quarterHourly = [];
  assert.equal(forecastLoadSegments(data, +at, +at + 3_600_000), null);
  assert.equal(planBatteryCharge(at, telemetry(), data, config, controller.limits).action, 'blocked');
  assert.equal(projectBatterySoc(at, telemetry(), controller, automation, [data], config).status, 'unavailable');
  assert.equal(buildPlannerDetails(at, telemetry(), controller, automation, data, config).highTariff.estimatedConsumptionKwh, null);
});

test('inactive or legacy channels add no automatic commitment; unavailable is never zero', () => {
  const data = forecast();
  assert.equal(carEnergyBetween(data, +at, +at + 1000), 0);
  data.carCharging = { status: 'inactive', date: data.date, calculatedAt: null, socObservedAt: null, slots: [] };
  assert.equal(carEnergyBetween(data, +at, +at + 1000), 0);
  data.carCharging.status = 'unavailable';
  assert.equal(carEnergyBetween(data, +at, +at + 1000), null);
  const plan = planBatteryCharge(at, telemetry(), data, config, controller.limits);
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.reason, 'car_forecast_unavailable');
});

test('malformed, overlapping, duplicate-date and conflicting contexts fail closed', () => {
  const first = slot('2026-10-25T12:15:00.000Z', '2026-10-25T12:45:00.000Z');
  const good = channel('2026-10-25', [first]);
  for (const changed of [
    { slots: [{ ...first, energyKwh: 999 }] }, { slots: [{ ...first, powerKw: -1 }] },
    { slots: [first, first] }, { slots: [{ ...first, start: '2026-10-25T12:15:00Z' }] },
    { slots: [{ ...first, end: '2026-10-24T12:45:00.000Z' }] },
    { slots: [slot('2026-10-25T06:00:00.000Z', '2026-10-25T11:30:00.000Z')] },
    { socObservedAt: '2026-10-25T11:00:00.000Z' },
  ]) assert.equal(validCarCharging({ ...good, ...changed }), false);
  const data = forecast(); data.carCharging = good;
  data.carChargingContext = [good, structuredClone(good)];
  assert.equal(validCarLoad(data), false);
  data.carChargingContext = [channel(data.date, [])];
  assert.equal(validCarLoad(data), false);
  data.carChargingContext = [structuredClone(good)];
  assert.equal(validCarLoad(data), true);
  close(carEnergyBetween(data, +at, +at + 3_600_000)!, 3);
});

test('car energy respects actual Zurich spring and fall elapsed charging hours', () => {
  for (const [date, cutoff, hours] of [
    ['2026-03-29', '2026-03-29T04:55:00.000Z', 5 + 55 / 60],
    ['2026-10-25', '2026-10-25T05:55:00.000Z', 7 + 55 / 60],
  ] as const) {
    const bounds = getCalendarDayBounds(new Date(date + 'T00:00:00Z'));
    const data = forecast(date);
    data.carCharging = channel(date, [slot(bounds.start.toISOString(), cutoff, 3)]);
    close(carEnergyBetween(data, +bounds.start, Date.parse(cutoff))!, hours * 3);
  }
});

test('cross-midnight contexts reserve pre-midnight and next-day battery hold time', () => {
  const now = new Date('2026-01-14T22:05:00.000Z');
  const data = forecast('2026-01-15', now, 0);
  const baseline = planBatteryCharge(now, telemetry(now, 10), data, config, controller.limits);
  const today = channel('2026-01-14', [slot(now.toISOString(), '2026-01-14T23:00:00.000Z', 6, 'grid', false)], now);
  const tomorrow = channel(data.date, [slot('2026-01-14T23:00:00.000Z', '2026-01-15T05:55:00.000Z', 6, 'grid', false)], now);
  data.carCharging = tomorrow; data.carChargingContext = [today, tomorrow];
  const result = planBatteryCharge(now, telemetry(now, 10), data, config, controller.limits);
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'car_priority');
  assert.ok(result.unmetKwh > baseline.unmetKwh + 10);
  assert.equal(carAllowsBatteryCharge(data, +now, Date.parse('2026-01-14T22:10:00Z')), false);
});

test('projection holds at exact car slot edges and resumes without draining storage into the car', () => {
  const now = new Date('2026-10-25T12:07:00.000Z');
  const data = forecast('2026-10-25', now, 0);
  data.carCharging = channel(data.date, [slot('2026-10-25T12:08:00.000Z', '2026-10-25T12:18:00.000Z', 3, 'grid', false)], now);
  const owned = { ...controller, mode: 'manual' as const, automated: true, automationOwner: 'owner',
    automationMode: 'charge' as const, powerKw: 6, targetSocPercent: 80 };
  const result = projectBatterySoc(now, telemetry(now, 10), owned, { ...automation, nextEvaluationAt: '2026-10-25T12:15:00Z' },
    [data], config, new Date('2026-10-25T12:20:00Z'));
  assert.equal(result.status, 'available');
  const atPoint = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  close(atPoint('2026-10-25T12:08:00.000Z'), 10 + 6 * Math.sqrt(.95) / 60 / 60 * 100);
  close(atPoint('2026-10-25T12:18:00.000Z'), atPoint('2026-10-25T12:08:00.000Z'));
  assert.ok(atPoint('2026-10-25T12:20:00.000Z') > atPoint('2026-10-25T12:18:00.000Z'));
  close(result.energyBalance!.consumptionKwh, 0);
});

test('solar car demand reduces surplus for storage and is shown once in planner demand', () => {
  const now = new Date('2026-10-24T15:05:00.000Z');
  const data = forecast('2026-10-24', now, 1, 3);
  const baseline = projectBatterySoc(now, telemetry(now, 50), controller, automation, [data], config, new Date(+now + 300_000));
  data.carCharging = channel(data.date, [slot(now.toISOString(), new Date(+now + 300_000).toISOString(), 1, 'solar')], now);
  const result = projectBatterySoc(now, telemetry(now, 50), controller, automation, [data], config, new Date(+now + 300_000));
  close(baseline.energyBalance!.solarKwh - result.energyBalance!.solarKwh, Math.sqrt(.95) / 12);
  const details = buildPlannerDetails(now, telemetry(now, 50), controller, automation, data, config);
  close(details.highTariff.estimatedConsumptionKwh!, 6 + 1 / 12);
  assert.equal(data.consumption.estimatedConsumptionKwh, 24);
});

test('an unavailable following-day car allocation retains only the known projection prefix', () => {
  const now = new Date('2026-10-25T22:55:00.000Z');
  const today = forecast('2026-10-25', now, 0), tomorrow = forecast('2026-10-26', now, 0);
  today.carCharging = { status: 'inactive', date: today.date, calculatedAt: null, socObservedAt: null, slots: [] };
  tomorrow.carCharging = { status: 'unavailable', date: tomorrow.date, calculatedAt: null, socObservedAt: null, slots: [] };
  const result = projectBatterySoc(now, telemetry(now, 50), { ...controller, mode: 'manual', automated: true,
    automationOwner: 'owner', automationMode: 'hold', powerKw: 0 }, { ...automation, nextEvaluationAt: '2026-10-25T23:00:00.000Z' },
  [today, tomorrow], config);
  assert.equal(result.status, 'available');
  assert.equal(result.reason, 'car_forecast_unavailable');
  assert.equal(result.points.at(-1)!.at, '2026-10-25T23:00:00.000Z');
});

test('next-morning protection includes household requirement, installed reserve and buffer, not afternoon80 or car energy', () => {
  const now = new Date('2026-10-25T20:00:00.000Z');
  const data = forecast('2026-10-26', now, 1);
  const limits = { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: 5 };
  close(nextNightHighTariffReserve(now, data, config, limits)!, 3 + 5 / Math.sqrt(.95));
  close(nextNightHighTariffReserve(now, data, { ...config, afternoonTargetSocPercent: 0 }, limits)!, 3 + 5 / Math.sqrt(.95));
  close(nextNightHighTariffReserve(now, data, { ...config, minimumEnergyBufferKwh: 1 }, limits)!, 4 + 5 / Math.sqrt(.95));
  close(nextNightHighTariffReserve(now, data, config, { ...limits, reserveSocPercent: 20 })!, 12 + 5 / Math.sqrt(.95));
  data.carCharging = { status: 'unavailable', date: data.date, calculatedAt: null, socObservedAt: null, slots: [] };
  close(nextNightHighTariffReserve(now, data, config, limits)!, 3 + 5 / Math.sqrt(.95));
});

test('late morning sunshine cannot erase household energy needed before that sunshine', () => {
  const now = new Date('2026-10-25T20:00:00.000Z');
  const data = forecast('2026-10-26', now, 0);
  for (const hour of data.consumption.hourly) if (['2026-10-26T06:00:00.000Z', '2026-10-26T07:00:00.000Z'].includes(hour.start)) hour.estimatedConsumptionKwh = 2;
  data.consumption.estimatedConsumptionKwh = 4;
  data.hourly!.find(hour => hour.start === '2026-10-26T10:00:00.000Z')!.estimatedProductionKwh = 2;
  data.estimatedProductionKwh = 2;
  data.consumption.quarterHourly = data.consumption.hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedConsumptionKwh: hour.estimatedConsumptionKwh / 4,
  })));
  data.quarterHourly!.forEach(point => { point.estimatedProductionKwh = point.start >= '2026-10-26T10:00:00.000Z'
    && point.start < '2026-10-26T11:00:00.000Z' ? .5 : 0; });
  close(nextNightHighTariffReserve(now, data, config)!, 3 + 4 / Math.sqrt(.95));
});

test('unavailable weather, unknown reserve and physically unprotectable morning return no assist budget', () => {
  const now = new Date('2026-10-25T20:00:00.000Z');
  for (const data of [{ ...forecast('2026-10-26', now), status: 'offline' as const },
    { ...forecast('2026-10-26', now), fetchedAt: null },
    { ...forecast('2026-10-26', now), fetchedAt: '2026-10-25T20:00:06.000Z' },
    { ...forecast('2026-10-26', now), hourly: null }, forecast('2026-10-25', now)]) {
    assert.equal(nextNightHighTariffReserve(now, data, config), null);
  }
  const data = forecast('2026-10-26', now);
  assert.equal(nextNightHighTariffReserve(now, data, config, { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: null }), null);
  assert.equal(nextNightHighTariffReserve(now, data, config, { maxPowerKw: .5, maxSocPercent: 90, reserveSocPercent: 5 }), null);
  assert.equal(nextNightHighTariffReserve(now, data, config, { maxPowerKw: 6, maxSocPercent: 10, reserveSocPercent: 5 }), null);
});

test('next-morning reserve still protects household demand using retained weather during an outage', () => {
  const now = new Date('2026-10-25T20:00:00.000Z');
  const fresh = forecast('2026-10-26', now);
  const retained = { ...fresh, status: 'stale' as const, fetchedAt: '2026-10-25T08:00:00.000Z' };
  close(nextNightHighTariffReserve(now, retained, config)!, nextNightHighTariffReserve(now, fresh, config)!);
});

test('next-morning reserve resolves the correct Zurich morning on both DST transition days', () => {
  for (const [time, date] of [['2026-03-28T23:30:00.000Z', '2026-03-29'], ['2026-10-24T22:30:00.000Z', '2026-10-25']]) {
    const now = new Date(time);
    close(nextNightHighTariffReserve(now, forecast(date, now), config)!, 3 + 5 / Math.sqrt(.95));
  }
});

test('night supply permits capped natural discharge while hold-only still prevents discharge', () => {
  const now = new Date('2026-10-25T22:10:00.000Z'), end = new Date('2026-10-25T22:20:00.000Z');
  const data = forecast('2026-10-25', now, 1);
  const session = slot(now.toISOString(), end.toISOString(), 6, 'grid', false);
  data.carCharging = channel(data.date, [session], now);
  const held = projectBatterySoc(now, telemetry(now, 60), controller, automation, [data], config, end);
  close(held.points.at(-1)!.socPercent, 60);
  session.batterySupply = { minimumSocPercent: 50, maxDischargeKw: 2 };
  assert.deepEqual(carBatterySupply(data, +now, +end), session.batterySupply);
  const result = projectBatterySoc(now, telemetry(now, 60), controller, automation, [data], config, end);
  close(result.points.at(-1)!.socPercent, 60 - (2 / 6) / 60 * 100);
  close(result.energyBalance!.consumptionKwh, 2 / 6);
  close(result.energyBalance!.gridKwh, 0);
  close(result.energyBalance!.solarKwh, 0);
});

test('supply reaches its protected floor without charging from grid or surplus PV', () => {
  const now = new Date('2026-10-25T22:10:00.000Z'), end = new Date('2026-10-25T22:20:00.000Z');
  const data = forecast('2026-10-25', now, 1);
  const session = { ...slot(now.toISOString(), end.toISOString(), 6, 'grid', false),
    batterySupply: { minimumSocPercent: 50, maxDischargeKw: 6 } };
  data.carCharging = channel(data.date, [session], now);
  const result = projectBatterySoc(now, telemetry(now, 50.2), controller, automation, [data], config, end);
  close(result.points.at(-1)!.socPercent, 50);
  close(result.energyBalance!.consumptionKwh, .12);
  close(result.energyBalance!.gridKwh, 0);
  const sunny = forecast('2026-10-25', now, 0, 10);
  sunny.carCharging = channel(sunny.date, [session], now);
  const noCharge = projectBatterySoc(now, telemetry(now, 60), controller, automation, [sunny], config, end);
  close(noCharge.points.at(-1)!.socPercent, 60);
  close(noCharge.energyBalance!.solarKwh, 0);
  close(noCharge.energyBalance!.gridKwh, 0);
});

test('invalid supply floors, power caps, daytime windows and charge-enabled supply are rejected', () => {
  const now = new Date('2026-10-25T22:10:00.000Z');
  const session = slot(now.toISOString(), '2026-10-25T22:20:00.000Z', 6, 'grid', false);
  for (const batterySupply of [{ minimumSocPercent: 0, maxDischargeKw: 6 },
    { minimumSocPercent: 100, maxDischargeKw: 6 }, { minimumSocPercent: 50, maxDischargeKw: 0 },
    { minimumSocPercent: 50, maxDischargeKw: 8 }, { minimumSocPercent: NaN, maxDischargeKw: 6 }]) {
    assert.equal(validCarCharging(channel('2026-10-25', [{ ...session, batterySupply }], now)), false);
  }
  const valid = { minimumSocPercent: 50, maxDischargeKw: 6 };
  assert.equal(validCarCharging(channel('2026-10-25', [{ ...session, batterySupply: valid, batteryChargeAllowed: true }], now)), false);
  assert.equal(validCarCharging(channel('2026-10-25', [{ ...slot('2026-10-25T12:10:00.000Z', '2026-10-25T12:20:00.000Z'),
    batteryChargeAllowed: false, batterySupply: valid }], now)), false);
});

test('night planning subtracts supplied stored energy instead of preserving an optimistic initial SOC', () => {
  const now = new Date('2026-01-14T23:00:00.000Z');
  const data = forecast('2026-01-15', now, 0);
  const baseline = planBatteryCharge(now, telemetry(now, 80), data, config, controller.limits);
  data.carCharging = channel(data.date, [{
    ...slot(now.toISOString(), '2026-01-15T05:55:00.000Z', 6, 'grid', false),
    batterySupply: { minimumSocPercent: 20, maxDischargeKw: 6 },
  }], now);
  const result = planBatteryCharge(now, telemetry(now, 80), data, config, controller.limits);
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'car_priority');
  assert.equal(baseline.unmetKwh, 0);
  assert.ok(result.unmetKwh > 7);
});

test('car contexts cover the complete weekly forecast plus its planning lookahead', () => {
  const data = forecast();
  data.carChargingContext = Array.from({ length: 9 }, (_, offset) => ({ status: 'inactive' as const,
    date: new Date(Date.parse(`${data.date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10),
    calculatedAt: null, socObservedAt: null, slots: [] }));
  assert.equal(validCarLoad(data), true);
  data.carChargingContext.push({ ...data.carChargingContext[8], date: '2026-12-01' });
  assert.equal(validCarLoad(data), false);
});
