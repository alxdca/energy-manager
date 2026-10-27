import test from 'node:test';
import assert from 'node:assert/strict';
import * as apiModule from '../src/api/api';
import { config } from '../src/config';

function fixture() {
  let initialized = 0;
  let reads = 0;
  let writes = 0;
  let cleaned = 0;
  let initializationError: Error | undefined;
  let reserve: number | null = null;
  let reserveError: Error | undefined;
  let production = 1000;
  let telemetryFailure: 'error' | 'empty' | null = null;
  const powers: Array<[number, number | undefined]> = [];
  const automation: unknown[][] = [];
  const inverter = {
    async initialize() { initialized++; await Promise.resolve(); if (initializationError) throw initializationError; },
    async disconnect() { cleaned++; },
    async getSystemOverview() {
      reads++; await new Promise(resolve => setImmediate(resolve));
      if (telemetryFailure === 'error') throw new Error('Telemetry read failed');
      if (telemetryFailure === 'empty') return { solar: null, grid: null, battery: null, site: null };
      return { solar: { currentProductionKw: production / 1000 }, grid: {}, battery: { socPercent: 50, capacityKwh: 10, currentChargeKwh: 5 }, site: { P_PV: production } };
    },
    getControlStatus() { return { active: false, enabled: true }; },
    getAutomationFence() { return {bootId: 'test-boot', generation: 0}; },
    async getAutomationReserve() { if (reserveError) throw reserveError; return reserve; },
    async chargeToTarget() { writes++; },
    async cancelControl() {},
  };
  const battery = {
    async initialize() {}, async cleanup() { cleaned++; },
    async chargeToTarget() { writes++; },
    async setChargePower(watts: number, target?: number) { writes++; powers.push([watts, target]); }, async setMode() { writes++; }, async setStandby() { writes++; },
    async setAutomationCharge(...args: unknown[]) { writes++; automation.push(args); },
    async setAutomationHold(...args: unknown[]) { writes++; automation.push(['hold', ...args]); },
    async stopAutomationCharge(owner: string) { writes++; automation.push([owner]); },
  };
  const createApi = (apiModule as any).createApi;
  assert.equal(typeof createApi, 'function', 'API must have an isolated injectable factory');
  const settings = { ...config, fronius: { ...config.fronius, control: { enabled: true, maxPowerWatts: 3000, maxSocPercent: 90, maxDurationMs: 300000, revertTimeoutSeconds: 30, checkIntervalMs: 5000 } }, api: { ...config.api } };
  const runtime = createApi({ settings, createInverter: () => inverter, createBattery: () => battery });
  function post(path: string, body: unknown) {
    return runtime.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { ...runtime, post, settings, powers, automation, setProduction(value: number) { production = value; },
    failTelemetry(value: 'error' | 'empty' | null) { telemetryFailure = value; },
    setReserve(value: number | null, error?: Error) { reserve = value; reserveError = error; }, get initialized() { return initialized; }, get reads() { return reads; }, get writes() { return writes; }, get cleaned() { return cleaned; }, failInit(value: boolean, error = new Error('offline')) { initializationError = value ? error : undefined; } };
}

test('manual optional SOC targets validate before device access, including explicit null and nonpositive power', async () => {
  const f = fixture();
  for (const targetSocPercent of [null, '60', false, -1, 0, 91, 100]) {
    assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: 1000, targetSocPercent })).status, 400);
  }
  for (const powerWatts of [0, -1000]) {
    assert.equal((await f.post('/inverter/set-charge-power', { powerWatts, targetSocPercent: 60 })).status, 400);
  }
  const infinite = await f.app.request('/inverter/set-charge-power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"powerWatts":1000,"targetSocPercent":1e400}' });
  assert.equal(infinite.status, 400);
  assert.equal(f.initialized, 0);
  assert.equal(f.writes, 0);
});

