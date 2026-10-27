import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/api.js';
import { loadConfig } from '../src/config/index.js';
import { FroniusInverter } from '../src/devices/fronius-inverter.js';
import { FroniusModbus } from '../src/devices/fronius-modbus.js';
import { FakeTransport, STORAGE } from './helpers/fake-fronius.js';

async function fixture(enabled: boolean, now?: () => number, maxPowerWatts = 2000) {
  const settings = loadConfig(enabled ? { FRONIUS_CONTROL_ENABLED: 'true', FRONIUS_MAX_POWER_WATTS: String(maxPowerWatts) } : {});
  const transport = new FakeTransport();
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', { client: transport, control: settings.fronius.control, now });
  const callbacks = new Map<number, () => void>(); let timer = 0;
  const inverter = new FroniusInverter('offline.invalid', 80, { modbus, readSiteLoadWatts: async () => 500, now,
    setTimer(fn) { const id = ++timer; callbacks.set(id, () => { callbacks.delete(id); fn(); }); return id; }, clearTimer(id) { callbacks.delete(id); },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    assert.ok(url.startsWith('http://offline.invalid/solar_api/v1/'), 'test must not access an actual host');
    return Response.json({ Body: { Data: url.includes('GetStorageRealtimeData')
      ? [{ Controller: { StateOfCharge_Relative: 50, Power_DC: 0 } }]
      : { Site: { P_PV: 1000, P_Load: -500, P_Grid: -500, P_Akku: 0 } } } });
  };
  const runtime = createApi({ settings, createInverter: () => inverter });
  function post(path: string, body: unknown = {}) {
    return runtime.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { ...runtime, transport, inverter, callbacks, post, async cleanup() { try { await runtime.shutdown(); } finally { globalThis.fetch = originalFetch; } } };
}

test('automation through the complete stack renews finite device leases and releases at expiry', async () => {
  const started = Date.now();
  let now = started;
  const f = await fixture(true, () => now, 6000);
  const expiresAt = new Date(started + 360_000).toISOString();
  try {
    const response = await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 70, expiresAt, owner: 'energy-manager'});
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(f.inverter.getControlStatus().expiresAt, expiresAt);
    assert.equal(f.transport.memory.get(STORAGE + 5), 3);
    for (let step = 0; step < 70; step++) {
      now += 5000;
      for (const callback of [...f.callbacks.values()]) callback();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.inverter.getControlStatus().active, true);
    }
    now += 5000;
    for (const callback of [...f.callbacks.values()]) callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.equal(f.callbacks.size, 0);
  } finally { await f.cleanup(); }
});

test('conditional automation stop through real wrappers cannot cancel a manual replacement', async () => {
  const started = Date.now();
  const f = await fixture(true, () => started, 6000);
  try {
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 70, expiresAt: new Date(started + 900_000).toISOString(), owner: 'energy-manager'})).status, 200);
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'foreign'})).status, 409);
    assert.equal(f.inverter.getControlStatus().automationOwner, 'energy-manager');
    assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000, targetSocPercent: 60})).status, 200);
    const before = [...f.transport.writes];
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status, 409);
    assert.deepEqual(f.transport.writes, before);
    assert.equal(f.inverter.getControlStatus().watts, 1000);
    assert.equal(f.inverter.getControlStatus().automationOwner, undefined);
  } finally { await f.cleanup(); }
});

test('automation stop reports failures until its own window is verifiably released', async () => {
  const started = Date.now();
  const f = await fixture(true, () => started, 6000);
  try {
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 70,
      expiresAt: new Date(started + 900_000).toISOString(), owner: 'energy-manager'})).status, 200);
    const writes = f.transport.writes.length;
    f.transport.failWrite = STORAGE + 5;
    assert.ok((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status >= 400);
    assert.ok((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status >= 400);
    f.transport.failWrite = undefined;
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status, 200);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.ok(f.transport.writes.slice(writes).every(([address, value]) => address === STORAGE + 5 && value === 0));
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status, 200);
    assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000, targetSocPercent: 60})).status, 200);
    const manualWrites = [...f.transport.writes];
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status, 409);
    for (const callback of [...f.callbacks.values()]) callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.transport.writes.slice(manualWrites.length).every(([address, value]) => address === STORAGE + 5 && value === 3),
      'only manual supervision may write after the replacement');
    assert.equal(f.inverter.getControlStatus().watts, 1000);
  } finally { f.transport.failWrite = undefined; await f.cleanup(); }
});

