import test from 'node:test';
import assert from 'node:assert/strict';
import { carSolarBatteryBudget } from '../src/car-battery-budget.js';
import { loadAutomationConfig } from '../src/automation-config.js';
import { estimateConsumption, loadConsumptionConfig } from '../src/consumption.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { EnergyForecast } from '../src/automation-plan.js';
import type { BatteryOriginSnapshot } from '../src/battery-origin.js';
import type { Telemetry } from '../src/status.js';
import type { WattpilotTelemetry } from '../src/wattpilot.js';

const now = new Date('2026-10-25T23:10:00+01:00');
function fixture() {
  const consumption = estimateConsumption('2026-10-26', { ...loadConsumptionConfig({}), baselinePowerW: 1000 });
  const bounds = getCalendarDayBounds(new Date('2026-10-26T00:00:00Z'));
  const forecast: EnergyForecast = { status: 'online', date: '2026-10-26', fetchedAt: now.toISOString(),
    estimatedProductionKwh: 0, locationName: 'Test', weatherCode: 0, temperatureMinC: 10, temperatureMaxC: 10, temperatureMeanC: 10,
    source: 'Open-Meteo', model: 'east_west_tilted_radiation', arrayPowerKw: 8.5, performanceRatio: .85,
    panelTiltDegrees: 15, eastFraction: .5, weatherModel: 'meteoswiss_icon_ch2', error: null,
    productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString(),
    quarterHourly: consumption.quarterHourly.map(slot => ({ start: slot.start, end: slot.end, estimatedProductionKwh: 0, temperatureC: null })),
    hourly: consumption.hourly.map(slot => ({ start: slot.start, end: slot.end, estimatedProductionKwh: 0, temperatureC: null })), consumption };
  const origin: BatteryOriginSnapshot = { available: true, solarStoredKwh: 10, storedKwh: 48, observedAt: now.toISOString(), error: null,
    night: { id: '2026-10-26T06:00:00.000Z', valid: true, solarAtStartKwh: 10, storedAtStartKwh: 48, dischargedKwh: 0 } };
  const telemetry: Telemetry = { status: 'online', observedAt: now.toISOString(), error: null,
    solarKw: 0, householdKw: 3.33, gridImportKw: 3.33, gridExportKw: 0, batterySocPercent: 80,
    batteryChargeKw: 0, batteryDischargeKw: 0 };
  const charger = { status: 'online', ready: true, stale: false, charging: true,
    powerObservedAt: now.toISOString(), powerWatts: 2830 } as WattpilotTelemetry;
  return { now, origin, telemetry, charger, forecasts: [forecast],
    config: loadAutomationConfig({ AUTOMATION_ENABLED: 'true' }),
    limits: { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: 5 }, supplySupported: true };
}
test('night permission uses only proven solar, protects chronological next-high demand and caps actual car draw', () => {
  const input = fixture();
  const budget = carSolarBatteryBudget(input);
  assert.equal(budget.available, true);
  assert.ok(budget.protectedStoredKwh! > 8);
  assert.ok(budget.usableStoredKwh > 0 && budget.usableStoredKwh <= 9.4);
  assert.ok(budget.minimumSocPercent! / 100 * 60 >= budget.protectedStoredKwh!);
  assert.equal(budget.maxDischargeKw, 2.83);
  input.origin.solarStoredKwh = 0;
  const gridStored = carSolarBatteryBudget(input);
  assert.equal(gridStored.usableStoredKwh, 0);
  assert.equal(gridStored.maxDischargeKw, 0);
});

test('the 06:55 car checkpoint does not roll the protected 07–12 reserve to tomorrow', () => {
  const input = fixture();
  const at = new Date('2026-10-26T06:57:00+01:00');
  input.now = at;
  input.telemetry.observedAt = at.toISOString();
  input.origin.observedAt = at.toISOString();
  input.charger.powerObservedAt = at.toISOString();
  input.forecasts[0].fetchedAt = at.toISOString();
  const budget = carSolarBatteryBudget(input);
  assert.equal(budget.available, true);
  assert.ok(budget.protectedStoredKwh! > 8);
  assert.ok(budget.usableStoredKwh > 0);
});
test('unknown initial energy and unexplained positive SOC jumps cannot increase the discharge allowance', () => {
  const input = fixture();
  input.telemetry.batterySocPercent = 95;
  const result = carSolarBatteryBudget(input);
  const measuredEnergy = .95 * 60;
  const energyToFloor = measuredEnergy - result.minimumSocPercent! / 100 * 60;
  assert.ok(energyToFloor <= result.usableStoredKwh + 1e-8);
  assert.ok(energyToFloor <= input.origin.solarStoredKwh!);
  input.origin.solarStoredKwh = .5;
  assert.equal(carSolarBatteryBudget(input).usableStoredKwh, 0, 'quantized flat SOC cannot create spendable solar credit');
});
test('missing origin, forecast, controller support or next-high coverage never authorizes storage use', () => {
  for (const kind of ['origin', 'forecast', 'support', 'reserve', 'stale', 'invalid-origin'] as const) {
    const input = fixture();
    if (kind === 'origin') input.origin.available = false;
    if (kind === 'forecast') input.forecasts = [];
    if (kind === 'support') input.supplySupported = false;
    if (kind === 'reserve') input.telemetry.batterySocPercent = 5;
    if (kind === 'stale') input.telemetry.observedAt = '2026-10-25T21:00:00.000Z';
    if (kind === 'invalid-origin') input.origin.solarStoredKwh = Infinity;
    const result = carSolarBatteryBudget(input);
    assert.equal(result.usableStoredKwh, 0, kind);
    assert.equal(result.maxDischargeKw, 0, kind);
  }
});
test('night permission needs fresh actual car consumption and is never available in the afternoon', () => {
  const input = fixture();
  input.charger.charging = false;
  assert.equal(carSolarBatteryBudget(input).maxDischargeKw, 0);
  input.charger.charging = true;
  input.charger.powerObservedAt = new Date(now.getTime() - 5000).toISOString();
  assert.equal(carSolarBatteryBudget(input).maxDischargeKw, 0);
  input.now = new Date('2026-10-26T13:00:00+01:00');
  assert.equal(carSolarBatteryBudget(input).usableStoredKwh, 0);
});

test('night grid deposits cannot unlock initially protected solar or replenish a spent night allowance', () => {
  const input = fixture();
  input.origin.night!.storedAtStartKwh = 8;
  input.origin.night!.solarAtStartKwh = 8;
  // Current storage48 could include40kWh bought after the night began. It
  // cannot make the original8kWh, needed for next high tariff, available to EV.
  assert.equal(carSolarBatteryBudget(input).usableStoredKwh, 0);
  input.origin.night!.storedAtStartKwh = 48;
  input.origin.night!.solarAtStartKwh = 10;
  const initial = carSolarBatteryBudget(input).usableStoredKwh;
  input.origin.night!.dischargedKwh = 10;
  input.origin.storedKwh = 54;
  input.telemetry.batterySocPercent = 90;
  assert.ok(initial > 0);
  assert.equal(carSolarBatteryBudget(input).usableStoredKwh, 0, 'later grid charging cannot restore spent permission');
  input.origin.night!.valid = false;
  assert.equal(carSolarBatteryBudget(input).usableStoredKwh, 0);
});
