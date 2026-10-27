import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerBattery, buildPlannerDetails, getUpcomingHighTariff } from '../src/planner-details.js';
import { planBatteryCharge, type AutomationConfig, type EnergyForecast } from '../src/automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from '../src/automation.js';
import { estimateConsumption, loadConsumptionConfig } from '../src/consumption.js';
import { getCalendarDayBounds, getSchedule } from '../src/policy.js';
import type { Telemetry } from '../src/status.js';

const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5, energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 };
const now = new Date('2026-10-24T12:00:00Z');
const control: AutomationControllerState & { automated?: boolean } = {
  available: true, mode: 'auto', powerKw: null, targetSocPercent: null,
  limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 }, error: null,
};
const automation: AutomationStatus = {
  enabled: true, status: 'charging', lastEvaluatedAt: now.toISOString(), nextEvaluationAt: '2026-10-24T12:15:00Z',
  targetSocPercent: 30, holdUntil: null, reason: 'energy_shortfall', plan: null, error: null,
};
function telemetry(at = now): Telemetry {
  return { status: 'online', observedAt: at.toISOString(), error: null, solarKw: 1, householdKw: 1,
    gridImportKw: 0, gridExportKw: 0, batterySocPercent: 17.4, batteryChargeKw: 0, batteryDischargeKw: 0 };
}
function forecast(date = '2026-10-24', at = now): EnergyForecast {
  const consumption = estimateConsumption(date, { ...loadConsumptionConfig({}), baselinePowerW: 1000 });
  const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  return {
    status: 'online', date, locationName: 'Installation de démonstration', estimatedProductionKwh: 0,
    quarterHourly: consumption.quarterHourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 0, temperatureC: 10 })),
    hourly: consumption.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 0, temperatureC: 10 })),
    weatherCode: 0, temperatureMinC: 10, temperatureMaxC: 10, temperatureMeanC: 10,
    fetchedAt: at.toISOString(), source: 'Open-Meteo', model: 'east_west_tilted_radiation', arrayPowerKw: 8.5,
    performanceRatio: .85, panelTiltDegrees: 15, eastFraction: .5, weatherModel: 'meteoswiss_icon_ch2',
    productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString(), error: null, consumption,
  };
}
const details = (data = forecast(), battery = control, status = automation, observation = telemetry(), at = now) =>
  buildPlannerDetails(at, observation, battery, status, data, config);
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function syncQuarters(data: EnergyForecast) {
  data.quarterHourly = data.hourly!.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedProductionKwh: hour.estimatedProductionKwh / 4, temperatureC: hour.temperatureC,
  })));
  data.consumption.quarterHourly = data.consumption.hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedConsumptionKwh: hour.estimatedConsumptionKwh / 4,
  })));
}

test('planner details capture the display schedule and copy the active plan', () => {
  const data = forecast();
  const battery = { ...control, revertTimeoutSeconds: 30 };
  const plan = planBatteryCharge(now, telemetry(), data, config, { ...battery.limits, revertTimeoutSeconds: 30 });
  const result = details(data, battery, { ...automation, plan });
  assert.deepEqual(result.calculation?.charging, getSchedule(now).charging);
  assert.deepEqual(result.calculation?.plan, plan);
  assert.notEqual(result.calculation?.plan, plan);
  plan.afternoonTargetSocPercent = 95;
  assert.equal(result.calculation?.plan?.afternoonTargetSocPercent, 80);
  assert.equal(details().calculation?.plan, null);
});

test('the displayed gap uses live energy and the afternoon goal instead of the upcoming night target', () => {
  const at = new Date('2026-10-25T17:00:00Z');
  const today = forecast('2026-10-25', at), tomorrow = forecast('2026-10-26', at);
  tomorrow.hourly!.forEach(hour => {
    hour.estimatedProductionKwh = hour.start >= '2026-10-26T09:00:00.000Z' && hour.start < '2026-10-26T14:00:00.000Z' ? 3 : 0;
  });
  tomorrow.estimatedProductionKwh = 15;
  syncQuarters(tomorrow);
  const result = buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: 70 }, { ...control, revertTimeoutSeconds: 30 },
    { ...automation, status: 'idle', targetSocPercent: null }, today, config, [today, tomorrow]);
  const sources = result.chargeBreakdown!;
  close(sources.storedKwh, 42);
  close(sources.consumptionKwh, (5 + 3 + 5 / 60) / Math.sqrt(.95));
  close(sources.gapKwh, 6 + sources.consumptionKwh!); // Target gap plus evening/morning battery use.
  assert.equal(sources.start, at.toISOString());
  assert.equal(sources.end, '2026-10-26T15:55:00.000Z');
  assert.ok(sources.solarKwh! > 0, 'daytime surplus contributes even though the next charge window is at night');
  assert.ok(sources.gridKwh! > 0);
});

