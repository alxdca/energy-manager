import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/api.js';
import { loadConfig } from '../src/config/index.js';
import type { Wattpilot, WattpilotCommand, WattpilotStatus } from '../src/devices/wattpilot.js';

function fixture() {
  let created = 0;
  const writes: WattpilotCommand[] = [];
  let state: WattpilotStatus = {
    status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: new Date().toISOString(), powerObservedAt: new Date().toISOString(), error: null,
    controlEnabled: true, mode: 'pause', carConnected: true, charging: false, allowedCharging: false,
    currentAmps: 6, phaseMode: 3, phaseSwitchingSupported: true, powerWatts: 0,
    sessionEnergyWh: 0, totalEnergyWh: 0, limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
  };
  const runtime = createApi({ wattpilotJournalPath: null,
    settings: loadConfig({ WATTPILOT_URL: 'ws://192.0.2.1/ws', WATTPILOT_PASSWORD: 'test-only',
      WATTPILOT_CONTROL_ENABLED: 'true', WATTPILOT_MAX_CURRENT_AMPS: '16' }),
    createInverter: () => { throw new Error('Automatic Wattpilot must not initialize GEN24'); },
    createWattpilot: () => {
      created++;
      return { async readStatus() { return state; }, async setControl(command: WattpilotCommand) {
        writes.push(command);
        state = { ...state, mode: command.mode, currentAmps: command.currentAmps ?? state.currentAmps,
          phaseMode: command.phases ?? state.phaseMode,
          charging: command.mode !== 'pause', allowedCharging: command.mode !== 'pause', powerWatts: command.mode === 'pause' ? 0 : 4140 };
        return state;
      }, async pauseAndConfirm() {
        writes.push({ mode: 'pause' });
        state = { ...state, mode: 'pause', charging: false, allowedCharging: false, powerWatts: 0 };
        return state;
      },
      async disconnect() {} } as unknown as Wattpilot;
    },
  });
  const post = (path: string, body: unknown) => runtime.app.request(`/wattpilot/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ...runtime, post, writes, get created() { return created; } };
}

test('automatic Wattpilot HTTP contract establishes, activates, renews and conditionally stops', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const established = await f.post('automation-epoch', { owner: 'orchestrator', expectedFence: 0 });
  assert.equal(established.status, 200);
  const { automation } = (await established.json()).wattpilot;
  assert.equal(automation.manualOverride, false);
  assert.equal(automation.fence, 1);
  assert.equal(f.writes.length, 0);
  const lease = { owner: 'orchestrator', epoch: automation.epoch, revision: 1,
    expiresAt: new Date(Date.now() + 90_000).toISOString() };
  const charged = await f.post('automation-control', { ...lease, mode: 'normal', currentAmps: 10, phases: 3 });
  assert.equal(charged.status, 200);
  assert.equal((await charged.json()).wattpilot.automation.active, true);
  assert.deepEqual(f.writes, [{ mode: 'normal', currentAmps: 10, phases: 3 }]);
  assert.equal((await f.post('automation-renew', lease)).status, 200);
  assert.equal(f.writes.length, 1);
  const stop = await f.post('automation-stop', { owner: lease.owner, epoch: lease.epoch, revision: 1 });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).wattpilot.automation.active, false);
  assert.equal(f.writes.at(-1)!.mode, 'pause');
});

test('invalid automatic HTTP bodies are rejected before the charger is created', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const request = { owner: 'orchestrator', epoch: 'epoch', revision: 1,
    expiresAt: new Date(Date.now() + 90_000).toISOString(), mode: 'normal', currentAmps: 6 };
  for (const [path, body] of [
    ['automation-epoch', { owner: 'owner', expectedFence: -1 }],
    ['automation-control', { ...request, currentAmps: 17 }],
    ['automation-control', { ...request, phases: 2 }],
    ['automation-control', { ...request, revision: 0 }],
    ['automation-control', { ...request, expiresAt: new Date(Date.now() + 200_000).toISOString() }],
    ['automation-control', { ...request, targetSocPercent: 60 }],
    ['automation-renew', { owner: 'owner', epoch: 'epoch', revision: 1 }],
    ['automation-stop', { owner: 'owner', epoch: 'epoch', revision: 1, currentAmps: 6 }],
  ] as const) assert.equal((await f.post(path, body)).status, 400, path);
  assert.equal(f.created, 0);
  assert.equal(f.writes.length, 0);
});

test('manual HTTP control invalidates old automation requests and status remains read-only', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const first = await (await f.post('automation-epoch', { owner: 'owner', expectedFence: 0 })).json();
  const identity = { owner: 'owner', epoch: first.wattpilot.automation.epoch, revision: 1 };
  await f.post('set-control', { mode: 'eco', currentAmps: 6 });
  const count = f.writes.length;
  assert.equal((await f.post('automation-control', { ...identity, mode: 'normal', currentAmps: 6,
    expiresAt: new Date(Date.now() + 90_000).toISOString() })).status, 409);
  assert.equal((await f.post('automation-stop', identity)).status, 409);
  const response = await f.app.request('/wattpilot/status');
  assert.equal((await response.json()).wattpilot.automation.manualOverride, true);
  assert.equal(f.writes.length, count);
});
