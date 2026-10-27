import assert from 'node:assert/strict';
import test from 'node:test';
import { Battery } from '../src/devices/battery.js';
import { BatteryMode, type BatteryInfo } from '../src/types/common.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function telemetry(soc: number | null): BatteryInfo {
  return { capacityKwh: 10, currentChargeKwh: soc === null ? 0 : soc / 10, chargeRateKw: 0, dischargeRateKw: 0, efficiency: 1, socPercent: soc, validValues: soc === null ? [] : ['soc'] };
}
function fixture(iso = '2026-10-21T20:00:00Z') {
  const calls: unknown[][] = [];
  const inverter = {
    isOnline: () => true,
    initialize: async () => { calls.push(['initialize']); },
    getBatteryData: async (): Promise<BatteryInfo | null> => telemetry(20),
    cancelControl: async () => { calls.push(['cancel']); },
    chargeToTarget: async (...args: unknown[]) => { calls.push(['target', ...args]); },
    setBatteryChargePower: async (watts: number, target?: number) => { calls.push(['power', watts, target]); },
    setBatteryMode: async (mode: BatteryMode) => { calls.push(['mode', mode]); },
    setBatteryStandby: async () => { calls.push(['standby']); },
    setAutomationCharge: async (...args: unknown[]) => { calls.push(['automation', ...args]); },
    setAutomationHold: async (...args: unknown[]) => { calls.push(['automation-hold', ...args]); },
    stopAutomationCharge: async (owner: string) => { calls.push(['automation-stop', owner]); },
    disconnect: async () => { calls.push(['disconnect']); },
  };
  const battery = new Battery(inverter as any, { now: () => new Date(iso) } as any);
  return { battery, inverter, calls };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('automation forwards conditional ownership operations without cancelling manual control first', async () => {
  const {battery, calls} = fixture();
  await battery.setAutomationCharge(6000, 70, '2026-10-21T20:15:00.000Z', 'energy-manager');
  await battery.stopAutomationCharge('energy-manager');
  assert.deepEqual(calls, [
    ['automation', 6000, 70, '2026-10-21T20:15:00.000Z', 'energy-manager'],
    ['automation-stop', 'energy-manager'],
  ]);
});

test('queued automation cannot supersede a newer manual transition', async () => {
  const {battery, calls} = fixture();
  const automated = battery.setAutomationCharge(6000, 70, '2026-10-21T20:15:00.000Z', 'energy-manager');
  const manual = battery.setChargePower(1000, 60);
  await assert.rejects(automated, conflict);
  await manual;
  assert.equal(calls.some(call => call[0] === 'automation'), false);
  assert.deepEqual(calls.at(-1), ['power', 1000, 60]);
});

test('queued old automation stop cannot stop a newer manual transition', async () => {
  const {battery, calls} = fixture();
  const automated = battery.stopAutomationCharge('energy-manager');
  const manual = battery.setChargePower(1000, 60);
  await assert.rejects(automated, conflict);
  await manual;
  assert.equal(calls.some(call => call[0] === 'automation-stop'), false);
  assert.deepEqual(calls.at(-1), ['power', 1000, 60]);
});

test('manual power forwards the optional SOC stopping target and preserves signed one-argument calls', async () => {
  const { battery, calls } = fixture();
  await battery.setChargePower(1000, 60);
  await battery.setChargePower(1500);
  await battery.setChargePower(-500);
  await battery.setChargePower(0);
  assert.deepEqual(calls.filter(call => call[0] === 'power'), [
    ['power', 1000, 60], ['power', 1500, undefined], ['power', -500, undefined], ['power', 0, undefined],
  ]);
  await battery.cleanup();
});

test('unknown SOC is never reported as an empty battery', async () => {
  const { battery, inverter } = fixture();
  assert.equal(battery.getChargePercentage(), null);
  inverter.getBatteryData = async () => telemetry(null);
  await battery.refreshInfo();
  assert.equal(battery.getChargePercentage(), null);
  inverter.getBatteryData = async () => telemetry(Number.NaN);
  await battery.refreshInfo();
  assert.equal(battery.getChargePercentage(), null);
});

test('failed or empty refresh invalidates previously cached battery data', async () => {
  const { battery, inverter } = fixture();
  await battery.refreshInfo();
  inverter.getBatteryData = async () => { throw new Error('offline'); };
  await assert.rejects(battery.refreshInfo(), /offline/);
  assert.equal(battery.getBatteryInfo(), null);
  assert.equal(battery.getChargePercentage(), null);
  inverter.getBatteryData = async () => null;
  assert.equal(await battery.refreshInfo(), null);
});

test('initialization and read-only cleanup do not set battery modes', async () => {
  const { battery, calls } = fixture();
  await battery.initialize();
  assert.deepEqual(calls, []);
  await battery.cleanup();
  assert.equal(calls.some(call => call[0] === 'mode'), false);
  assert.equal(calls.at(-1)?.[0], 'disconnect');
});

test('manual power cancels target charging before taking ownership', async () => {
  const { battery, inverter, calls } = fixture();
  const job = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async (...args) => { started = true; calls.push(['target', ...args]); await job.promise; };
  inverter.cancelControl = async () => { calls.push(['cancel']); if (started) job.resolve(); };
  const targeting = battery.chargeToTarget(1500, 50);
  void targeting.catch(() => undefined);
  await flush();
  await battery.setChargePower(1000);
  await assert.rejects(targeting, conflict);
  const powerIndex = calls.findIndex(call => call[0] === 'power');
  assert.equal(calls[powerIndex - 1]?.[0], 'cancel');
  await battery.cleanup();
});

test('concurrent telemetry refreshes share one inverter read', async () => {
  const { battery, inverter } = fixture();
  const read = deferred<BatteryInfo | null>();
  let reads = 0;
  inverter.getBatteryData = async () => { reads++; return read.promise; };
  const first = battery.refreshInfo();
  const second = battery.refreshInfo();
  assert.equal(reads, 1);
  read.resolve(telemetry(40));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(info => info?.socPercent), [40, 40]);
  await battery.cleanup();
});

