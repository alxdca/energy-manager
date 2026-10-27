import test from 'node:test';
import assert from 'node:assert/strict';
import { FroniusInverter } from '../src/devices/fronius-inverter.js';
import { FroniusModbus } from '../src/devices/fronius-modbus.js';
import { FakeTransport, control, STORAGE } from './helpers/fake-fronius.js';

function fixture() {
  const transport = new FakeTransport();
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {
    client: transport, control: { ...control, maxPowerWatts: 6000 }, now: () => now,
  });
  const inverter = new FroniusInverter('offline.invalid', 80, {
    modbus, readSiteLoadWatts: async () => 1000, now: () => now,
    setTimer: callback => { timers.set(++nextId, callback); return nextId; },
    clearTimer: id => { timers.delete(id); },
  });
  return {
    inverter, modbus, transport,
    setState(state: number) { transport.memory.set(40107, state); },
    async tick(milliseconds = 5000) {
      now += milliseconds;
      const callbacks = [...timers.values()]; timers.clear();
      callbacks.forEach(callback => callback());
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    },
    charge: () => inverter.setAutomationCharge(6000, 85.7, new Date(now + 900_000).toISOString(), 'planner'),
  };
}

test('expired automatic charge and hold recover only after a fresh safe read without replaying a command', async () => {
  for (const hold of [false, true]) {
    const f = fixture();
    try {
      const expiresAt = new Date(20_000).toISOString();
      if (hold) await f.inverter.setAutomationHold(expiresAt, 'planner');
      else await f.inverter.setAutomationCharge(6000, 85.7, expiresAt, 'planner');
      await f.tick(14_000);
      assert.equal(f.inverter.getControlStatus().active, true);
      await f.tick(1000);
      assert.equal(f.inverter.getControlStatus().active, false, 'release keeps its five-second cleanup margin');
      assert.match(f.inverter.getControlStatus().error!, /duration expired/);
      assert.equal(f.transport.memory.get(STORAGE + 5), 0);
      const writes = [...f.transport.writes];
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.ok(f.inverter.getControlStatus().error, 'cached safety state cannot clear an expiration');
      await f.tick(4000);
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, undefined);
      assert.equal(f.inverter.getControlStatus().active, false, 'recovery waits for a new plan');
      assert.deepEqual(f.transport.writes, writes, 'recovery is read-only');
      await f.charge();
      assert.equal(f.inverter.getControlStatus().active, true);
    } finally { await f.inverter.cancelControl(); await f.modbus.disconnect(); }
  }
});

test('unknown, foreign and invalid safety state cannot clear an automatic expiration', async () => {
  const f = fixture();
  try {
    await f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner');
    await f.tick(15_000);
    const error = f.inverter.getControlStatus().error;
    assert.match(error!, /duration expired/);
    const writes = [...f.transport.writes];
    f.transport.failRead = 40107;
    assert.equal(await f.inverter.getAutomationReserve(), null);
    assert.equal(f.inverter.getControlStatus().error, error);
    f.transport.failRead = undefined;
    await f.tick(); f.transport.memory.set(STORAGE + 5, 3);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
    await f.tick(); f.transport.memory.set(STORAGE + 5, 0); f.transport.memory.set(STORAGE + 7, 65535);
    assert.equal(await f.inverter.getAutomationReserve(), null);
    assert.equal(f.inverter.getControlStatus().error, error);
    await f.tick(); f.transport.memory.set(STORAGE + 7, 2000);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.deepEqual(f.transport.writes, writes);
  } finally { await f.modbus.disconnect(); }
});

test('real faults stay latched while failed expiration cleanup recovers only after a verified retry', async () => {
  for (const failedCleanup of [false, true]) {
    const f = fixture();
    try {
      await f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner');
      if (failedCleanup) f.transport.failWrite = STORAGE + 5;
      await f.tick(15_000);
      assert.equal(f.inverter.getControlStatus().active, false);
      if (!failedCleanup) {
        f.setState(7);
        assert.equal(await f.inverter.getAutomationReserve(), null);
        assert.match(f.inverter.getControlStatus().error!, /state=7/);
      }
      const error = f.inverter.getControlStatus().error;
      assert.ok(error);
      f.setState(4); f.transport.failWrite = undefined; f.transport.memory.set(STORAGE + 5, 0);
      for (let i = 0; i < 7; i++) await f.tick();
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, failedCleanup ? undefined : error);
    } finally { await f.modbus.disconnect(); }
  }
});

