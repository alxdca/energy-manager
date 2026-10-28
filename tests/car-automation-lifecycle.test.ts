import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi as createControllerApi } from '../services/energy-controller/src/api/api.js';
import { loadConfig } from '../services/energy-controller/src/config/index.js';
import type { Wattpilot, WattpilotCommand, WattpilotStatus } from '../services/energy-controller/src/devices/wattpilot.js';
import { WattpilotError } from '../services/energy-controller/src/devices/wattpilot.js';
import { createControlsService } from '../services/energy-orchestrator/src/controls.js';
import { createCarAutomation } from '../services/energy-orchestrator/src/car-automation.js';
import { createCarAutomationState } from '../services/energy-orchestrator/src/car-automation-state.js';
import { loadCarAutomationConfig } from '../services/energy-orchestrator/src/car-config.js';
import type { CarTelemetry } from '../services/energy-orchestrator/src/tesla.js';
import type { SolarBatterySupport } from '../services/energy-orchestrator/src/car-types.js';
import { createCarBatteryCoordinator } from '../services/energy-orchestrator/src/car-coordination.js';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(t: TestContext, origin: string) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(origin) });
  const now = () => new Date();
  const directory = await mkdtemp(join(tmpdir(), 'car-lifecycle-'));
  const writes: WattpilotCommand[] = [];
  const calls: { path: string; method: string; body: unknown }[] = [];
  let failedStops = 0;
  let solarSupport: SolarBatterySupport | undefined;
  let home = { mode: 'hold' as 'hold' | 'supply', watts: 0, minimumSocPercent: undefined as number | undefined };
  let homeGeneration = 0;
  const actualDischarge = () => home.mode === 'supply' ? Math.min(-home.watts, device.powerWatts ?? 0) : 0;
  let device: WattpilotStatus = {
    status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: now().toISOString(), powerObservedAt: now().toISOString(), error: null,
    controlEnabled: true, mode: 'eco', carConnected: true, charging: false, allowedCharging: false,
    currentAmps: 6, phaseMode: 3, phaseSwitchingSupported: true, powerWatts: 0,
    sessionEnergyWh: 0, totalEnergyWh: 1000, limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
  };
  const homeowner = 'home-battery-owner';
  const controller = createControllerApi({ wattpilotJournalPath: join(directory, 'controller.json'),
    settings: loadConfig({ WATTPILOT_URL: 'ws://192.0.2.1/ws', WATTPILOT_PASSWORD: 'test-only',
      WATTPILOT_CONTROL_ENABLED: 'true', WATTPILOT_MAX_CURRENT_AMPS: '16',
      FRONIUS_CONTROL_ENABLED: 'true', FRONIUS_MAX_POWER_WATTS: '6000' }),
    createWattpilot: () => ({ async readStatus() {
      return { ...device, observedAt: now().toISOString(), powerObservedAt: now().toISOString() };
    }, async setControl(command: WattpilotCommand) {
      writes.push(command);
      device = { ...device, mode: command.mode, currentAmps: command.currentAmps ?? device.currentAmps,
        phaseMode: command.phases ?? device.phaseMode, charging: command.mode === 'normal', allowedCharging: command.mode === 'normal',
        powerWatts: command.mode === 'normal' ? (command.currentAmps ?? 6) * 690 : 0,
        observedAt: now().toISOString(), powerObservedAt: now().toISOString() };
      return device;
    }, async pauseAndConfirm() {
      if (failedStops > 0) { failedStops--; throw new WattpilotError('Stopped power was not confirmed.', 503, 'unknown'); }
      writes.push({ mode: 'pause' });
      device = { ...device, mode: 'pause', charging: false, allowedCharging: false, powerWatts: 0,
        observedAt: now().toISOString(), powerObservedAt: now().toISOString() };
      return device;
    }, async disconnect() {} }) as unknown as Wattpilot,
    createInverter: () => ({ async initialize() {}, async disconnect() {},
      async getSystemOverview() { return { solar: {}, grid: {}, battery: { socPercent: 80, validValues: ['soc'] },
        site: { P_PV: 0, P_Load: -500 - (device.powerWatts ?? 0), P_Grid: 500 + (device.powerWatts ?? 0) - actualDischarge(), P_Akku: actualDischarge() } }; },
      getControlStatus() { return { enabled: true, active: true, watts: home.watts, minimumSocPercent: home.minimumSocPercent,
        automationOwner: homeowner, automationMode: home.mode, expiresAt: new Date(Date.now() + 900_000).toISOString() }; },
      async getAutomationReserve() { return 5; },
      getAutomationFence() { return { bootId: 'fake-battery-boot', generation: homeGeneration }; },
    }) as never,
    createBattery: () => ({ async initialize() {}, async cleanup() {},
      async setAutomationHold() { homeGeneration++; home = { mode: 'hold', watts: 0, minimumSocPercent: undefined }; },
      async setAutomationSupply(maxPowerWatts: number, minimumSocPercent: number, _expiresAt: string, _owner: string,
        fence: { bootId: string; generation: number }) {
        assert.deepEqual(fence, { bootId: 'fake-battery-boot', generation: homeGeneration });
        homeGeneration++;
        home = { mode: 'supply', watts: -maxPowerWatts, minimumSocPercent };
      },
    }) as never,
  });
  await controller.start();
  let state = await createCarAutomationState(join(directory, 'car.json'));
  let car: CarTelemetry = { status: 'online', vehicleName: 'Model 3', socPercent: 45, chargeLimitPercent: 80,
    chargingState: 'Stopped', observedAt: now().toISOString(), error: null };
  let runner!: ReturnType<typeof createCarAutomation>;
  const controls = createControlsService({ controllerUrl: 'http://controller.invalid', now,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'http://controller.invalid', 'all device traffic stays inside the fake controller');
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return controller.app.fetch(new Request(url, init));
    },
    automation: { enabled: () => true, owns: owner => owner === homeowner,
      async setManualOverride() { assert.fail('Car controls must not change battery manual state'); } },
    carAutomation: { status: () => runner.status(), owns: owner => owner === state.owner,
      manualStateReady: () => state.manualOverride && state.error === null,
      batteryConstraint: () => runner.batteryConstraint(),
      setManualOverride: value => runner.setManualOverride(value), setTargetOverride: value => runner.setTargetOverride(value) },
  });
  const coordinator = createCarBatteryCoordinator({ readControl: controls.automationController.read,
    readConstraint: () => runner.batteryConstraint(), owns: owner => owner === homeowner,
    evaluate: async () => {
      const constraint = runner.batteryConstraint();
      const expiresAt = new Date(Date.now() + 900_000).toISOString();
      if (constraint.supply) await controls.automationController.supply(homeowner,
        Math.floor(constraint.supply.maxDischargeKw * 1000), constraint.supply.minimumSocPercent, expiresAt, () => true,
        constraint.supply.authorizationExpiresAt);
      else await controls.automationController.hold(homeowner, expiresAt, () => true);
    } });
  const makeRunner = () => createCarAutomation({ config: loadCarAutomationConfig({}), state, controller: controls.carAutomationController, now,
    readCar: async () => car,
    readTelemetry: async () => ({ status: 'online', observedAt: now().toISOString(), error: null,
      solarKw: 0, householdKw: .5 + (device.powerWatts ?? 0) / 1000,
      gridImportKw: .5 + ((device.powerWatts ?? 0) - actualDischarge()) / 1000, gridExportKw: 0,
      batterySocPercent: 80, batteryChargeKw: 0, batteryDischargeKw: actualDischarge() / 1000 }),
    readBattery: async () => ({ available: true, automatic: true, requestedPowerKw: 0, socPercent: 80, goalSocPercent: 80, solarSupport }),
    readForecasts: async () => [], coordinate: coordinator.coordinate, releaseCoordination: coordinator.release,
  });
  runner = makeRunner();
  runner.start();
  t.after(async () => { await runner.stop(); await controller.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const post = (body: unknown) => controls.api.request('/car', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { get runner() { return runner; }, get state() { return state; }, controller, controls, writes, calls, post,
    async restart() {
      await runner.stop();
      state = await createCarAutomationState(join(directory, 'car.json'));
      runner = makeRunner(); runner.start();
      await runner.evaluate();
    },
    failStops(count: number) { failedStops = count; },
    solar(value: SolarBatterySupport) { solarSupport = value; },
    soc(value: number) { car = { ...car, socPercent: value, observedAt: now().toISOString() }; },
    async advance(ms: number) { t.mock.timers.tick(ms); await settle(); },
  };
}

test('real car facade and controller supervisor remain manual until Auto, then stop at measured target without renewal replay', async t => {
  const f = await fixture(t, '2026-10-25T23:10:00+01:00');
  await f.controls.api.request('/');
  await f.runner.evaluate();
  assert.equal(f.writes.length, 0);
  assert.equal((await f.post({ mode: 'auto' })).status, 200);
  await settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1);
  const activation = f.calls.find(call => call.path.endsWith('/automation-control'));
  assert.ok(activation);
  for (let i = 0; i < 13; i++) await f.advance(5000);
  assert.ok(f.calls.some(call => call.path.endsWith('/automation-renew')));
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1, 'renewal must not repeat a physical charge command');
  f.soc(60); await f.runner.evaluate();
  assert.equal(f.runner.status().plan?.reason, 'eco_target_reached');
  assert.equal(f.writes.at(-1)!.mode, 'eco');
  const old = activation.body as object;
  const response = await f.controller.app.request('/wattpilot/automation-control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(old),
  });
  assert.equal(response.status, 409, 'the completed revision cannot reactivate after stop');
});

