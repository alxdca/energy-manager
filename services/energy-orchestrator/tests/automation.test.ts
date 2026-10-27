import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation, type AutomationControllerState } from '../src/automation.js';
import type { AutomationConfig, EnergyForecast } from '../src/automation-plan.js';
import type { AutomationState } from '../src/automation-state.js';
import { estimateConsumption } from '../src/consumption.js';
import { getCalendarDayBounds, getLocalDate } from '../src/policy.js';
import type { Telemetry } from '../src/status.js';

const owner = '00000000-0000-4000-8000-000000000001';
const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5, energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function forecast(date: string, at: Date): EnergyForecast {
  const { start, end } = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  const hourly = Array.from({ length: (end.getTime() - start.getTime()) / 3_600_000 }, (_, index) => ({
    start: new Date(start.getTime() + index * 3_600_000).toISOString(),
    end: new Date(start.getTime() + (index + 1) * 3_600_000).toISOString(), estimatedProductionKwh: 0, temperatureC: 10,
  }));
  return { status: 'online', date, locationName: 'Test', estimatedProductionKwh: 0, hourly,
    quarterHourly: hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
      start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
      end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
      estimatedProductionKwh: hour.estimatedProductionKwh / 4, temperatureC: hour.temperatureC,
    }))),
    weatherCode: 0, temperatureMinC: 10, temperatureMaxC: 10, temperatureMeanC: 10,
    fetchedAt: at.toISOString(), source: 'Open-Meteo', model: 'east_west_tilted_radiation',
    arrayPowerKw: 8.5, performanceRatio: 0.85, panelTiltDegrees: 15, eastFraction: 0.5,
    weatherModel: 'meteoswiss_icon_ch2', productionPeriodStart: start.toISOString(), productionPeriodEnd: end.toISOString(), error: null,
    consumption: estimateConsumption(date, { baselinePowerW: 500 }),
  };
}
function harness(origin = '2026-10-24T12:03:00Z') {
  let clock = Date.parse(origin);
  let id = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const now = () => new Date(clock);
  const state: AutomationState = { owner, manualOverride: false, error: null,
    async setManualOverride(value) { (state as { manualOverride: boolean }).manualOverride = value; },
  };
  let controller: AutomationControllerState = { available: true, mode: 'auto', powerKw: null, targetSocPercent: null,
    limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 }, automationSupported: true, automationHoldSupported: true, revertTimeoutSeconds: 30, error: null };
  let telemetry: Partial<Telemetry> = {};
  let reads = 0;
  const charges: { target: number; expires: string; at: number; powerKw: number }[] = [];
  const holds: { expires: string; at: number }[] = [];
  const stops: string[] = [];
  const forecasts: { offset: number; at: number }[] = [];
  const options = {
    config, state, now,
    setTimer(callback: () => void, delay: number) { const handle = ++id; tasks.set(handle, { at: clock + delay, callback }); return handle; },
    clearTimer(handle: unknown) { tasks.delete(handle as number); },
    controller: {
      async read() { reads++; return { ...controller }; },
      async charge(value: string, target: number, expires: string, isCurrent: () => boolean, powerKw = 6) {
        assert.equal(value, owner);
        if (!isCurrent()) return;
        charges.push({ target, expires, at: clock, powerKw });
        controller = { ...controller, mode: 'manual', powerKw, targetSocPercent: target, automationOwner: owner, automationMode: 'charge', expiresAt: expires };
      },
      async hold(value: string, expires: string, isCurrent: () => boolean) {
        assert.equal(value, owner);
        if (!isCurrent()) return;
        holds.push({ expires, at: clock });
        controller = { ...controller, mode: 'manual', powerKw: 0, targetSocPercent: null,
          automationOwner: owner, automationMode: 'hold', expiresAt: expires };
      },
      async stop(value: string) { if (controller.automationOwner === value) { stops.push(value); controller = { ...controller, mode: 'auto', automationOwner: undefined }; } },
    },
    async readTelemetry(): Promise<Telemetry> { return {
      status: 'online', observedAt: now().toISOString(), error: null, solarKw: 0, householdKw: 1,
      gridImportKw: controller.automationMode === 'charge' ? 1 + controller.powerKw! : 1, gridExportKw: 0, batterySocPercent: 5,
      batteryChargeKw: controller.automationMode === 'charge' ? controller.powerKw! : 0, batteryDischargeKw: 0, ...telemetry,
    }; },
    async readForecast(offset: 0 | 1) {
      forecasts.push({ offset, at: clock });
      const date = getLocalDate(new Date(clock + offset * 24 * 3_600_000));
      return forecast(date, now());
    },
  };
  return { options, charges, holds, stops, forecasts, state, reads: () => reads, now,
    tasks: () => tasks.size, setController(value: Partial<AutomationControllerState>) { controller = { ...controller, ...value }; },
    setTelemetry(value: Partial<Telemetry>) { telemetry = { ...telemetry, ...value }; },
    async advance(ms: number) {
      clock += ms;
      for (const [handle, task] of [...tasks]) if (task.at <= clock) { tasks.delete(handle); task.callback(); }
      await settle();
    },
  };
}

