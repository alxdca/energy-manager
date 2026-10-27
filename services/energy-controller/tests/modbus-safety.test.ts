import test from 'node:test';
import assert from 'node:assert/strict';
import { FroniusModbus } from '../src/devices/fronius-modbus';
import { BatteryMode } from '../src/types/common';

import { control, STORAGE, FakeTransport, client } from './helpers/fake-fronius.js';
const signed = (n: number) => n < 0 ? 65536 + n : n;

test('failed releases retry the owned window until normal mode is verified without reactivating charging', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1000);
  const writes = fake.writes.length;
  fake.failWrite = STORAGE + 5;
  await assert.rejects(modbus.releaseControl(), /Write failed/);
  await assert.rejects(modbus.releaseControl({retry: true}), /Write failed/);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
  fake.failWrite = undefined;
  await modbus.releaseControl({retry: true});
  assert.equal(fake.memory.get(STORAGE + 5), 0);
  assert.ok(fake.writes.slice(writes).every(([address, value]) => address === STORAGE + 5 && value === 0));
  const stoppedWrites = [...fake.writes];
  await modbus.releaseControl({retry: true});
  assert.deepEqual(fake.writes, stoppedWrites);
  await modbus.disconnect();
});

test('release retry confirms an already normal inverter with reads and no writes', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1000);
  fake.failWrite = STORAGE + 5;
  await assert.rejects(modbus.releaseControl());
  fake.failWrite = undefined;
  fake.memory.set(STORAGE + 5, 0);
  const reads = fake.reads.length;
  const writes = [...fake.writes];
  await modbus.releaseControl({retry: true});
  assert.ok(fake.reads.length > reads, 'success must observe normal mode after the failed stop');
  assert.deepEqual(fake.writes, writes);
  await modbus.disconnect();
});

test('release retry refuses a changed foreign window without register writes', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1000);
  fake.failWrite = STORAGE + 5;
  await assert.rejects(modbus.releaseControl());
  fake.failWrite = undefined;
  fake.memory.set(STORAGE + 13, 2000);
  const writes = [...fake.writes];
  await assert.rejects(modbus.releaseControl({retry: true}), /ownership was lost/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
});

test('renewing an identical owned charge window keeps control active and extends only its finite lease', async () => {
  const fake = new FakeTransport();
  let now = 0;
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake, control, now: () => now});
  try {
    await modbus.setBatteryChargePower(1000, {deadline: 900_000, chargeUntilFull: true});
    now = 5000;
    const writes = fake.writes.length;
    await modbus.setBatteryChargePower(1000, {deadline: 905_000, chargeUntilFull: true});
    assert.deepEqual(fake.writes.slice(writes), [[STORAGE + 5, 3]], 'renewal must not release or rewrite power bounds');
    assert.equal(fake.memory.get(STORAGE + 5), 3);
    now = 30_000;
    await modbus.verifyControl({deadline: 905_000});
    assert.equal(fake.memory.get(STORAGE + 5), 3, 'the replacement supervision deadline is active');
    await modbus.releaseControl();
  } finally { await modbus.disconnect(); }
});

test('failed charge-to-hold transitions retain confirmed and ambiguous windows for stop-only retries', async () => {
  for (const lostBoundAck of [false, true]) {
    const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
    await modbus.setBatteryChargePower(6000, {deadline: Date.now() + 900_000, chargeUntilFull: true});
    fake.failWrite = STORAGE + 5;
    if (lostBoundAck) {
      const write = fake.writeRegister.bind(fake);
      fake.writeRegister = async (address, value) => {
        await write(address, value);
        if (address === STORAGE + 12 && value === 0) throw new Error('Bound write acknowledgement lost');
      };
    }
    await assert.rejects(modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true}));
    assert.equal(fake.memory.get(STORAGE + 12), 0);
    assert.equal(fake.memory.get(STORAGE + 5), 3);
    fake.failWrite = undefined;
    const writes = fake.writes.length;
    await modbus.releaseControl({retry: true});
    assert.equal(fake.memory.get(STORAGE + 5), 0);
    assert.deepEqual(fake.writes.slice(writes), [[STORAGE + 5, 0]]);
    await modbus.disconnect();
  }
});