test('failed-stop retries preserve foreign owners and cannot cancel an explicit manual recovery', async () => {
  const started = Date.now();
  const f = await fixture(true, () => started, 6000);
  try {
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 70,
      expiresAt: new Date(started + 900_000).toISOString(), owner: 'energy-manager'})).status, 200);
    f.transport.failWrite = STORAGE + 5;
    assert.ok((await f.post('/inverter/automation-stop', {owner: 'energy-manager'})).status >= 400);
    const staleRetries = [...f.callbacks.values()];
    const writes = [...f.transport.writes];
    assert.equal((await f.post('/inverter/automation-stop', {owner: 'foreign'})).status, 409);
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 70,
      expiresAt: new Date(started + 900_000).toISOString(), owner: 'foreign'})).status, 409);
    assert.deepEqual(f.transport.writes, writes);
    const originalStop = await f.post('/inverter/automation-stop', {owner: 'energy-manager'});
    assert.ok(originalStop.status >= 400);
    assert.notEqual(originalStop.status, 409, 'a foreign renewal cannot replace the pending stop owner');
    f.transport.failWrite = undefined;
    assert.equal((await f.post('/inverter/set-mode', {mode: 'normal'})).status, 200);
    assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000, targetSocPercent: 60})).status, 200);
    const manualWrites = [...f.transport.writes];
    staleRetries.forEach(callback => callback());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.transport.writes, manualWrites);
    assert.equal(f.inverter.getControlStatus().watts, 1000);
  } finally { f.transport.failWrite = undefined; await f.cleanup(); }
});

test('control status reads the configured inverter reserve through the full stack without register writes', async () => {
  const f = await fixture(true);
  try {
    f.transport.memory.set(STORAGE + 7, 2500);
    const response = await f.app.request('/inverter/control-status');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).limits.reserveSocPercent, 25);
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.inverter.getControlStatus().active, false);
  } finally { await f.cleanup(); }
  assert.deepEqual(f.transport.writes, []);
});

test('full monitoring stack initializes and shuts down with zero Modbus writes in default mode', async () => {
  const f = await fixture(false);
  try {
    const response = await f.app.request('/system/status'); assert.equal(response.status, 200);
    assert.equal((await response.json()).battery.socPercent, 50);
    assert.equal((await f.post('/inverter/standby')).status, 503);
    assert.deepEqual(f.transport.writes, []); assert.equal(f.transport.connected, false);
  } finally { await f.cleanup(); }
  assert.deepEqual(f.transport.writes, []);
});

test('manual charging runs past five minutes and 90 percent, then stops at 100 percent', async () => {
  let now = 0;
  const f = await fixture(true, () => now);
  const tick = async () => {
    now += 5000;
    for (const callback of [...f.callbacks.values()]) callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    f.transport.memory.set(STORAGE + 8, 9500);
    const response = await f.post('/inverter/set-charge-power', {powerWatts: 1000});
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const status = (await (await f.app.request('/inverter/control-status')).json()).control;
    assert.equal(status.targetSocPercent, 100);
    assert.equal(status.expiresAt, null);
    for (let step = 0; step < 72; step++) {
      await tick();
      assert.equal(f.inverter.getControlStatus().active, true, `session stopped at ${now}ms`);
      assert.equal(f.transport.memory.get(STORAGE + 5), 3);
      assert.equal(f.transport.memory.get(STORAGE + 15), 30);
    }
    assert.equal(f.callbacks.size, 1);
    const writes = f.transport.writes.length;
    f.transport.memory.set(STORAGE + 8, 10000);
    await tick();
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.deepEqual(f.transport.writes.slice(writes), [[STORAGE + 5, 0]]);
    assert.equal(f.callbacks.size, 0);
  } finally { await f.cleanup(); }
});

test('manual charging at full SOC is already complete without activating a power window', async () => {
  const f = await fixture(true);
  try {
    f.transport.memory.set(STORAGE + 8, 10000);
    assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000})).status, 200);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.callbacks.size, 0);
  } finally { await f.cleanup(); }
});