test('starts explicitly, charges at 6 kW and plans on aligned quarter hours without safety renewals', async () => {
  const h = harness(); const runner = createAutomation(h.options);
  assert.equal(h.reads(), 0); assert.equal(h.tasks(), 0);
  runner.start(); runner.start(); await settle();
  assert.equal(h.charges.length, 1); assert.equal(runner.status().status, 'charging');
  assert.equal(runner.status().nextEvaluationAt, '2026-10-24T12:15:00.000Z');
  await h.advance(5000); assert.equal(h.charges.length, 1); assert.equal(h.forecasts.length, 1);
  await h.advance(11 * 60_000 + 55_000);
  assert.equal(h.charges.length, 2); assert.equal(h.forecasts.length, 2);
  assert.equal(h.charges[1].at, Date.parse('2026-10-24T12:15:00Z'));
  await runner.stop(); assert.equal(h.tasks(), 0); assert.equal(h.stops.length, 1);
});

test('car priority curtails only home-battery power on safety ticks and resumes after a zero cap', async () => {
  const h = harness('2026-10-25T22:05:00Z');
  const constraint = { active: true, allowCharge: true, guardNight: true,
    until: '2026-10-26T06:00:00.000Z', maxChargePowerKw: 6 };
  const runner = createAutomation({ ...h.options, readCarConstraint: () => constraint });
  runner.start(); await settle();
  assert.equal(h.charges.at(-1)!.powerKw, 6);
  const target = runner.status().targetSocPercent;
  const forecasts = h.forecasts.length;

  constraint.maxChargePowerKw = 3.2;
  // The existing 6 kW battery request has caused an overshoot; replacing it
  // with 3.2 kW brings the measured 12.7 kW base below the 16 kW site limit.
  h.setTelemetry({ gridImportKw: 18.7, householdKw: 12.7, batteryChargeKw: 6 });
  await h.advance(5000);
  assert.equal(h.charges.at(-1)!.powerKw, 3.2);
  assert.equal(runner.status().plan!.powerKw, 3.2);
  assert.equal(runner.status().status, 'charging');
  assert.equal(h.stops.length, 0);

  constraint.maxChargePowerKw = 0;
  h.setTelemetry({ gridImportKw: 15.9, householdKw: 12.7, batteryChargeKw: 3.2 });
  await h.advance(5000);
  assert.equal(runner.status().status, 'holding');
  assert.equal(runner.status().plan!.powerKw, 0);
  assert.equal(runner.status().targetSocPercent, target);
  assert.equal(h.stops.length, 0);

  constraint.maxChargePowerKw = 6;
  h.setTelemetry({ gridImportKw: 12.7, householdKw: 12.7, batteryChargeKw: 0 });
  await h.advance(5000);
  assert.equal(h.charges.at(-1)!.powerKw, 3.3, 'fresh site headroom can be tighter than the published car cap');
  assert.equal(runner.status().status, 'charging');
  assert.equal(runner.status().targetSocPercent, target);
  assert.equal(h.forecasts.length, forecasts, 'load allocation does not wait for or repeat economic planning');
  await runner.stop();
});

test('curtailed charging renews its actual power and cannot extend grid charging beyond 06:55', async () => {
  const h = harness('2026-10-26T05:54:50Z');
  const constraint = { active: true, allowCharge: true, guardNight: true,
    until: '2026-10-26T06:00:00.000Z', maxChargePowerKw: 3.2 };
  const runner = createAutomation({ ...h.options, readCarConstraint: () => constraint });
  runner.start(); await settle();
  assert.equal(h.charges[0]!.powerKw, 3.2);
  h.setController({ expiresAt: new Date(h.now().getTime() + 5000).toISOString() });
  await h.advance(5000);
  assert.equal(h.charges.at(-1)!.powerKw, 3.2);
  await h.advance(5000);
  assert.equal(runner.status().status, 'holding');
  assert.equal(runner.status().plan!.powerKw, 0);
  assert.ok(h.charges.every(charge => charge.at < Date.parse('2026-10-26T05:55:00Z')));
  await h.advance(5 * 60_000);
  assert.equal(h.stops.length, 1);
  await runner.stop();
});

test('household overload curtails battery charging to zero without releasing ownership, even without car Auto', async () => {
  const h = harness();
  const runner = createAutomation(h.options);
  runner.start(); await settle();
  const target = runner.status().targetSocPercent;
  h.setTelemetry({ householdKw: 17, gridImportKw: 5, solarKw: 12 });
  await h.advance(5000);
  assert.equal(h.stops.length, 0);
  assert.equal(runner.status().status, 'holding');
  assert.equal(runner.status().reason, 'site_power_limit');
  assert.equal(runner.status().targetSocPercent, target);
  h.setTelemetry({ householdKw: 10, gridImportKw: 0, solarKw: 16 });
  await h.advance(5000);
  assert.equal(h.charges.at(-1)!.powerKw, 6);
  assert.equal(runner.status().status, 'charging');
  await runner.stop();
});

