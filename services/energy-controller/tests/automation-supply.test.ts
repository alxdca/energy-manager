import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/api.js';
import { loadConfig } from '../src/config/index.js';
import { FroniusInverter } from '../src/devices/fronius-inverter.js';
import { FroniusModbus } from '../src/devices/fronius-modbus.js';
import { Battery } from '../src/devices/battery.js';
import { FakeTransport, STORAGE } from './helpers/fake-fronius.js';

const signed = (value: number) => value > 32767 ? value - 65536 : value;
function fixture(ceiling = 6000) {
  const origin = Date.now();
  let clock = origin, nextId = 0;
  const callbacks = new Map<number, { at: number; callback(): void }>();
  const transport = new FakeTransport();
  const settings = loadConfig({ FRONIUS_CONTROL_ENABLED: 'true', FRONIUS_MAX_POWER_WATTS: String(ceiling) });
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', { client: transport,
    control: settings.fronius.control, now: () => clock });
  const inverter = new FroniusInverter('offline.invalid', 80, { modbus, readSiteLoadWatts: async () => 500, now: () => clock,
    setTimer(callback, delay) { const id = ++nextId; callbacks.set(id, {at: clock + delay, callback}); return id; },
    clearTimer(id) { callbacks.delete(id); } });
  const battery = new Battery(inverter);
  // Discovery/control remain real; HTTP telemetry is unrelated to these tests.
  inverter.initialize = async () => {};
  battery.initialize = async () => {};
  const runtime = createApi({ settings, wattpilotJournalPath: null, createInverter: () => inverter, createBattery: () => battery });
  const expiry = (seconds = 120) => new Date(clock + seconds * 1000).toISOString();
  const post = (body: unknown) => runtime.app.request('/inverter/automation-supply', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) });
  const authorization = () => new Date(clock + 10_000).toISOString();
  const context = () => ({ deadline: clock + 90_000, renewable: true });
  async function advance(milliseconds: number) {
    const end = clock + milliseconds;
    while (callbacks.size) {
      const [id, current] = [...callbacks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]!;
      if (current.at > end) break;
      callbacks.delete(id); clock = current.at; current.callback();
      await new Promise(resolve => setImmediate(resolve));
    }
    clock = end;
    await new Promise(resolve => setImmediate(resolve));
  }
  return { ...runtime, modbus, inverter, battery, transport, expiry, post, context, authorization, advance, origin };
}

test('natural supply uses [input zero,out positive cap], distinct from forced negative power', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.modbus.setBatteryChargePower(-2000, {deadline: f.origin + 120_000});
  assert.equal(signed(f.transport.memory.get(STORAGE + 13)!), -2000, 'legacy negative power requires discharge');
  const from = f.transport.writes.length;
  await f.modbus.setBatterySupply(2000, 30, f.context(), Date.parse(f.authorization()));
  assert.equal(signed(f.transport.memory.get(STORAGE + 12)!), 2000);
  assert.equal(f.transport.memory.get(STORAGE + 13), 0, 'supply forbids all battery charging');
  assert.equal(f.transport.memory.get(STORAGE + 5), 3);
  assert.equal(f.transport.writes.slice(from).some(([address, value]) => address === STORAGE + 5 && value === 0), false,
    'transition stays inside an owned window rather than briefly restoring unrestricted operation');
  await f.modbus.disconnect();
});

test('owned supply exposes its floor and renews without releasing or forcing discharge', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const response = await f.post({authorizationExpiresAt: f.authorization(), automationFence: f.inverter.getAutomationFence(), owner: 'planner', expiresAt: f.expiry(), maxPowerWatts: 2000, minimumSocPercent: 30});
  assert.equal(response.status, 200);
  const status = (await response.json()).control;
  assert.equal(status.automationMode, 'supply');
  assert.equal(status.watts, -2000);
  assert.equal(status.minimumSocPercent, 30);
  const before = f.transport.writes.length;
  await f.battery.setAutomationSupply(2000, 30, f.expiry(180), 'planner', f.inverter.getAutomationFence(), f.authorization());
  assert.ok(f.transport.writes.slice(before).every(([address, value]) => address === STORAGE + 5 && value === 3));
  await f.advance(40_000);
  assert.equal(f.inverter.getControlStatus().automationMode, 'supply');
  assert.equal(f.transport.memory.get(STORAGE + 13), 0);
});

