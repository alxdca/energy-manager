import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarAutomation } from '../src/car-automation.js';
import type { CarActivation, CarAutomationState, CarCheckpoint, CarPlan, CarPlanInput, CarTargetOverride, SolarBatterySupport } from '../src/car-types.js';
import type { WattpilotTelemetry } from '../src/wattpilot.js';
import type { CarTelemetry } from '../src/tesla.js';
import { planCarCharge } from '../src/car-plan.js';

const origin = Date.parse('2026-10-25T22:05:00.000Z');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const config = { capacityKwh: 75, chargingEfficiency: .9, maxCurrentAmps: 16,
  socFreshnessMs: 600_000, leaseSeconds: 90, wakeCooldownMs: 900_000 };


function fixture(options: {
  manual?: boolean;
  stateError?: string;
  plan?: (input: CarPlanInput) => CarPlan;
  activate?: (request: CarActivation, signal?: AbortSignal) => Promise<void>;
  renew?: (snapshot: WattpilotTelemetry) => Promise<WattpilotTelemetry>;
  authorize?: () => Promise<void>;
  wake?: (signal?: AbortSignal) => Promise<CarTelemetry>;
  coordinate?: (plan: CarPlan, guard: () => boolean) => Promise<void>;
  stopThrowsOnForeign?: boolean;
} = {}) {
  let clock = origin;
  let manualOverride = options.manual ?? true;
  let epoch: string | null = manualOverride ? null : 'epoch-one';
  let revision = 0;
  let lastCheckpoint: CarCheckpoint | null = null;
  let targetOverride: CarTargetOverride | null = null;
  let completedTarget: CarTargetOverride | null = null;
  let stateError: string | null = options.stateError ?? null;
  let soc = 40;
  let carStatus: CarTelemetry['status'] = 'online';
  let staleSoc = false;
  let observedAt: string | null = null;
  let siteUnavailable = false;
  let connected = true;
  let stopConfirmed = true;
  let carPowerWatts = 0;
  let gridImportKw = .5;
  let batteryChargeKw = 0;
  let solarSupport: SolarBatterySupport | undefined;
  const events: Array<{ kind: string; request?: any }> = [];
  const timers = new Map<number, { at: number; callback(): void }>();
  let timerId = 0;
  const state: CarAutomationState = {
    owner: 'owner-one', get manualOverride() { return manualOverride; }, get epoch() { return epoch; },
    get revision() { return revision; }, get error() { return stateError; },
    get targetOverride() { return targetOverride; }, get lastCheckpoint() { return lastCheckpoint; },
    get completedTarget() { return completedTarget; },
    async setManualOverride(value) { manualOverride = value; events.push({ kind: 'persist-manual', request: value }); },
    async setSession(value, next) { epoch = value; revision = next; events.push({ kind: 'persist-session', request: next }); },
    async setTargetOverride(value) { targetOverride = value; },
    async setCheckpoint(value) { lastCheckpoint = value; },
    async setCompletedTarget(value) { completedTarget = value; },
  };
  let device: WattpilotTelemetry = {
    status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: new Date(clock).toISOString(), powerObservedAt: new Date(clock).toISOString(), error: null,
    controlEnabled: true, mode: 'pause', currentAmps: 6, phaseMode: 3, phaseSwitchingSupported: true,
    carConnected: true, charging: false, allowedCharging: false, powerWatts: 0, sessionEnergyWh: 0, totalEnergyWh: 0,
    limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
    automation: { supported: true, owner: epoch ? state.owner : null, epoch, revision: null, lastRevision: 0,
      expiresAt: null, active: false, stopping: false, manualOverride, fence: 0, error: null, deviceExpirySupported: false },
  };
  const car = (): CarTelemetry => ({ status: carStatus, vehicleName: 'Model 3', socPercent: soc,
    observedAt: observedAt ?? new Date(clock - (staleSoc ? 700_000 : 0)).toISOString(), chargeLimitPercent: 80,
    chargingState: carStatus === 'asleep' ? null : 'Stopped', error: null });
  const readDevice = () => structuredClone({ ...device, carConnected: connected,
    powerWatts: carPowerWatts,
    observedAt: new Date(clock).toISOString(), powerObservedAt: new Date(clock).toISOString() });
  const runner = createCarAutomation({ config, state, now: () => new Date(clock), plan: options.plan ?? planCarCharge,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer(handle) { timers.delete(handle as number); },
    controller: {
      async read() { events.push({ kind: 'read' }); return readDevice(); },
      async authorize(owner) {
        events.push({ kind: 'authorize' });
        await options.authorize?.();
        device.automation = { ...device.automation!, owner, epoch: 'epoch-one', manualOverride: false,
          fence: device.automation!.fence + 1, active: false, stopping: false };
        device.mode = 'pause';
        return readDevice();
      },
      async activate(request, guard, signal) {
        events.push({ kind: 'activate', request });
        assert.equal(guard(), true);
        assert.equal(state.revision, request.revision, 'revision must be durable before activation');
        await options.activate?.(request, signal);
        if (signal?.aborted || !guard()) throw new Error('activation cancelled');
        device = { ...device, mode: request.mode, currentAmps: request.currentAmps, phaseMode: request.phases ?? device.phaseMode,
          automation: { ...device.automation!, active: true, stopping: false,
            revision: request.revision, lastRevision: request.revision, expiresAt: request.expiresAt } };
        return readDevice();
      },
      async renew(request, guard) {
        events.push({ kind: 'renew', request });
        assert.equal(guard(), true);
        if (options.renew) return options.renew(readDevice());
        device.automation = { ...device.automation!, expiresAt: request.expiresAt };
        return readDevice();
      },
      async stop(request) {
        events.push({ kind: 'stop', request });
        const info = device.automation!;
        if (info.epoch !== request.epoch || info.owner !== request.owner || info.manualOverride) {
          if (options.stopThrowsOnForeign !== false) throw Object.assign(new Error('Epoch revoked'), { status: 409 });
          return readDevice();
        }
        info.lastRevision = Math.max(info.lastRevision, request.revision);
        if (info.revision === null || info.revision <= request.revision) {
          device.mode = 'pause'; info.active = false; info.stopping = !stopConfirmed; info.revision = null;
        }
        return readDevice();
      },
    },
    async readCar() { return car(); },
    async refreshCarForCharging(signal) {
      events.push({ kind: 'wake' });
      if (runner.status().plan?.target.kind === 'morning') {
        assert.equal(runner.batteryConstraint().guardNight, true, 'Eco keeps the night anti-grid-origin guard during wake');
      }
      if (options.wake) return options.wake(signal);
      carStatus = 'online'; staleSoc = false; return car();
    },
    async readTelemetry() { return { status: siteUnavailable ? 'offline' : 'online', observedAt: new Date(clock).toISOString(),
      error: null, solarKw: 0, householdKw: Math.max(0, gridImportKw - batteryChargeKw), gridImportKw, gridExportKw: 0,
      batterySocPercent: 50, batteryChargeKw, batteryDischargeKw: 0 }; },
    async readBattery() { return { available: true, automatic: true, requestedPowerKw: 6, socPercent: 50, goalSocPercent: 80, solarSupport }; },
    async readForecasts() { return []; },
    async coordinate(plan, guard) {
      assert.equal(guard(), true); events.push({ kind: 'coordinate', request: plan.allowBatteryCharge });
      await options.coordinate?.(plan, guard);
    },
    async releaseCoordination() { events.push({ kind: 'release' }); },
  });
  const settle = async () => { await tick(); await tick(); };
  async function enable() { runner.start(); await runner.setManualOverride(false); await settle(); }
  async function advance(ms: number) {
    const end = clock + ms;
    while (timers.size) {
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0]!;
      if (entry[1].at > end) break;
      timers.delete(entry[0]); clock = entry[1].at; entry[1].callback(); await settle();
    }
    clock = end; await settle();
  }
  return { runner, state, events, timers, car, enable, advance, settle,
    count(kind: string) { return events.filter(event => event.kind === kind); },
    jump(ms: number) { clock += ms; },
    soc(value: number) { soc = value; }, asleep() { carStatus = 'asleep'; staleSoc = true; },
    online() { carStatus = 'online'; staleSoc = false; },
    observedAt(value: string | null) { observedAt = value; },
    offlineSite(value = true) { siteUnavailable = value; }, connected(value: boolean) { connected = value; },
    stale(value = true) { staleSoc = value; }, stopConfirmed(value: boolean) { stopConfirmed = value; },
    actualCarPower(value: number) { carPowerWatts = value; }, support(value: SolarBatterySupport | undefined) { solarSupport = value; },
    gridImport(value: number) { gridImportKw = value; }, batteryCharge(value: number) { batteryChargeKw = value; },
    failState(value = true) { stateError = value ? 'State unavailable' : null; },
    manualDevice(stopping = false) {
      device.mode = 'eco';
      device.automation = { ...device.automation!, epoch: null, owner: null, active: false, manualOverride: true, stopping };
    },
    fireCutoff() {
      const until = runner.status().plan!.windowEndsAt!;
      const end = Date.parse(until);
      const entry = [...timers].find(([, task]) => task.at === end);
      assert.ok(entry, 'independent exact-cutoff timer');
      timers.delete(entry[0]); clock = end; entry[1].callback();
    },
  };
}

