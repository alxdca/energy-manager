import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBatterySoc } from '../src/battery-projection.js';
import { planBatteryCharge, type AutomationConfig, type EnergyForecast } from '../src/automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from '../src/automation.js';
import { estimateConsumption } from '../src/consumption.js';
import { getCalendarDayBounds, getLocalDate } from '../src/policy.js';
import type { Telemetry } from '../src/status.js';

const efficiency = Math.sqrt(.95);
const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5,
  energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 };
const controller: AutomationControllerState & { automated?: boolean } = {
  available: true, mode: 'auto', powerKw: null, targetSocPercent: null,
  limits: { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: 5 }, revertTimeoutSeconds: 30, error: null,
};
const automation: AutomationStatus = { enabled: true, status: 'idle', lastEvaluatedAt: null, nextEvaluationAt: null,
  targetSocPercent: null, holdUntil: null, reason: 'outside_charging_window', plan: null, error: null };
function telemetry(now: Date, soc = 20): Telemetry {
  return { status: 'online', observedAt: now.toISOString(), error: null, solarKw: 0, householdKw: 1,
    gridImportKw: 1, gridExportKw: 0, batterySocPercent: soc, batteryChargeKw: 0, batteryDischargeKw: 0 };
}
function forecast(date: string, now: Date, load = 1, solar = 0): EnergyForecast {
  const consumption = estimateConsumption(date, { baselinePowerW: load * 1000 });
  const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  return { status: 'online', date, locationName: 'Installation de démonstration', estimatedProductionKwh: Math.round(solar * consumption.dayHours * 10) / 10,
    quarterHourly: consumption.quarterHourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: solar / 4, temperatureC: null })),
    hourly: consumption.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: solar, temperatureC: null })),
    weatherCode: null, temperatureMinC: null, temperatureMaxC: null, temperatureMeanC: null,
    fetchedAt: now.toISOString(), source: 'Open-Meteo', model: 'east_west_tilted_radiation', arrayPowerKw: 8.5,
    performanceRatio: .85, panelTiltDegrees: 15, eastFraction: .5, weatherModel: 'meteoswiss_icon_ch2',
    productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString(), error: null, consumption };
}
function project(at: string, soc = 20, load = 1, solar = 0) {
  const now = new Date(at);
  return projectBatterySoc(now, telemetry(now, soc), controller, automation, [forecast(getLocalDate(now), now, load, solar)], config);
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('manual charging uses confirmed power across tariff boundaries without automatic top-ups', () => {
  const now = new Date('2026-10-26T15:50:00Z'); // 16:50 Zurich, five minutes before automatic cutoff.
  const control = { ...controller, mode: 'manual' as const, powerKw: 3, targetSocPercent: 100 };
  const state = { ...automation, status: 'manual_override' as const };
  const result = projectBatterySoc(now, telemetry(now), control, state,
    [forecast('2026-10-26', now, 1)], config, new Date('2026-10-26T16:50:00Z'));
  assert.equal(result.status, 'available');
  assert.equal(result.assumption, 'manual_charging');
  close(result.points.at(-1)!.socPercent, 20 + 3 * efficiency / 60 * 100);
  close(result.energyBalance!.gridKwh, 3 * efficiency);
});

test('manual charging reaches its target once, then resumes natural consumption for the full horizon', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const control = { ...controller, mode: 'manual' as const, powerKw: 3, targetSocPercent: 20.1 };
  const result = projectBatterySoc(now, telemetry(now), control,
    { ...automation, status: 'manual_override' }, [forecast('2026-10-26', now, 1)], config,
    new Date('2026-10-26T14:00:00Z'));
  assert.equal(result.status, 'available');
  const chargeHours = .06 / (3 * efficiency);
  close(result.points.at(-1)!.socPercent, 20.1 - (1 - chargeHours) / efficiency / 60 * 100);
  close(result.energyBalance!.gridKwh, .06);
  assert.ok(result.points.slice(2).every((point, index) => point.socPercent < result.points[index + 1].socPercent));
});

test('confirmed manual full charge can exceed the configured custom-target ceiling', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const result = projectBatterySoc(now, telemetry(now, 89), { ...controller, mode: 'manual', powerKw: 3,
    targetSocPercent: 100 }, { ...automation, status: 'manual_override' }, [forecast('2026-10-26', now, 0)], config,
  new Date('2026-10-26T16:00:00Z'));
  assert.equal(result.status, 'available');
  close(result.points.at(-1)!.socPercent, 100);
});

test('manual forecasts use the confirmed requested power after temporary site curtailment', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const result = projectBatterySoc(now, telemetry(now), { ...controller, mode: 'manual', powerKw: 0,
    requestedPowerKw: 3, targetSocPercent: 80 }, { ...automation, status: 'manual_override' },
  [forecast('2026-10-26', now, 1)], config, new Date('2026-10-26T14:00:00Z'));
  assert.equal(result.status, 'available');
  close(result.points.at(-1)!.socPercent, 20 + 3 * efficiency / 60 * 100);
});