test('custom manual target keeps finite device leases beyond max duration then restores normal at target', async () => {
  let now = 0;
  const f = await fixture(true, () => now);
  const tick = async () => {
    now += 5000;
    for (const callback of [...f.callbacks.values()]) callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    const response = await f.post('/inverter/set-charge-power', { powerWatts: 1000, targetSocPercent: 60 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).targetSocPercent, 60);
    assert.equal(f.inverter.getControlStatus().targetSocPercent, 60);
    assert.equal(f.inverter.getControlStatus().expiresAt, null);
    for (let step = 0; step < 72; step++) {
      await tick();
      assert.equal(f.inverter.getControlStatus().active, true, `session stopped at ${now}ms`);
      assert.equal(f.transport.memory.get(STORAGE + 5), 3);
      assert.equal(f.transport.memory.get(STORAGE + 15), 30);
    }
    const writes = f.transport.writes.length;
    f.transport.memory.set(STORAGE + 8, 6000);
    await tick();
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    // Existing low-level verification renews the finite lease before upper-level target completion.
    assert.deepEqual(f.transport.writes.slice(writes), [[STORAGE + 5, 3], [STORAGE + 5, 0]]);
    assert.equal(f.callbacks.size, 0);
    // Stopping the forced session sets normal mode; it installs no global SOC ceiling.
    assert.equal(f.transport.memory.get(STORAGE + 7), 2000);
  } finally { await f.cleanup(); }
});

test('manual target already reached returns after preflight without a charge write', async () => {
  const f = await fixture(true);
  try {
    f.transport.memory.set(STORAGE + 8, 6000);
    const response = await f.post('/inverter/set-charge-power', { powerWatts: 1000, targetSocPercent: 60 });
    assert.equal(response.status, 200);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.callbacks.size, 0);
  } finally { await f.cleanup(); }
});

test('zero power and normal mode stop persistent charging and stale callbacks cannot restart it', async () => {
  for (const [route, body] of [
    ['/inverter/set-charge-power', {powerWatts: 0}],
    ['/inverter/set-mode', {mode: 'normal'}],
  ] as const) {
    const f = await fixture(true);
    try {
      assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000})).status, 200);
      const staleCallbacks = [...f.callbacks.values()];
      assert.equal((await f.post(route, body)).status, 200);
      const writes = [...f.transport.writes];
      staleCallbacks.forEach(callback => callback());
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.inverter.getControlStatus().active, false);
      if (route === '/inverter/set-mode') assert.equal(f.inverter.getControlStatus().error, undefined);
      assert.equal(f.transport.memory.get(STORAGE + 5), 0);
      assert.deepEqual(f.transport.writes, writes);
      assert.equal(f.callbacks.size, 0);
    } finally { await f.cleanup(); }
  }
});

test('API without authentication through real wrappers applies bounded power, preserves policy and restores on shutdown', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.post('/inverter/set-charge-power', { powerWatts: 1000 })).status, 200);
    assert.equal(f.transport.memory.get(STORAGE + 5), 3);
    assert.equal(f.transport.memory.get(STORAGE + 12), 65536 - 1000);
    assert.equal(f.transport.memory.get(STORAGE + 13), 1000);
    assert.equal(f.transport.memory.get(STORAGE + 15), 30);
    assert.equal(f.transport.memory.get(STORAGE + 7), 2000);
    assert.equal(f.transport.memory.get(STORAGE + 17), 1);
    assert.equal((await f.post('/inverter/standby')).status, 200);
    assert.equal(f.transport.memory.get(STORAGE + 12), 0);
    assert.equal(f.transport.memory.get(STORAGE + 13), 0);
    assert.equal(f.inverter.getControlStatus().active, true);
  } finally { await f.cleanup(); }
  assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  assert.equal(f.inverter.getControlStatus().active, false);
  assert.equal(f.callbacks.size, 0);
});

test('normal-mode API cancels a real target job and stale timers cannot restart it', async () => {
  const f = await fixture(true);
  try {
    const request = f.post('/inverter/charge-battery', { chargePowerWatts: 1000, targetSocPercent: 60 });
    for (let i = 0; i < 100 && !f.inverter.getControlStatus().active; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.inverter.getControlStatus().active, true);
    const staleTimers = [...f.callbacks.values()];
    assert.equal((await f.post('/inverter/set-mode', { mode: 'normal' })).status, 200);
    assert.equal((await request).status, 409);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    const writes = [...f.transport.writes]; staleTimers.forEach(callback => callback());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.transport.writes, writes);
  } finally { await f.cleanup(); }
});

test('manual stop through the full stack invalidates a charge still awaiting Modbus preflight', async () => {
  const f = await fixture(true);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const originalRead = f.transport.readHoldingRegisters.bind(f.transport);
  let stalled = false;
  f.transport.readHoldingRegisters = async (address, length) => {
    if (!stalled && address === STORAGE + 2 && length === 24) { stalled = true; entered(); await gate; }
    return originalRead(address, length);
  };
  try {
    const activating = f.post('/inverter/set-charge-power', { powerWatts: 1000 });
    await started;
    const stopping = f.post('/inverter/set-charge-power', { powerWatts: 0 });
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.equal((await activating).status, 409);
    assert.equal((await stopping).status, 200);
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.inverter.getControlStatus().active, false);
  } finally { release(); await f.cleanup(); }
});