test('construction, startup and status are passive until explicit durable Auto authorization', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.runner.start(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'manual');
  assert.equal(f.events.length, 0);
  await f.enable();
  assert.equal(f.state.manualOverride, false);
  assert.equal(f.count('authorize').length, 1);
  assert.equal(f.count('activate').length, 1);
  const activation = f.events.findIndex(event => event.kind === 'activate');
  assert.ok(f.events.findIndex(event => event.kind === 'persist-session' && event.request === 1) < activation);
  assert.equal(f.runner.status().status, 'charging');
});

test('a corrupt persisted state reports blocked even when its safe default is manual', async t => {
  const f = fixture({ stateError: 'L’état persistant est indisponible.' }); t.after(() => f.runner.stop());
  assert.equal(f.runner.status().status, 'blocked');
  assert.equal(f.runner.status().reason, 'state_unavailable');
  assert.equal(f.runner.status().enabled, false);
  f.runner.start();
  await f.runner.evaluate();
  assert.equal(f.events.length, 0);
});

test('unchanged charging renews its lease without replaying setpoints', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); await f.advance(65_000);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('renew').length, 2);
  assert.equal(f.count('renew')[0]!.request.revision, 1);
});

test('household fluctuations curtail the home battery without restarting full-power Tesla charging', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.soc(12); f.batteryCharge(6); f.gridImport(6.7);
  await f.enable();
  assert.equal(f.count('activate')[0]!.request.currentAmps, 16);
  assert.equal(f.runner.batteryConstraint().maxChargePowerKw, 3.1);
  f.batteryCharge(3.1); f.actualCarPower(11040);
  for (const grid of [14.64, 14.84, 14.64, 14.84, 14.64, 14.84, 14.64, 14.84]) {
    f.gridImport(grid); await f.advance(5000);
    assert.equal(f.runner.status().status, 'charging');
    assert.equal(f.runner.status().plan!.currentAmps, 16);
    assert.equal(f.runner.status().plan!.feasible, true);
  }
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('stop').length, 0);
  assert.ok(f.count('renew').length > 0);
  f.gridImport(16.3); await f.advance(5000);
  assert.equal(f.runner.status().plan!.currentAmps, 16);
  assert.equal(f.runner.batteryConstraint().maxChargePowerKw, 1.6);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('stop').length, 0);
});