test('manual charging respects a confirmed expiry and the household power ceiling', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const control = { ...controller, mode: 'manual' as const, powerKw: 3, targetSocPercent: 80,
    expiresAt: '2026-10-26T13:07:00Z' };
  const state = { ...automation, status: 'manual_override' as const };
  const result = projectBatterySoc(now, telemetry(now, 40), control, state,
    [forecast('2026-10-26', now, 15)], config, new Date('2026-10-26T13:10:00Z'));
  assert.equal(result.status, 'available');
  close(result.energyBalance!.gridKwh, efficiency * 7 / 60);
  close(result.energyBalance!.consumptionKwh, 7 * 3 / 60);
  assert.ok(result.points.some(point => point.at === control.expiresAt.replace('Z', '.000Z')));
});

test('confirmed manual forecasts work with automation disabled and a lower controller power ceiling', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const result = projectBatterySoc(now, telemetry(now), { ...controller, mode: 'manual', powerKw: 2,
    targetSocPercent: 80, revertTimeoutSeconds: undefined, limits: { ...controller.limits, maxPowerKw: 3 } },
  { ...automation, enabled: false, status: 'disabled' }, [forecast('2026-10-26', now)], { ...config, enabled: false },
  new Date('2026-10-26T14:00:00Z'));
  assert.equal(result.status, 'available');
  assert.equal(result.assumption, 'manual_charging');
  close(result.points.at(-1)!.socPercent, 20 + 2 * efficiency / 60 * 100);
});

test('manual forecasts reject unknown targets, unsafe power, unavailable controls and stale SOC', () => {
  const now = new Date('2026-10-26T13:00:00Z');
  const manual = { ...controller, mode: 'manual' as const, powerKw: 3, targetSocPercent: 80 };
  for (const control of [
    { ...manual, powerKw: null }, { ...manual, powerKw: -3 }, { ...manual, powerKw: 0 },
    { ...manual, powerKw: 7 }, { ...manual, targetSocPercent: null }, { ...manual, targetSocPercent: 101 },
    { ...manual, available: false }, { ...manual, error: 'unknown command outcome' },
    { ...manual, expiresAt: 'invalid' }, { ...manual, expiresAt: now.toISOString() },
    { ...manual, automationOwner: 'foreign' },
  ]) {
    const result = projectBatterySoc(now, telemetry(now), control, { ...automation, status: 'manual_override' },
      [forecast('2026-10-26', now)], config);
    assert.equal(result.status, 'unavailable', JSON.stringify(control));
    assert.deepEqual(result.points, []);
  }
  assert.equal(projectBatterySoc(now, { ...telemetry(now), status: 'stale' }, manual,
    { ...automation, status: 'manual_override' }, [forecast('2026-10-26', now)], config).status, 'unavailable');
});

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

test('deadline energy sources account for charge duration when the capacity cap is reached partway through a step', () => {
  const now = new Date('2026-10-24T14:50:00Z');
  const result = projectBatterySoc(now, telemetry(now, 79.8), {
    ...controller, mode: 'manual', automated: true, automationOwner: 'test', automationMode: 'charge',
    powerKw: 6, targetSocPercent: 80, limits: { ...controller.limits, maxSocPercent: 80 },
  }, { ...automation, nextEvaluationAt: '2026-10-24T14:55:00Z' },
  [forecast('2026-10-24', now, 1, 3)], config, new Date('2026-10-24T14:55:00Z'));
  close(result.points.at(-1)!.socPercent, 80);
  close(result.energyBalance!.solarKwh, .04);
  close(result.energyBalance!.gridKwh, .08);
  close(result.energyBalance!.consumptionKwh, 0);
});

test('deadline energy accounting balances the exact trajectory through consumption, solar and both charging windows', () => {
  const now = new Date('2026-10-25T17:03:21Z');
  const today = forecast('2026-10-25', now), tomorrow = forecast('2026-10-26', now);
  tomorrow.hourly!.forEach(hour => { hour.estimatedProductionKwh = hour.start >= '2026-10-26T09:00:00.000Z'
    && hour.start < '2026-10-26T14:00:00.000Z' ? 3 : 0; });
  tomorrow.estimatedProductionKwh = 15;
  syncQuarters(tomorrow);
  const result = projectBatterySoc(now, telemetry(now, 70), controller, automation, [today, tomorrow], config,
    new Date('2026-10-26T15:55:00Z'));
  const balance = result.energyBalance!;
  assert.ok(balance.solarKwh > 0 && balance.gridKwh > 0 && balance.consumptionKwh > 0);
  close(result.points.at(-1)!.socPercent / 100 * 60,
    42 + balance.solarKwh + balance.gridKwh - balance.consumptionKwh);
});