test('an ambiguous charge-to-hold transition still refuses a different foreign window', async () => {
  const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
  await modbus.setBatteryChargePower(6000, {deadline: Date.now() + 900_000, chargeUntilFull: true});
  fake.failWrite = STORAGE + 5;
  await assert.rejects(modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true}));
  fake.failWrite = undefined;
  fake.memory.set(STORAGE + 13, 5000);
  const writes = [...fake.writes];
  await assert.rejects(modbus.releaseControl({retry: true}), /ownership was lost/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
});

test('low-SOC discharge respects the inverter reserve without a 10% app floor', async () => {
  const {modbus, fake} = client();
  fake.memory.set(STORAGE + 7, 500);
  fake.memory.set(STORAGE + 8, 700);
  await modbus.setBatteryChargePower(-500);
  await modbus.verifyControl();
  assert.equal(fake.memory.get(STORAGE + 5), 3);
  assert.equal(fake.memory.get(STORAGE + 7), 500, 'the inverter reserve must not be changed');
  fake.memory.set(STORAGE + 8, 500);
  const writes = fake.writes.length;
  assert.equal((await modbus.verifyControl()).reserve, 5);
  assert.equal(fake.writes.length, writes, 'control must not be renewed at the inverter reserve');
  await modbus.disconnect();
});

test('discharge at or below the inverter reserve performs no writes', async () => {
  for (const soc of [400, 500, 700]) {
    const {modbus, fake} = client();
    fake.memory.set(STORAGE + 7, soc === 700 ? 800 : 500);
    fake.memory.set(STORAGE + 8, soc);
    await assert.rejects(modbus.setBatteryChargePower(-500), /SOC limits/);
    assert.deepEqual(fake.writes, []);
  }
});

test('read-only boundary rejects commands without any register writes', async () => {
  const {modbus, fake} = client(undefined, {...control, enabled: false});
  await assert.rejects(modbus.setBatteryChargePower(1000));
  assert.deepEqual(fake.writes, []);
  await modbus.disconnect(); assert.deepEqual(fake.writes, []);
});

test('linked SunSpec discovery and SF apply in both inverter modes', async () => {
  for (const mode of ['int', 'float'] as const) {
    const {modbus, fake} = client(undefined, control, mode);
    if (mode === 'float') {
      for (let address = 40069; address < 40131; address++) fake.memory.set(address,0);
      fake.model(40069,113,60); fake.memory.set(40069+48,4); fake.model(40131,160,67);
    }
    assert.equal(await modbus.scanForModel124(), STORAGE);
    fake.memory.set(STORAGE + 22, signed(-1)); fake.memory.set(STORAGE + 8, 456);
    assert.equal(await modbus.getBatterySOC(), 45.6);
    await modbus.disconnect(); assert.deepEqual(fake.writes, []);
  }
});

test('charging is bounded on both sides, finite timeout is verified before activation, settings preserved', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1234);
  assert.equal(fake.memory.get(STORAGE + 12), signed(-1234));
  assert.equal(fake.memory.get(STORAGE + 13), 1234);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
  assert.ok(fake.writes.findIndex(([a,v]) => a === STORAGE + 15 && v === 30) < fake.writes.findIndex(([a,v]) => a === STORAGE + 5 && v === 3));
  assert.equal(fake.memory.get(STORAGE + 7), 2000); assert.equal(fake.memory.get(STORAGE + 17), 1);
  assert.ok(fake.writes.every(([address]) => [STORAGE + 5, STORAGE + 12, STORAGE + 13, STORAGE + 15].includes(address)));
  await modbus.disconnect();
});

test('discharge uses both directional limits and standby is zero on both', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(-1000);
  assert.equal(fake.memory.get(STORAGE + 12), 1000); assert.equal(fake.memory.get(STORAGE + 13), signed(-1000));
  await modbus.setBatteryStandby();
  assert.equal(fake.memory.get(STORAGE + 12), 0); assert.equal(fake.memory.get(STORAGE + 13), 0);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
  await modbus.disconnect();
});