test('expired manual control remains latched after a healthy read', async () => {
  const f = fixture();
  try {
    await f.inverter.setBatteryStandby();
    await f.tick(300_000);
    const error = f.inverter.getControlStatus().error;
    assert.match(error!, /duration expired/);
    assert.equal(f.inverter.getControlStatus().active, false);
    for (let i = 0; i < 7; i++) await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
  } finally { await f.modbus.disconnect(); }
});

test('expired automatic control retries failed stops every five seconds without replaying charging', async () => {
  const f = fixture();
  try {
    await f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner');
    const writes = f.transport.writes.length;
    f.transport.failWrite = STORAGE + 5;
    await f.tick(15_000);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 3);
    await f.tick();
    assert.equal(f.transport.writes.slice(writes).filter(([address, value]) => address === STORAGE + 5 && value === 0).length, 2);
    f.transport.failWrite = undefined;
    await f.tick();
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.ok(f.transport.writes.slice(writes).every(([address, value]) => address === STORAGE + 5 && value === 0));
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    const stoppedWrites = [...f.transport.writes];
    await f.tick();
    assert.deepEqual(f.transport.writes, stoppedWrites);
  } finally { await f.modbus.disconnect(); }
});

test('a real inverter fault remains latched after a failed cleanup is successfully retried', async () => {
  const f = fixture();
  try {
    await f.charge();
    f.setState(7); f.transport.failWrite = STORAGE + 5;
    await f.tick();
    assert.equal(f.inverter.getControlStatus().active, false);
    f.transport.failWrite = undefined;
    await f.tick();
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    const error = f.inverter.getControlStatus().error;
    assert.match(error!, /state=7/);
    f.setState(4);
    await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
  } finally { await f.modbus.disconnect(); }
});

test('automatic activation refuses the effective cutoff before and after preflight', async () => {
  for (const duringPreflight of [false, true]) {
    const f = fixture();
    try {
      if (duringPreflight) {
        const read = f.modbus.readSafetyState.bind(f.modbus);
        f.modbus.readSafetyState = async context => {
          const result = await read(context);
          await f.tick(15_000);
          return result;
        };
      } else await f.tick(15_000);
      await assert.rejects(f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner'), /expired|deadline/i);
      assert.equal(f.inverter.getControlStatus().active, false);
      assert.ok(f.transport.writes.every(([address, value]) => address !== STORAGE + 5 || value !== 3));
    } finally { await f.modbus.disconnect(); }
  }
});

test('automatic activation cannot cross its cutoff inside the Modbus preflight', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const read = f.transport.readHoldingRegisters.bind(f.transport);
    f.transport.readHoldingRegisters = async (address, length) => {
      const result = await read(address, length);
      if (address === 40107 && ++reads === 2) await f.tick(15_000);
      return result;
    };
    await assert.rejects(f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner'), /superseded|deadline/);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.ok(f.transport.writes.every(([address, value]) => address !== STORAGE + 5 || value !== 3));
  } finally { await f.modbus.disconnect(); }
});

test('a late automation renewal releases its existing session without a new activation', async () => {
  const f = fixture();
  try {
    await f.charge();
    await f.tick(15_000);
    const writes = f.transport.writes.length;
    await assert.rejects(f.inverter.setAutomationCharge(6000, 85.7, new Date(20_000).toISOString(), 'planner'), /expired/);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.ok(f.transport.writes.slice(writes).every(([address, value]) => address === STORAGE + 5 && value === 0));
  } finally { await f.modbus.disconnect(); }
});