test('anchors to measured SOC and uses a short first interval before real five-minute boundaries', () => {
  const result = project('2026-10-24T15:01:27Z');
  assert.equal(result.status, 'available');
  assert.equal(result.observedAt, '2026-10-24T15:01:27.000Z');
  assert.deepEqual(result.points[0], { at: '2026-10-24T15:01:27.000Z', socPercent: 20 });
  assert.equal(result.points[1].at, '2026-10-24T15:05:00.000Z');
  close(result.points[1].socPercent, 20 - (213 / 3600) / efficiency / 60 * 100);
  assert.ok(result.points.every(point => point.at >= result.points[0].at));
});

test('five-minute afternoon cutoff changes hold to discharge, including the cheap-tariff bridge', () => {
  const result = project('2026-10-24T14:50:00Z', 85);
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  close(at('2026-10-24T14:55:00.000Z'), 85);
  close(at('2026-10-24T15:00:00.000Z'), 85 - (1 / 12) / efficiency / 60 * 100);
});

test('confirmed charge keeps its active target until the actual next planner evaluation', () => {
  const now = new Date('2026-10-24T14:31:00Z'); // 16:31 Zurich.
  const control = { ...controller, mode: 'manual' as const, automated: true, automationOwner: 'owner',
    automationMode: 'charge' as const, powerKw: 6, targetSocPercent: 50, expiresAt: '2026-10-24T14:46:00Z' };
  const automatic = { ...automation, status: 'charging' as const, nextEvaluationAt: '2026-10-24T14:45:00Z' };
  const result = projectBatterySoc(now, telemetry(now, 20), control, automatic, [forecast('2026-10-24', now)],
    { ...config, afternoonTargetSocPercent: 0 });
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  close(at('2026-10-24T14:35:00.000Z'), 20 + 6 * efficiency * 4 / 60 / 60 * 100);
  close(at('2026-10-24T14:45:00.000Z'), 20 + 6 * efficiency * 14 / 60 / 60 * 100);
  close(at('2026-10-24T14:50:00.000Z'), at('2026-10-24T14:45:00.000Z'));
});

test('confirmed hold is not immediately replaced by a new forecast charge target', () => {
  const now = new Date('2026-10-24T14:31:00Z');
  const control = { ...controller, mode: 'manual' as const, automated: true, automationOwner: 'owner',
    automationMode: 'hold' as const, powerKw: 0, expiresAt: '2026-10-24T14:46:00Z' };
  const automatic = { ...automation, status: 'holding' as const, nextEvaluationAt: '2026-10-24T14:45:00Z' };
  const result = projectBatterySoc(now, telemetry(now, 5), control, automatic, [forecast('2026-10-24', now)], config);
  close(result.points.find(point => point.at === '2026-10-24T14:45:00.000Z')!.socPercent, 5);
  close(result.points.find(point => point.at === '2026-10-24T14:50:00.000Z')!.socPercent, 5 + 6 * efficiency / 12 / 60 * 100);
});

test('renewing an intermediate lease preserves charging until the next evaluation', () => {
  const now = new Date('2026-10-24T14:31:00Z');
  const control = { ...controller, mode: 'manual' as const, automated: true, automationOwner: 'owner',
    automationMode: 'charge' as const, powerKw: 6, targetSocPercent: 50, expiresAt: '2026-10-24T14:38:17Z' };
  const automatic = { ...automation, status: 'charging' as const, nextEvaluationAt: '2026-10-24T14:45:00Z' };
  const result = projectBatterySoc(now, telemetry(now, 20), control, automatic, [forecast('2026-10-24', now)], config);
  const evaluated = result.points.find(point => point.at === '2026-10-24T14:45:00.000Z')!;
  close(evaluated.socPercent, 20 + 6 * efficiency * 14 / 60 / 60 * 100);
});

test('forced charging continues through the final seconds and stops at the window cutoff', () => {
  const now = new Date('2026-10-24T14:50:00Z');
  const control = { ...controller, mode: 'manual' as const, automated: true, automationOwner: 'owner',
    automationMode: 'charge' as const, powerKw: 6, targetSocPercent: 50, expiresAt: '2026-10-24T14:56:00Z' };
  const automatic = { ...automation, status: 'charging' as const, nextEvaluationAt: '2026-10-24T15:00:00Z' };
  const result = projectBatterySoc(now, telemetry(now, 20), control, automatic, [forecast('2026-10-24', now, 4)], config);
  const ended = result.points.find(point => point.at === '2026-10-24T14:55:00.000Z')!;
  close(ended.socPercent, 20 + 6 * efficiency * 300 / 3600 / 60 * 100);
  assert.ok(result.points.find(point => point.at === '2026-10-24T15:00:00.000Z')!.socPercent < ended.socPercent);
});