test('high tariff selects the current period or the next one at every exact boundary', () => {
  for (const [wall, start, end, current, date] of [
    ['00:00', '07:00', '12:00', false, '2026-10-24'],
    ['06:59', '07:00', '12:00', false, '2026-10-24'],
    ['07:00', '07:00', '12:00', true, '2026-10-24'],
    ['11:59', '07:00', '12:00', true, '2026-10-24'],
    ['12:00', '17:00', '23:00', false, '2026-10-24'],
    ['16:45', '17:00', '23:00', false, '2026-10-24'],
    ['17:00', '17:00', '23:00', true, '2026-10-24'],
    ['22:59', '17:00', '23:00', true, '2026-10-24'],
    ['23:00', '07:00', '12:00', false, '2026-10-25'],
  ] as const) {
    const period = getUpcomingHighTariff(new Date(`2026-10-24T${wall}:00+02:00`));
    const offset = date === '2026-10-24' ? '+02:00' : '+01:00';
    assert.deepEqual(period, {
      start: new Date(`${date}T${start}:00${offset}`).toISOString(),
      end: new Date(`${date}T${end}:00${offset}`).toISOString(), date, isCurrent: current,
    }, wall);
  }
});

test('Zurich dates and offset transitions use calendar boundaries rather than 24-hour arithmetic', () => {
  for (const [instant, date, start] of [
    ['2026-03-28T23:30:00+01:00', '2026-03-29', '2026-03-29T05:00:00.000Z'],
    ['2026-10-24T23:30:00+02:00', '2026-10-25', '2026-10-25T06:00:00.000Z'],
    ['2026-12-31T23:30:00+01:00', '2027-01-01', '2027-01-01T06:00:00.000Z'],
    ['2026-10-24T22:30:00Z', '2026-10-25', '2026-10-25T06:00:00.000Z'],
  ]) {
    const result = getUpcomingHighTariff(new Date(instant));
    assert.equal(result.date, date);
    assert.equal(result.start, start);
    assert.equal(result.isCurrent, false);
  }
});

test('evening demand integrates only the six expensive hours and keeps known zero solar', () => {
  const result = details();
  assert.equal(result.highTariff.estimatedConsumptionKwh, 6);
  assert.equal(result.highTariff.estimatedProductionKwh, 0);
  assert.equal(result.highTariff.netDemandKwh, 6);
  assert.equal(result.highTariff.remainingConsumptionKwh, 6);
  assert.equal(result.highTariff.consumptionMethod, 'baseline_only');
});

test('remaining demand prorates the current forecast hour without relabelling it as measured', () => {
  const at = new Date('2026-10-24T15:30:00Z'); // 17:30 Zurich
  const data = forecast('2026-10-24', at);
  data.hourly!.find(hour => hour.start === '2026-10-24T15:00:00.000Z')!.estimatedProductionKwh = .8;
  data.estimatedProductionKwh = .8;
  syncQuarters(data);
  const result = details(data, control, automation, telemetry(at), at).highTariff;
  assert.equal(result.isCurrent, true);
  close(result.estimatedConsumptionKwh, 6);
  close(result.remainingConsumptionKwh, 5.5);
  close(result.estimatedProductionKwh, .8);
  close(result.remainingProductionKwh, .4);
  close(result.remainingNetDemandKwh, 5.1);
});

test('full 23-hour and 25-hour series integrate the five-hour morning correctly', () => {
  for (const [date, instant, count] of [
    ['2026-03-29', '2026-03-28T22:30:00Z', 23], ['2026-10-25', '2026-10-24T21:30:00Z', 25],
  ] as const) {
    const at = new Date(instant);
    const data = forecast(date, at);
    assert.equal(data.hourly!.length, count);
    const result = details(data, control, automation, telemetry(at), at).highTariff;
    assert.equal(result.estimatedConsumptionKwh, 5);
    assert.equal(result.remainingConsumptionKwh, 5);
  }
});

test('missing solar does not turn into zero or discard a separately valid configured consumption profile', () => {
  const data = { ...forecast(), status: 'offline' as const, fetchedAt: null, hourly: null, estimatedProductionKwh: null };
  const result = details(data).highTariff;
  assert.equal(result.forecastStatus, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.netDemandKwh, null);
  assert.equal(result.remainingNetDemandKwh, null);
  assert.equal(result.estimatedConsumptionKwh, 6);
});

test('invalid solar hours and mismatched totals invalidate solar without hiding valid demand', () => {
  const mutations: Array<(data: EnergyForecast) => void> = [
    data => { data.hourly!.pop(); },
    data => { data.hourly![0] = data.hourly![1]; },
    data => { data.hourly![0].estimatedProductionKwh = NaN; },
    data => { data.hourly![0].estimatedProductionKwh = -1; },
    data => { data.estimatedProductionKwh = 1; },
    data => { data.hourly![0].end = data.hourly![0].start; },
  ];
  for (const mutate of mutations) {
    const data = forecast(); mutate(data);
    const result = details(data).highTariff;
    assert.equal(result.estimatedProductionKwh, null);
    assert.equal(result.estimatedConsumptionKwh, 6);
  }
});