test('temporary inverter states stop automatic charging and recover only after a fresh safe read', async () => {
  for (const state of [1, 2, 3, 6]) {
    const f = fixture();
    try {
      await f.charge();
      f.setState(state);
      await f.tick();
      assert.equal(f.inverter.getControlStatus().active, false);
      assert.match(f.inverter.getControlStatus().error!, /Inverter is not ready/);
      assert.equal(f.transport.memory.get(STORAGE + 5), 0, 'owned command must be released');
      assert.equal(await f.inverter.getAutomationReserve(), null, 'still-unready inverter stays blocked');
      const writes = [...f.transport.writes];
      f.setState(4);
      assert.equal(await f.inverter.getAutomationReserve(), null, 'cached read cannot clear the error');
      assert.ok(f.inverter.getControlStatus().error);
      await f.tick();
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, undefined, `state ${state} should recover`);
      assert.equal(f.inverter.getControlStatus().active, false, 'recovery must not replay the previous command');
      assert.deepEqual(f.transport.writes, writes, 'recovery is read-only');
      await f.charge();
      assert.equal(f.inverter.getControlStatus().active, true, 'a newly authorized plan can charge again');
    } finally { await f.inverter.cancelControl(); await f.modbus.disconnect(); }
  }
});

test('failed automatic activation during a temporary state can recover without replaying the command', async () => {
  const f = fixture();
  try {
    f.setState(3);
    await assert.rejects(f.charge(), /Inverter is not ready/);
    assert.deepEqual(f.transport.writes, []);
    f.setState(4);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.deepEqual(f.transport.writes, []);
  } finally { await f.modbus.disconnect(); }
});

test('automatic ownership conflicts recover only after a fresh safe normal-mode read', async () => {
  for (const mode of [1, 2, 3]) {
    const f = fixture();
    try {
      f.transport.memory.set(STORAGE + 5, mode);
      await assert.rejects(f.charge(), /Another controller already owns the battery/);
      const error = f.inverter.getControlStatus().error;
      assert.ok(error);
      await f.tick();
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, error, 'foreign control must remain blocked');
      assert.deepEqual(f.transport.writes, [], 'foreign control must never be overwritten');

      f.transport.memory.set(STORAGE + 5, 0);
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, error, 'cached state cannot clear the conflict');
      await f.tick();
      f.transport.failRead = 40107;
      assert.equal(await f.inverter.getAutomationReserve(), null);
      assert.equal(f.inverter.getControlStatus().error, error, 'an incomplete safety read cannot clear the conflict');
      f.transport.failRead = undefined;
      await f.tick();
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, undefined);
      assert.equal(f.inverter.getControlStatus().active, false, 'recovery must wait for a new plan');
      assert.deepEqual(f.transport.writes, [], 'recovery must be read-only');

      await f.charge();
      assert.equal(f.inverter.getControlStatus().active, true);
    } finally { await f.inverter.cancelControl(); await f.modbus.disconnect(); }
  }
});

test('manual ownership conflicts remain latched after normal mode is observed', async () => {
  const f = fixture();
  try {
    f.transport.memory.set(STORAGE + 5, 3);
    await assert.rejects(f.inverter.setBatteryChargePower(1000), /Another controller already owns the battery/);
    const error = f.inverter.getControlStatus().error;
    assert.ok(error);
    f.transport.memory.set(STORAGE + 5, 0);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
    assert.deepEqual(f.transport.writes, []);
  } finally { await f.modbus.disconnect(); }
});

test('an inverter fault during ownership recovery stays latched after the conflict ends', async () => {
  const f = fixture();
  try {
    f.transport.memory.set(STORAGE + 5, 3);
    await assert.rejects(f.charge(), /Another controller already owns the battery/);
    f.setState(7);
    await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), null);
    const error = f.inverter.getControlStatus().error;
    assert.match(error!, /state=7/);
    f.setState(4); f.transport.memory.set(STORAGE + 5, 0);
    await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
    assert.deepEqual(f.transport.writes, []);
  } finally { await f.modbus.disconnect(); }
});

test('actual inverter faults and event warnings stay latched after a healthy read', async () => {
  for (const [state, address, value] of [[7, 40109, 0], [3, 40114, 2], [4, 40109, 1], [4, 40116, 1]]) {
    const f = fixture();
    try {
      await f.charge();
      f.setState(state);
      f.transport.memory.set(address, value);
      await f.tick();
      assert.equal(f.inverter.getControlStatus().active, false);
      const error = f.inverter.getControlStatus().error;
      assert.ok(error);
      f.setState(4); f.transport.memory.set(address, 0);
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, error, 'faults/warnings require explicit recovery');
    } finally { await f.modbus.disconnect(); }
  }
});