test('car allocation cannot modulate a foreign manual battery command', async () => {
  const h = harness('2026-10-25T22:05:00Z');
  const constraint = { active: true, allowCharge: true, guardNight: true,
    until: '2026-10-26T06:00:00.000Z', maxChargePowerKw: 3.2 };
  const runner = createAutomation({ ...h.options, readCarConstraint: () => constraint });
  runner.start(); await settle();
  const charged = h.charges.length;
  h.setController({ mode: 'manual', powerKw: 4, automationOwner: 'manual-user' });
  constraint.maxChargePowerKw = 0;
  await h.advance(5000);
  assert.equal(runner.status().status, 'manual_override');
  assert.equal(h.charges.length, charged);
  assert.equal(h.holds.length, 0);
  assert.equal(h.stops.length, 0);
  await runner.stop();
});

test('an awaited evaluation consumes newly published inputs before the coordinator captures the resulting plan', async () => {
  const h = harness('2026-10-24T21:15:00Z');
  let sunshine = false;
  let chargeCalls = 0;
  const acknowledgement = deferred<void>();
  const events: string[] = [];
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller, async charge(...args) {
    if (++chargeCalls === 2) await acknowledgement.promise;
    await h.options.controller.charge(...args);
  } }, async readForecast(offset) {
    const data = await h.options.readForecast(offset);
    events.push(sunshine ? 'forecast:updated' : 'forecast:initial');
    if (sunshine) {
      data.hourly!.forEach(hour => { hour.estimatedProductionKwh = hour.start >= '2026-10-25T08:00:00.000Z'
        && hour.start < '2026-10-25T15:00:00.000Z' ? 6 : 0; });
      data.estimatedProductionKwh = 42;
      data.quarterHourly!.forEach(point => { point.estimatedProductionKwh = point.start >= '2026-10-25T08:00:00.000Z'
        && point.start < '2026-10-25T15:00:00.000Z' ? 1.5 : 0; });
    }
    return data;
  } });
  runner.start(); await settle();
  const initialTarget = runner.status().targetSocPercent!;
  sunshine = true; events.push('inputs:published');
  let evaluated = false;
  const evaluation = runner.evaluate().then(() => { evaluated = true; });
  await settle();
  assert.equal(chargeCalls, 2);
  assert.equal(evaluated, false, 'The coordinator must wait for controller acknowledgement before capturing');
  acknowledgement.resolve();
  await evaluation;
  events.push('capture');
  assert.deepEqual(events, ['forecast:initial', 'inputs:published', 'forecast:updated', 'capture']);
  assert.ok(runner.status().targetSocPercent! < initialTarget);
  assert.equal(h.charges.length, 2);
  assert.equal(h.tasks(), 1, 'The previous idle safety timer is replaced, not duplicated');
  await runner.stop();
});

test('concurrent explicit evaluations coalesce and wait behind the active run without overlap', async () => {
  const h = harness();
  const weather = deferred<EnergyForecast>();
  let calls = 0, active = 0, maximumActive = 0;
  const runner = createAutomation({ ...h.options, async readForecast(offset) {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    try { return calls === 1 ? await weather.promise : await h.options.readForecast(offset); }
    finally { active--; }
  } });
  runner.start(); await settle();
  const first = runner.evaluate(), second = runner.evaluate();
  assert.equal(first, second);
  let completed = false;
  void first.then(() => { completed = true; });
  await h.advance(60_000);
  assert.equal(calls, 1); assert.equal(completed, false);
  weather.resolve(forecast('2026-10-24', h.now()));
  await first;
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(h.charges.length, 1, 'The first run has stale telemetry; the queued evaluation reads fresh telemetry');
  assert.equal(h.tasks(), 1);
  await runner.stop();
});

test('shutdown cancels an evaluation queued behind a pending forecast', async () => {
  const h = harness(), weather = deferred<EnergyForecast>();
  let forecasts = 0;
  const runner = createAutomation({ ...h.options, readForecast: () => { forecasts++; return weather.promise; } });
  runner.start(); await settle();
  const evaluation = runner.evaluate();
  const stopping = runner.stop();
  weather.resolve(forecast('2026-10-24', h.now()));
  await Promise.all([evaluation, stopping]);
  await runner.evaluate();
  assert.equal(forecasts, 1);
  assert.equal(h.charges.length, 0);
  assert.equal(h.tasks(), 0);
});

test('explicit evaluation preserves a manual override and cannot create an immediate retry loop', async () => {
  const h = harness();
  await h.state.setManualOverride(true);
  h.setController({ mode: 'manual', powerKw: 4, automationOwner: 'manual' });
  const runner = createAutomation(h.options);
  runner.start(); await settle();
  await runner.evaluate();
  assert.equal(runner.status().status, 'manual_override');
  assert.equal(h.forecasts.length, 0); assert.equal(h.charges.length, 0); assert.equal(h.stops.length, 0);
  const reads = h.reads();
  await h.advance(0);
  assert.equal(h.reads(), reads);
  assert.equal(h.tasks(), 1);
  await runner.stop();
});