test('the night window switches an owned Eco session to Normal at 23:05 without solar', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.jump(-5000); // 23:04:55 in Zurich, before the night charging window.
  f.soc(12);
  await f.enable();
  assert.equal(f.runner.status().status, 'eco');
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['eco']);

  await f.advance(5000);
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.runner.status().plan!.source, 'grid');
  assert.equal(f.runner.status().plan!.target.minimumSocPercent, 60);
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['eco', 'normal']);
  assert.equal(f.count('activate').at(-1)!.request.phases, 3);
  const stop = f.events.findIndex(event => event.kind === 'stop');
  const normal = f.events.findIndex(event => event.kind === 'activate' && event.request.mode === 'normal');
  assert.ok(stop >= 0 && stop < normal, 'the Eco lease must stop before Normal replaces it');
});

test('every completed target waits for a five point drop then recharges fully before latching again', async t => {
  for (const targetSoc of [50, 60, 70, 80]) {
    const f = fixture(); t.after(() => f.runner.stop());
    f.jump(Date.parse('2026-10-26T22:10:00.000Z') - origin);
    if (targetSoc !== 50) await f.runner.setTargetOverride({
      deadline: '2026-10-27T05:55:00.000Z', targetSocPercent: targetSoc,
    });
    f.soc(targetSoc - 1); await f.enable();
    assert.equal(f.runner.status().status, 'charging', 'initial charging has no dead band');
    f.soc(targetSoc); await f.advance(5000);
    assert.equal(f.runner.status().reason, 'eco_target_reached');
    assert.equal(f.state.completedTarget?.targetSocPercent, targetSoc);
    for (const drop of [1, 4, 4.9]) {
      f.soc(targetSoc - drop); await f.advance(5000);
      assert.equal(f.runner.status().reason, 'eco_target_hysteresis');
      assert.equal(f.count('activate').filter(event => event.request.mode === 'normal').length, 1);
    }
    f.soc(targetSoc - 5); await f.advance(5000);
    assert.equal(f.runner.status().status, 'charging');
    assert.equal(f.state.completedTarget, null);
    for (const drop of [4, 1]) {
      f.soc(targetSoc - drop); await f.advance(5000);
      assert.equal(f.runner.status().status, 'charging');
    }
    f.soc(targetSoc); await f.advance(5000);
    f.soc(targetSoc - 1); await f.advance(5000);
    assert.equal(f.runner.status().reason, 'eco_target_hysteresis');
    assert.equal(f.count('activate').filter(event => event.request.mode === 'normal').length, 2);
  }
});