test('a completed charge survives restart and only resumes after a five point drop', async t => {
  const f = await fixture(t, '2026-10-27T01:00:00+01:00');
  await f.post({ mode: 'auto' }); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.soc(50); await f.runner.evaluate();
  f.soc(49); await f.restart();
  assert.equal(f.state.completedTarget?.targetSocPercent, 50);
  assert.equal(f.runner.status().plan?.reason, 'eco_target_hysteresis');
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1);
  f.soc(45); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.state.completedTarget, null);
  f.soc(49); await f.restart();
  assert.equal(f.runner.status().status, 'charging', 'a resumed charge survives restart and continues to target');
  f.soc(50); await f.runner.evaluate();
  f.soc(49); await f.runner.evaluate();
  assert.equal(f.runner.status().plan?.reason, 'eco_target_hysteresis');
});

test('night solar quota reaches the real supply API and exhausted quota returns to hold without replaying the car charge', async t => {
  const f = await fixture(t, '2026-10-25T23:10:00+01:00');
  assert.equal((await f.post({ mode: 'auto' })).status, 200);
  await settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.solar({ available: true, solarStoredKwh: 10, protectedStoredKwh: 20, usableStoredKwh: 9.4,
    minimumSocPercent: 64.4, maxDischargeKw: 6, authorizationExpiresAt: new Date(Date.now() + 10_000).toISOString() });
  await f.runner.evaluate();
  const supplied = await (await f.controller.app.request('/inverter/control-status')).json();
  assert.equal(supplied.control.automationMode, 'supply');
  assert.equal(supplied.control.watts, -6000);
  assert.equal(supplied.control.minimumSocPercent, 64.4);
  assert.ok(f.calls.some(call => call.path === '/inverter/automation-supply'));
  f.solar({ available: true, solarStoredKwh: .6, protectedStoredKwh: 20, usableStoredKwh: 0,
    minimumSocPercent: 80, maxDischargeKw: 0 });
  await f.runner.evaluate();
  const protectedState = await (await f.controller.app.request('/inverter/control-status')).json();
  assert.equal(protectedState.control.automationMode, 'hold');
  assert.equal(protectedState.control.watts, 0);
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1);
});