test('explicit evaluation cannot start an unstarted or disabled runtime', async () => {
  for (const enabled of [true, false]) {
    const h = harness();
    const runner = createAutomation({ ...h.options, config: { ...config, enabled } });
    await runner.evaluate();
    assert.equal(h.reads(), 0); assert.equal(h.tasks(), 0);
    if (!enabled) {
      runner.start(); await runner.evaluate();
      assert.equal(h.reads(), 0); assert.equal(h.tasks(), 0);
    }
    await runner.stop();
  }
});

test('night selects tomorrow before midnight and today after midnight', async () => {
  for (const [origin, offset] of [['2026-10-24T21:15:00Z', 1], ['2026-10-24T22:15:00Z', 0]] as const) {
    const h = harness(origin); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.forecasts[0].offset, offset); assert.equal(h.charges.length, 1); await runner.stop();
  }
});

test('night prepares the afternoon goal even when current SOC already covers the morning', async () => {
  const h = harness('2026-10-24T21:15:00Z');
  h.setTelemetry({ batterySocPercent: 20 });
  const runner = createAutomation(h.options);
  runner.start(); await settle();
  assert.equal(h.charges.length, 1);
  assert.equal(h.holds.length, 0);
  assert.equal(runner.status().status, 'charging');
  assert.equal(runner.status().plan!.afternoonTargetSocPercent, 80);
  assert.equal(runner.status().plan!.afternoonTargetAt, '2026-10-25T15:55:00.000Z');
  assert.ok(runner.status().plan!.requiredStoredKwh! > 12);
  await runner.stop();
});

test('foreign manual charge persists override and remains untouched on shutdown', async () => {
  const h = harness(); h.setController({ mode: 'manual', powerKw: 4, automationOwner: 'someone-else' });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.state.manualOverride, true); assert.equal(runner.status().status, 'manual_override');
  assert.equal(h.charges.length, 0); await runner.stop(); assert.equal(h.stops.length, 0);
});

test('persisted manual override prevents restart charging and Auto schedules an immediate new plan', async () => {
  const h = harness(); await h.state.setManualOverride(true);
  const runner = createAutomation(h.options); runner.start(); await settle(); assert.equal(h.charges.length, 0);
  await runner.setManualOverride(false); assert.equal(h.charges.length, 0);
  await h.advance(0); assert.equal(h.charges.length, 1); await runner.stop();
});

test('each unsafe telemetry condition stops only an owned charge', async () => {
  const cases: Partial<Telemetry>[] = [
    { status: 'stale' }, { observedAt: '2026-10-24T12:02:49Z' }, { observedAt: '2026-10-24T12:03:20Z' },
    { batterySocPercent: null }, { gridImportKw: null }, { batteryChargeKw: null },
    { householdKw: null }, { householdKw: -1 },
  ];
  for (const unsafe of cases) {
    const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
    h.setTelemetry(unsafe); await h.advance(5000);
    assert.equal(h.stops.length, 1, JSON.stringify(unsafe)); assert.equal(h.charges.length, 1);
    assert.equal(runner.status().status, 'blocked'); await runner.stop();
  }
});

test('predictive headroom removes existing battery charge rather than adding 6 kW twice', async () => {
  const h = harness(); h.setTelemetry({ gridImportKw: 14, batteryChargeKw: 6 });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges.length, 1); await runner.stop();
});

test('reaches target and holds within five seconds without further forecasts', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  h.setTelemetry({ batterySocPercent: h.charges[0].target }); await h.advance(5000);
  assert.equal(h.stops.length, 0); assert.equal(h.holds.length, 1); assert.equal(h.charges.length, 1);
  assert.equal(runner.status().status, 'holding'); assert.equal(h.forecasts.length, 1);
  await h.advance(5000); assert.equal(h.holds.length, 1);
  await runner.stop();
});

test('charging continues until the exact cutoff, independently of the safety lease', async () => {
  const h = harness('2026-10-24T14:54:00.052Z'); const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges[0].expires, '2026-10-24T14:55:05.000Z');
  await h.advance(59_947);
  assert.equal(h.stops.length, 0); assert.equal(h.holds.length, 0); assert.equal(runner.status().status, 'charging');
  await h.advance(1);
  assert.equal(h.charges.length, 1); assert.equal(h.stops.length, 1);
  assert.equal(runner.status().holdUntil, null);
  assert.equal(runner.status().status, 'idle');
  await runner.stop();
});

test('weather completing after the charge cutoff cannot start or extend reserve mode', async () => {
  const h = harness('2026-10-24T14:54:59Z');
  const weather = deferred<EnergyForecast>();
  const runner = createAutomation({ ...h.options, readForecast: () => weather.promise });
  runner.start(); await settle();
  await h.advance(1000);
  weather.resolve(await h.options.readForecast(0)); await settle();
  assert.equal(h.charges.length, 0); assert.equal(h.holds.length, 0);
  assert.equal(runner.status().status, 'idle');
  assert.equal(runner.status().holdUntil, null);
  await runner.stop();
});

test('a late start still charges through the remaining part of the window', async () => {
  const h = harness('2026-10-24T14:54:19Z'); const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges.length, 1); assert.equal(h.charges[0].expires, '2026-10-24T14:55:05.000Z');
  assert.equal(h.holds.length, 0); await runner.stop();
});

