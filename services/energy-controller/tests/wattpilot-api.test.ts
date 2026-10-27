import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/api.js';
import { loadConfig } from '../src/config/index.js';
import type { Wattpilot } from '../src/devices/wattpilot.js';

function fixture(enabled = true) {
  const settings = loadConfig({
    WATTPILOT_URL: 'ws://192.0.2.1/ws', WATTPILOT_PASSWORD: 'test-only',
    WATTPILOT_CONTROL_ENABLED: String(enabled), WATTPILOT_MAX_CURRENT_AMPS: '16',
  });
  let created = 0;
  let reads = 0;
  let closed = 0;
  const commands: unknown[] = [];
  let failure: Error | null = null;
  const runtime = createApi({ settings, wattpilotJournalPath: null,
    createInverter() { throw new Error('Wattpilot must not initialize GEN24'); },
    createWattpilot() {
      created++;
      return {
        async readStatus() { reads++; return { status: 'online' }; },
        async setControl(command: unknown) { commands.push(command); if (failure) throw failure; return { status: 'online' }; },
        async disconnect() { closed++; },
      } as unknown as Wattpilot;
    },
  });
  const post = (value: unknown) => runtime.app.request('/wattpilot/set-control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return { ...runtime, settings, post, commands, fail(error: Error) { failure = error; },
    get created() { return created; }, get reads() { return reads; }, get closed() { return closed; } };
}

test('Wattpilot has independent lazy status/control while GEN24 is read-only and unreachable', async () => {
  const f = fixture();
  assert.equal(f.settings.fronius.control.enabled, false);
  const response = await f.app.request('/wattpilot/status');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.wattpilot.status, 'online');
  assert.equal(body.wattpilot.automation.supported, true);
  assert.equal(body.wattpilot.automation.manualOverride, true);
  const commands = [{ mode: 'pause' }, { mode: 'normal', currentAmps: 10 }, { mode: 'eco', currentAmps: 6 },
    { mode: 'normal', currentAmps: 6, phases: 1 }, { mode: 'eco', currentAmps: 10, phases: 3 }];
  for (const command of commands) {
    assert.equal((await f.post(command)).status, 200);
  }
  assert.equal(f.created, 1);
  assert.deepEqual(f.commands, commands);
  assert.equal((await f.app.request('/inverter/set-mode', { method: 'POST', body: '{"mode":"normal"}' })).status, 503);
  await f.shutdown();
});

test('Wattpilot write opt-in does not block read-only monitoring and rejects writes before initialization', async () => {
  const f = fixture(false);
  assert.equal((await f.post({ mode: 'pause' })).status, 503);
  assert.equal(f.created, 0);
  assert.equal((await f.app.request('/wattpilot/status')).status, 200);
  assert.equal(f.reads, 1);
  assert.equal(f.commands.length, 0);
  await f.shutdown();
});

test('Wattpilot validates fields, finite integer per-phase current, body size and cancellation before device access', async () => {
  const f = fixture();
  for (const value of [null, [], {}, { mode: 'auto' }, { mode: 'pause', currentAmps: 6 },
    { mode: 'normal' }, { mode: 'eco', currentAmps: 5 }, { mode: 'normal', currentAmps: 17 },
    { mode: 'normal', currentAmps: '6' }, { mode: 'normal', currentAmps: 6.5 },
    { mode: 'normal', currentAmps: null }, { mode: 'normal', currentAmps: 6, targetSocPercent: 60 },
    { mode: 'normal', currentAmps: 6, powerWatts: 1400 }, { mode: 'pause', phases: 1 },
    ...[null, 0, 2, '1', true].map(phases => ({ mode: 'normal', currentAmps: 6, phases }))]) {
    assert.equal((await f.post(value)).status, 400, JSON.stringify(value));
  }
  for (const body of ['{', '{"mode":"normal","currentAmps":1e400}']) {
    assert.equal((await f.app.request('/wattpilot/set-control', { method: 'POST', body })).status, 400);
  }
  assert.equal((await f.post({ mode: 'pause', padding: 'x'.repeat(5000) })).status, 413);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.app.request('/wattpilot/set-control', {
    method: 'POST', signal: controller.signal, body: '{"mode":"pause"}',
  })).status, 409);
  assert.equal(f.created, 0);
  assert.equal(f.commands.length, 0);
  await f.shutdown();
});