test('unknown capabilities, invalid values, missing SOC, fault and foreign device all fail closed', async () => {
  for (const mutate of [
    (f: FakeTransport) => f.memory.set(STORAGE + 2, 0),
    (f: FakeTransport) => f.memory.set(STORAGE + 18, 32768),
    (f: FakeTransport) => f.memory.set(STORAGE + 8, 65535),
    (f: FakeTransport) => f.memory.set(40069 + 38, 7),
    (f: FakeTransport) => f.string(40004, 'Not Fronius', 16),
    (f: FakeTransport) => { f.failRead = STORAGE + 2; },
  ]) {
    const {modbus, fake} = client(); mutate(fake);
    await assert.rejects(modbus.setBatteryChargePower(1000)); assert.deepEqual(fake.writes, []);
  }
  for (const watts of [NaN, Infinity, -Infinity, 3001]) {
    const {modbus, fake} = client(); await assert.rejects(modbus.setBatteryChargePower(watts)); assert.deepEqual(fake.writes, []);
  }
});

test('force mode has no implicit power and is rejected', async () => {
  const {modbus, fake} = client();
  await assert.rejects(modbus.setBatteryMode(BatteryMode.FORCE_CHARGE));
  await assert.rejects(modbus.setBatteryMode(BatteryMode.FORCE_DISCHARGE));
  assert.deepEqual(fake.writes, []);
});

test('unverified fallback prevents activation; partial failures restore mode and close', async () => {
  const {modbus, fake} = client(); fake.ignoreWrite = STORAGE + 15;
  await assert.rejects(modbus.setBatteryChargePower(1000));
  assert.ok(!fake.writes.some(([a,v]) => a === STORAGE + 5 && v === 3));
  assert.equal(fake.closed, true);
});

test('all requests and write transactions are serialized', async () => {
  const {modbus, fake} = client();
  await Promise.all([modbus.setBatteryChargePower(1000), modbus.getBatterySOC(), modbus.setBatteryStandby()]);
  assert.equal(fake.maxActiveRequests, 1);
  await modbus.disconnect();
});

test('foreign ownership blocks power writes; passive release/disconnect do not clear it', async () => {
  const {modbus, fake} = client(); fake.memory.set(STORAGE + 5,3);
  await assert.rejects(modbus.setBatteryChargePower(1000));
  await modbus.releaseControl(); await modbus.disconnect(); assert.deepEqual(fake.writes,[]);
});

test('explicit authorized normal recovery clears previous control even in fault state', async () => {
  const {modbus,fake} = client(); fake.memory.set(STORAGE+5,3); fake.memory.set(40069+38,7);
  await modbus.setBatteryMode(BatteryMode.NORMAL);
  assert.deepEqual(fake.writes,[[STORAGE+5,0]]); await modbus.disconnect();
  const readonly = client(undefined,{...control,enabled:false});
  await assert.rejects(readonly.modbus.setBatteryMode(BatteryMode.NORMAL)); assert.deepEqual(readonly.fake.writes,[]);
});

test('control ownership loss disconnects without clearing another client window', async () => {
  const {modbus,fake} = client(); await modbus.setBatteryChargePower(1000);
  fake.memory.set(STORAGE+13,2000); const writes = [...fake.writes];
  await assert.rejects(modbus.verifyControl(),/ownership/);
  await assert.rejects(modbus.releaseControl(), /fallback/); await modbus.disconnect();
  assert.deepEqual(fake.writes,writes); assert.equal(fake.closed,true);
});

test('ownership failures identify the changed setting without overwriting it', async () => {
  for (const [offset, value, detail] of [
    [5, 0, 'StorCtl_Mod expected 3, observed 0'],
    [12, 0, 'OutWRte expected -1000, observed 0'],
    [13, 2000, 'InWRte expected 1000, observed 2000'],
    [15, 25, 'InOutWRte_RvrtTms expected 30, observed 25'],
  ] as const) {
    const {modbus, fake} = client();
    await modbus.setBatteryChargePower(1000);
    fake.memory.set(STORAGE + offset, value);
    const writes = [...fake.writes];
    await assert.rejects(modbus.verifyControl(), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(detail), error.message);
      return true;
    });
    await modbus.disconnect();
    assert.deepEqual(fake.writes, writes);
  }
});