test('cutoff stop is retried until acknowledged even when controller status becomes unavailable', async () => {
  const h = harness('2026-10-24T14:54:59Z');
  const attempts: string[] = [];
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller,
    async stop(value) {
      attempts.push(h.now().toISOString());
      if (attempts.length < 3) {
        h.setController({ available: false, mode: 'unknown', error: 'offline' });
        throw new Error('Stop not acknowledged');
      }
      await h.options.controller.stop(value);
      h.setController({ available: true, mode: 'auto', error: null });
    },
  } });
  runner.start(); await settle();
  await h.advance(1000);
  assert.deepEqual(attempts, ['2026-10-24T14:55:00.000Z']);
  assert.equal(runner.status().status, 'error');
  await h.advance(5000); assert.equal(attempts.length, 2);
  await h.advance(5000); assert.equal(attempts.length, 3);
  assert.equal(runner.status().status, 'idle');
  assert.equal(runner.status().error, null);
  assert.equal(h.charges.length, 1);
  await h.advance(5000); assert.equal(attempts.length, 3);
  await runner.stop();
});

test('an expiring intermediate lease renews charging without switching to hold', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  h.setController({ expiresAt: new Date(h.now().getTime() + 25_000).toISOString() });
  await h.advance(5000);
  assert.equal(h.charges.length, 2);
  assert.equal(h.holds.length, 0);
  assert.equal(runner.status().status, 'charging');
  await runner.stop();
});

test('high tariffs and excluded first fifteen minutes never start a charge', async () => {
  for (const origin of ['2026-10-24T10:00:00Z', '2026-10-24T15:00:00Z', '2026-10-24T21:00:00Z']) {
    const h = harness(origin); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.charges.length, 0); assert.equal(h.forecasts.length, 0); await runner.stop();
  }
});

test('missing capability or safe fallback prohibits charging', async () => {
  for (const value of [{ automationSupported: false }, { automationHoldSupported: false }, { revertTimeoutSeconds: undefined }, { revertTimeoutSeconds: 121 }, { limits: { maxPowerKw: 5, maxSocPercent: 100 } }]) {
    const h = harness(); h.setController(value); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.charges.length, 0); assert.equal(runner.status().reason, 'controller_capabilities'); await runner.stop();
  }
});

test('slow forecast cannot overlap ticks and manual override invalidates its pending write', async () => {
  const h = harness(); const weather = deferred<EnergyForecast>();
  const runner = createAutomation({ ...h.options, readForecast: () => weather.promise }); runner.start(); await settle();
  await h.advance(60_000); assert.equal(h.reads(), 1); assert.equal(h.tasks(), 0);
  await runner.setManualOverride(true);
  weather.resolve(forecast('2026-10-24', h.now())); await settle();
  assert.equal(h.charges.length, 0); assert.equal(runner.status().status, 'manual_override'); await runner.stop();
});

test('stale telemetry after slow weather prevents a command', async () => {
  const h = harness(); const weather = deferred<EnergyForecast>();
  const runner = createAutomation({ ...h.options, readForecast: () => weather.promise }); runner.start(); await settle();
  await h.advance(11_000); weather.resolve(forecast('2026-10-24', h.now())); await settle();
  assert.equal(h.charges.length, 0); assert.equal(runner.status().reason, 'telemetry_unavailable'); await runner.stop();
});

test('ambiguous write is reconciled by controller read without immediate retry', async () => {
  const h = harness(); let calls = 0;
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller, async charge(...args) {
    calls++; await h.options.controller.charge(...args); throw new Error('timeout');
  } } });
  runner.start(); await settle(); assert.equal(runner.status().status, 'error'); assert.equal(calls, 1);
  await h.advance(5000); assert.equal(runner.status().status, 'charging'); assert.equal(calls, 1);
  await runner.stop();
});

test('shutdown invalidates pending plans and only releases its own lease', async () => {
  const h = harness(); const weather = deferred<EnergyForecast>();
  const runner = createAutomation({ ...h.options, readForecast: () => weather.promise }); runner.start(); await settle();
  const stopping = runner.stop(); weather.resolve(forecast('2026-10-24', h.now())); await stopping;
  assert.equal(h.charges.length, 0); assert.equal(h.tasks(), 0); assert.equal(h.stops.length, 0);
  runner.start(); await h.advance(15 * 60_000); assert.equal(h.charges.length, 0);
});

test('state failure blocks automation without overwriting the fault', async () => {
  const h = harness(); Object.assign(h.state, { error: 'broken state' });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(runner.status().status, 'blocked'); assert.equal(h.charges.length, 0); await runner.stop();
});

test('disabled runtime has no periodic reads or commands', async () => {
  const h = harness(); const runner = createAutomation({ ...h.options, config: { ...config, enabled: false } }); runner.start(); await settle();
  assert.equal(h.reads(), 0); assert.equal(h.tasks(), 0); assert.equal(runner.status().status, 'disabled'); await runner.stop();
});


