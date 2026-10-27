import test from 'node:test';
import assert from 'node:assert/strict';
import { getCarForceWindow, planCarCharge, validateCarTargetOverride } from '../src/car-plan.js';
import { loadCarAutomationConfig } from '../src/car-config.js';
import type { CarPlanInput, SolarBatterySupport } from '../src/car-types.js';
import { unavailableWattpilot } from '../src/wattpilot.js';
import { getNightTariffEnd } from '../src/policy.js';

function input(at = '2026-10-26T00:00:00+01:00'): CarPlanInput {
  const now = new Date(at), observedAt = now.toISOString();
  return { now, config: loadCarAutomationConfig({}),
    car: { status: 'online', vehicleName: 'Model3', socPercent: 20, chargeLimitPercent: 80,
      chargingState: 'Stopped', observedAt, error: null },
    charger: { ...unavailableWattpilot(), status: 'online', configured: true, ready: true, connected: true,
      controlEnabled: true, observedAt, powerObservedAt: observedAt, mode: 'normal', carConnected: true,
      charging: false, allowedCharging: false, currentAmps: 6, powerWatts: 0,
      phaseMode: 3, phaseSwitchingSupported: true, limits: { minCurrentAmps: 6, maxCurrentAmps: 16 } },
    telemetry: { status: 'online', observedAt, error: null, solarKw: 0, householdKw: .5,
      gridImportKw: .5, gridExportKw: 0, batterySocPercent: 50, batteryChargeKw: 0, batteryDischargeKw: 0 },
    battery: { available: true, automatic: true, requestedPowerKw: 6, socPercent: 50, goalSocPercent: 80 }, forecasts: [] };
}
function support(changes: Partial<SolarBatterySupport> = {}): SolarBatterySupport {
  return { available: true, solarStoredKwh: 2, protectedStoredKwh: 30, usableStoredKwh: 1,
    minimumSocPercent: 50, maxDischargeKw: 2, ...changes };
}
function chargingWithSupport(at?: string) {
  const f = input(at);
  f.battery.socPercent = 60; f.battery.solarSupport = support();
  f.charger.charging = true; f.charger.allowedCharging = true; f.charger.powerWatts = 3500;
  f.telemetry.gridImportKw = 4; f.telemetry.householdKw = 4; f.telemetry.householdKw = 4;
  return f;
}

test('forced night minima follow all destination weekdays and remain measured SOC targets', () => {
  for (const [date, minimum] of [['2026-10-26', 60], ['2026-10-27', 50], ['2026-10-28', 50], ['2026-10-29', 60],
    ['2026-10-30', 50], ['2026-10-31', 60], ['2026-11-01', 60]] as const) {
    const plan = planCarCharge(input(`${date}T01:00:00+01:00`));
    assert.equal(plan.target.kind, 'morning');
    assert.equal(plan.target.date, date);
    assert.equal(plan.target.minimumSocPercent, minimum);
    assert.equal(plan.action, 'charge');
    assert.equal(plan.source, 'grid');
  }
  const f = input(); f.car.socPercent = 55;
  const estimate = planCarCharge(f);
  assert.equal(estimate.requiredStoredKwh, 3.75);
  assert.ok(Math.abs(estimate.requiredAcKwh! - 4.1666666667) < 1e-6);
  f.car.socPercent = 0;
  assert.equal(planCarCharge(f).socPercent, 0);
  assert.equal(planCarCharge(f).requiredStoredKwh, 45);
});