test('supervision refreshes a write-driven revert timer without extending the session deadline', async () => {
  const fake = new FakeTransport();
  let now = 0;
  let lastActivation = 0;
  const write = fake.writeRegister.bind(fake);
  fake.writeRegister = async (address, value) => {
    await write(address, value);
    if (address === STORAGE + 5 && value === 3) lastActivation = now;
  };
  const read = fake.readHoldingRegisters.bind(fake);
  fake.readHoldingRegisters = async (address, length) => {
    if (now - lastActivation >= control.revertTimeoutSeconds * 1000) fake.memory.set(STORAGE + 5, 0);
    return read(address, length);
  };
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake, control, now: () => now});
  await modbus.setBatteryChargePower(1000);
  const initialWrites = fake.writes.length;
  for (let step = 0; step < 12; step++) {
    now += control.checkIntervalMs;
    await modbus.verifyControl();
    assert.equal(fake.memory.get(STORAGE + 5), 3);
  }
  assert.deepEqual(fake.writes.slice(initialWrites), Array.from({length: 12}, () => [STORAGE + 5, 3]));
  const writes = [...fake.writes];
  now = control.maxDurationMs;
  await assert.rejects(modbus.verifyControl(), /duration/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.closed, true);
});

test('supervision never renews unsafe, superseded or SOC-limited control', async () => {
  for (const mutate of [
    (fake: FakeTransport) => fake.memory.set(40069 + 38, 7),
    (fake: FakeTransport) => fake.memory.set(STORAGE + 17, 0),
  ]) {
    const {modbus, fake} = client();
    await modbus.setBatteryChargePower(1000);
    mutate(fake);
    const writes = [...fake.writes];
    await assert.rejects(modbus.verifyControl());
    assert.deepEqual(fake.writes, writes);
    await modbus.disconnect();
  }
  for (const [watts, soc] of [[1000, 9000], [-1000, 2000]]) {
    const {modbus, fake} = client();
    await modbus.setBatteryChargePower(watts);
    fake.memory.set(STORAGE + 8, soc);
    const writes = [...fake.writes];
    await modbus.verifyControl();
    assert.deepEqual(fake.writes, writes);
    await modbus.disconnect();
  }
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1000);
  let current = true;
  const read = fake.readHoldingRegisters.bind(fake);
  fake.readHoldingRegisters = async (address, length) => {
    const result = await read(address, length);
    if (address === STORAGE + 2) current = false;
    return result;
  };
  const writes = [...fake.writes];
  await assert.rejects(modbus.verifyControl({deadline: Date.now() + control.maxDurationMs, isCurrent: () => current}), /superseded/);
  assert.deepEqual(fake.writes, writes);
  await modbus.disconnect();
});

test('ownership changing during safety reads prevents the keepalive write', async () => {
  const {modbus, fake} = client();
  await modbus.setBatteryChargePower(1000);
  const read = fake.readHoldingRegisters.bind(fake);
  fake.readHoldingRegisters = async (address, length) => {
    const result = await read(address, length);
    if (address === STORAGE + 2) fake.memory.set(STORAGE + 13, 2000);
    return result;
  };
  const writes = [...fake.writes];
  await assert.rejects(modbus.verifyControl(), /InWRte expected 1000, observed 2000/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.closed, true);
});

test('coarse scaling rounds requested magnitude downward for both directions', async () => {
  for (const watts of [1234,-1234]) {
    const {modbus,fake} = client(); fake.memory.set(STORAGE+18,1); fake.memory.set(STORAGE+2,1000);
    fake.memory.set(STORAGE+25,signed(-1));
    await modbus.setBatteryChargePower(watts);
    assert.equal(Math.abs(fake.memory.get(STORAGE+13)! > 32767 ? fake.memory.get(STORAGE+13)! - 65536 : fake.memory.get(STORAGE+13)!),123);
    assert.equal(Math.abs(fake.memory.get(STORAGE+12)! > 32767 ? fake.memory.get(STORAGE+12)! - 65536 : fake.memory.get(STORAGE+12)!),123);
    await modbus.disconnect();
  }
});