test('manual override releases an old owned lease when the subsequent manual write failed', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges.length, 1);
  await runner.setManualOverride(true); await h.advance(5000);
  assert.equal(h.stops.length, 1); assert.equal(runner.status().status, 'manual_override');
  assert.equal(runner.status().nextEvaluationAt, null); await runner.stop();
});

test('manual override never releases the successful replacement manual charge', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  await runner.setManualOverride(true); h.setController({ automationOwner: undefined, powerKw: 4 });
  await h.advance(5000); assert.equal(h.stops.length, 0); await runner.stop(); assert.equal(h.stops.length, 0);
});

test('state persistence failure releases a prior owned charge and blocks fresh commands', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  Object.assign(h.state, { error: 'disk unavailable' }); await h.advance(5000);
  assert.equal(h.stops.length, 1); assert.equal(h.charges.length, 1);
  assert.equal(runner.status().reason, 'state_unavailable'); assert.equal(runner.status().nextEvaluationAt, null); await runner.stop();
});


test('shutdown conditionally invalidates an ambiguous queued activation even while GET still reports auto', async () => {
  const h = harness(); const activation = deferred<void>();
  let remoteGeneration = 0;
  let remoteMode = 'auto';
  let releases = 0;
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller,
    async charge() {
      const captured = remoteGeneration;
      // Model a request that timed out locally while activation remains queued remotely.
      void activation.promise.then(() => { if (captured === remoteGeneration) remoteMode = 'manual'; });
      throw new Error('POST timed out');
    },
    async stop(value) { assert.equal(value, owner); releases++; remoteGeneration++; },
  } });
  runner.start(); await settle(); assert.equal(runner.status().status, 'error');
  await runner.stop(); assert.equal(releases, 1);
  activation.resolve(); await settle(); assert.equal(remoteMode, 'auto');
});

test('missing actual controller reserve blocks automatic planning', async () => {
  const h = harness(); h.setController({ limits: { maxPowerKw: 6, maxSocPercent: 100 } });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges.length, 0); assert.equal(runner.status().reason, 'controller_capabilities'); await runner.stop();
});

test('actual reserve raises the charge target above the afternoon floor when evening needs require it', async () => {
  const low = harness(); const high = harness();
  high.setController({ limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 80 } });
  const a = createAutomation(low.options); const b = createAutomation(high.options);
  a.start(); b.start(); await settle();
  assert.equal(low.charges[0].target, 80);
  assert.ok(high.charges[0].target > low.charges[0].target);
  await a.stop(); await b.stop();
});

test('old plan and target are cleared outside windows, on manual override and state error', async () => {
  for (const scenario of ['outside', 'manual', 'state'] as const) {
    const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.ok(runner.status().plan); assert.ok(runner.status().targetSocPercent);
    if (scenario === 'manual') await runner.setManualOverride(true);
    if (scenario === 'state') Object.assign(h.state, { error: 'storage unavailable' });
    await h.advance(scenario === 'outside' ? 3 * 3_600_000 : 5000);
    assert.equal(runner.status().plan, null); assert.equal(runner.status().targetSocPercent, null); await runner.stop();
  }
});

test('already sufficient battery is held after restart, renewed only each quarter, and can resume charging', async () => {
  const h = harness(); h.setTelemetry({ batterySocPercent: 90 });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.charges.length, 0); assert.equal(h.holds.length, 1);
  assert.equal(runner.status().status, 'holding');
  assert.equal(runner.status().holdUntil, '2026-10-24T14:55:00.000Z');
  await h.advance(5000); assert.equal(h.holds.length, 1);
  await h.advance(11 * 60_000 + 55_000);
  assert.equal(h.holds.length, 2); assert.equal(h.forecasts.length, 2);
  h.setTelemetry({ batterySocPercent: 5 }); await h.advance(quarterHour);
  assert.equal(h.charges.length, 1); assert.equal(runner.status().status, 'charging');
  assert.equal(runner.status().holdUntil, null);
  await runner.stop(); assert.equal(h.stops.length, 1);
});
const quarterHour = 15 * 60_000;

test('opening low-tariff buffers hold immediately without fetching weather or charging', async () => {
  for (const [origin, until] of [
    ['2026-10-24T10:00:00Z', '2026-10-24T14:55:00.000Z'],
    ['2026-10-24T21:00:00Z', '2026-10-25T05:55:00.000Z'],
  ]) {
    const h = harness(origin); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.holds.length, 1); assert.equal(h.charges.length, 0); assert.equal(h.forecasts.length, 0);
    assert.equal(runner.status().holdUntil, until);
    await h.advance(5000); assert.equal(h.holds.length, 1);
    await h.advance(5 * 60_000 - 10_000); assert.equal(h.charges.length, 0);
    await h.advance(5000); assert.equal(h.charges.length, 1);
    assert.equal(h.charges[0].at, Date.parse(origin) + 5 * 60_000);
    await runner.stop();
  }
});