test('invalid consumption hours and mismatched totals do not hide separately valid solar', () => {
  for (const mutate of [
    (data: EnergyForecast) => { data.consumption.hourly.pop(); },
    (data: EnergyForecast) => { data.consumption.estimatedConsumptionKwh = 1; },
    (data: EnergyForecast) => { data.consumption.hourly[0].estimatedConsumptionKwh = -1; },
    (data: EnergyForecast) => { data.consumption.excludesCar = false as true; },
  ]) {
    const data = forecast(); mutate(data);
    const result = details(data).highTariff;
    assert.equal(result.estimatedConsumptionKwh, null);
    assert.equal(result.estimatedProductionKwh, 0);
    assert.equal(result.netDemandKwh, null);
  }
});

test('real zero demand and excess solar clamp aggregate net demand at zero', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  data.consumption.estimatedConsumptionKwh = 0;
  syncQuarters(data);
  const result = details(data).highTariff;
  assert.equal(result.estimatedConsumptionKwh, 0);
  assert.equal(result.netDemandKwh, 0);
  const solar = forecast();
  solar.hourly!.find(hour => hour.start === '2026-10-24T15:00:00.000Z')!.estimatedProductionKwh = 10;
  solar.estimatedProductionKwh = 10;
  syncQuarters(solar);
  assert.equal(details(solar).highTariff.netDemandKwh, 0);
});

test('retained weather remains explicitly stale beyond six hours and future weather is rejected', () => {
  const data = forecast();
  data.status = 'stale'; data.fetchedAt = new Date(now.getTime() - 6 * 3_600_000).toISOString();
  assert.equal(details(data).highTariff.forecastStatus, 'stale');
  assert.equal(details(data).highTariff.estimatedConsumptionKwh, 6);
  data.fetchedAt = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  assert.equal(details(data).highTariff.forecastStatus, 'stale');
  assert.equal(details(data).highTariff.estimatedConsumptionKwh, 6);
  assert.equal(details(data).highTariff.estimatedProductionKwh, 0);
  data.status = 'online'; data.fetchedAt = new Date(now.getTime() + 5001).toISOString();
  assert.equal(details(data).highTariff.estimatedProductionKwh, null);
});

test('a forecast for another date never supplies the expensive-period energy', () => {
  const result = details(forecast('2026-10-25')).highTariff;
  assert.equal(result.forecastStatus, 'offline');
  assert.equal(result.estimatedConsumptionKwh, null);
  assert.equal(result.estimatedProductionKwh, null);
});

test('confirmed usable capacity and actual reserve determine energy rather than any legacy controller capacity', () => {
  const result = details().battery;
  close(result.storedKwh, 10.44);
  close(result.reserveKwh, 3);
  close(result.availableKwh, 7.44);
  assert.equal(result.capacityKwh, 60);
  const higherReserve = details(forecast(), { ...control, limits: { ...control.limits, reserveSocPercent: 10 } }).battery;
  close(higherReserve.availableKwh, 4.44);
  for (const reserveSocPercent of [undefined, null, NaN, -1, 101]) {
    const invalid = details(forecast(), { ...control, limits: { ...control.limits, reserveSocPercent } }).battery;
    assert.equal(invalid.reserveKwh, null);
    assert.equal(invalid.availableKwh, null);
    close(invalid.storedKwh, 10.44);
  }
});

test('effective reserve uses the larger configured or verified controller floor', () => {
  const belowConfigured = details(forecast(), { ...control, limits: { ...control.limits, reserveSocPercent: 4 } }).battery;
  assert.equal(belowConfigured.reserveSocPercent, 5);
  close(belowConfigured.availableKwh, 7.44);
  const higherConfigured = buildPlannerDetails(now, telemetry(), control, automation, forecast(), { ...config, reserveSocPercent: 10 }).battery;
  assert.equal(higherConfigured.reserveSocPercent, 10);
  close(higherConfigured.reserveKwh, 6);
  close(higherConfigured.availableKwh, 4.44);
});

test('available energy always excludes the 5% minimum and never goes below zero', () => {
  const lowReserveControl = { ...control, limits: { ...control.limits, reserveSocPercent: 0 } };
  for (const reserveSocPercent of [0, 4]) {
    const result = buildPlannerDetails(now, { ...telemetry(), batterySocPercent: 13.6 / 60 * 100 },
      lowReserveControl, automation, forecast(), { ...config, reserveSocPercent }).battery;
    close(result.storedKwh, 13.6);
    close(result.reserveKwh, 3);
    close(result.availableKwh, 10.6);
  }
  for (const batterySocPercent of [0, 4, 5]) {
    const result = details(forecast(), control, automation, { ...telemetry(), batterySocPercent }).battery;
    assert.equal(result.availableKwh, 0);
  }
});