test('opening afternoon buffer holds before charging at 12:05 and follows the shared planner target', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const data = forecast('2026-10-24', now);
  const result = projectBatterySoc(now, telemetry(now, 40), controller, automation, [data], config);
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  close(at('2026-10-24T10:05:00.000Z'), 40);
  close(at('2026-10-24T10:10:00.000Z'), 40 + 6 * efficiency / 12 / 60 * 100);
  const plannedAt = new Date('2026-10-24T10:05:00Z');
  const plan = planBatteryCharge(plannedAt, telemetry(plannedAt, 40), { ...data, fetchedAt: plannedAt.toISOString() }, config,
    { ...controller.limits, revertTimeoutSeconds: controller.revertTimeoutSeconds });
  close(at('2026-10-24T14:55:00.000Z'), plan.targetSocPercent!);
});

test('night target prepares the morning and preferred afternoon SOC, and releases at 06:55', () => {
  const now = new Date('2026-10-24T21:05:00Z'); // 23:05 before the autumn DST transition.
  const today = forecast('2026-10-24', now);
  const tomorrow = forecast('2026-10-25', now);
  const result = projectBatterySoc(now, telemetry(now, 5), controller, automation, [today, tomorrow], config);
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  const plan = planBatteryCharge(now, telemetry(now, 5), tomorrow, config,
    { ...controller.limits, revertTimeoutSeconds: controller.revertTimeoutSeconds });
  close(at('2026-10-25T05:55:00.000Z'), plan.targetSocPercent!);
  assert.equal(plan.afternoonTargetSocPercent, 80);
  assert.ok(plan.targetSocPercent! > 80);
  assert.ok(at('2026-10-25T15:55:00.000Z') >= 80);
  assert.ok(at('2026-10-25T06:00:00.000Z') < at('2026-10-25T05:55:00.000Z'));
  assert.ok(result.points.some(point => point.at === '2026-10-24T22:00:00.000Z')); // Zurich midnight.
  assert.equal(result.points.at(-1)!.at, '2026-10-25T22:05:00.000Z'); // Needs unavailable Monday forecast here.
});

test('both low-tariff windows reach the next-day 80% goal when night charging alone cannot', () => {
  const now = new Date('2026-01-15T22:05:00Z');
  const today = forecast('2026-01-15', now);
  const tomorrow = forecast('2026-01-16', now);
  const result = projectBatterySoc(now, telemetry(now, 5), controller, automation, [today, tomorrow], config);
  assert.equal(result.status, 'available');
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  const nightPlan = planBatteryCharge(now, telemetry(now, 5), tomorrow, config,
    { ...controller.limits, revertTimeoutSeconds: 30 });
  assert.ok(at('2026-01-16T05:55:00.000Z') < nightPlan.targetSocPercent!);
  assert.ok(at('2026-01-16T11:15:00.000Z') < 80);
  assert.ok(at('2026-01-16T11:20:00.000Z') > at('2026-01-16T11:15:00.000Z'));
  assert.ok(at('2026-01-16T15:55:00.000Z') >= 80, `afternoon SOC ${at('2026-01-16T15:55:00.000Z')}`);
  assert.ok(at('2026-01-16T16:00:00.000Z') < at('2026-01-16T15:55:00.000Z'));
});

test('useful daytime solar leaves overnight room without sacrificing the morning load or afternoon goal', () => {
  const now = new Date('2026-01-15T22:05:00Z');
  const today = forecast('2026-01-15', now);
  const cloudy = forecast('2026-01-16', now);
  for (const hour of cloudy.consumption.hourly) {
    const localHour = new Date(hour.start).getUTCHours() + 1;
    if (localHour >= 7 && localHour < 12) hour.estimatedConsumptionKwh = 3;
  }
  cloudy.consumption.estimatedConsumptionKwh = cloudy.consumption.hourly.reduce((sum, hour) => sum + hour.estimatedConsumptionKwh, 0);
  syncQuarters(cloudy);
  const sunny = structuredClone(cloudy);
  for (const hour of sunny.hourly!) {
    const localHour = new Date(hour.start).getUTCHours() + 1;
    if (localHour >= 12 && localHour < 17) hour.estimatedProductionKwh = 7;
  }
  sunny.estimatedProductionKwh = 35;
  syncQuarters(sunny);
  const limits = { ...controller.limits, revertTimeoutSeconds: 30 };
  const sunnyPlan = planBatteryCharge(now, telemetry(now, 5), sunny, config, limits);
  const cloudyPlan = planBatteryCharge(now, telemetry(now, 5), cloudy, config, limits);
  assert.ok(sunnyPlan.targetSocPercent! < cloudyPlan.targetSocPercent!);
  assert.ok(sunnyPlan.targetSocPercent! > 5 + 15 / efficiency / 60 * 100);
  const result = projectBatterySoc(now, telemetry(now, 5), controller, automation, [today, sunny], config);
  const at = (stamp: string) => result.points.find(point => point.at === stamp)!.socPercent;
  assert.ok(at('2026-01-16T11:00:00.000Z') >= 5);
  assert.ok(at('2026-01-16T11:15:00.000Z') < 80);
  assert.ok(at('2026-01-16T15:55:00.000Z') >= 80, `afternoon SOC ${at('2026-01-16T15:55:00.000Z')}; night target ${sunnyPlan.targetSocPercent}`);
  assert.ok(result.points.every(point => point.socPercent >= 5 && point.socPercent <= 90));
});