test('only buffered night and afternoon intervals force normal; other periods select Eco', () => {
  for (const [at, window, action] of [
    ['2026-10-25T23:04:59+01:00', null, 'eco'], ['2026-10-25T23:05:00+01:00', 'night', 'charge'],
    ['2026-10-26T06:54:59+01:00', 'night', 'charge'], ['2026-10-26T06:55:00+01:00', null, 'eco'],
    ['2026-10-25T12:04:59+01:00', null, 'eco'], ['2026-10-25T12:05:00+01:00', 'afternoon', 'charge'],
    ['2026-10-25T16:54:59+01:00', 'afternoon', 'charge'], ['2026-10-25T16:55:00+01:00', null, 'eco'],
    ['2026-10-25T10:00:00+01:00', null, 'eco'], ['2026-10-25T18:00:00+01:00', null, 'eco'],
  ] as const) {
    const f = input(at);
    assert.equal(getCarForceWindow(f.now), window, at);
    assert.equal(planCarCharge(f).action, action, at);
  }
});

test('afternoon restores only30 percent, ignores the next morning minimum, then returns Eco', () => {
  const f = input('2026-10-25T12:05:00+01:00'); f.car.socPercent = 29;
  let plan = planCarCharge(f);
  assert.equal(plan.target.kind, 'afternoon');
  assert.equal(plan.target.minimumSocPercent, 30);
  assert.equal(plan.target.deadline, '2026-10-25T15:55:00.000Z');
  assert.equal(plan.reason, 'afternoon_minimum');
  assert.equal(plan.action, 'charge');
  f.car.socPercent = 30;
  plan = planCarCharge(f);
  assert.equal(plan.action, 'eco');
  assert.equal(plan.source, 'eco');
  assert.equal(plan.reason, 'eco_target_reached');
  assert.equal(plan.requiredAcKwh, 0);
  assert.equal(plan.slots.length, 0);
  f.car.socPercent = 40;
  assert.equal(planCarCharge(f).action, 'eco');
  f.override = { deadline: '2026-10-26T05:00:00.000Z', targetSocPercent: 90 };
  assert.equal(planCarCharge(f).target.minimumSocPercent, 30);
});

test('Eco requires no Tesla SOC, forecast, or plugged car, and never claims unknown success', () => {
  for (const at of ['2026-10-25T10:00:00+01:00', '2026-10-25T12:30:00+01:00', '2026-10-26T01:00:00+01:00']) {
    const f = input(at); f.car.status = 'asleep'; f.car.socPercent = null; f.car.observedAt = null;
    const plan = planCarCharge(f);
    assert.equal(plan.status, 'available'); assert.equal(plan.action, 'eco');
    assert.equal(plan.reason, 'eco_soc_unavailable'); assert.equal(plan.phases, null);
    assert.equal(plan.feasible, null); assert.equal(plan.requiredAcKwh, null);
    assert.equal(plan.estimatedCompletionAt, null); assert.equal(plan.slots.length, 0);
  }
  const f = input(); f.charger.carConnected = false; f.charger.currentAmps = 16;
  f.telemetry.status = 'offline'; f.telemetry.gridImportKw = null; f.car.status = 'offline';
  const unplugged = planCarCharge(f);
  assert.equal(unplugged.action, 'eco');
  assert.equal(unplugged.currentAmps, 16);
  assert.equal(unplugged.phases, null);
  assert.equal(unplugged.reason, 'eco_car_unplugged');
});

test('Eco never raises a valid observed current and respects pending battery and site demand', () => {
  const f = input('2026-10-25T10:00:00+01:00'); f.charger.currentAmps = 16;
  let plan = planCarCharge(f);
  assert.equal(plan.action, 'eco'); assert.equal(plan.currentAmps, 12);
  f.charger.currentAmps = 8;
  assert.equal(planCarCharge(f).currentAmps, 8);
  f.config.maxCurrentAmps = 6;
  assert.equal(planCarCharge(f).currentAmps, 6);
  f.config.maxCurrentAmps = 16; f.charger.currentAmps = 16;
  f.telemetry.gridImportKw = 2.5; f.telemetry.householdKw = .5; f.telemetry.batteryChargeKw = 2; f.battery.pendingChargeKw = 4;
  assert.equal(planCarCharge(f).currentAmps, 12, 'actual2 pluspending4 is reserved once');
  f.telemetry.gridImportKw = 11; f.telemetry.householdKw = 11; f.telemetry.batteryChargeKw = 0; f.battery.pendingChargeKw = 6;
  plan = planCarCharge(f);
  assert.equal(plan.action, 'pause'); assert.equal(plan.reason, 'grid_limit');
  f.telemetry.status = 'offline';
  assert.equal(planCarCharge(f).reason, 'site_unavailable');
});