test('preservation ends exactly five minutes before high tariffs, including both DST changes', async () => {
  for (const [origin, until] of [
    ['2026-10-24T14:54:59Z', '2026-10-24T14:55:00.000Z'],
    ['2026-10-24T04:54:59Z', '2026-10-24T04:55:00.000Z'],
    ['2026-10-25T05:54:59Z', '2026-10-25T05:55:00.000Z'],
    ['2026-03-29T04:54:59Z', '2026-03-29T04:55:00.000Z'],
  ]) {
    const h = harness(origin); h.setTelemetry({ batterySocPercent: 100 });
    const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.holds.length, 1); assert.equal(h.charges.length, 0);
    assert.equal(h.holds[0].expires, new Date(Date.parse(until) + 5000).toISOString());
    assert.equal(runner.status().holdUntil, until);
    await h.advance(1000); assert.equal(h.stops.length, 1); assert.equal(runner.status().status, 'idle');
    assert.equal(runner.status().holdUntil, null);
    await runner.stop();
  }
});

test('closing buffers and high tariffs never establish a hold or forced charge', async () => {
  for (const origin of ['2026-10-24T04:55:00Z', '2026-10-24T14:55:00Z', '2026-10-24T15:00:00Z', '2026-10-24T05:00:00Z']) {
    const h = harness(origin); const runner = createAutomation(h.options); runner.start(); await settle();
    assert.equal(h.holds.length, 0); assert.equal(h.charges.length, 0); assert.equal(h.forecasts.length, 0);
    assert.equal(runner.status().status, 'idle');
    await runner.stop();
  }
});

test('hold safety checks replacement household load without adding the 6 kW charge setpoint', async () => {
  const h = harness(); h.setTelemetry({ batterySocPercent: 90, gridImportKw: 14, batteryChargeKw: 0 });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.holds.length, 1); assert.equal(runner.status().status, 'holding');
  // Fixed household consumption above the total ceiling is reported.
  h.setTelemetry({ householdKw: 17, batteryDischargeKw: 3 }); await h.advance(5000);
  assert.equal(h.stops.length, 0); assert.equal(runner.status().reason, 'site_power_limit');
  assert.equal(runner.status().status, 'holding'); await runner.stop();
});

test('controller target-completion hold is recognized and its short lease extended without weather', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  h.setController({ automationMode: 'hold', powerKw: 0, targetSocPercent: null,
    expiresAt: new Date(h.now().getTime() + 15_000).toISOString() });
  await h.advance(5000);
  assert.equal(h.holds.length, 1); assert.equal(h.state.manualOverride, false);
  assert.equal(runner.status().status, 'holding'); assert.equal(h.forecasts.length, 1);
  await h.advance(5000); assert.equal(h.holds.length, 1); await runner.stop();
});

test('a hold bridging the last seconds is not repeatedly renewed with the identical deadline', async () => {
  const h = harness('2026-10-24T14:54:40Z'); h.setTelemetry({ batterySocPercent: 90 });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.holds.length, 1);
  for (let index = 0; index < 3; index++) await h.advance(5000);
  assert.equal(h.holds.length, 1);
  await h.advance(5000); assert.equal(h.stops.length, 1); await runner.stop();
});

test('manual replacement and state failure release only the previous owned hold', async () => {
  for (const scenario of ['manual', 'foreign', 'state'] as const) {
    const h = harness(); h.setTelemetry({ batterySocPercent: 90 });
    const runner = createAutomation(h.options); runner.start(); await settle(); assert.equal(h.holds.length, 1);
    if (scenario === 'state') Object.assign(h.state, { error: 'disk unavailable' });
    else {
      await runner.setManualOverride(true);
      if (scenario === 'foreign') h.setController({ automationOwner: undefined, automationMode: undefined, powerKw: 4 });
    }
    await h.advance(5000);
    assert.equal(h.stops.length, scenario === 'foreign' ? 0 : 1);
    assert.equal(runner.status().holdUntil, null); await runner.stop();
    assert.equal(h.stops.length, scenario === 'foreign' ? 0 : 1);
  }
});

test('an ambiguous queued hold is conditionally invalidated on shutdown', async () => {
  const h = harness(); h.setTelemetry({ batterySocPercent: 90 });
  const activation = deferred<void>(); let generation = 0; let remoteMode = 'auto'; let releases = 0;
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller,
    async hold() {
      const captured = generation;
      void activation.promise.then(() => { if (captured === generation) remoteMode = 'hold'; });
      throw new Error('hold POST timed out');
    },
    async stop(value) { assert.equal(value, owner); releases++; generation++; },
  } });
  runner.start(); await settle(); assert.equal(runner.status().status, 'error');
  await runner.stop(); assert.equal(releases, 1);
  activation.resolve(); await settle(); assert.equal(remoteMode, 'auto');
});

test('controller-completed hold with an adequate lease needs no redundant command', async () => {
  const h = harness(); const runner = createAutomation(h.options); runner.start(); await settle();
  h.setController({ automationMode: 'hold', powerKw: 0, targetSocPercent: null });
  await h.advance(5000);
  assert.equal(h.holds.length, 0); assert.equal(h.charges.length, 1);
  assert.equal(runner.status().status, 'holding');
  assert.equal(runner.status().holdUntil, '2026-10-24T14:55:00.000Z');
  assert.equal(h.state.manualOverride, false); await runner.stop();
});

