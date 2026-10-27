import test from 'node:test';
import assert from 'node:assert/strict';
import { FroniusInverter } from '../src/devices/fronius-inverter.js';
import { FroniusModbus } from '../src/devices/fronius-modbus.js';
import { loadConfig } from '../src/config/index.js';
import { FakeTransport, STORAGE } from './helpers/fake-fronius.js';

function fixture() {
  let clock = Date.parse('2026-10-26T01:00:00Z');
  let load: number | null = 14000;
  let failMeter = false;
  let id = 0;
  const tasks = new Map<number, () => void>();
  const transport = new FakeTransport();
  const settings = loadConfig({ FRONIUS_CONTROL_ENABLED: 'true', FRONIUS_MAX_POWER_WATTS: '6000' });
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', { client: transport,
    control: settings.fronius.control, now: () => clock });
  const inverter = new FroniusInverter('offline.invalid', 80, { modbus, now: () => clock,
    readSiteLoadWatts: async () => { if (failMeter) throw new Error('Meter offline'); return load; },
    setTimer(callback) { tasks.set(++id, callback); return id; },
    clearTimer(handle) { tasks.delete(handle); } });
  return { inverter, transport, expiry: () => new Date(clock + 120000).toISOString(),
    load(value: number | null) { load = value; }, failMeter() { failMeter = true; },
    async tick() {
      clock += 5000;
      const callbacks = [...tasks.values()]; tasks.clear();
      callbacks.forEach(callback => callback());
      for (let i = 0; i < 200; i++) await Promise.resolve();
    } };
}

for (const automatic of [false, true]) test(`${automatic ? 'automatic' : 'manual'} charge yields to total load, reaches zero and recovers its request`, async t => {
  const f = fixture(); t.after(() => f.inverter.disconnect());
  if (automatic) await f.inverter.setAutomationCharge(6000, 80, f.expiry(), 'planner');
  else await f.inverter.setBatteryChargePower(6000, 80);
  const initial = f.inverter.getControlStatus();
  assert.equal(initial.watts, 2000);
  assert.equal(initial.requestedWatts, 6000);
  assert.equal(initial.targetSocPercent, 80);
  const before = f.transport.writes.length;
  f.load(17000); await f.tick();
  const curtailed = f.inverter.getControlStatus();
  assert.equal(curtailed.watts, 0);
  assert.equal(curtailed.siteLimitExceeded, true);
  assert.equal(curtailed.automationMode, automatic ? 'charge' : undefined);
  assert.equal(f.transport.memory.get(STORAGE + 12), 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 0, 'zero means no charging, including solar charging');
  f.load(10000); await f.tick();
  const resumed = f.inverter.getControlStatus();
  assert.equal(resumed.watts, 6000, JSON.stringify(resumed));
  assert.equal(resumed.targetSocPercent, 80);
  assert.equal(resumed.expiresAt, initial.expiresAt);
  assert.equal(resumed.automationOwner, initial.automationOwner);
  assert.equal(f.transport.writes.slice(before).some(([address, value]) => address === STORAGE + 5 && value === 0), false,
    'curtailment and recovery never release the bounded power window');
});

test('unknown or failed site measurements stop charging without restoring unrestricted mode', async t => {
  for (const failure of [null, NaN, -1, 'throw'] as const) {
    const f = fixture(); t.after(() => f.inverter.disconnect());
    await f.inverter.setBatteryChargePower(6000);
    if (failure === 'throw') f.failMeter(); else f.load(failure);
    await f.tick();
    assert.equal(f.inverter.getControlStatus().active, true);
    assert.equal(f.inverter.getControlStatus().watts, 0);
    assert.equal(f.transport.memory.get(STORAGE + 5), 3);
    assert.equal(f.transport.memory.get(STORAGE + 13), 0);
  }
});

test('solar-allowed hold and target-completion hold obey the same gross consumption ceiling', async t => {
  const f = fixture(); t.after(() => f.inverter.disconnect());
  await f.inverter.setAutomationHold(f.expiry(), 'planner');
  assert.equal(f.transport.memory.get(STORAGE + 13), 2000);
  f.load(16000); await f.tick();
  assert.equal(f.transport.memory.get(STORAGE + 13), 0);
  f.load(15000);
  await f.inverter.setAutomationCharge(6000, 80, f.expiry(), 'planner');
  f.transport.memory.set(STORAGE + 8, 8000);
  await f.tick();
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
  assert.equal(f.transport.memory.get(STORAGE + 13), 1000);
});

test('runtime protection also limits natural solar charging while retaining natural discharge', async t => {
  const f = fixture(); t.after(() => f.inverter.disconnect());
  assert.equal(f.transport.writes.length, 0, 'construction and status reads are passive');
  f.inverter.getControlStatus();
  assert.equal(f.transport.writes.length, 0);
  f.inverter.startSitePowerSupervision();
  await f.tick();
  assert.equal(f.inverter.getControlStatus().active, false, 'the safety ceiling is independent of manual and automatic jobs');
  assert.equal(f.transport.memory.get(STORAGE + 13), 2000);
  assert.equal(f.transport.memory.get(STORAGE + 12), 6000, 'a positive discharge allowance never forces discharge');
  f.load(18000); await f.tick();
  assert.equal(f.transport.memory.get(STORAGE + 13), 0);
  assert.equal(f.transport.memory.get(STORAGE + 12), 6000);
  f.load(5000); await f.tick();
  assert.equal(f.transport.memory.get(STORAGE + 13), 6000);
  assert.equal(f.inverter.getControlStatus().sitePowerProtection?.chargingLimitWatts, 6000);
});

test('runtime protection never replaces an active manual command and stops on disconnect', async () => {
  const f = fixture();
  f.inverter.startSitePowerSupervision(); await f.tick();
  await f.inverter.setBatteryChargePower(1000, 80);
  await f.tick();
  assert.equal(f.inverter.getControlStatus().watts, 1000);
  assert.equal(f.inverter.getControlStatus().requestedWatts, 1000);
  assert.equal(f.inverter.getControlStatus().targetSocPercent, 80);
  await f.inverter.disconnect();
  const before = f.transport.writes.length;
  await f.tick();
  assert.equal(f.transport.writes.length, before);
});

test('natural protection waits for verified recovery after an automatic lease expires', async t => {
  const f = fixture(); t.after(() => f.inverter.disconnect());
  f.inverter.startSitePowerSupervision(); await f.tick();
  await f.inverter.setAutomationCharge(6000, 80, f.expiry(), 'planner');
  for (let i = 0; i < 23; i++) await f.tick();
  assert.equal(f.inverter.getControlStatus().active, false);
  assert.match(f.inverter.getControlStatus().error!, /expired/);
  assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  await f.inverter.getAutomationReserve();
  assert.equal(f.inverter.getControlStatus().error, undefined);
  await f.tick();
  assert.equal(f.transport.memory.get(STORAGE + 5), 3);
  assert.equal(f.transport.memory.get(STORAGE + 13), 2000);
});

test('natural protection reports foreign register ownership without changing its window', async t => {
  const f = fixture(); t.after(() => f.inverter.disconnect());
  f.transport.memory.set(STORAGE + 5, 3);
  f.transport.memory.set(STORAGE + 13, 4500);
  f.inverter.startSitePowerSupervision(); await f.tick();
  assert.match(f.inverter.getControlStatus().sitePowerProtection?.error!, /Another controller/);
  assert.equal(f.transport.writes.length, 0);
  assert.equal(f.transport.memory.get(STORAGE + 13), 4500);
});