test('invalid model chain/signature and unusable scale factors cannot write guessed addresses', async () => {
  for (const mutate of [
    (f: FakeTransport)=>f.memory.set(40000,0),
    (f: FakeTransport)=>f.memory.set(40122,0),
    (f: FakeTransport)=>f.memory.set(STORAGE+1,23),
    (f: FakeTransport)=>f.memory.set(STORAGE+25,32768),
    (f: FakeTransport)=>f.memory.set(STORAGE+21,32768),
    (f: FakeTransport)=>f.memory.set(40069+44,65535),
    (f: FakeTransport)=>f.memory.set(40069+45,1),
    (f: FakeTransport)=>f.memory.set(STORAGE+11,7),
  ]) {
    const {modbus,fake} = client(); mutate(fake);
    await assert.rejects(modbus.setBatteryChargePower(1000)); assert.deepEqual(fake.writes,[]);
  }
});

test('readback mismatch after activation triggers verified normal-mode recovery', async () => {
  const {modbus,fake} = client(); fake.ignoreWrite=STORAGE+5;
  await assert.rejects(modbus.setBatteryChargePower(1000));
  assert.equal(fake.memory.get(STORAGE+5),0); assert.equal(fake.closed,true);
  assert.deepEqual(fake.writes.at(-1),[STORAGE+5,0]);
});


test('forced charging preserves disabled grid permission and rejects with zero writes', async () => {
  const {modbus,fake} = client(); fake.memory.set(STORAGE+17,0);
  await assert.rejects(modbus.setBatteryChargePower(1000),/permission/);
  assert.deepEqual(fake.writes,[]);
});

test('direct low-level reads cannot extend a control beyond its hard lifetime', async () => {
  const fake = new FakeTransport(); let now = 0;
  const modbus = new FroniusModbus('offline.invalid',502,1,'int',{client:fake,control,now:()=>now});
  await modbus.setBatteryChargePower(1000); now = control.maxDurationMs;
  await assert.rejects(modbus.getBatterySOC(),/duration/);
  assert.equal(fake.closed,true); assert.equal(fake.memory.get(STORAGE+5),3);
});

test('charging until full renews its supervision lease beyond the bounded session duration', async () => {
  const fake = new FakeTransport(); let now = 0;
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake, control, now: () => now});
  fake.memory.set(STORAGE + 8, 9500);
  await modbus.setBatteryChargePower(1000, {deadline: 30000, chargeUntilFull: true});
  for (let step = 0; step < 72; step++) {
    now += 5000;
    await modbus.verifyControl({deadline: now + 30000});
    assert.equal(fake.memory.get(STORAGE + 5), 3);
  }
  const writes = [...fake.writes];
  fake.memory.set(STORAGE + 8, 10000);
  assert.equal((await modbus.verifyControl({deadline: now + 30000})).soc, 100);
  assert.deepEqual(fake.writes, writes);
  await modbus.releaseControl();
  assert.equal(fake.memory.get(STORAGE + 5), 0);
  await modbus.disconnect();
});

test('missed supervision lease stops persistent charging before any new Modbus traffic', async () => {
  const fake = new FakeTransport(); let now = 0;
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake, control, now: () => now});
  await modbus.setBatteryChargePower(1000, {deadline: 30000, chargeUntilFull: true});
  now = 20000;
  await modbus.getBatterySOC(); // Passive reads must not renew the supervision lease.
  const reads = fake.reads.length;
  const writes = [...fake.writes];
  now = 30000;
  await assert.rejects(modbus.verifyControl({deadline: 60000}), /duration/);
  assert.equal(fake.reads.length, reads);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.closed, true);
  await assert.rejects(modbus.getBatterySOC(), /fallback/);
});

test('verification cannot upgrade bounded control into persistent charging', async () => {
  const fake = new FakeTransport(); let now = 0;
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake, control, now: () => now});
  await modbus.setBatteryChargePower(1000);
  now = control.maxDurationMs - 5000;
  await modbus.verifyControl({deadline: now + 30000, chargeUntilFull: true});
  now = control.maxDurationMs;
  const writes = [...fake.writes];
  await assert.rejects(modbus.verifyControl({deadline: now + 30000, chargeUntilFull: true}), /duration/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.closed, true);
});

test('persistent charging requires positive power and a finite activation deadline', async () => {
  for (const [watts, deadline] of [[-1000, 30000], [0, 30000], [1000, Infinity]]) {
    const {modbus, fake} = client();
    await assert.rejects(modbus.setBatteryChargePower(watts, {deadline, chargeUntilFull: true}));
    assert.deepEqual(fake.writes, []);
  }
});