test('fresh telemetry remains mandatory while preserving energy', async () => {
  for (const bad of [{ status: 'stale' }, { batterySocPercent: null }, { batteryDischargeKw: null }] as Partial<Telemetry>[]) {
    const h = harness(); h.setTelemetry({ batterySocPercent: 90 });
    const runner = createAutomation(h.options); runner.start(); await settle();
    h.setTelemetry(bad); await h.advance(5000);
    assert.equal(h.stops.length, 1); assert.equal(runner.status().status, 'blocked');
    assert.equal(runner.status().holdUntil, null); await runner.stop();
  }
});

test('a queued hold checks ownership guard after manual override before writing', async () => {
  const h = harness(); h.setTelemetry({ batterySocPercent: 90 }); const release = deferred<void>();
  const runner = createAutomation({ ...h.options, controller: { ...h.options.controller,
    async hold(...args) { await release.promise; await h.options.controller.hold(...args); },
  } });
  runner.start(); await settle(); await runner.setManualOverride(true);
  release.resolve(); await settle();
  assert.equal(h.holds.length, 0); assert.equal(runner.status().status, 'manual_override'); await runner.stop();
});

test('charging without sufficient headroom keeps a safe existing hold instead of discharging it', async () => {
  const h = harness(); h.setTelemetry({ batterySocPercent: 90 });
  const runner = createAutomation(h.options); runner.start(); await settle();
  assert.equal(h.holds.length, 1);
  h.setTelemetry({ batterySocPercent: 5, gridImportKw: 16, householdKw: 16, batteryChargeKw: 0 });
  await h.advance(12 * 60_000);
  assert.equal(h.charges.length, 0); assert.equal(h.stops.length, 0); assert.equal(h.holds.length, 2);
  assert.equal(runner.status().plan?.action, 'charge');
  assert.equal(runner.status().status, 'holding'); assert.equal(runner.status().reason, 'site_power_limit');
  assert.equal(runner.status().holdUntil, '2026-10-24T14:55:00.000Z');
  assert.equal(h.holds[1].expires, '2026-10-24T12:31:00.000Z');
  await runner.stop(); assert.equal(h.stops.length, 1);
});

test('offline and rejected forecasts renew only an existing safe hold with a finite lease', async () => {
  for (const failure of ['offline', 'rejected'] as const) {
    const h = harness(); h.setTelemetry({ batterySocPercent: 90 }); let broken = false;
    const runner = createAutomation({ ...h.options, async readForecast(offset) {
      if (broken && failure === 'rejected') throw new Error('weather unavailable');
      const value = await h.options.readForecast(offset);
      return broken ? { ...value, status: 'offline' as const, error: 'weather unavailable' } : value;
    } });
    runner.start(); await settle(); assert.equal(h.holds.length, 1);
    broken = true; await h.advance(12 * 60_000);
    assert.equal(h.holds.length, 2); assert.equal(h.charges.length, 0); assert.equal(h.stops.length, 0);
    assert.equal(runner.status().status, 'holding'); assert.equal(runner.status().reason, 'forecast_unavailable');
    assert.equal(h.holds[1].expires, '2026-10-24T12:31:00.000Z');
    assert.equal(runner.status().holdUntil, '2026-10-24T14:55:00.000Z');
    await h.advance(5000); assert.equal(h.holds.length, 2);
    assert.equal(runner.status().reason, 'forecast_unavailable');
    await runner.stop(); assert.equal(h.stops.length, 1);
  }
});

test('missing forecasts do not begin preserving an unowned battery', async () => {
  for (const failure of ['offline', 'rejected'] as const) {
    const h = harness();
    const runner = createAutomation({ ...h.options, async readForecast(offset) {
      if (failure === 'rejected') throw new Error('weather unavailable');
      return { ...await h.options.readForecast(offset), status: 'offline' as const, error: 'weather unavailable' };
    } });
    runner.start(); await settle();
    assert.equal(h.charges.length, 0); assert.equal(h.holds.length, 0); assert.equal(h.stops.length, 0);
    assert.equal(runner.status().status, failure === 'offline' ? 'blocked' : 'error'); await runner.stop();
  }
});

test('weather failure never renews a hold using telemetry that became stale during the request', async () => {
  for (const failure of ['offline', 'rejected'] as const) {
    const h = harness(); h.setTelemetry({ batterySocPercent: 90 }); let broken = false;
    const weather = deferred<void>();
    const runner = createAutomation({ ...h.options, async readForecast(offset) {
      if (!broken) return h.options.readForecast(offset);
      await weather.promise;
      if (failure === 'rejected') throw new Error('weather unavailable');
      return { ...await h.options.readForecast(offset), status: 'offline' as const, error: 'weather unavailable' };
    } });
    runner.start(); await settle(); broken = true;
    await h.advance(12 * 60_000); await h.advance(11_000); weather.resolve(); await settle();
    assert.equal(h.holds.length, 1); assert.equal(h.stops.length, 1);
    assert.equal(runner.status().status, 'blocked'); assert.equal(runner.status().reason, 'telemetry_unavailable');
    assert.equal(runner.status().holdUntil, null); await runner.stop();
  }
});