test('cleanup closes inverter even when restoration fails and propagates failure', async () => {
  const { battery, inverter, calls } = fixture();
  inverter.cancelControl = async () => { throw new Error('restore failed'); };
  await assert.rejects(battery.cleanup(), /restore failed/);
  assert.equal(calls.at(-1)?.[0], 'disconnect');
});

test('a stale rejected job cannot cancel the replacement manual command', async () => {
  const { battery, inverter, calls } = fixture();
  const job = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async () => { started = true; await job.promise; };
  inverter.cancelControl = async () => {
    calls.push(['cancel']);
    if (started) job.reject(new Error('previous job canceled'));
  };
  const targeting = battery.chargeToTarget(1500, 50);
  void targeting.catch(() => undefined);
  await flush();
  await battery.setStandby();
  await assert.rejects(targeting, /previous job canceled/);
  await flush();
  assert.equal(calls.at(-1)?.[0], 'standby');
  await battery.cleanup();
});

test('manual target does not hold the transition lock while waiting and normal mode cancels it', async () => {
  const { battery, inverter, calls } = fixture();
  const job = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async (...args) => { started = true; calls.push(['target', ...args]); await job.promise; };
  inverter.cancelControl = async () => { calls.push(['cancel']); if (started) job.resolve(); };
  const targeting = battery.chargeToTarget(1500, 50);
  void targeting.catch(() => undefined);
  await flush();
  assert.equal(started, true);
  await battery.setMode(BatteryMode.NORMAL);
  await assert.rejects(targeting, conflict);
  assert.deepEqual(calls.slice(-2), [['cancel'], ['mode', BatteryMode.NORMAL]]);
  await battery.cleanup();
});

test('new target cancels a pending target before starting its own bounded job', async () => {
  const { battery, inverter, calls } = fixture();
  const manual = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async (...args) => {
    calls.push(['target', ...args]);
    if (args[1] === 50) { started = true; await manual.promise; }
  };
  inverter.cancelControl = async () => { calls.push(['cancel']); if (started) manual.resolve(); };
  const targeting = battery.chargeToTarget(1500, 50);
  void targeting.catch(() => undefined);
  await flush();
  await battery.chargeToTarget(1000, 60);
  await assert.rejects(targeting, conflict);
  const targetIndex = calls.findIndex(call => call[0] === 'target' && call[2] === 60);
  assert.ok(targetIndex > 0);
  assert.equal(calls[targetIndex - 1]?.[0], 'cancel');
  await battery.cleanup();
});