test('manual charge acknowledges optional target after activation and retains default, zero and discharge contracts', async () => {
  const f = fixture();
  for (const targetSocPercent of [5, 10, 60, 90]) {
    const response = await f.post('/inverter/set-charge-power', { powerWatts: 1000, targetSocPercent });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.targetSocPercent, targetSocPercent);
    assert.match(result.message, new RegExp(`until ${targetSocPercent}% SOC`));
  }
  const defaultResponse = await f.post('/inverter/set-charge-power', { powerWatts: 1000 });
  const defaultResult = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assert.equal('targetSocPercent' in defaultResult, false);
  assert.match(defaultResult.message, /until 100% SOC/);
  assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: 0 })).status, 200);
  assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: -1000 })).status, 200);
  assert.deepEqual(f.powers, [[1000, 5], [1000, 10], [1000, 60], [1000, 90], [1000, undefined], [0, undefined], [-1000, undefined]]);
  await f.shutdown();
});

test('control status reports configured limits without changing control fields, including disabled power ceiling', async () => {
  const f = fixture();
  const response = await f.app.request('/inverter/control-status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, control: { active: false, enabled: true }, automationFence: {bootId: 'test-boot', generation: 0}, capabilities: { automationCharge: true, automationHold: true, automationSupply: true }, limits: { maxPowerWatts: 3000, minSocPercent: 0, maxSocPercent: 90, revertTimeoutSeconds: 30, reserveSocPercent: null } });
  f.settings.fronius.control.maxPowerWatts = null;
  assert.equal((await (await f.app.request('/inverter/control-status')).json()).limits.maxPowerWatts, null);
  await f.shutdown();
});

test('automation requests validate bounded power, target, ownership and finite expiry before hardware access', async () => {
  const f = fixture();
  f.settings.fronius.control.maxPowerWatts = 6000;
  const valid = {powerWatts: 6000, targetSocPercent: 70, owner: 'energy-manager', expiresAt: new Date(Date.now() + 900_000).toISOString()};
  for (const change of [
    {powerWatts: 0}, {powerWatts: -1}, {powerWatts: 6001}, {powerWatts: 3000.5}, {powerWatts: NaN},
    {targetSocPercent: null}, {targetSocPercent: 91}, {targetSocPercent: 0},
    {owner: ''}, {owner: 'other owner'}, {owner: 'x'.repeat(81)}, {owner: null},
    {expiresAt: new Date(Date.now() - 1).toISOString()}, {expiresAt: new Date(Date.now() + 961_000).toISOString()},
    {expiresAt: '2026-10-24T14:00:00+02:00'}, {expiresAt: 'invalid'}, {extra: true},
  ]) {
    assert.equal((await f.post('/inverter/automation-charge', {...valid, ...change})).status, 400, JSON.stringify(change));
  }
  for (const request of [{owner: null}, {owner: 'energy-manager', extra: true}, {}]) {
    assert.equal((await f.post('/inverter/automation-stop', request)).status, 400);
  }
  assert.equal(f.initialized, 0);
  assert.equal(f.writes, 0);
  assert.equal((await f.post('/inverter/automation-charge', valid)).status, 200);
  assert.equal((await f.post('/inverter/automation-charge', {...valid, powerWatts: 3000})).status, 200);
  assert.deepEqual(f.automation, [[6000, 70, valid.expiresAt, 'energy-manager'], [3000, 70, valid.expiresAt, 'energy-manager']]);
  f.settings.fronius.control.maxPowerWatts = 3000;
  assert.equal((await f.post('/inverter/automation-charge', {...valid, powerWatts: 3001})).status, 400);
  assert.equal((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status, 200);
  assert.equal(f.writes, 3);
  await f.shutdown();
});

test('control status exposes the actual reserve and reserve-read failures cannot block status or manual recovery', async () => {
  const f = fixture();
  f.setReserve(20);
  assert.equal((await (await f.app.request('/inverter/control-status')).json()).limits.reserveSocPercent, 20);
  f.setReserve(null, new Error('Reserve read failed'));
  const unknown = await f.app.request('/inverter/control-status');
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).limits.reserveSocPercent, null);
  assert.equal((await f.post('/inverter/set-mode', {mode: 'normal'})).status, 200);
  f.settings.fronius.control.enabled = false;
  assert.equal((await (await f.app.request('/inverter/control-status')).json()).limits.reserveSocPercent, null);
  await f.shutdown();
});

