import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlsService } from '../src/controls.js';
import type { CarAutomationStatus, CarPlan, CarTargetOverride } from '../src/car-types.js';

const at = '2026-10-25T20:00:00.000Z';
function fixture(batteryTarget = 0, batteryActual = 0, solarWatts = 8000, gridWatts = -7500, atTime = at) {
  const calls: { path: string; method: string }[] = [];
  const overrides: boolean[] = [];
  const targets: Array<CarTargetOverride | null> = [];
  const carStatus: CarAutomationStatus = { enabled: true, status: 'idle', reason: 'awaiting_evaluation', error: null,
    lastEvaluatedAt: null, nextEvaluationAt: null, lastCheckpoint: null,
    plan: { source: 'eco', action: 'eco', observedAt: atTime } as CarPlan };
  let charger = {
    status: 'online', configured: true, connected: true, ready: true, stale: false, observedAt: atTime, powerObservedAt: atTime,
    error: null, controlEnabled: true, mode: 'pause', carConnected: true, charging: false, allowedCharging: false,
    currentAmps: 6, phaseMode: 3, phaseSwitchingSupported: true, powerWatts: 0, sessionEnergyWh: 0, totalEnergyWh: 0,
    limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
    automation: { supported: true, owner: 'car-owner', epoch: 'epoch', revision: null as number | null,
      lastRevision: 0, expiresAt: null as string | null, active: false, stopping: false,
      manualOverride: false, fence: 1, error: null, deviceExpirySupported: false },
  };
  const service = createControlsService({ controllerUrl: 'http://controller.test', now: () => new Date(atTime),
    carAutomation: { status: () => carStatus, owns: owner => owner === 'car-owner',
      async setManualOverride(value) { overrides.push(value); }, async setTargetOverride(value) { targets.push(value); } },
    automation: { enabled: () => true, owns: owner => owner === 'battery-owner', async setManualOverride() {} },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET' });
      if (path === '/system/status') return Response.json({ success: true, timestamp: atTime,
        site: { P_Grid: gridWatts, P_Akku: -batteryActual, P_PV: solarWatts, P_Load: -Math.max(0, gridWatts - batteryActual + solarWatts) } });
      if (path === '/inverter/control-status') return Response.json({ success: true,
        control: { enabled: true, active: true, watts: batteryTarget, automationOwner: 'battery-owner',
          automationMode: batteryTarget ? 'charge' : 'hold' },
        capabilities: { automationCharge: true, automationHold: true },
        limits: { maxPowerWatts: 6000, minSocPercent: 0, maxSocPercent: 90, reserveSocPercent: 5 } });
      if (path === '/wattpilot/automation-control') {
        const request = JSON.parse(String(init!.body));
        charger = { ...charger, mode: request.mode, currentAmps: request.currentAmps, charging: request.mode === 'normal', allowedCharging: true,
          automation: { ...charger.automation, active: true, revision: request.revision, lastRevision: request.revision, expiresAt: request.expiresAt } };
      }
      if (path === '/wattpilot/set-control') charger = { ...charger, mode: 'pause' };
      return Response.json({ success: true, wattpilot: charger });
    },
  });
  const activation = { owner: 'car-owner', epoch: 'epoch', revision: 1, expiresAt: new Date(Date.parse(atTime) + 90_000).toISOString(),
    mode: 'normal' as const, currentAmps: 8, phases: 3 as const };
  const post = (path: string, value: unknown, signal?: AbortSignal) => service.api.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
  return { service, activation, calls, overrides, targets, post,
    plan(value: CarPlan) { carStatus.plan = value; } };
}
test('normal automatic charging outside the night/afternoon force periods is refused even with sunshine', async () => {
  const pending = fixture(6000);
  await assert.rejects(pending.service.carAutomationController.activate(pending.activation, () => true), /période autorisée/);
  assert.equal(pending.calls.some(call => call.method === 'POST'), false);
});
test('Eco remains available in the rest period and still reserves pending battery load for site safety', async () => {
  const free = fixture();
  const eco = { ...free.activation, mode: 'eco' as const, phases: undefined };
  assert.equal((await free.service.carAutomationController.activate(eco, () => true)).mode, 'eco');
  assert.equal(free.calls.filter(call => call.method === 'POST').length, 1);
  const pending = fixture(6000, 0, 0, 10_000);
  await assert.rejects(pending.service.carAutomationController.activate({ ...pending.activation, mode: 'eco', phases: undefined }, () => true), /16 kW/);
  assert.equal(pending.calls.some(call => call.method === 'POST'), false);
});
test('afternoon normal commands require a fresh below30% goal and cannot use the weekly morning minimum', async () => {
  for (const [socPercent, target] of [[29, 30], [30, 30], [29, 60]]) {
    const f = fixture(0, 0, 0, 500, '2026-10-26T12:10:00.000Z');
    f.plan({ action: 'charge', source: 'grid', observedAt: '2026-10-26T12:10:00.000Z', socPercent,
      target: { minimumSocPercent: target, gridChargingEndsAt: '2026-10-26T15:55:00.000Z', kind: 'afternoon' } } as CarPlan);
    if (socPercent < 30 && target === 30) {
      assert.equal((await f.service.carAutomationController.activate(f.activation, () => true)).mode, 'normal');
    } else {
      await assert.rejects(f.service.carAutomationController.activate(f.activation, () => true), /période autorisée/);
      assert.equal(f.calls.some(call => call.method === 'POST'), false);
    }
  }
});
test('Auto and target actions validate declarative inputs without sending manual charger settings', async () => {
  const f = fixture();
  assert.equal((await f.post('/car', { mode: 'auto', phases: 1 })).status, 400);
  assert.deepEqual(f.overrides, []);
  assert.equal((await f.post('/car', { mode: 'auto' })).status, 200);
  assert.deepEqual(f.overrides, [false]);
  assert.equal(f.calls.length, 0);
  for (const value of [{ targetSocPercent: 50, deadline: '2026-10-26T04:30:00.000Z' },
    { targetSocPercent: 70, deadline: '2026-10-26T08:30:00.000Z' }, { extra: true }]) {
    assert.equal((await f.post('/car-target', value)).status, 400);
  }
  const target = { targetSocPercent: 70, deadline: '2026-10-26T04:30:00.000Z' };
  assert.equal((await f.post('/car-target', target)).status, 200);
  assert.equal((await f.post('/car-target', null)).status, 200);
  assert.deepEqual(f.targets, [target, null]);
  assert.equal((await f.post('/car-target', { padding: 'x'.repeat(5000) })).status, 413);
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.post('/car-target', target, abort.signal)).status, 409);
  assert.equal(f.targets.length, 2);
  assert.equal(f.calls.length, 0);
});