test('a night completion survives midnight and stale SOC without permitting a top-up', async t => {
  const f = fixture({ wake: async () => ({ ...f.car(), status: 'asleep' }) });
  t.after(() => f.runner.stop());
  f.soc(60); await f.enable();
  f.jump(2 * 3_600_000);
  f.soc(59); await f.runner.evaluate();
  assert.equal(f.runner.status().reason, 'eco_target_hysteresis');
  f.soc(50); f.stale(); await f.runner.evaluate();
  assert.equal(f.state.completedTarget?.targetSocPercent, 60);
  f.online(); f.soc(59); await f.runner.evaluate();
  assert.equal(f.runner.status().reason, 'eco_target_hysteresis');
  assert.equal(f.count('activate').some(event => event.request.mode === 'normal'), false);
});

test('a new night and a higher explicit target can charge a small initial shortfall', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.soc(60); await f.enable();
  await f.runner.setTargetOverride({ deadline: '2026-10-26T05:55:00.000Z', targetSocPercent: 62 });
  await f.settle(); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.state.completedTarget, null);
  f.soc(62); await f.runner.evaluate();
  f.jump(24 * 3_600_000);
  f.soc(49); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.runner.status().plan?.target.minimumSocPercent, 50);
});

test('the afternoon has its own completion latch and restarts at 25 percent', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.soc(60); await f.enable();
  f.jump(Date.parse('2026-10-26T11:05:00.000Z') - origin);
  f.soc(29); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.soc(30); await f.runner.evaluate();
  f.soc(29); await f.runner.evaluate();
  assert.equal(f.runner.status().reason, 'eco_target_hysteresis');
  f.soc(25); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.soc(29); await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  f.soc(30); await f.runner.evaluate();
  assert.equal(f.runner.status().reason, 'eco_target_reached');
});