test('evening needs above the preferred 80% goal retain the higher reserve-protected target', () => {
  const now = new Date('2026-01-15T22:05:00Z');
  const today = forecast('2026-01-15', now);
  const tomorrow = forecast('2026-01-16', now);
  for (const hour of tomorrow.consumption.hourly) {
    const localHour = new Date(hour.start).getUTCHours() + 1;
    if (localHour >= 17 && localHour < 23) hour.estimatedConsumptionKwh = 6.5;
  }
  tomorrow.consumption.estimatedConsumptionKwh = tomorrow.consumption.hourly.reduce((sum, hour) => sum + hour.estimatedConsumptionKwh, 0);
  syncQuarters(tomorrow);
  const protectedController = { ...controller, limits: { ...controller.limits, reserveSocPercent: 10 } };
  const protectedConfig = { ...config, reserveSocPercent: 10 };
  const plan = planBatteryCharge(now, telemetry(now, 50), tomorrow, protectedConfig,
    { ...protectedController.limits, revertTimeoutSeconds: 30 });
  assert.ok(plan.afternoonTargetSocPercent! > 80);
  const result = projectBatterySoc(now, telemetry(now, 50), protectedController, automation, [today, tomorrow], config);
  const afternoon = result.points.find(point => point.at === '2026-01-16T15:55:00.000Z')!;
  assert.ok(afternoon.socPercent >= plan.afternoonTargetSocPercent!);
});

test('projection stops when a future night target is unknown and does not fabricate past or missing days', () => {
  const result = project('2026-10-24T15:00:00Z');
  assert.equal(result.status, 'available');
  assert.equal(result.reason, 'forecast_unavailable');
  assert.equal(result.points.at(-1)!.at, '2026-10-24T21:05:00.000Z');
  assert.ok(result.points.every(point => getLocalDate(new Date(point.at)) === '2026-10-24'));
  assert.equal(project('2026-10-24T21:05:00Z').status, 'unavailable');
});

test('a third-day planner forecast fills tomorrow’s final hour through its midnight endpoint only', () => {
  const now = new Date('2026-01-15T15:00:00Z');
  const data = ['2026-01-15', '2026-01-16', '2026-01-17'].map(date => forecast(date, now));
  const result = projectBatterySoc(now, telemetry(now), controller, automation, data, config);
  const end = getCalendarDayBounds(new Date('2026-01-16T00:00:00Z')).end.toISOString();
  assert.equal(result.status, 'available'); assert.equal(result.reason, null);
  assert.equal(result.points.at(-1)!.at, end);
  assert.ok(result.points.some(point => point.at === '2026-01-16T22:55:00.000Z'));
  assert.ok(result.points.every(point => point.at <= end), 'third-day forecast supplies decisions, never another chart day');
  for (const retained of data) {
    retained.status = 'stale';
    retained.fetchedAt = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  }
  assert.deepEqual(projectBatterySoc(now, telemetry(now), controller, automation, data, config), result);
});

test('tomorrow’s 23:05 night decision uses actual third-day needs rather than reusing tomorrow', () => {
  const now = new Date('2026-01-15T15:00:00Z');
  const today = forecast('2026-01-15', now, 0), tomorrow = forecast('2026-01-16', now, 0);
  const low = projectBatterySoc(now, telemetry(now), controller, automation,
    [today, tomorrow, forecast('2026-01-17', now, 0)], config);
  const high = projectBatterySoc(now, telemetry(now), controller, automation,
    [today, tomorrow, forecast('2026-01-17', now, 4)], config);
  const change = '2026-01-16T22:05:00.000Z';
  const lowAtChange = low.points.find(point => point.at === change)!.socPercent;
  const highAtChange = high.points.find(point => point.at === change)!.socPercent;
  close(lowAtChange, highAtChange);
  close(low.points.at(-1)!.socPercent, lowAtChange);
  close(high.points.at(-1)!.socPercent, highAtChange + 6 * efficiency * (55 / 60) / 60 * 100);
  assert.ok(high.points.at(-1)!.socPercent > low.points.at(-1)!.socPercent);
});