test('Eco may preserve an observed current with unknown cable limits but cannot change it', () => {
  const unplugged = input('2026-10-25T10:00:00+01:00');
  unplugged.charger.carConnected = false;
  unplugged.charger.limits.maxCurrentAmps = null;
  unplugged.charger.currentAmps = 14;
  unplugged.telemetry.status = 'offline';
  const preserved = planCarCharge(unplugged);
  assert.equal(preserved.action, 'eco');
  assert.equal(preserved.currentAmps, 14);
  assert.equal(preserved.phases, null);
  const connected = input(); connected.charger.limits.maxCurrentAmps = null;
  connected.charger.currentAmps = 6;
  const knownSOC = planCarCharge(connected);
  assert.equal(knownSOC.action, 'eco', 'a forced night minimum still requires known cable limits');
  assert.equal(knownSOC.currentAmps, 6);
  assert.equal(knownSOC.reason, 'current_limits_unavailable');
  connected.charger.currentAmps = 14;
  assert.equal(planCarCharge(connected).action, 'pause', 'sitebudgetwouldrequirelowering14Ato11A');
  assert.equal(planCarCharge(connected).reason, 'current_limits_unavailable');
  unplugged.charger.currentAmps = 20;
  assert.equal(planCarCharge(unplugged).action, 'pause', 'an unverified current above config cannot be clamped blindly');
  unplugged.charger.currentAmps = null;
  assert.equal(planCarCharge(unplugged).action, 'pause');
});

test('night guard includes buffers while forced charging still ends06:55', () => {
  for (const at of ['2026-10-25T23:00:00+01:00', '2026-10-26T06:59:59+01:00']) {
    const f = input(at);
    assert.equal(getNightTariffEnd(f.now), '2026-10-26T06:00:00.000Z');
    assert.equal(planCarCharge(f).action, 'eco');
    assert.equal(planCarCharge(f).windowEndsAt, '2026-10-26T06:00:00.000Z');
  }
  assert.equal(getNightTariffEnd(input('2026-10-26T07:00:00+01:00').now), null);
});

test('night charging keeps actual elapsed spring and autumn window durations', () => {
  for (const [at, hours] of [['2026-03-28T23:05:00+01:00', 6 + 50 / 60], ['2026-10-24T23:05:00+02:00', 8 + 50 / 60]] as const) {
    const f = input(at); f.car.socPercent = 0; f.config.capacityKwh = 250;
    const plan = planCarCharge(f);
    assert.equal(plan.feasible, false); assert.equal(plan.action, 'charge');
    assert.ok(Math.abs(plan.slots.reduce((sum, slot) => sum + (Date.parse(slot.end) - Date.parse(slot.start)) / 3_600_000, 0) - hours) < 1e-8);
  }
});

test('night car charging has priority and caps only home-battery power', () => {
  const shared = planCarCharge(input());
  assert.equal(shared.currentAmps, 16); assert.equal(shared.allowBatteryCharge, true); assert.equal(shared.feasible, true);
  assert.equal(shared.maxBatteryChargePowerKw, 3.3);
  const urgent = input('2026-10-26T05:00:00+01:00'); urgent.car.socPercent = 40;
  const yielding = planCarCharge(urgent);
  assert.equal(yielding.currentAmps, 16); assert.equal(yielding.allowBatteryCharge, true); assert.equal(yielding.feasible, true);
  urgent.car.socPercent = 0;
  assert.equal(planCarCharge(urgent).reason, 'deadline_infeasible');
  const competition = input(); competition.telemetry.gridImportKw = 3; competition.telemetry.householdKw = 3;
  assert.equal(planCarCharge(competition).action, 'charge', 'normal may yield the battery even when Eco plus6kW cannot fit');
  competition.telemetry.gridImportKw = 5; competition.telemetry.householdKw = 5;
  assert.equal(planCarCharge(competition).reason, 'grid_limit', 'a load that cannot fit even with zero battery charging remains unsafe');
});