test('the final cutoff lease is not renewed when its deadline cannot be extended', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.jump(Date.parse('2026-10-26T05:54:00.000Z') - origin);
  await f.enable(); await f.advance(35_000);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('renew').length, 0);
  assert.equal(f.count('activate')[0]!.request.expiresAt, '2026-10-26T05:55:00.000Z');
});

test('target completion between planning batches returns Eco and retains the night guard', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.soc(60); await f.advance(5000);
  assert.equal(f.runner.status().reason, 'eco_target_reached');
  assert.equal(f.count('stop').length, 1);
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['normal', 'eco']);
  assert.equal(f.runner.batteryConstraint().guardNight, true);
  assert.ok(f.count('release').length > 0);
  assert.ok(f.events.findIndex(event => event.kind === 'stop') < f.events.findIndex(event => event.kind === 'release'));
});

test('the independent cutoff timer stops charging exactly at the permitted boundary', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  f.fireCutoff(); await f.settle();
  assert.equal(f.count('stop').length, 1);
  assert.equal(f.runner.status().reason, 'outside_charging_window');
  assert.equal(f.runner.batteryConstraint().guardNight, true);
  await f.runner.evaluate();
  assert.equal(f.count('activate').length, 2);
  assert.equal(f.count('activate')[1]!.request.mode, 'eco');
  assert.ok(Date.parse(f.count('activate')[1]!.request.expiresAt) > Date.parse('2026-10-26T05:55:00.000Z'));
});

test('unsafe site measurements stop an active charge without waiting for a quarter', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.offlineSite(); await f.advance(5000);
  assert.equal(f.runner.status().status, 'blocked');
  assert.equal(f.count('stop').length, 1);
  assert.equal(f.count('activate').length, 1);
});

test('unplugging returns an owned Normal session to Eco', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.connected(false); await f.advance(5000);
  assert.equal(f.count('stop').length, 1);
  assert.equal(f.runner.status().status, 'eco');
  assert.equal(f.count('activate').at(-1)!.request.mode, 'eco');
});

test('stale SOC stops charging before a long explicit wake, then revalidates before a new revision', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.asleep(); await f.advance(5000);
  const stopped = f.events.findIndex(event => event.kind === 'stop');
  const waking = f.events.findIndex(event => event.kind === 'wake');
  assert.ok(stopped >= 0 && stopped < waking);
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['normal', 'eco', 'normal']);
  assert.equal(f.count('activate')[1]!.request.revision, 2);
});

test('failed freshness recovery has a fifteen-minute wake cooldown instead of five-second wake storms', async t => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ wake: async () => ({ ...f.car(), status: 'asleep' }) }); t.after(() => f.runner.stop());
  f.asleep(); await f.enable(); await f.advance(20_000);
  assert.equal(f.count('wake').length, 1);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.mode, 'eco');
  assert.equal(f.runner.status().status, 'eco');
  f.jump(900_000); await f.runner.evaluate();
  assert.equal(f.count('wake').length, 2);
});

test('Eco remains owned and renews while a forced-window freshness request is pending', async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let f: ReturnType<typeof fixture>;
  f = fixture({ wake: async () => { entered(); await gate; f.online(); return f.car(); } });
  t.after(() => f.runner.stop());
  f.asleep(); await f.enable(); await waiting;
  await f.advance(35_000);
  assert.equal(f.runner.status().status, 'waking');
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.mode, 'eco');
  assert.equal(f.count('renew').length, 1);
  release(); await f.settle();
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['eco', 'normal']);
});