test('manual discharge keeps its signed power without showing a charging target', () => {
  const result = details(forecast(), { ...control, mode: 'manual', powerKw: -2, targetSocPercent: 25 }).battery;
  assert.equal(result.mode, 'manual');
  assert.equal(result.powerKw, -2);
  assert.equal(result.targetSocPercent, null);
  assert.equal(result.targetSource, null);
});

test('an unknown consumption source never supplies derived energy even with fresh weather', () => {
  const data = forecast();
  data.consumption.source = 'unknown' as typeof data.consumption.source;
  const result = details(data).highTariff;
  assert.equal(result.estimatedConsumptionKwh, null);
  assert.equal(result.remainingConsumptionKwh, null);
  assert.equal(result.netDemandKwh, null);
  assert.equal(result.consumptionMethod, null);
  assert.equal(result.estimatedProductionKwh, 0);
});

test('stale, future and invalid SOC cannot produce a stored or available energy estimate', () => {
  for (const change of [
    { status: 'stale' as const }, { status: 'offline' as const }, { observedAt: null },
    { observedAt: new Date(now.getTime() - 30_001).toISOString() },
    { observedAt: new Date(now.getTime() + 5001).toISOString() },
    ...[null, NaN, -1, 101].map(batterySocPercent => ({ batterySocPercent })),
  ]) {
    const result = details(forecast(), control, automation, { ...telemetry(), ...change }).battery;
    assert.equal(result.socPercent, null);
    assert.equal(result.storedKwh, null);
    assert.equal(result.availableKwh, null);
    assert.equal(result.gapKwh, null);
  }
});

test('confirmed active controller target takes precedence over the planner and gap cannot be negative', () => {
  const result = details(forecast(), { ...control, mode: 'manual', powerKw: 6, targetSocPercent: 25, automated: true }).battery;
  assert.equal(result.targetSource, 'controller');
  assert.equal(result.targetSocPercent, 25);
  assert.equal(result.targetStoredKwh, 15);
  close(result.gapKwh, 4.56);
  assert.equal(result.powerKw, 6);
  assert.equal(result.automated, true);
  const reached = details(forecast(), { ...control, mode: 'manual', powerKw: 6, targetSocPercent: 10 }).battery;
  assert.equal(reached.gapKwh, 0);
});

test('planner target is explanatory during idle holding, and manual overrides do not borrow it', () => {
  const result = details(forecast(), { ...control, mode: 'manual', powerKw: 0, targetSocPercent: null, automated: true }, { ...automation, status: 'holding' }).battery;
  assert.equal(result.targetSource, 'planner');
  assert.equal(result.targetSocPercent, 30);
  assert.equal(result.targetStoredKwh, 18);
  const manual = details(forecast(), { ...control, mode: 'manual', powerKw: 6 }, { ...automation, status: 'manual_override' }).battery;
  assert.equal(manual.targetSocPercent, null);
  assert.equal(manual.targetSource, null);
  assert.equal(manual.automated, false);
});

test('unconfirmed and expired controller values never appear as an active target or power', () => {
  for (const change of [{ mode: 'unknown' as const }, { available: false }, { error: 'offline' },
    { expiresAt: now.toISOString() }, { expiresAt: 'invalid' }]) {
    const result = details(forecast(), { ...control, mode: 'manual', powerKw: 6, targetSocPercent: 80, ...change }, { ...automation, targetSocPercent: null }).battery;
    assert.equal(result.targetSocPercent, null);
    assert.equal(result.targetSource, null);
    assert.equal(result.powerKw, null);
    assert.equal(result.mode, 'unknown');
    assert.equal(result.automated, false);
  }
});

test('assumptions describe fixed charging power, full next-period coverage and efficiency', () => {
  assert.deepEqual(details().assumptions, { coveragePercent: 100, chargePowerKw: 6, roundTripEfficiencyPercent: 95 });
  assert.equal(JSON.stringify(details()).includes('automationOwner'), false);
});

test('upcoming afternoon plan uses projected starting energy after consumption and solar, with reserve protection', () => {
  for (const solarKw of [0, 3]) {
    const at = new Date('2026-10-24T08:00:00Z'); // 10:00 Zurich, two hours of discharge before the buffer.
    const data = forecast('2026-10-24', at);
    data.hourly!.forEach(hour => { hour.estimatedProductionKwh = solarKw; });
    data.estimatedProductionKwh = solarKw * data.hourly!.length;
  syncQuarters(data);
    const observation = { ...telemetry(at), batterySocPercent: 40 };
    const result = buildPlannerDetails(at, observation, { ...control, revertTimeoutSeconds: 30 },
      { ...automation, status: 'idle', targetSocPercent: null }, data, config);
    const preview = result.upcomingPlan!;
    assert.equal(preview.start, '2026-10-24T10:05:00.000Z');
    assert.equal(preview.end, '2026-10-24T14:55:00.000Z');
    const expectedStored = solarKw === 0 ? 24 - 2 / Math.sqrt(.95) : 24 + 2 * (2 + 5 / 60) * Math.sqrt(.95);
    close(preview.estimatedSocPercent, expectedStored / 60 * 100);
    close(preview.plan.storedKwh, expectedStored);
    close(preview.plan.shortfallKwh, Math.max(0, preview.plan.targetSocPercent! / 100 * 60 - expectedStored));
    assert.equal(result.battery.socPercent, 40, 'live SOC stays measured');
    assert.equal(result.battery.targetSocPercent, null);
  }
});