test('missing, offline or malformed third-day lookahead preserves the valid prefix and explicit missing-forecast reason', () => {
  const now = new Date('2026-01-15T15:00:00Z');
  const firstTwo = [forecast('2026-01-15', now), forecast('2026-01-16', now)];
  const missing = projectBatterySoc(now, telemetry(now), controller, automation, firstTwo, config);
  assert.equal(missing.status, 'available'); assert.equal(missing.reason, 'forecast_unavailable');
  assert.equal(missing.points.at(-1)!.at, '2026-01-16T22:05:00.000Z');
  for (const mutate of [
    (value: EnergyForecast) => { value.status = 'offline'; },
    (value: EnergyForecast) => { value.fetchedAt = 'invalid'; },
    (value: EnergyForecast) => { value.fetchedAt = new Date(now.getTime() + 5001).toISOString(); },
    (value: EnergyForecast) => { value.hourly!.pop(); },
    (value: EnergyForecast) => { value.consumption.date = '2026-01-16'; },
    (value: EnergyForecast) => { value.consumption.hourly[0].estimatedConsumptionKwh = NaN; },
    (value: EnergyForecast) => { value.date = '2026-01-18'; },
  ]) {
    const third = forecast('2026-01-17', now); mutate(third);
    const result = projectBatterySoc(now, telemetry(now), controller, automation, [...firstTwo, third], config);
    assert.deepEqual(result, missing);
  }
  const noTomorrow = projectBatterySoc(now, telemetry(now), controller, automation,
    [firstTwo[0], forecast('2026-01-17', now)], config);
  assert.equal(noTomorrow.points.at(-1)!.at, '2026-01-15T22:05:00.000Z');
  assert.equal(noTomorrow.reason, 'forecast_unavailable');
});

test('third-day lookahead completes 23- and 25-hour tomorrow projections at the correct Zurich midnight', () => {
  for (const [day, nextDay, thirdDay, at, hours] of [
    ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-28T15:00:00Z', 23],
    ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-24T15:00:00Z', 25],
  ] as const) {
    const now = new Date(at);
    const data = [day, nextDay, thirdDay].map(date => forecast(date, now, 0));
    assert.equal(data[1].hourly!.length, hours);
    const result = projectBatterySoc(now, telemetry(now), controller, automation, data, config);
    const end = getCalendarDayBounds(new Date(`${nextDay}T00:00:00Z`)).end.toISOString();
    assert.equal(result.status, 'available'); assert.equal(result.reason, null);
    assert.equal(result.points.at(-1)!.at, end);
    assert.ok(result.points.every((point, index) => point.at <= end
      && (index === 0 || (Date.parse(point.at) > Date.parse(result.points[index - 1].at)
        && Date.parse(point.at) - Date.parse(result.points[index - 1].at) <= 300_000))));
  }
});

test('retained forecasts remain usable after refresh failures without resetting their timestamps', () => {
  const now = new Date('2026-10-24T10:05:00Z');
  const data = forecast('2026-10-24', now);
  data.fetchedAt = new Date(now.getTime() - 3_600_000).toISOString();
  const result = projectBatterySoc(now, telemetry(now), controller, automation, [data], config);
  assert.equal(result.status, 'available');
  assert.equal(result.points.at(-1)!.at, '2026-10-24T21:05:00.000Z');
  data.status = 'stale';
  data.fetchedAt = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  data.error = 'Les prévisions météo sont indisponibles.';
  assert.deepEqual(projectBatterySoc(now, telemetry(now), controller, automation, [data], config), result);
  assert.equal(data.fetchedAt, '2026-10-23T22:05:00.000Z');
});

test('total headroom limits forced charging to five kilowatts without discharging the held battery', () => {
  const result = project('2026-10-24T10:05:00Z', 5, 11);
  assert.equal(result.status, 'available');
  close(result.points.find(point => point.at === '2026-10-24T14:55:00.000Z')!.socPercent, 5 + 5 * efficiency * (4 + 50 / 60) / 60 * 100);
  assert.ok(project('2026-10-24T10:05:00Z', 5, 10).points[1].socPercent > 5);
});

test('solar production cannot create extra gross charging allowance above sixteen kilowatts', () => {
  const result = project('2026-10-24T10:05:00Z', 5, 16, 20);
  assert.equal(result.status, 'available');
  close(result.points.find(point => point.at === '2026-10-24T14:55:00.000Z')!.socPercent, 5);
});

test('forced battery charge is 6 kW total even with solar surplus', () => {
  const result = project('2026-10-24T10:05:00Z', 5, 5, 4);
  close(result.points[1].socPercent, 5 + 6 * efficiency / 12 / 60 * 100);
  // Increase solar at the current hour only: future target still needs charging.
  const now = new Date('2026-10-24T10:05:00Z');
  const data = forecast('2026-10-24', now, 5, 4);
  data.hourly!.find(hour => hour.start === '2026-10-24T10:00:00.000Z')!.estimatedProductionKwh = 8;
  data.estimatedProductionKwh = 100;
  syncQuarters(data);
  const surplus = projectBatterySoc(now, telemetry(now, 5), controller, automation, [data], config);
  close(surplus.points[1].socPercent, 5 + 6 * efficiency / 12 / 60 * 100);
});