test('manual takeover cancels an in-flight activation and tombstones it without reclaiming control', async t => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ activate: async (_request, signal) => {
    entered(); await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } }); t.after(() => f.runner.stop());
  await f.enable(); await waiting;
  await f.runner.setManualOverride(true); await f.settle();
  assert.equal(f.state.manualOverride, true);
  assert.equal(f.runner.status().status, 'manual');
  assert.equal(f.count('stop').length, 1);
  assert.equal(f.count('stop')[0]!.request.revision, 1);
  f.jump(20_000); await f.runner.evaluate();
  assert.equal(f.count('activate').length, 1);
});

test('an unconfirmed stop blocks fresh activations until cleanup is confirmed', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.stopConfirmed(false); f.soc(60); await f.advance(5000);
  assert.equal(f.runner.status().status, 'stopping');
  assert.equal(f.runner.batteryConstraint().active, true);
  assert.equal(f.count('release').length, 0, 'unknown car stop must retain the battery reservation');
  f.soc(40); await f.advance(5000);
  assert.equal(f.count('activate').length, 1);
  f.stopConfirmed(true); await f.advance(5000);
  assert.equal(f.runner.status().status, 'paused');
  assert.equal(f.runner.batteryConstraint().guardNight, true);
  await f.advance(5000);
  assert.equal(f.count('activate').length, 2);
});

test('a changed controller epoch preserves foreign control and persists manual mode', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable(); f.manualDevice(); await f.advance(5000);
  assert.equal(f.state.manualOverride, true);
  assert.equal(f.runner.status().status, 'manual');
  assert.equal(f.count('stop').length, 0);
});

test('external epoch revocation before a local manual action does not permanently block later Auto', async t => {
  for (const stopThrowsOnForeign of [true, false]) {
    const f = fixture({ stopThrowsOnForeign }); t.after(() => f.runner.stop());
    await f.enable();
    f.manualDevice();
    await f.runner.setManualOverride(true);
    assert.equal(f.state.manualOverride, true);
    assert.equal(f.runner.status().status, 'manual');
    assert.equal(f.runner.batteryConstraint().active, false);
    assert.equal(f.count('activate').length, 1, 'foreign manual settings must not be replaced during reconciliation');
    await f.runner.setManualOverride(false); await f.settle();
    assert.equal(f.state.manualOverride, false);
    assert.equal(f.count('authorize').length, 2);
    assert.equal(f.count('activate').length, 2);
    assert.equal(f.runner.status().status, 'charging');
  }
});

test('a revoked epoch with cleanup still pending retains the old battery reservation', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  f.manualDevice(true);
  await assert.rejects(f.runner.setManualOverride(true), /Epoch revoked/);
  assert.equal(f.state.manualOverride, true);
  assert.equal(f.runner.batteryConstraint().active, true);
  assert.equal(f.count('authorize').length, 1);
});

test('shutdown interrupts wake polling and never activates afterward', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ wake: async signal => {
    entered(); await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    throw new Error('unreachable');
  } });
  f.asleep(); await f.enable(); await waiting;
  await f.runner.stop();
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.mode, 'eco');
  assert.equal(f.runner.status().reason, 'stopped');
});

test('an unplug during wake cancels polling before any charger activation', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ wake: async signal => {
    entered(); await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    throw new Error('unreachable');
  } });
  f.asleep(); await f.enable(); await waiting;
  f.connected(false); await f.advance(5000);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.mode, 'eco');
  assert.equal(f.runner.status().reason, 'eco_car_unplugged');
  await f.runner.stop();
});

test('a persisted Auto epoch can restart with a fresh new decision without reauthorizing', async t => {
  const f = fixture({ manual: false }); t.after(() => f.runner.stop());
  f.runner.start(); await f.settle();
  assert.equal(f.count('authorize').length, 0);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.revision, 1);
});