test('local SOC floor changes supply directly to owned hold without changing installed reserve', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(3000, 35, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  const from = f.transport.writes.length;
  f.transport.memory.set(STORAGE + 8, 3500);
  await f.advance(5000);
  const state = f.inverter.getControlStatus();
  assert.equal(state.automationMode, 'hold');
  assert.equal(state.automationOwner, 'planner');
  assert.equal(state.watts, 0);
  assert.equal(state.minimumSocPercent, 35);
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
  assert.equal(f.transport.memory.get(STORAGE + 7), 2000, 'installed reserve is untouched');
  assert.equal(f.transport.writes.slice(from).some(([address, value]) => address === STORAGE + 5 && value === 0), false);
  assert.equal(f.transport.writes.slice(from).find(([address]) => address !== STORAGE + 5)?.[0], STORAGE + 12,
    'first reduce discharge to zero before allowing solar charging');
});

test('a tighter floor and rising installed reserve retain a safe hold instead of normal release', async t => {
  for (const raiseReserve of [false, true]) {
    const f = fixture(); t.after(() => f.shutdown());
    await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
    const from = f.transport.writes.length;
    if (raiseReserve) {
      f.transport.memory.set(STORAGE + 7, 5500);
      await f.advance(5000);
    } else await f.battery.setAutomationSupply(2000, 55, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
    assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
    assert.equal(f.transport.memory.get(STORAGE + 12), 0);
    assert.equal(f.transport.writes.slice(from).some(([address, value]) => address === STORAGE + 5 && value === 0), false);
  }
});

test('sub-six-kilowatt installations can still enforce the supply floor with a bounded hold', async t => {
  const f = fixture(3000); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  f.transport.memory.set(STORAGE + 8, 3000);
  await f.advance(5000);
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 3000);
});

test('supply validation rejects unsafe values before discovery and rejects unknown/current SOC before activation', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const valid = {authorizationExpiresAt: f.authorization(), automationFence: f.inverter.getAutomationFence(), owner: 'planner', expiresAt: f.expiry(), maxPowerWatts: 2000, minimumSocPercent: 30};
  for (const change of [{maxPowerWatts: 0}, {maxPowerWatts: 7001}, {maxPowerWatts: '2000'},
    {maxPowerWatts: 6001}, {minimumSocPercent: null}, {minimumSocPercent: -1}, {minimumSocPercent: 100},
    {owner: ''}, {expiresAt: 'invalid'}, {expiresAt: new Date(f.origin - 1000).toISOString()},
    {expiresAt: new Date(f.origin + 961_000).toISOString()}, {extra: true},
    {automationFence: undefined}, {automationFence: null}, {automationFence: []}, {automationFence: {}},
    {automationFence: {bootId: 'boot', generation: -1}}, {automationFence: {bootId: 'boot', generation: 1.5}},
    {automationFence: {bootId: 'boot', generation: 0, extra: true}},
    {automationFence: {bootId: '', generation: 0}}, {authorizationExpiresAt: undefined},
    {authorizationExpiresAt: null}, {authorizationExpiresAt: 'invalid'},
    {authorizationExpiresAt: new Date(f.origin + 60_000).toISOString()},
    {authorizationExpiresAt: '2026-10-25T12:00:00+00:00'}]) {
    assert.equal((await f.post({...valid, ...change})).status, 400, JSON.stringify(change));
  }
  assert.equal(f.transport.reads.length, 0);
  assert.equal(f.transport.writes.length, 0);
  for (const floor of [10, 50, 60]) {
    const bad = fixture(); t.after(() => bad.shutdown());
    await assert.rejects(bad.inverter.setAutomationSupply(2000, floor, bad.expiry(), 'planner', bad.inverter.getAutomationFence(), bad.authorization()), /floor/);
    assert.equal(bad.transport.writes.length, 0);
  }
  const badSoc = fixture(); t.after(() => badSoc.shutdown());
  badSoc.transport.memory.set(STORAGE + 8, 65535);
  await assert.rejects(badSoc.inverter.setAutomationSupply(2000, 30, badSoc.expiry(), 'planner', badSoc.inverter.getAutomationFence(), badSoc.authorization()));
  assert.equal(badSoc.transport.writes.length, 0);
});