test('deadline crossing inside read closes socket before any subsequent request', async () => {
  const fake = new FakeTransport(); let now = 0;
  const modbus = new FroniusModbus('offline.invalid',502,1,'int',{client:fake,control,now:()=>now});
  await modbus.setBatteryChargePower(1000);
  const read = fake.readHoldingRegisters.bind(fake);
  fake.readHoldingRegisters = async (address,length) => { const result=await read(address,length); now=control.maxDurationMs; return result; };
  const beforeReads = fake.reads.length; const beforeWrites = fake.writes.length;
  await assert.rejects(modbus.verifyControl(),/duration/);
  assert.equal(fake.reads.length,beforeReads+1); assert.equal(fake.writes.length,beforeWrites); assert.equal(fake.closed,true);
  await assert.rejects(modbus.getBatterySOC(),/fallback/);
  assert.equal(fake.reads.length,beforeReads+1);
});

test('superseded transaction stops before activation and only performs normal cleanup', async () => {
  const {modbus,fake} = client(); let current = true;
  const write = fake.writeRegister.bind(fake);
  fake.writeRegister = async (address,value) => { await write(address,value); if (address===STORAGE+12) current=false; };
  await assert.rejects(modbus.setBatteryChargePower(1000,{deadline:Date.now()+300000,isCurrent:()=>current}),/superseded/);
  assert.ok(!fake.writes.some(([address,value])=>address===STORAGE+5 && value===3));
  assert.equal(fake.memory.get(STORAGE+5),0); assert.equal(fake.closed,true);
});

test('connect failure closes pending transport before connected flag was established', async () => {
  const {modbus,fake} = client(); fake.connectTCP=async()=>{throw new Error('connect failed');};
  await assert.rejects(modbus.connect(),/connect failed/); assert.equal(fake.closed,true); assert.deepEqual(fake.writes,[]);
});

test('never-resolving Modbus read cannot strand deadline, cancellation or shutdown', {timeout:1000}, async () => {
  const {modbus,fake} = client(); await modbus.setBatteryChargePower(1000);
  fake.readHoldingRegisters=()=>new Promise(()=>{});
  const before = fake.reads.length;
  const failed = modbus.verifyControl({deadline:Date.now()+25}).catch((error:Error)=>error);
  const stop = modbus.releaseControl(); const shutdown = modbus.disconnect();
  assert.ok(await failed instanceof Error); await assert.rejects(stop, /fallback/); await shutdown;
  assert.equal(fake.closed,true); assert.equal(fake.reads.length,before);
});

test('unverified cancellation quarantines retry traffic until inverter fallback expires', async () => {
  const {modbus,fake}=client(); await modbus.setBatteryChargePower(1000);
  fake.failWrite=STORAGE+5;
  await assert.rejects(modbus.releaseControl());
  assert.equal(fake.memory.get(STORAGE+5),3);
  const beforeReads=fake.reads.length; const beforeWrites=fake.writes.length;
  await assert.rejects(modbus.readSafetyState(),/fallback/);
  assert.equal(fake.reads.length,beforeReads); assert.equal(fake.writes.length,beforeWrites);
  fake.failWrite=undefined;
  await modbus.setBatteryMode(BatteryMode.NORMAL);
  assert.equal(fake.memory.get(STORAGE+5),0); await modbus.disconnect();
});

test('failed replacement cleanup quarantines all retry reads instead of renewing abandoned control', async () => {
  const {modbus,fake}=client(); await modbus.setBatteryChargePower(1000);
  fake.failWrite=STORAGE+5;
  await assert.rejects(modbus.setBatteryStandby());
  const before=fake.reads.length;
  await assert.rejects(modbus.getBatterySOC(),/fallback/);
  assert.equal(fake.reads.length,before); assert.equal(fake.memory.get(STORAGE+5),3);
});

test('failed shutdown restoration also quarantines subsequent reconnect attempts', async () => {
  const {modbus,fake}=client(); await modbus.setBatteryChargePower(1000);
  fake.failWrite=STORAGE+5;
  await assert.rejects(modbus.disconnect());
  const before=fake.reads.length;
  await assert.rejects(modbus.readSafetyState(),/fallback/);
  assert.equal(fake.reads.length,before);
});