test('upcoming night plan uses tomorrow while projecting discharge today through the pre-charge buffer', () => {
  const at = new Date('2026-10-24T15:00:00Z'); // 17:00 Zurich before the 25-hour day.
  const today = forecast('2026-10-24', at);
  const tomorrow = forecast('2026-10-25', at);
  const result = buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: 40 }, { ...control, revertTimeoutSeconds: 30 },
    { ...automation, status: 'idle', targetSocPercent: null }, today, config, [today, tomorrow]);
  const preview = result.upcomingPlan!;
  assert.equal(preview.start, '2026-10-24T21:05:00.000Z');
  assert.equal(preview.end, '2026-10-25T05:55:00.000Z');
  close(preview.plan.storedKwh, 24 - 6 / Math.sqrt(.95));
  assert.equal(preview.plan.window, 'night');
  assert.equal(preview.plan.forecastDate, '2026-10-25');
  assert.equal(preview.plan.action, 'charge');
  assert.equal(preview.plan.afternoonTargetAt, '2026-10-25T15:55:00.000Z');
  assert.equal(result.highTariff.isCurrent, true);
});

test('upcoming night completion is projected from the window start, including charging losses and DST', () => {
  const at = new Date('2026-10-24T15:00:00Z');
  const today = forecast('2026-10-24', at), tomorrow = forecast('2026-10-25', at);
  const result = buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: 70 }, { ...control, revertTimeoutSeconds: 30 },
    automation, today, config, [today, tomorrow]);
  const preview = result.upcomingPlan!;
  assert.equal(preview.plan.action, 'charge');
  const earliest = Date.parse(preview.start) + preview.plan.shortfallKwh! / (6 * Math.sqrt(.95)) * 3_600_000;
  const finish = Date.parse(preview.estimatedCompletionAt!);
  assert.ok(finish >= earliest - 1000 && finish <= earliest + 5 * 60_000,
    'completion follows the chronological trajectory at five-minute resolution');
  assert.ok(finish <= Date.parse(preview.end));
  assert.equal(result.battery.socPercent, 70, 'the future completion must not replace current measurements');
});

test('upcoming completion respects household power limits and never promises an unreachable target', () => {
  const at = new Date('2026-10-24T10:00:00Z'); // Five minutes before the afternoon window.
  const build = (householdKw: number, soc: number) => {
    const data = forecast('2026-10-24', at);
    data.consumption.hourly.forEach(hour => {
      if (hour.start >= '2026-10-24T10:00:00.000Z' && hour.start < '2026-10-24T15:00:00.000Z') hour.estimatedConsumptionKwh = householdKw;
    });
    data.consumption.estimatedConsumptionKwh = data.consumption.hourly.reduce((sum, hour) => sum + hour.estimatedConsumptionKwh, 0);
  syncQuarters(data);
    return buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: soc }, { ...control, revertTimeoutSeconds: 30 },
      automation, data, config).upcomingPlan!;
  };
  const normal = build(1, 70), limited = build(14, 70), unreachable = build(16, 70);
  assert.ok(Date.parse(limited.estimatedCompletionAt!) > Date.parse(normal.estimatedCompletionAt!),
    'household use leaves only 2 kW for battery charging');
  assert.equal(unreachable.plan.action, 'charge');
  assert.equal(unreachable.estimatedCompletionAt, null);
  const reached = build(1, 95);
  assert.equal(reached.plan.action, 'hold');
  assert.equal(reached.estimatedCompletionAt, null, 'no charge finish is invented when no charging is planned');
});