test('solar export and home-battery discharge cannot increase the total consumption budget', () => {
  const f = input();
  f.telemetry.householdKw = 4;
  f.telemetry.gridImportKw = 0;
  f.telemetry.gridExportKw = 10;
  f.telemetry.batteryDischargeKw = 6;
  assert.equal(planCarCharge(f).reason, 'grid_limit');
  f.telemetry.householdKw = 3;
  const plan = planCarCharge(f);
  assert.equal(plan.currentAmps, 16);
  assert.equal(plan.maxBatteryChargePowerKw, .8);
});

test('home-battery goal does not lower the fixed Tesla rate', () => {
  const f = input('2026-10-25T23:05:00+01:00'); f.car.socPercent = 0;
  f.telemetry.gridImportKw = 3; f.telemetry.householdKw = 3;
  const plan = planCarCharge(f);
  assert.equal(plan.feasible, true); assert.equal(plan.currentAmps, 16);
  assert.equal(plan.maxBatteryChargePowerKw, .8);
  assert.equal(plan.slots[0]!.batteryChargeAllowed, true);
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0]!.powerKw, 11.040000000000001);
  f.battery.capacityKwh = 120;
  assert.equal(planCarCharge(f).maxBatteryChargePowerKw, .8);
});

test('unknown, initial, grid-origin, exhausted or unprotected stored energy never authorizes supply', () => {
  for (const value of [undefined, support({ available: false }), support({ solarStoredKwh: null }),
    support({ solarStoredKwh: 0, usableStoredKwh: 0 }), support({ usableStoredKwh: 0 }),
    support({ protectedStoredKwh: null }), support({ minimumSocPercent: null }), support({ maxDischargeKw: 0 })]) {
    const f = chargingWithSupport(); f.battery.solarSupport = value;
    const plan = planCarCharge(f);
    assert.equal(plan.action, 'charge');
    assert.equal(plan.solarKwh, 0);
    assert.equal(plan.slots.some(slot => slot.batterySupply !== undefined), false);
  }
});

test('only proven night solar above the protected floor can supply the car, with no simultaneous battery charging', () => {
  const f = chargingWithSupport();
  const plan = planCarCharge(f);
  assert.equal(plan.reason, 'night_charge_solar_support');
  assert.equal(plan.allowBatteryCharge, false);
  assert.equal(plan.batterySupport!.minimumSocPercent, 50);
  assert.ok(plan.slots.some(slot => slot.batterySupply !== undefined));
  assert.ok(plan.slots.every(slot => !slot.batteryChargeAllowed));
  const solarAc = plan.slots.reduce((sum, slot) => sum + (slot.batterySupply?.maxDischargeKw ?? 0)
    * (Date.parse(slot.end) - Date.parse(slot.start)) / 3_600_000, 0);
  assert.ok(solarAc <= Math.sqrt(.95) + 1e-8);
  assert.ok(Math.abs(solarAc - plan.solarKwh!) < 1e-8);
  for (const slot of plan.slots) {
    if (slot.batterySupply) assert.equal(slot.batterySupply.minimumSocPercent, 50);
    assert.ok(Math.abs(slot.energyKwh - slot.powerKw * (Date.parse(slot.end) - Date.parse(slot.start)) / 3_600_000) < 1e-12);
  }
  assert.ok(plan.gridKwh! > 0);
});