test('supply cannot replace manual/foreign control and old callbacks cannot affect manual replacement', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  await assert.rejects(f.battery.setAutomationSupply(2000, 30, f.expiry(), 'foreign', f.inverter.getAutomationFence(), f.authorization()), /another battery controller/);
  await f.battery.setChargePower(1000);
  const from = f.transport.writes.length;
  await assert.rejects(f.battery.stopAutomationCharge('planner'), /another battery controller/);
  await f.advance(5000);
  assert.equal(f.inverter.getControlStatus().watts, 1000);
  assert.ok(f.transport.writes.slice(from).every(([address, value]) => address === STORAGE + 5 && value === 3));
});

test('supply lease still expires through the existing verified normal fallback', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(2000, 30, f.expiry(20), 'planner', f.inverter.getAutomationFence(), f.authorization());
  await f.advance(14_999);
  assert.equal(f.inverter.getControlStatus().automationMode, 'supply');
  await f.advance(1);
  assert.equal(f.inverter.getControlStatus().active, false);
  assert.equal(f.transport.memory.get(STORAGE + 5), 0);
});

test('a transient supply supervision failure falls back to owned hold when safe device state is still readable', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  const verify = f.modbus.verifyControl.bind(f.modbus);
  let first = true;
  f.modbus.verifyControl = async context => {
    if (first) { first = false; throw new Error('Transient monitor failure'); }
    return verify(context);
  };
  const from = f.transport.writes.length;
  await f.advance(5000);
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
  assert.match(f.inverter.getControlStatus().error!, /Transient/);
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.writes.slice(from).some(([address, value]) => address === STORAGE + 5 && value === 0), false);
});

test('supply consumes the status fence and an old request cannot reopen a newer hold after grid recharge', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const snapshot = await (await f.app.request('/inverter/control-status')).json();
  assert.equal(snapshot.automationFence.generation, 0);
  assert.equal(typeof snapshot.automationFence.bootId, 'string');
  const request = {authorizationExpiresAt: f.authorization(), owner: 'planner', expiresAt: f.expiry(), maxPowerWatts: 2000, minimumSocPercent: 30,
    automationFence: snapshot.automationFence};
  assert.equal((await f.post(request)).status, 200, 'current status authorizes exactly this transition');
  const beforeRenewal = f.inverter.getAutomationFence();
  assert.equal((await f.post({...request, automationFence: beforeRenewal})).status, 200);
  const renewedWrites = f.transport.writes.length;
  assert.equal((await f.post({...request, automationFence: beforeRenewal})).status, 409);
  assert.equal(f.transport.writes.length, renewedWrites, 'late renewal performs no hardware writes');
  const beforeHold = f.inverter.getAutomationFence();
  await f.battery.setAutomationHold(f.expiry(), 'planner');
  await f.battery.setAutomationCharge(6000, 60, f.expiry(), 'planner');
  f.transport.memory.set(STORAGE + 8, 5500); // Grid energy has replenished the household battery.
  const writes = f.transport.writes.length;
  assert.equal((await f.post({...request, automationFence: beforeHold})).status, 409);
  assert.equal(f.transport.writes.length, writes);
  assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
});