test('upcoming projection never falls below reserve and never substitutes current SOC for missing forecasts', () => {
  const at = new Date('2026-10-24T08:00:00Z');
  const data = forecast('2026-10-24', at);
  const build = (observation = { ...telemetry(at), batterySocPercent: 6 }, forecasts = [data]) =>
    buildPlannerDetails(at, observation, { ...control, revertTimeoutSeconds: 30 }, automation, data, config, forecasts).upcomingPlan!;
  close(build().estimatedSocPercent, 5);
  for (const change of [
    { status: 'offline' as const }, { fetchedAt: 'invalid' },
    { fetchedAt: new Date(at.getTime() + 5001).toISOString() }, { hourly: null },
  ]) {
    const result = build(undefined, [{ ...data, ...change }]);
    assert.equal(result.estimatedSocPercent, null);
    assert.equal(result.plan.action, 'blocked');
    assert.equal(result.plan.targetSocPercent, null);
    assert.equal(result.estimatedCompletionAt, null);
  }
  const stale = build({ ...telemetry(at), batterySocPercent: 40, observedAt: new Date(at.getTime() - 30_001).toISOString() });
  assert.equal(stale.estimatedSocPercent, null);
  assert.equal(stale.plan.action, 'blocked');
});

test('preview appears only outside charge windows and respects disabled and manual control', () => {
  assert.equal(details().upcomingPlan, null);
  const at = new Date('2026-10-24T08:00:00Z');
  for (const change of [{ enabled: false }, { status: 'disabled' as const }, { status: 'manual_override' as const }]) {
    assert.equal(details(forecast('2026-10-24', at), control, { ...automation, ...change }, telemetry(at), at).upcomingPlan, null);
  }
  assert.equal(details(forecast('2026-10-24', at), { ...control, mode: 'manual', powerKw: 6 }, automation, telemetry(at), at).upcomingPlan, null);
});

test('preview switches at exact window boundaries and keeps Zurich DST/calendar dates', () => {
  for (const [instant, targetDate, start, end] of [
    ['2026-10-24T06:55:00+02:00', '2026-10-24', '2026-10-24T10:05:00.000Z', '2026-10-24T14:55:00.000Z'],
    ['2026-10-24T12:05:00+02:00', '2026-10-24', null, null],
    ['2026-10-24T16:55:00+02:00', '2026-10-25', '2026-10-24T21:05:00.000Z', '2026-10-25T05:55:00.000Z'],
    ['2026-03-28T23:04:59+01:00', '2026-03-29', '2026-03-28T22:05:00.000Z', '2026-03-29T04:55:00.000Z'],
    ['2026-10-24T23:05:00+02:00', '2026-10-25', null, null],
    ['2026-12-31T23:04:59+01:00', '2027-01-01', '2026-12-31T22:05:00.000Z', '2027-01-01T05:55:00.000Z'],
  ] as const) {
    const at = new Date(instant);
    const today = forecast(instant.slice(0, 10), at);
    const upcoming = forecast(targetDate, at);
    const result = buildPlannerDetails(at, telemetry(at), { ...control, revertTimeoutSeconds: 30 }, automation,
      today, config, [today, upcoming]).upcomingPlan;
    if (start === null) assert.equal(result, null, instant);
    else {
      assert.equal(result!.start, start, instant);
      assert.equal(result!.end, end, instant);
      assert.equal(result!.plan.forecastDate, targetDate, instant);
      assert.notEqual(result!.estimatedSocPercent, null, instant);
    }
  }
});


test('afternoon estimate is a feasible projected SOC rather than the desired goal', () => {
  const data = forecast();
  const battery = { ...control, revertTimeoutSeconds: 30 };
  const plan = planBatteryCharge(now, telemetry(), data, config, { ...battery.limits, revertTimeoutSeconds: 30 });
  const result = details(data, battery, { ...automation, plan });
  assert.equal(plan.afternoonTargetSocPercent, 80);
  assert.equal(result.afternoonEstimate?.at, '2026-10-24T14:55:00.000Z');
  close(result.afternoonEstimate!.socPercent, 17.4 + 6 * Math.sqrt(.95) * (2 * 3600 + 55 * 60) / 3600 / 60 * 100);
  assert.ok(result.afternoonEstimate!.socPercent! < 80);
});

test('upcoming night estimates reach the same afternoon deadline across DST', () => {
  for (const [date, nextDate, origin, deadline] of [
    ['2026-03-28', '2026-03-29', '2026-03-28T22:00:00Z', '2026-03-29T14:55:00.000Z'],
    ['2026-10-24', '2026-10-25', '2026-10-24T21:00:00Z', '2026-10-25T15:55:00.000Z'],
  ]) {
    const at = new Date(origin);
    const today = forecast(date, at), tomorrow = forecast(nextDate, at);
    const result = buildPlannerDetails(at, telemetry(at), { ...control, revertTimeoutSeconds: 30 },
      { ...automation, status: 'idle', plan: null }, tomorrow, config, [today, tomorrow]);
    assert.equal(result.afternoonEstimate?.at, deadline);
    // The simulated controller stops within 0.02 SOC points of its target.
    assert.ok(Math.abs(result.afternoonEstimate!.socPercent! - 80) <= .02);
  }
});