test('manual control can finish an uncertain automatic stop and a later Auto action remains recoverable', async t => {
  const f = await fixture(t, '2026-10-25T23:10:00+01:00');
  assert.equal((await f.post({ mode: 'auto' })).status, 200);
  await settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.failStops(1);
  assert.equal((await f.post({ mode: 'eco', currentAmps: 6, phases: 1 })).status, 200);
  assert.equal(f.state.manualOverride, true);
  assert.equal(f.runner.batteryConstraint().active, false);
  assert.equal(f.writes.at(-1)!.mode, 'eco');
  assert.equal((await f.post({ mode: 'auto' })).status, 200);
  await settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
});

test('cross-service car charge cuts off at06:55 and manual takeover durably fences old automatic traffic', async t => {
  const f = await fixture(t, '2026-10-26T06:54:20+01:00');
  assert.equal((await f.post({ mode: 'auto' })).status, 200);
  await settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  const activation = f.calls.find(call => call.path.endsWith('/automation-control'))!.body as { expiresAt: string };
  assert.equal(activation.expiresAt, '2026-10-26T05:55:00.000Z');
  for (let i = 0; i < 9; i++) await f.advance(5000);
  await f.runner.evaluate();
  assert.equal(f.writes.at(-1)!.mode, 'eco');
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1);
  assert.equal((await f.post({ mode: 'eco', currentAmps: 6, phases: 1 })).status, 200);
  assert.equal(f.state.manualOverride, true);
  const before = f.writes.length;
  const stale = await f.controller.app.request('/wattpilot/automation-control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(activation),
  });
  assert.ok([400, 409].includes(stale.status));
  await f.runner.evaluate();
  assert.equal(f.writes.length, before);
  assert.equal(f.writes.at(-1)!.mode, 'eco');
});