test('supply cap never exceeds measured car draw and no supply is projected without fresh power', () => {
  const f = chargingWithSupport(); f.battery.solarSupport = support({ maxDischargeKw: 7 });
  assert.equal(planCarCharge(f).batterySupport!.maxDischargeKw, 3.5);
  f.charger.powerObservedAt = new Date(+f.now - 5000).toISOString();
  const unverified = planCarCharge(f);
  assert.equal(unverified.batterySupport!.maxDischargeKw, 0);
  assert.equal(unverified.slots.some(slot => slot.batterySupply), false);
  f.charger.powerObservedAt = f.now.toISOString(); f.battery.socPercent = 50;
  assert.equal(planCarCharge(f).slots.some(slot => slot.batterySupply), false);
  f.battery.socPercent = 60; f.battery.solarSupport = support({ solarStoredKwh: 20, usableStoredKwh: 20 });
  assert.equal(planCarCharge(f).batterySupport!.usableStoredKwh, 6, 'a reported quota cannot cross the protected50percent floor');
});

test('afternoon ignores available home solar support and restores30 using normal mode only', () => {
  const f = chargingWithSupport('2026-10-25T12:05:00+01:00'); f.car.socPercent = 29;
  const plan = planCarCharge(f);
  assert.equal(plan.action, 'charge'); assert.equal(plan.target.minimumSocPercent, 30);
  assert.equal(plan.batterySupport, undefined); assert.equal(plan.solarKwh, 0);
  assert.equal(plan.slots.some(slot => slot.batterySupply), false);
  f.car.socPercent = 30;
  assert.equal(planCarCharge(f).action, 'eco');
});

test('stale SOC and charging contradictions use Eco without a forced target promise', () => {
  for (const mutate of [
    (f: CarPlanInput) => { f.car.status = 'asleep'; },
    (f: CarPlanInput) => { f.car.observedAt = new Date(+f.now - 600_001).toISOString(); },
    (f: CarPlanInput) => { f.car.observedAt = new Date(+f.now + 5001).toISOString(); },
    (f: CarPlanInput) => { f.car.socPercent = null; },
    (f: CarPlanInput) => { f.car.chargingState = 'Disconnected'; },
    (f: CarPlanInput) => { f.charger.carConnected = false; },
    (f: CarPlanInput) => { f.battery.automatic = false; },
  ]) {
    const f = input(); mutate(f);
    const plan = planCarCharge(f);
    assert.equal(plan.action, 'eco'); assert.equal(plan.status, 'available');
    assert.equal(plan.source, 'eco'); assert.equal(plan.slots.length, 0);
  }
});

test('one-off higher/earlier morning targets remain night-only and never raise the afternoon floor', () => {
  const now = input().now;
  const override = { deadline: '2026-10-26T05:00:00.000Z', targetSocPercent: 70 };
  assert.deepEqual(validateCarTargetOverride(override, now), override);
  for (const value of [{ ...override, targetSocPercent: 50 }, { ...override, deadline: '2026-10-26T07:00:00.000Z' },
    { ...override, deadline: '2026-10-25T05:00:00.000Z' }, { ...override, deadline: '2026-10-26T05:00:00Z' }]) {
    assert.throws(() => validateCarTargetOverride(value, now));
  }
  const f = input(); f.override = override;
  assert.equal(planCarCharge(f).target.minimumSocPercent, 70);
  assert.equal(planCarCharge(f).windowEndsAt, override.deadline);
  const past = input('2026-10-26T06:30:00+01:00'); past.override = override;
  assert.equal(planCarCharge(past).action, 'eco');
  assert.equal(planCarCharge(past).reason, 'eco_deadline_passed');
  const afternoon = input('2026-10-25T12:30:00+01:00'); afternoon.override = override;
  assert.equal(planCarCharge(afternoon).target.minimumSocPercent, 30);
});