const conflict = (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409;

test('superseded public control requests reject with 409 instead of reporting success', async () => {
  const { battery, calls } = fixture();
  const power = battery.setChargePower(1000);
  const standby = battery.setStandby();
  await assert.rejects(power, conflict);
  await standby;
  assert.equal(calls.some(call => call[0] === 'power'), false);
  const target = battery.chargeToTarget(1000, 50);
  const stop = battery.setChargePower(0);
  await assert.rejects(target, conflict);
  await stop;
  const obsoleteStop = battery.setChargePower(0);
  const currentMode = battery.setMode(BatteryMode.NORMAL);
  await assert.rejects(obsoleteStop, conflict);
  await currentMode;
  await battery.cleanup();
});

test('stop invalidates lower inverter intent immediately during slow power activation', async () => {
  const { battery, inverter } = fixture();
  const activation = deferred<void>();
  let started = false;
  let invalidated = false;
  inverter.setBatteryChargePower = async () => {
    started = true;
    await activation.promise;
    if (invalidated) throw Object.assign(new Error('Power activation superseded'), { statusCode: 409 });
  };
  inverter.cancelControl = async () => {
    if (started) {
      invalidated = true;
      activation.resolve();
    }
  };
  const power = battery.setChargePower(1000);
  await flush();
  const stop = battery.setChargePower(0);
  try {
    assert.equal(invalidated, true);
  } finally {
    activation.resolve();
    await Promise.allSettled([power, stop]);
  }
  await assert.rejects(power, conflict);
  await battery.cleanup();
});

test('pre-aborted target request rejects before any control side effect', async () => {
  const { battery, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(battery.chargeToTarget(1000, 50, controller.signal), conflict);
  assert.deepEqual(calls, []);
});

test('aborting an active target awaits cancellation and rejects the request', async () => {
  const { battery, inverter, calls } = fixture();
  const job = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async (...args) => { started = true; calls.push(['target', ...args]); await job.promise; };
  inverter.cancelControl = async () => { calls.push(['cancel']); if (started) job.resolve(); };
  const controller = new AbortController();
  const targeting = battery.chargeToTarget(1000, 50, controller.signal);
  await flush();
  const previous = calls.filter(call => call[0] === 'cancel').length;
  controller.abort();
  try {
    assert.equal(calls.filter(call => call[0] === 'cancel').length, previous + 1);
  } finally {
    job.resolve();
    await Promise.allSettled([targeting]);
  }
  await assert.rejects(targeting, conflict);
  await battery.cleanup();
});

test('aborting a pending target prevents activation after initial cleanup finishes', async () => {
  const { battery, inverter, calls } = fixture();
  const cleanup = deferred<void>();
  let cancellations = 0;
  inverter.cancelControl = async () => { cancellations++; if (cancellations === 1) await cleanup.promise; };
  const controller = new AbortController();
  const targeting = battery.chargeToTarget(1000, 50, controller.signal);
  await flush();
  controller.abort();
  cleanup.resolve();
  await assert.rejects(targeting, conflict);
  assert.equal(calls.some(call => call[0] === 'target'), false);
  await battery.cleanup();
});

test('an old request abort cannot cancel a newer replacement owner', async () => {
  const { battery, inverter, calls } = fixture();
  const oldJob = deferred<void>();
  const cleanup = deferred<void>();
  let started = false;
  inverter.chargeToTarget = async () => { started = true; await oldJob.promise; };
  inverter.cancelControl = async () => {
    calls.push(['cancel']);
    if (started) await cleanup.promise;
  };
  const controller = new AbortController();
  const targeting = battery.chargeToTarget(1000, 50, controller.signal);
  await flush();
  const replacement = battery.setStandby();
  const cancellations = calls.filter(call => call[0] === 'cancel').length;
  controller.abort();
  assert.equal(calls.filter(call => call[0] === 'cancel').length, cancellations);
  cleanup.resolve();
  oldJob.resolve();
  await Promise.allSettled([targeting]);
  await replacement;
  assert.equal(calls.at(-1)?.[0], 'standby');
  await battery.cleanup();
});

test('hold forwards ownership without cancelling and queued hold cannot supersede manual control', async () => {
  const {battery, calls} = fixture();
  await battery.setAutomationHold('2026-10-21T20:15:00.000Z', 'energy-manager');
  assert.deepEqual(calls, [['automation-hold', '2026-10-21T20:15:00.000Z', 'energy-manager']]);
  const queued = battery.setAutomationHold('2026-10-21T20:15:00.000Z', 'energy-manager');
  const manual = battery.setChargePower(1000, 60);
  await assert.rejects(queued, conflict);
  await manual;
  assert.equal(calls.filter(call => call[0] === 'automation-hold').length, 1);
  assert.deepEqual(calls.at(-1), ['power', 1000, 60]);
});