test('enabled bounded controls accept requests without authorization headers', async () => {
  const f = fixture();
  const commands = [
    ['/inverter/set-charge-power', { powerWatts: 2500 }],
    ['/inverter/standby', {}],
    ['/inverter/set-mode', { mode: 'normal' }],
    ['/inverter/charge-battery', { chargePowerWatts: 2500, targetSocPercent: 80 }],
  ] as const;
  for (const [route, body] of commands) {
    assert.equal((await f.post(route, body)).status, 200);
  }
  assert.equal(f.initialized, 1);
  assert.equal(f.writes, commands.length);
  await f.shutdown();
});

test('bounded charging accepts a target below the former 10% floor', async () => {
  const f = fixture();
  assert.equal((await f.post('/inverter/charge-battery', { chargePowerWatts: 500, targetSocPercent: 7 })).status, 200);
  assert.equal(f.writes, 1);
  await f.shutdown();
});

test('read-only configuration rejects every mutation before hardware access', async () => {
  const f = fixture(); f.settings.fronius.control.enabled = false;
  for (const route of ['/inverter/set-charge-power', '/inverter/standby', '/inverter/set-mode', '/inverter/charge-battery', '/inverter/automation-charge', '/inverter/automation-hold', '/inverter/automation-stop']) {
    assert.equal((await f.post(route, { powerWatts: 1 })).status, 503);
  }
  assert.equal(f.initialized, 0); assert.equal(f.writes, 0);
});

test('invalid, excessive and infinite powers never initialize hardware', async () => {
  const f = fixture();
  for (const body of [{}, { powerWatts: '1000' }, { powerWatts: null }, { powerWatts: 3001 }, { powerWatts: -3001 }]) {
    assert.equal((await f.post('/inverter/set-charge-power', body)).status, 400);
  }
  const infinite = await f.app.request('/inverter/set-charge-power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"powerWatts":1e400}' });
  assert.equal(infinite.status, 400); assert.equal(f.initialized, 0);
});

test('malformed JSON and null bodies return 400 without device access', async () => {
  const f = fixture();
  const response = await f.app.request('/inverter/set-charge-power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.equal((await f.post('/inverter/set-mode', null)).status, 400);
  assert.equal(f.initialized, 0);
});

test('ambiguous force modes and unsafe SOC targets are rejected before initialization', async () => {
  const f = fixture();
  for (const mode of ['force_charge', 'force_discharge']) assert.equal((await f.post('/inverter/set-mode', { mode })).status, 400);
  for (const targetSocPercent of [-1, 0, 91, 100]) assert.equal((await f.post('/inverter/charge-battery', { chargePowerWatts: 1000, targetSocPercent })).status, 400);
  assert.equal(f.initialized, 0);
});

test('concurrent status requests initialize once and share telemetry across routes', async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => f.app.request(i % 2 ? '/battery/status' : '/system/status')));
  assert.ok(responses.every((r: Response) => r.status === 200));
  assert.equal(f.initialized, 1); assert.equal(f.reads, 1); assert.equal(f.writes, 0);
  assert.equal((await f.app.request('/system/status')).status, 200); assert.equal(f.reads, 2);
});

test('sequential status requests always read updated telemetry without waiting for a TTL', async () => {
  const f = fixture();
  assert.equal((await (await f.app.request('/system/status')).json()).site.P_PV, 1000);
  f.setProduction(2500);
  assert.equal((await (await f.app.request('/system/status')).json()).site.P_PV, 2500);
  assert.equal(f.reads, 2);
  assert.equal(f.initialized, 1);
  assert.equal(f.writes, 0);
});

test('a failed read never serves the prior snapshot and failure does not prevent an immediate retry', async () => {
  for (const failure of ['error', 'empty'] as const) {
    const f = fixture();
    assert.equal((await f.app.request('/system/status')).status, 200);
    f.failTelemetry(failure);
    const failed = await Promise.all([f.app.request('/system/status'), f.app.request('/battery/status')]);
    assert.ok(failed.every(response => response.status === (failure === 'error' ? 502 : 503)));
    assert.equal(f.reads, 2, 'simultaneous failing requests still share their in-flight read');
    f.failTelemetry(null); f.setProduction(3000);
    const recovered = await f.app.request('/system/status');
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).site.P_PV, 3000);
    assert.equal(f.reads, 3);
    assert.equal(f.writes, 0);
  }
});