test('keepalive failures stop supervision and restore normal or quarantine unreadable control', async () => {
  for (const failure of ['write', 'readback']) {
    const f = await fixture(true);
    try {
      assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000})).status, 200);
      const write = f.transport.writeRegister.bind(f.transport);
      f.transport.writeRegister = async (address, value) => {
        if (address === STORAGE + 5 && value === 3) {
          if (failure === 'write') throw new Error('Keepalive write failed');
          await write(address, value);
          f.transport.failRead = STORAGE + 5;
          return;
        }
        await write(address, value);
      };
      const tick = [...f.callbacks.values()][0];
      tick();
      await new Promise(resolve => setImmediate(resolve));
      const status = f.inverter.getControlStatus();
      assert.equal(status.active, false);
      assert.ok(status.error);
      assert.equal(f.callbacks.size, 0);
      assert.equal(f.transport.closed, true);
      if (failure === 'write') {
        assert.equal(f.transport.memory.get(STORAGE + 5), 0);
      } else {
        assert.equal(f.transport.memory.get(STORAGE + 5), 3);
        const writes = [...f.transport.writes];
        const reads = f.transport.reads.length;
        const response = await f.post('/inverter/set-charge-power', {powerWatts: 1000});
        assert.equal(response.status, 503);
        assert.match((await response.json()).error, /fallback/);
        assert.deepEqual(f.transport.writes, writes);
        assert.equal(f.transport.reads.length, reads);
      }
    } finally { await f.cleanup(); }
  }
});

test('automatic SOC completion keeps owned charge-only window through renewals and releases at finite expiry', async () => {
  const started = Date.now(); let now = started;
  const f = await fixture(true, () => now, 6000);
  const tick = async (ms = 5000) => {
    now += ms;
    for (const callback of [...f.callbacks.values()]) callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    const expiresAt = new Date(started + 360_000).toISOString();
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 60,
      expiresAt, owner: 'energy-manager'})).status, 200);
    const count = f.transport.writes.length;
    f.transport.memory.set(STORAGE + 8, 6000);
    await tick();
    assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
    assert.equal(f.inverter.getControlStatus().watts, 0);
    assert.equal(f.inverter.getControlStatus().expiresAt, expiresAt);
    assert.equal(f.transport.memory.get(STORAGE + 12), 0);
    assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
    assert.ok(f.transport.writes.slice(count).every(([address, value]) => address !== STORAGE + 5 || value !== 0),
      'target completion must never release to normal mode');
    const beforeRenewal = f.transport.writes.length;
    const renewed = new Date(started + 600_000).toISOString();
    assert.equal((await f.post('/inverter/automation-hold', {expiresAt: renewed, owner: 'energy-manager'})).status, 200);
    assert.equal(f.inverter.getControlStatus().expiresAt, renewed);
    assert.ok(f.transport.writes.slice(beforeRenewal).every(([address, value]) => address !== STORAGE + 5 || value !== 0));
    f.transport.memory.set(STORAGE + 17, 0);
    f.transport.memory.set(STORAGE + 8, 10000);
    for (let i = 0; i < 117; i++) {
      await tick();
      assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
      assert.equal(f.transport.memory.get(STORAGE + 12), 0);
      assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
    }
    await tick();
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  } finally { await f.cleanup(); }
});

test('hold full-stack starts with already-achieved target and manual request immediately wins', async () => {
  const started = Date.now();
  const f = await fixture(true, () => started, 6000);
  try {
    f.transport.memory.set(STORAGE + 8, 7000);
    assert.equal((await f.post('/inverter/automation-charge', {powerWatts: 6000, targetSocPercent: 60,
      expiresAt: new Date(started + 900_000).toISOString(), owner: 'energy-manager'})).status, 200);
    assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
    assert.equal(f.transport.memory.get(STORAGE + 12), 0);
    assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
    assert.equal((await f.post('/inverter/set-charge-power', {powerWatts: 1000, targetSocPercent: 80})).status, 200);
    const before = [...f.transport.writes];
    assert.equal((await f.post('/inverter/automation-hold', {expiresAt: new Date(started + 900_000).toISOString(), owner: 'energy-manager'})).status, 409);
    assert.deepEqual(f.transport.writes, before);
    assert.equal(f.inverter.getControlStatus().watts, 1000);
    assert.equal(f.inverter.getControlStatus().automationMode, undefined);
  } finally { await f.cleanup(); }
});