test('hold permits zero to 6 kW charging with no discharge or forced charging and preserves inverter policy', async () => {
  const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
  fake.memory.set(STORAGE + 17, 0); // Solar charging must not require grid-charge permission.
  fake.memory.set(STORAGE + 8, 10000); // Holding a full battery remains valid.
  await modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true});
  assert.equal(fake.memory.get(STORAGE + 12), 0);
  assert.equal(fake.memory.get(STORAGE + 13), 6000);
  assert.equal(fake.memory.get(STORAGE + 5), 3);
  for (let i = 0; i < 3; i++) await modbus.verifyControl({deadline: Date.now() + 900_000});
  assert.equal(fake.memory.get(STORAGE + 12), 0);
  assert.equal(fake.memory.get(STORAGE + 13), 6000);
  assert.equal(fake.memory.get(STORAGE + 7), 2000);
  assert.equal(fake.memory.get(STORAGE + 17), 0);
  assert.ok(fake.writes.every(([address]) => [STORAGE + 5, STORAGE + 12, STORAGE + 13, STORAGE + 15].includes(address)));
  await modbus.disconnect();
});

test('owned charge to hold never activates normal mode or zeroes the permitted solar-charge ceiling', async () => {
  const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
  const deadline = Date.now() + 900_000;
  await modbus.setBatteryChargePower(6000, {deadline, chargeUntilFull: true});
  const count = fake.writes.length;
  await modbus.setBatteryHold({deadline, renewable: true});
  assert.deepEqual(fake.writes.slice(count), [[STORAGE + 12, 0], [STORAGE + 5, 3]]);
  assert.equal(fake.memory.get(STORAGE + 13), 6000);
  await modbus.disconnect();
});

test('hold rejects unsafe power policy, foreign ownership, lost ownership and unbounded contexts', async () => {
  const low = client();
  await assert.rejects(low.modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true}), /configured limit/);
  assert.deepEqual(low.fake.writes, []);
  for (const context of [{deadline: Infinity, renewable: true}, {deadline: Date.now() + 900_000},
    {deadline: Date.now() + 900_000, renewable: true, chargeUntilFull: true}]) {
    const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
    await assert.rejects(modbus.setBatteryHold(context));
    assert.deepEqual(fake.writes, []);
  }
  const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
  fake.memory.set(STORAGE + 5, 3);
  await assert.rejects(modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true}), /Another controller/);
  assert.deepEqual(fake.writes, []);
  fake.memory.set(STORAGE + 5, 0);
  await modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true});
  fake.memory.set(STORAGE + 13, 5000);
  const writes = [...fake.writes];
  await assert.rejects(modbus.verifyControl(), /ownership was lost.*InWRte/);
  assert.deepEqual(fake.writes, writes);
});

test('hold renews finite supervision beyond bounded manual duration then abandons an expired lease before traffic', async () => {
  const fake = new FakeTransport();
  let now = 0;
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {client: fake,
    control: {...control, maxPowerWatts: 6000, maxDurationMs: 10_000}, now: () => now});
  await modbus.setBatteryHold({deadline: 900_000, renewable: true});
  for (let i = 0; i < 10; i++) {
    now += 5000;
    await modbus.verifyControl({deadline: 900_000});
  }
  const writes = [...fake.writes]; const reads = fake.reads.length;
  now += 30_000;
  await assert.rejects(modbus.verifyControl({deadline: 900_000}), /duration expired/);
  assert.deepEqual(fake.writes, writes);
  assert.equal(fake.reads.length, reads);
  assert.equal(fake.closed, true);
});

test('hold supervision read timeout closes transport and cannot postpone finite fallback', {timeout: 1000}, async () => {
  const {modbus, fake} = client(undefined, {...control, maxPowerWatts: 6000});
  await modbus.setBatteryHold({deadline: Date.now() + 900_000, renewable: true});
  const writes = [...fake.writes];
  fake.readHoldingRegisters = () => new Promise(() => {});
  await assert.rejects(modbus.verifyControl({deadline: Date.now() + 25}), /timed out|duration expired/);
  assert.equal(fake.closed, true);
  assert.deepEqual(fake.writes, writes);
  await assert.rejects(modbus.readSafetyState(), /fallback/);
});