test('failed initialization can be retried instead of publishing broken singletons', async () => {
  const f = fixture(); f.failInit(true);
  assert.equal((await f.app.request('/system/status')).status, 503);
  f.failInit(false); assert.equal((await f.app.request('/system/status')).status, 200);
  assert.equal(f.initialized, 2);
});

test('failed control initialization reports the device error and never applies power', async () => {
  for (const message of [
    'connect ECONNREFUSED 192.0.2.1:502',
    'Connection timeout: inverter did not respond within 10 seconds',
    'Unsupported storage model layout',
  ]) {
    const f = fixture(); f.failInit(true, new Error(message));
    const response = await f.post('/inverter/set-charge-power', { powerWatts: 3000 });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: `Device initialization failed: ${message}` });
    assert.equal(f.cleaned, 1);
    assert.equal(f.writes, 0);
    f.failInit(false);
    assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: 3000 })).status, 200);
    await f.shutdown();
  }
});

test('bounded commands execute; shutdown cleans once and blocks new requests', async () => {
  const f = fixture(); assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: 1000 })).status, 200);
  assert.equal(f.writes, 1); await Promise.all([f.shutdown(), f.shutdown()]);
  assert.equal(f.cleaned, 1); assert.equal((await f.app.request('/system/status')).status, 503);
});

test('shutdown prevents a pending initialized request from starting a late control', async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  let cleaned = 0;
  const settings = { ...config, fronius: { ...config.fronius, control: { ...config.fronius.control, enabled: true, maxPowerWatts: 3000 } }, api: { ...config.api } };
  const { app, shutdown } = (apiModule as any).createApi({ settings,
    createInverter: () => ({ initialize: () => pending, disconnect: async () => {} }),
    createBattery: () => ({ initialize: async () => {}, setChargePower: async () => { writes++; }, cleanup: async () => { cleaned++; } }),
  });
  const response = app.request('/inverter/set-charge-power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"powerWatts":1000}' });
  await new Promise(resolve => setImmediate(resolve));
  const stopping = shutdown(); release(); await stopping;
  assert.equal((await response).status, 503); assert.equal(writes, 0); assert.equal(cleaned, 1);
});

test('already aborted write requests never initialize a device', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  const response = await f.app.request('/inverter/set-charge-power', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: '{"powerWatts":1000}' });
  assert.equal(response.status, 409); assert.equal(f.initialized, 0); assert.equal(f.writes, 0);
});

test('oversized mutation bodies fail before hardware initialization', async () => {
  const f = fixture();
  assert.equal((await f.post('/inverter/set-charge-power', { padding: 'x'.repeat(5000), powerWatts: 1000 })).status, 413);
  assert.equal(f.initialized, 0); assert.equal(f.writes, 0);
});

test('removed automation routes return 404 without hardware access', async () => {
  const f = fixture();
  assert.equal((await f.post('/automated-mode/enable', { mode: 'winter' })).status, 404);
  assert.equal((await f.post('/automated-mode/disable', {})).status, 404);
  assert.equal((await f.app.request('/automated-mode/status')).status, 404);
  assert.equal(f.initialized, 0);
  assert.equal(f.writes, 0);
});

test('automation hold strictly validates a finite lease and owner before hardware access', async () => {
  const f = fixture();
  f.settings.fronius.control.maxPowerWatts = 6000;
  const valid = {owner: 'energy-manager', expiresAt: new Date(Date.now() + 900_000).toISOString()};
  for (const change of [{owner: ''}, {owner: null}, {owner: 'bad owner'}, {expiresAt: 'invalid'},
    {expiresAt: new Date(Date.now() - 1).toISOString()}, {expiresAt: new Date(Date.now() + 961_000).toISOString()},
    {powerWatts: 6000}, {targetSocPercent: 70}, {extra: true}]) {
    assert.equal((await f.post('/inverter/automation-hold', {...valid, ...change})).status, 400);
  }
  assert.equal(f.initialized, 0); assert.equal(f.writes, 0);
  assert.equal((await f.post('/inverter/automation-hold', valid)).status, 200);
  assert.deepEqual(f.automation, [['hold', valid.expiresAt, valid.owner]]);
  await f.shutdown();
});