test('restart tombstones a persisted activation that has not reached the controller yet', async t => {
  const f = fixture({ manual: false }); t.after(() => f.runner.stop());
  await f.state.setSession('epoch-one', 1);
  f.runner.start(); await f.settle();
  assert.equal(f.count('activate').length, 0);
  assert.equal(f.count('stop').length, 1);
  assert.equal(f.count('stop')[0]!.request.revision, 1);
  await f.advance(5000);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.revision, 2);
});

test('late Auto authorization cannot undo a subsequent manual action', async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ authorize: async () => { entered(); await gate; } }); t.after(() => f.runner.stop());
  f.runner.start();
  const enabling = f.runner.setManualOverride(false);
  await waiting;
  await f.runner.setManualOverride(true);
  release(); await enabling; await f.settle();
  assert.equal(f.state.manualOverride, true);
  assert.equal(f.count('activate').length, 0);
  assert.equal(f.runner.status().status, 'manual');
});

test('simultaneous evaluations share one forced evaluation and never duplicate activation', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  const first = f.runner.evaluate();
  const second = f.runner.evaluate();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(f.count('activate').length, 1);
});

test('a site coordination delay crossing cutoff cannot start charging', async t => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ coordinate: async plan => {
    f.jump(Date.parse(plan.windowEndsAt!) - origin);
  } }); t.after(() => f.runner.stop());
  await f.enable();
  assert.equal(f.count('activate').length, 0);
  assert.equal(f.runner.batteryConstraint().guardNight, true);
});

test('an original before-deadline SOC observation is recorded at the morning checkpoint', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  // Reach and observe the minimum before the 06:55 checkpoint, without running
  // thousands of fake safety ticks through the whole night.
  f.jump(Date.parse('2026-10-26T05:54:00.000Z') - origin);
  f.soc(60); await f.runner.evaluate();
  f.jump(60_000); await f.runner.evaluate();
  assert.equal(f.state.lastCheckpoint?.date, '2026-10-26');
  assert.equal(f.state.lastCheckpoint?.kind, 'morning');
  assert.equal(f.state.lastCheckpoint?.result, 'met');
  assert.equal(f.state.lastCheckpoint?.observedSocPercent, 60);
});

test('outside force windows a sleeping or unplugged car defaults to Eco without any wake request', async t => {
  for (const unplugged of [false, true]) {
    const f = fixture(); t.after(() => f.runner.stop());
    f.jump(Date.parse('2026-10-26T09:00:00.000Z') - origin);
    f.asleep(); f.connected(!unplugged); await f.enable();
    assert.equal(f.runner.status().status, 'eco');
    assert.equal(f.count('wake').length, 0);
    assert.equal(f.count('activate').length, 1);
    assert.equal(f.count('activate')[0]!.request.mode, 'eco');
    assert.equal('phases' in f.count('activate')[0]!.request, false);
  }
});

test('the afternoon only forces a fresh sub-30 SOC and returns to Eco at 30', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.jump(Date.parse('2026-10-26T11:05:00.000Z') - origin);
  f.soc(29); await f.enable();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.runner.status().plan?.target.minimumSocPercent, 30);
  assert.equal(f.runner.status().plan?.target.kind, 'afternoon');
  f.soc(30); await f.advance(5000);
  assert.equal(f.runner.status().status, 'eco');
  assert.deepEqual(f.count('activate').map(event => event.request.mode), ['normal', 'eco']);
  assert.equal(f.runner.batteryConstraint().active, false);
});

test('a stale renewal response cannot replace a later manual status', async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ renew: async snapshot => { entered(); await gate; return snapshot; } });
  t.after(() => f.runner.stop());
  f.jump(Date.parse('2026-10-26T09:00:00.000Z') - origin);
  await f.enable();
  const advancing = f.advance(30_000); await waiting;
  await f.runner.setManualOverride(true);
  release(); await advancing; await f.settle();
  assert.equal(f.runner.status().status, 'manual');
  assert.equal(f.state.manualOverride, true);
});