test('local floor and monitoring-error holds both invalidate prior supply authorization', async t => {
  for (const monitorFailure of [false, true]) {
    const f = fixture(); t.after(() => f.shutdown());
    await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
    const old = f.inverter.getAutomationFence();
    if (monitorFailure) f.modbus.verifyControl = async () => { throw new Error('Monitor interrupted'); };
    else f.transport.memory.set(STORAGE + 8, 3000);
    await f.advance(5000);
    assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
    assert.ok(f.inverter.getAutomationFence().generation > old.generation);
    f.transport.memory.set(STORAGE + 8, 5000);
    const writes = f.transport.writes.length;
    await assert.rejects(f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', old, f.authorization()), {statusCode: 409});
    assert.equal(f.transport.writes.length, writes);
  }
});

test('a pending manual command exposes the old session fence and supersedes supply before actuation', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  const old = f.inverter.getAutomationFence();
  let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const safety = f.modbus.readSafetyState.bind(f.modbus);
  f.modbus.readSafetyState = async context => { entered(); await blocked; return safety(context); };
  const manual = f.inverter.setBatteryChargePower(1000);
  // Before its queued cleanup, the existing session cannot advertise the pending manual generation.
  assert.deepEqual(f.inverter.getAutomationFence(), old);
  const stale = assert.rejects(f.inverter.setAutomationSupply(2000, 30, f.expiry(), 'planner', old, f.authorization()), {statusCode: 409});
  await started;
  unblock();
  await manual;
  const writes = f.transport.writes.length;
  await stale;
  assert.equal(f.transport.writes.length, writes);
  assert.equal(f.inverter.getControlStatus().watts, 1000);
});

test('expiry, explicit stop and a new controller instance invalidate old supply fences', async t => {
  for (const expire of [false, true]) {
    const f = fixture(); t.after(() => f.shutdown());
    await f.battery.setAutomationSupply(2000, 30, f.expiry(20), 'planner', f.inverter.getAutomationFence(), f.authorization());
    const old = f.inverter.getAutomationFence();
    if (expire) await f.advance(15_000);
    else await f.battery.stopAutomationCharge('planner');
    const writes = f.transport.writes.length;
    await assert.rejects(f.battery.setAutomationSupply(2000, 30, f.expiry(), 'planner', old, f.authorization()), {statusCode: 409});
    assert.equal(f.transport.writes.length, writes);
  }
  const old = fixture(), restarted = fixture();
  t.after(() => old.shutdown()); t.after(() => restarted.shutdown());
  assert.notEqual(old.inverter.getAutomationFence().bootId, restarted.inverter.getAutomationFence().bootId);
  await assert.rejects(restarted.inverter.setAutomationSupply(2000, 30, restarted.expiry(), 'planner', old.inverter.getAutomationFence(), restarted.authorization()), {statusCode: 409});
  assert.equal(restarted.transport.writes.length, 0);
  await restarted.inverter.setAutomationSupply(2000, 30, restarted.expiry(), 'planner', restarted.inverter.getAutomationFence(), restarted.authorization());
  assert.equal(restarted.inverter.getControlStatus().automationMode, 'supply');
});

test('a seven-minute source delay cannot turn same-generation grid charging into solar supply', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationCharge(6000, 90, f.expiry(900), 'planner');
  const fence = f.inverter.getAutomationFence(), authorizationExpiresAt = f.authorization(), expiresAt = f.expiry(900);
  await f.advance(7 * 60_000);
  f.transport.memory.set(STORAGE + 8, 5120);
  assert.deepEqual(f.inverter.getAutomationFence(), fence, 'grid charging did not change control generation');
  const writes = f.transport.writes.length;
  await assert.rejects(f.battery.setAutomationSupply(2000, 49.8, expiresAt, 'planner', fence, authorizationExpiresAt), {statusCode: 409});
  assert.equal(f.transport.writes.length, writes);
  assert.deepEqual(f.inverter.getAutomationFence(), fence, 'already expired permission does not consume control generation');
  assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
  await f.battery.setAutomationSupply(2000, 51, f.expiry(), 'planner', fence, f.authorization());
  assert.equal(f.inverter.getControlStatus().automationMode, 'supply', 'a newly planned current source authorization is accepted');
});