test('afternoon estimates stay unknown with missing forecasts, stale SOC or manual control', () => {
  const data = forecast();
  const battery = { ...control, revertTimeoutSeconds: 30 };
  const plan = planBatteryCharge(now, telemetry(), data, config, battery.limits);
  const active = { ...automation, plan };
  for (const [observation, forecasts, status] of [
    [telemetry(), [], active],
    [{ ...telemetry(), observedAt: new Date(now.getTime() - 30_001).toISOString() }, [data], active],
    [telemetry(), [{ ...data, status: 'offline' as const }], active],
    [telemetry(), [data], { ...active, status: 'manual_override' as const }],
  ] as const) {
    const result = buildPlannerDetails(now, observation, battery, status, data, config, [...forecasts]);
    assert.equal(result.afternoonEstimate?.socPercent ?? null, null);
  }
  assert.equal(details(data, battery, { ...automation, plan: null }).afternoonEstimate, null);
  const old = { ...plan, afternoonTargetAt: '2026-10-23T14:55:00.000Z' };
  assert.equal(details(data, battery, { ...active, plan: old }).afternoonEstimate, null);
});

function chargeDetails(solarKw = 0, instant = '2026-10-24T10:05:00Z', soc = 40, targetSocPercent = 80) {
  const at = new Date(instant);
  const data = forecast('2026-10-24', at);
  data.hourly!.forEach(hour => { hour.estimatedProductionKwh = solarKw; });
  data.estimatedProductionKwh = solarKw * data.hourly!.length;
  syncQuarters(data);
  const battery = { ...control, mode: 'manual' as const, automated: true, powerKw: 6, targetSocPercent,
    revertTimeoutSeconds: 30, automationOwner: 'test-owner', automationMode: 'charge' as const };
  const observation = { ...telemetry(at), batterySocPercent: soc };
  const plan = planBatteryCharge(at, observation, data, config, { ...battery.limits, revertTimeoutSeconds: 30 });
  const active = { ...automation, plan, nextEvaluationAt: new Date(at.getTime() + 15 * 60_000).toISOString() };
  const build = (forecasts = [data], reading = observation, controller = battery) =>
    buildPlannerDetails(at, reading, controller, active, data, config, forecasts);
  return { at, data, build, battery, observation };
}

test('live battery details can update independently of the captured afternoon requirement', () => {
  const f = chargeDetails(3);
  const captured = f.build();
  const later = new Date(f.at.getTime() + 60_000);
  const freshReading = { ...f.observation, observedAt: later.toISOString(), batterySocPercent: 45 };
  const battery = buildPlannerBattery(later, freshReading, f.battery, automation, config);
  close(battery.socPercent, 45);
  close(battery.storedKwh, 27);
  close(battery.availableKwh, 24);
  assert.equal(battery.targetSocPercent, 80);
  assert.equal(battery.targetSource, 'controller');
  close(captured.chargeBreakdown!.storedKwh, 24);
  close(captured.chargeBreakdown!.gapKwh, 24);
  const expired = buildPlannerBattery(later, freshReading, { ...f.battery, expiresAt: later.toISOString() }, automation, config);
  assert.equal(expired.mode, 'unknown');
  assert.equal(expired.targetSocPercent, null);
  assert.equal(expired.powerKw, null);
  assert.equal(expired.availableKwh, null);
  close(expired.socPercent, 45);
  const stale = buildPlannerBattery(later, f.observation, f.battery, automation, config);
  assert.equal(stale.socPercent, null);
  assert.equal(stale.storedKwh, null);
  assert.equal(stale.availableKwh, null);
});

test('afternoon breakdown allocates only net household surplus and respects charging losses', () => {
  for (const solarKw of [0, .5, 3, 20]) {
    const result = chargeDetails(solarKw).build();
    const sources = result.chargeBreakdown!;
    close(sources.gapKwh, 24);
    close(sources.consumptionKwh, 0); // The battery is held during the cheap window.
    close(sources.solarKwh! + sources.gridKwh! + sources.unmetKwh!, 24);
    close(sources.unmetKwh, 0);
    if (solarKw <= 1) close(sources.solarKwh, 0);
    if (solarKw === 20) close(sources.gridKwh, 0);
    if (solarKw === 3) assert.ok(sources.solarKwh! > 8, 'solar still contributes after the intermediate target is reached');
    assert.equal(sources.start, '2026-10-24T10:05:00.000Z');
    assert.equal(sources.end, '2026-10-24T14:55:00.000Z');
  }
});

test('late afternoon breakdown respects the exact deadline and reports the uncovered goal', () => {
  const result = chargeDetails(3, '2026-10-24T14:50:00Z', 20).build().chargeBreakdown!;
  const efficiency = Math.sqrt(.95);
  const solar = 2 * efficiency * 5 / 60;
  const grid = 4 * efficiency * 5 / 60;
  close(result.gapKwh, 36);
  close(result.solarKwh, solar);
  close(result.gridKwh, grid);
  close(result.unmetKwh, 36 - solar - grid);
});