test('unconfirmed Wattpilot writes surface unknown outcome without retry or fabricated success', async () => {
  const f = fixture();
  f.fail(Object.assign(new Error('Command confirmation timed out'), { statusCode: 504, outcome: 'unknown' }));
  const response = await f.post({ mode: 'normal', currentAmps: 6 });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'Command confirmation timed out', outcome: 'unknown' });
  assert.equal(f.commands.length, 1);
  await f.shutdown();
});

test('API forwards cancellation during a pending charger operation and preserves its conflict status', { timeout: 1000 }, async () => {
  const settings = loadConfig({ WATTPILOT_URL: 'ws://192.0.2.1/ws', WATTPILOT_PASSWORD: 'test-only',
    WATTPILOT_CONTROL_ENABLED: 'true', WATTPILOT_MAX_CURRENT_AMPS: '16' });
  let signalSeen: AbortSignal | undefined;
  const runtime = createApi({ settings, wattpilotJournalPath: null, createWattpilot: () => ({
    async setControl(_command: unknown, signal?: AbortSignal) {
      signalSeen = signal;
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('Wattpilot request was cancelled.'), { statusCode: 409 }));
      }, { once: true }));
    }, async disconnect() {},
  }) as never });
  const controller = new AbortController();
  const response = runtime.app.request('/wattpilot/set-control', {
    method: 'POST', body: '{"mode":"pause"}', signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(signalSeen);
  controller.abort();
  assert.equal((await response).status, 409);
  assert.equal(signalSeen.aborted, true);
  await runtime.shutdown();
});

test('shutdown closes Wattpilot once and rejects subsequent reads and commands', async () => {
  const f = fixture();
  await f.app.request('/wattpilot/status');
  await Promise.all([f.shutdown(), f.shutdown()]);
  assert.equal(f.closed, 1);
  assert.equal((await f.app.request('/wattpilot/status')).status, 503);
  assert.equal((await f.post({ mode: 'pause' })).status, 503);
});

test('shutdown still closes Wattpilot if battery cleanup fails', async () => {
  let closed = false;
  const runtime = createApi({
    wattpilotJournalPath: null,
    settings: loadConfig({}),
    createInverter: () => ({ async initialize() {}, async getSystemOverview() { return { solar: {} }; } }) as never,
    createBattery: () => ({ async initialize() {}, async cleanup() { throw new Error('battery cleanup'); } }) as never,
    createWattpilot: () => ({ async readStatus() { return {}; }, async disconnect() { closed = true; } }) as never,
  });
  await runtime.app.request('/wattpilot/status');
  await runtime.app.request('/system/status');
  await assert.rejects(runtime.shutdown(), /battery cleanup/);
  assert.equal(closed, true);
});

test('absent Wattpilot configuration reports not configured without a network connection', async () => {
  const runtime = createApi({ settings: loadConfig({}), wattpilotJournalPath: null });
  const response = await runtime.app.request('/wattpilot/status');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).wattpilot.status, 'not_configured');
  await runtime.shutdown();
});

test('shutdown disconnects the charger immediately while GEN24 initialization is still pending', async () => {
  let release!: () => void;
  const initializing = new Promise<void>(resolve => { release = resolve; });
  let closed = false;
  const runtime = createApi({ settings: loadConfig({}), wattpilotJournalPath: null,
    createInverter: () => ({ async initialize() { await initializing; } }) as never,
    createBattery: () => ({ async initialize() {}, async cleanup() {} }) as never,
    createWattpilot: () => ({ async readStatus() { return {}; }, async disconnect() { closed = true; } }) as never,
  });
  await runtime.app.request('/wattpilot/status');
  const reading = runtime.app.request('/system/status');
  await new Promise(resolve => setImmediate(resolve));
  const stopping = runtime.shutdown();
  assert.equal(closed, true, 'charger disconnect must not wait for inverter initialization');
  release();
  await stopping;
  assert.equal((await reading).status, 503);
});