test('the afternoon checkpoint is distinct from an earlier morning checkpoint on the same date', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.state.setCheckpoint({ date: '2026-10-26', targetSocPercent: 60, observedSocPercent: 60,
    result: 'met', recordedAt: '2026-10-26T06:00:00.000Z', kind: 'morning' });
  f.jump(Date.parse('2026-10-26T11:05:00.000Z') - origin);
  f.soc(29); await f.enable();
  f.jump(Date.parse('2026-10-26T15:54:59.000Z') - Date.parse('2026-10-26T11:05:00.000Z'));
  f.soc(30); await f.runner.evaluate();
  f.jump(1000); await f.runner.evaluate();
  assert.equal(f.state.lastCheckpoint?.kind, 'afternoon');
  assert.equal(f.state.lastCheckpoint?.targetSocPercent, 30);
  assert.equal(f.state.lastCheckpoint?.result, 'met');
});

test('unchanged Eco renews without replaying its setpoint and may expire after a Normal cutoff', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.jump(Date.parse('2026-10-26T05:55:10.000Z') - origin);
  await f.enable(); await f.advance(65_000);
  assert.equal(f.count('activate').length, 1);
  assert.equal(f.count('activate')[0]!.request.mode, 'eco');
  assert.ok(Date.parse(f.count('activate')[0]!.request.expiresAt) > Date.parse('2026-10-26T05:55:00.000Z'));
  assert.equal(f.count('renew').length, 2);
  assert.equal(f.runner.batteryConstraint().guardNight, true);
});

test('night Eco guards through 07:00 and supplies only proven solar while the car actually draws', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  f.jump(-5 * 60_000);
  f.support({ available: true, solarStoredKwh: 5, protectedStoredKwh: 25, usableStoredKwh: 3,
    minimumSocPercent: 45, maxDischargeKw: 1 });
  await f.enable();
  assert.equal(f.runner.status().status, 'eco');
  assert.equal(f.runner.batteryConstraint().guardNight, true);
  assert.equal(f.runner.batteryConstraint().until, '2026-10-26T06:00:00.000Z');
  assert.equal(f.runner.batteryConstraint().supply, undefined);
  f.actualCarPower(2000); await f.advance(5000);
  assert.deepEqual(f.runner.batteryConstraint().supply, { minimumSocPercent: 45, maxDischargeKw: 1 });
  assert.equal(f.runner.batteryConstraint().allowCharge, false);
  f.actualCarPower(0); await f.advance(5000);
  assert.equal(f.runner.batteryConstraint().supply, undefined);
  f.jump(Date.parse('2026-10-26T06:00:00.000Z') - (origin - 5 * 60_000 + 10_000));
  await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'eco');
  assert.equal(f.runner.batteryConstraint().active, false);
});

test('the checkpoint considers a late-arriving sample observed just before departure', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  f.jump(Date.parse('2026-10-26T05:55:00.000Z') - origin);
  f.soc(60); f.observedAt('2026-10-26T05:54:59.000Z');
  await f.runner.evaluate();
  assert.equal(f.state.lastCheckpoint?.result, 'met');
  assert.equal(f.state.lastCheckpoint?.observedSocPercent, 60);
});

test('a newer post-departure sample cannot overwrite the last eligible checkpoint proof', async t => {
  const f = fixture(); t.after(() => f.runner.stop());
  await f.enable();
  f.jump(Date.parse('2026-10-26T05:54:58.000Z') - origin);
  f.soc(60); await f.runner.evaluate();
  f.jump(2000);
  f.soc(40); f.observedAt('2026-10-26T05:55:01.000Z');
  await f.runner.evaluate();
  assert.equal(f.state.lastCheckpoint?.result, 'met');
  assert.equal(f.state.lastCheckpoint?.observedSocPercent, 60);
});