test('an intermediate command target never replaces the afternoon goal', () => {
  const f = chargeDetails(0, undefined, 40, 60);
  const result = f.build();
  close(result.battery.gapKwh, 12);
  close(result.chargeBreakdown!.gapKwh, 24);
  assert.ok(result.chargeBreakdown!.gridKwh! > 12, 'subsequent evaluations fund the final goal');
});

test('upcoming night breakdown includes daytime solar and intervening consumption across DST', () => {
  for (const [todayDate, tomorrowDate, instant, end] of [
    ['2026-03-28', '2026-03-29', '2026-03-28T16:00:00Z', '2026-03-29T14:55:00.000Z'],
    ['2026-10-24', '2026-10-25', '2026-10-24T15:00:00Z', '2026-10-25T15:55:00.000Z'],
    ['2026-10-25', '2026-10-26', '2026-10-25T16:00:00Z', '2026-10-26T15:55:00.000Z'],
  ]) {
    const at = new Date(instant);
    const today = forecast(todayDate, at), tomorrow = forecast(tomorrowDate, at);
    tomorrow.hourly!.forEach(hour => { hour.estimatedProductionKwh = Date.parse(hour.start) >= Date.parse(`${tomorrowDate}T08:00:00Z`)
      && Date.parse(hour.end) <= Date.parse(`${tomorrowDate}T15:00:00Z`) ? 6 : 0; });
    tomorrow.estimatedProductionKwh = tomorrow.hourly!.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0);
  syncQuarters(tomorrow);
    const result = buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: 10 }, { ...control, revertTimeoutSeconds: 30 },
      { ...automation, status: 'idle', targetSocPercent: null }, today, config, [today, tomorrow]);
    const sources = result.chargeBreakdown!;
    assert.equal(sources.end, end);
    close(sources.gapKwh, 42 + sources.consumptionKwh!);
    assert.ok(sources.consumptionKwh! > 0);
    assert.ok(sources.solarKwh! > 0);
    assert.ok(sources.gridKwh! > 0);
    close(sources.solarKwh! + sources.gridKwh! + sources.unmetKwh!, sources.gapKwh!);
  }
});

test('missing or invalid forecasts cannot produce a consumption-adjusted gap or source split', () => {
  for (const change of [
    { status: 'offline' as const }, { status: 'not_configured' as const }, { hourly: null },
    { fetchedAt: 'invalid' }, { fetchedAt: '2026-10-24T10:05:06Z' },
  ]) {
    const f = chargeDetails(3);
    const result = f.build([{ ...f.data, ...change }]).chargeBreakdown!;
    assert.equal(result.gapKwh, null);
    assert.equal(result.consumptionKwh, null);
    assert.equal(result.solarKwh, null);
    assert.equal(result.gridKwh, null);
    assert.equal(result.unmetKwh, null);
  }
  const f = chargeDetails(3);
  assert.equal(f.build([]).chargeBreakdown!.solarKwh, null);
  f.data.consumption.hourly[0].estimatedConsumptionKwh = NaN;
  assert.equal(f.build().chargeBreakdown!.gridKwh, null);
});

test('stale SOC, unavailable control and absent afternoon goals never borrow the command gap', () => {
  const f = chargeDetails(3);
  assert.equal(f.build(undefined, { ...f.observation, status: 'stale' }).chargeBreakdown, null);
  assert.equal(f.build(undefined, undefined, { ...f.battery, available: false }).chargeBreakdown, null);
  assert.equal(details().chargeBreakdown, null);
  const reached = chargeDetails(0, undefined, 80).build().chargeBreakdown!;
  close(reached.gapKwh, 0);
  close(reached.solarKwh, 0);
  close(reached.gridKwh, 0);
  close(reached.unmetKwh, 0);
});


test('upcoming previews keep using both retained forecast days after refresh failure', () => {
  const at = new Date('2026-10-24T15:00:00Z');
  const today = forecast('2026-10-24', at), tomorrow = forecast('2026-10-25', at);
  const build = () => buildPlannerDetails(at, { ...telemetry(at), batterySocPercent: 40 },
    { ...control, revertTimeoutSeconds: 30 }, { ...automation, status: 'idle', targetSocPercent: null },
    today, config, [today, tomorrow]);
  const expected = build();
  for (const data of [today, tomorrow]) {
    data.status = 'stale';
    data.fetchedAt = new Date(at.getTime() - 12 * 3_600_000).toISOString();
    data.error = 'Les prévisions météo sont indisponibles.';
  }
  const result = build();
  assert.equal(result.upcomingPlan!.plan.action, 'charge');
  assert.deepEqual(result.upcomingPlan, expected.upcomingPlan);
  assert.deepEqual(result.afternoonEstimate, expected.afternoonEstimate);
  assert.deepEqual(result.chargeBreakdown, expected.chargeBreakdown);
  assert.equal(result.highTariff.forecastStatus, 'stale');
});