test('hold accepts solar while normal discharge is capped at 7 kW and protected reserve', () => {
  assert.ok(project('2026-10-24T10:05:00Z', 40, 0, 2).points[1].socPercent > 40);
  const discharge = project('2026-10-24T15:00:00Z', 50, 20);
  close(discharge.points[1].socPercent, 50 - 7 / 12 / 60 * 100);
  assert.ok(discharge.points.every(point => point.socPercent >= 5));
});

test('inverter reserve and configured reserve are both respected and empty protected energy is never invented', () => {
  const now = new Date('2026-10-24T15:00:00Z');
  const data = forecast('2026-10-24', now, 4);
  const higher = projectBatterySoc(now, telemetry(now, 20), { ...controller, limits: { ...controller.limits, reserveSocPercent: 12 } }, automation, [data], config);
  close(higher.points.at(-1)!.socPercent, 12);
  const configured = projectBatterySoc(now, telemetry(now, 20), controller, automation, [data], { ...config, reserveSocPercent: 15 });
  close(configured.points.at(-1)!.socPercent, 15);
  const below = projectBatterySoc(now, telemetry(now, 3), controller, automation, [data], config);
  below.points.forEach(point => close(point.socPercent, 3));
});

test('SOC stays physical without clipping an actual SOC above the configured maximum', () => {
  const result = project('2026-10-24T15:00:00Z', 95, 0, 8);
  assert.ok(result.points.every(point => point.socPercent === 95));
  const capped = project('2026-10-24T15:00:00Z', 89.9, 0, 100);
  assert.ok(capped.points.every(point => point.socPercent >= 0 && point.socPercent <= 90));
});

test('spring and autumn DST preserve real five-minute chronology and duplicate local hours', () => {
  for (const [day, nextDay, start, expectedHours] of [
    ['2026-03-28', '2026-03-29', '2026-03-28T22:05:00Z', 23],
    ['2026-10-24', '2026-10-25', '2026-10-24T21:05:00Z', 25],
  ] as const) {
    const now = new Date(start);
    const next = forecast(nextDay, now, 0);
    assert.equal(next.hourly!.length, expectedHours);
    const result = projectBatterySoc(now, telemetry(now), controller, automation, [forecast(day, now, 0), next], config);
    assert.equal(result.status, 'available');
    assert.ok(result.points.every((point, index) => index === 0 || Date.parse(point.at) - Date.parse(result.points[index - 1].at) === 300_000));
    assert.equal(result.points.at(-1)!.at, nextDay === '2026-03-29' ? '2026-03-29T21:05:00.000Z' : '2026-10-25T22:05:00.000Z');
  }
});

test('blocked automation projects passive solar and demand through tomorrow without scheduled charging', () => {
  const now = new Date('2026-10-24T21:05:00Z');
  const days = [forecast('2026-10-24', now, 1), forecast('2026-10-25', now, 1)];
  const broken = { ...controller, available: false, mode: 'unknown' as const,
    revertTimeoutSeconds: undefined, error: 'Inverter warning' };
  for (const state of [
    { ...automation, status: 'blocked' as const, error: 'Inverter warning' },
    { ...automation, status: 'error' as const },
    { ...automation, error: 'Planner unavailable' },
  ]) {
    const result = projectBatterySoc(now, telemetry(now, 40), broken, state, days, config);
    assert.equal(result.status, 'available');
    assert.equal(result.assumption, 'passive_operation');
    assert.equal(result.reason, null);
    assert.equal(result.points[0].socPercent, 40);
    assert.equal(result.points.at(-1)!.at, '2026-10-25T23:00:00.000Z');
    close(result.points[1].socPercent, 40 - 1 / 12 / efficiency / 60 * 100);
    assert.ok(result.points.every((point, i) => point.socPercent >= 5
      && (i === 0 || point.socPercent <= result.points[i - 1].socPercent)));
  }
  const plannerError = projectBatterySoc(now, telemetry(now, 40), controller,
    { ...automation, status: 'blocked' }, days, config);
  assert.equal(plannerError.assumption, 'passive_operation');
  close(plannerError.points[1].socPercent, 40 - 1 / 12 / efficiency / 60 * 100);
});

test('controller outages retain a passive forecast with solar, known limits and fresh SOC', () => {
  const now = new Date('2026-10-24T10:05:00Z');
  for (const control of [
    { ...controller, available: false }, { ...controller, mode: 'unknown' as const },
    { ...controller, error: 'Inverter warning' },
    { ...controller, available: false, limits: { maxPowerKw: 2, maxSocPercent: 50, reserveSocPercent: null }, revertTimeoutSeconds: undefined },
  ]) {
    const result = projectBatterySoc(now, telemetry(now, 40), control, automation,
      [forecast('2026-10-24', now, 1, 5)], config);
    assert.equal(result.status, 'available');
    assert.equal(result.assumption, 'passive_operation');
    assert.equal(result.points.at(-1)!.at, '2026-10-24T22:00:00.000Z');
    close(result.points[1].socPercent, 40 + Math.min(4, control.limits.maxPowerKw) * efficiency / 12 / 60 * 100);
    assert.ok(result.points.every(point => point.socPercent <= control.limits.maxSocPercent));
    assert.equal(projectBatterySoc(now, { ...telemetry(now), status: 'stale' }, control, automation,
      [forecast('2026-10-24', now)], config).status, 'unavailable');
    assert.equal(projectBatterySoc(now, telemetry(now), control, automation, [], config).status, 'unavailable');
  }
});