test('a real fault appearing during recovery replaces the transient error and stays latched', async () => {
  const f = fixture();
  try {
    await f.charge(); f.setState(3); await f.tick();
    f.setState(7);
    assert.equal(await f.inverter.getAutomationReserve(), null);
    const error = f.inverter.getControlStatus().error;
    assert.match(error!, /state=7/);
    f.setState(4); await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
  } finally { await f.modbus.disconnect(); }
});

test('unknown reads, foreign control and invalid reserve cannot clear a temporary interruption', async () => {
  const f = fixture();
  try {
    await f.charge(); f.setState(3); await f.tick();
    const error = f.inverter.getControlStatus().error;
    f.setState(4);
    f.transport.failRead = 40107;
    assert.equal(await f.inverter.getAutomationReserve(), null);
    assert.equal(f.inverter.getControlStatus().error, error);
    f.transport.failRead = undefined;
    await f.tick(); f.transport.memory.set(STORAGE + 5, 3);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, error);
    await f.tick(); f.transport.memory.set(STORAGE + 5, 0); f.transport.memory.set(STORAGE + 7, 65535);
    assert.equal(await f.inverter.getAutomationReserve(), null);
    assert.equal(f.inverter.getControlStatus().error, error);
  } finally { await f.modbus.disconnect(); }
});

test('manual interruptions stay latched while failed automatic cleanup retries until verified', async () => {
  for (const manual of [true, false]) {
    const f = fixture();
    try {
      if (manual) await f.inverter.setBatteryChargePower(1000, 85.7);
      else { await f.charge(); f.transport.failWrite = STORAGE + 5; }
      f.setState(3); await f.tick();
      const error = f.inverter.getControlStatus().error;
      assert.ok(error);
      f.setState(4); f.transport.failWrite = undefined; f.transport.memory.set(STORAGE + 5, 0);
      for (let i = 0; i < 7; i++) await f.tick();
      assert.equal(await f.inverter.getAutomationReserve(), 20);
      assert.equal(f.inverter.getControlStatus().error, manual ? error : undefined);
    } finally { await f.modbus.disconnect(); }
  }
});

test('an unclassified activation failure stays latched after its cleanup retry verifies normal mode', async () => {
  const f = fixture();
  try {
    await f.charge();
    let stateReads = 0;
    const read = f.transport.readHoldingRegisters.bind(f.transport);
    f.transport.readHoldingRegisters = async (address, length) => {
      if (address === 40107 && ++stateReads === 2) f.setState(3);
      return read(address, length);
    };
    f.transport.failWrite = STORAGE + 5;
    await assert.rejects(f.charge(), /cleanup could not be verified/);
    const error = f.inverter.getControlStatus().error;
    assert.ok(error);
    f.setState(4); f.transport.failWrite = undefined; f.transport.memory.set(STORAGE + 5, 0);
    for (let i = 0; i < 7; i++) await f.tick();
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.match(f.inverter.getControlStatus().error!, /state=3.*cleanup could not be verified/);
  } finally { await f.modbus.disconnect(); }
});

test('automatic holds also release on a temporary state and wait for a new plan after recovery', async () => {
  const f = fixture();
  try {
    await f.inverter.setAutomationHold(new Date(900_000).toISOString(), 'planner');
    f.setState(3); await f.tick();
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    f.setState(4);
    assert.equal(await f.inverter.getAutomationReserve(), 20);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.equal(f.inverter.getControlStatus().active, false);
  } finally { await f.modbus.disconnect(); }
});

test('readiness errors include the actual operating state and event fields', async () => {
  const f = fixture();
  try {
    f.setState(3); f.transport.memory.set(40114, 2);
    await assert.rejects(f.modbus.readSafetyState(), error => {
      assert.match((error as Error).message, /state=3/);
      assert.match((error as Error).message, /EvtVnd1=0x00000002/);
      return true;
    });
  } finally { await f.modbus.disconnect(); }
});