test('expired source authorization is rejected before API discovery or queued control mutation', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  const response = await f.post({owner: 'planner', expiresAt: f.expiry(), maxPowerWatts: 2000, minimumSocPercent: 30,
    automationFence: f.inverter.getAutomationFence(), authorizationExpiresAt: new Date(f.origin - 1000).toISOString()});
  assert.equal(response.status, 409);
  assert.equal(f.transport.reads.length, 0);
  const fence = f.inverter.getAutomationFence(), authorization = f.authorization();
  let entered!: () => void, unblock!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const safety = f.modbus.readSafetyState.bind(f.modbus);
  f.modbus.readSafetyState = async context => { entered(); await blocked; return safety(context); };
  const read = f.inverter.getAutomationReserve();
  await started;
  const queued = assert.rejects(f.inverter.setAutomationSupply(2000, 30, f.expiry(), 'planner', fence, authorization), {statusCode: 409});
  await f.advance(10_000);
  unblock();
  await read; await queued;
  assert.deepEqual(f.inverter.getAutomationFence(), fence);
  assert.equal(f.transport.writes.length, 0);
});

test('source authorization expiring during owned preflight commits hold and never releases normal', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationCharge(6000, 90, f.expiry(), 'planner');
  const safety = f.modbus.readSafetyState.bind(f.modbus);
  let first = true;
  f.modbus.readSafetyState = async context => {
    const state = await safety(context);
    if (first) { first = false; await f.advance(10_000); }
    return state;
  };
  const writes = f.transport.writes.length;
  await assert.rejects(f.battery.setAutomationSupply(2000, 49.8, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization()), {statusCode: 409});
  const control = f.inverter.getControlStatus();
  assert.equal(control.automationMode, 'hold');
  assert.equal(control.automationOwner, 'planner');
  assert.equal(control.error, undefined, 'a safe policy refusal must not latch a device fault');
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
  assert.equal(f.transport.writes.slice(writes).some(([address, value]) => address === STORAGE + 5 && value === 0), false);
  assert.equal(f.transport.writes.slice(writes).some(([address, value]) => address === STORAGE + 12 && signed(value) > 0), false);
  await f.battery.setAutomationSupply(2000, 49.8, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  assert.equal(f.inverter.getControlStatus().automationMode, 'supply', 'a fresh plan resumes without manual recovery');
});

test('expiry during the final raw ownership read refuses all supply writes and retains owned hold', async t => {
  const f = fixture(); t.after(() => f.shutdown());
  await f.battery.setAutomationCharge(6000, 90, f.expiry(), 'planner');
  let insideRawSupply = false, delayed = false;
  const rawSupply = f.modbus.setBatterySupply.bind(f.modbus);
  f.modbus.setBatterySupply = async (...args) => {
    insideRawSupply = true;
    try { return await rawSupply(...args); }
    finally { insideRawSupply = false; }
  };
  const read = f.transport.readHoldingRegisters.bind(f.transport);
  f.transport.readHoldingRegisters = async (address, length) => {
    const result = await read(address, length);
    if (insideRawSupply && !delayed && address === STORAGE + 12 && length === 4) {
      delayed = true;
      await f.advance(10_000);
    }
    return result;
  };
  const writes = f.transport.writes.length;
  await assert.rejects(f.battery.setAutomationSupply(2000, 49.8, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization()), {statusCode: 409});
  assert.equal(delayed, true, 'authorization expires inside raw preflight, after inverter-level checks');
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
  assert.equal(f.inverter.getControlStatus().automationOwner, 'planner');
  assert.equal(f.inverter.getControlStatus().error, undefined, 'verified hold remains available after stale source rejection');
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
  assert.equal(f.transport.writes.slice(writes).some(([address, value]) => address === STORAGE + 5 && value === 0), false);
  assert.equal(f.transport.writes.slice(writes).some(([address, value]) => address === STORAGE + 12 && signed(value) > 0), false);
  await f.advance(5000);
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold', 'source expiry is not retained as an ongoing session deadline');
  await f.battery.setAutomationSupply(2000, 49.8, f.expiry(), 'planner', f.inverter.getAutomationFence(), f.authorization());
  assert.equal(f.inverter.getControlStatus().automationMode, 'supply', 'fresh source permission resumes without a manual reset');
});