test('invalid SOC, manual overrides and invalid planning limits return an empty unavailable curve', () => {
  const now = new Date('2026-10-24T15:00:00Z');
  const data = [forecast('2026-10-24', now)];
  for (const actual of [ { ...telemetry(now), batterySocPercent: null }, { ...telemetry(now), status: 'stale' as const },
    { ...telemetry(now), observedAt: '2026-10-24T14:59:29Z' }, { ...telemetry(now), observedAt: '2026-10-24T15:00:06Z' } ]) {
    assert.deepEqual(projectBatterySoc(now, actual, controller, automation, data, config).points, []);
  }
  for (const state of [{ ...automation, enabled: false }, { ...automation, status: 'manual_override' as const }]) {
    assert.equal(projectBatterySoc(now, telemetry(now), controller, state, data, config).status, 'unavailable');
  }
  for (const control of [{ ...controller, mode: 'manual' as const }, { ...controller, limits: { ...controller.limits, reserveSocPercent: null } },
    { ...controller, limits: { ...controller.limits, maxSocPercent: 4 } }]) {
    assert.equal(projectBatterySoc(now, telemetry(now), control, automation, data, config).status, 'unavailable');
  }
  const owned = { ...controller, mode: 'manual' as const, powerKw: 0, automated: true, automationOwner: 'owner', automationMode: 'hold' as const };
  assert.equal(projectBatterySoc(now, telemetry(now), owned, automation, data, config).status, 'available');
});

test('malformed, shifted and incomplete forecasts are ignored without filling a missing current day', () => {
  const now = new Date('2026-10-24T15:00:00Z');
  const invalid: Array<(value: EnergyForecast) => void> = [
    value => { value.status = 'offline'; }, value => { value.date = '2026-02-31'; },
    value => { value.consumption.date = '2026-10-25'; }, value => { value.hourly!.pop(); },
    value => { value.hourly![0].start = value.hourly![1].start; },
    value => { value.estimatedProductionKwh = 10; }, value => { value.consumption.estimatedConsumptionKwh = 10; },
    value => { value.consumption.hourly[0].estimatedConsumptionKwh = NaN; },
    value => { value.fetchedAt = new Date(now.getTime() + 5001).toISOString(); },
  ];
  for (const mutate of invalid) {
    const value = forecast('2026-10-24', now);
    mutate(value);
    const result = projectBatterySoc(now, telemetry(now), controller, automation, [value, forecast('2026-10-25', now)], config);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.points, []);
  }
});

test('invalid capacity, reserve, margin or controller power never produce an estimate', () => {
  const now = new Date('2026-10-24T15:00:00Z');
  const data = [forecast('2026-10-24', now)];
  for (const settings of [{ ...config, enabled: false }, { ...config, socCapacityKwh: 0 },
    { ...config, socCapacityKwh: NaN }, { ...config, reserveSocPercent: 100 },
    { ...config, energyBufferPercent: -1 }, { ...config, minimumEnergyBufferKwh: 61 },
    { ...config, afternoonTargetSocPercent: -1 }, { ...config, afternoonTargetSocPercent: 101 },
    { ...config, afternoonTargetSocPercent: NaN }]) {
    assert.equal(projectBatterySoc(now, telemetry(now), controller, automation, data, settings).status, 'unavailable');
  }
  assert.equal(projectBatterySoc(now, telemetry(now), { ...controller, limits: { ...controller.limits, maxPowerKw: 5 } }, automation, data, config).status, 'unavailable');
  for (const fallback of [undefined, 9, 121, NaN]) {
    assert.equal(projectBatterySoc(now, telemetry(now), { ...controller, revertTimeoutSeconds: fallback }, automation, data, config).status, 'unavailable');
  }
  assert.equal(projectBatterySoc(new Date(NaN), telemetry(now), controller, automation, data, config).status, 'unavailable');
});

test('temperature data is not required, inputs remain unchanged and no future curve is claimed without a next-day target', () => {
  const now = new Date('2026-10-24T15:00:00Z');
  const inputs = { actual: telemetry(now), control: structuredClone(controller), automatic: structuredClone(automation),
    data: [forecast('2026-10-24', now)], settings: structuredClone(config) };
  const before = structuredClone(inputs);
  const result = projectBatterySoc(now, inputs.actual, inputs.control, inputs.automatic, inputs.data, inputs.settings);
  assert.equal(result.status, 'available');
  assert.deepEqual(inputs, before);
  assert.equal(result.assumption, 'automatic_planning');
});
