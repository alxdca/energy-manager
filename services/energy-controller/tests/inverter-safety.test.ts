import test from 'node:test';
import assert from 'node:assert/strict';
import { FroniusInverter } from '../src/devices/fronius-inverter';
import { BatteryMode } from '../src/types/common';

const policy = {enabled: true, maxPowerWatts: 3000, maxSocPercent: 90, maxDurationMs: 30000, revertTimeoutSeconds: 30, checkIntervalMs: 5000};
class FakeModbus {
  calls: string[] = [];
  soc = 40;
  reserve = 20;
  failure?: Error;
  getControlPolicy() { return {...policy}; }
  async connect() { this.calls.push('connect'); }
  async disconnect() { this.calls.push('disconnect'); }
  async getBatterySOC() { return this.soc; }
  async readSafetyState(_context?: {deadline: number}) { return {soc:this.soc, reserve:this.reserve, maxPower:10000, rateScale:0.01, mode:0, gridChargingAllowed:true}; }
  async verifyControl() { this.calls.push('verify'); if (this.failure) throw this.failure; return this.readSafetyState(); }
  async setBatteryChargePower(watts: number) { this.calls.push(`power:${watts}`); }
  async setBatteryStandby() { this.calls.push('standby'); }
  async setBatteryHold() { this.calls.push('hold'); }
  async releaseControl() { this.calls.push(`mode:${BatteryMode.NORMAL}`); }
  async setBatteryMode(mode: BatteryMode) { this.calls.push(`mode:${mode}`); }
}
class FakeClock {
  value = 0;
  timers = new Map<number, () => void>();
  counter = 0;
  now = () => this.value;
  setTimer = (fn: () => void, _delay: number) => { const id = ++this.counter; this.timers.set(id, fn); return id; };
  clearTimer = (id: number) => { this.timers.delete(id); };
  async tick(ms = 5000) {
    this.value += ms;
    const callbacks = [...this.timers.values()]; this.timers.clear();
    callbacks.forEach(fn => fn());
    // Allow queued async transaction and supervision chain to finish, without wall-clock waits.
    for (let i=0;i<40;i++) await Promise.resolve();
  }
}
function setup() {
  const modbus = new FakeModbus(); const clock = new FakeClock();
  const inverter = new (FroniusInverter as any)('offline.invalid',80,{modbus, readSiteLoadWatts: async () => 500, now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  inverter.modbus = modbus;
  return {inverter,modbus,clock};
}

function automationSetup() {
  const f = setup();
  f.modbus.getControlPolicy = () => ({...policy, maxPowerWatts: 6000});
  return f;
}

test('automation reserve is read from the inverter at startup with a bounded read and at most five seconds of caching', async () => {
  const {inverter, modbus, clock} = setup();
  let reads = 0;
  const original = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async context => {
    reads++;
    assert.equal(context?.deadline, clock.value + 4000);
    return original(context);
  };
  assert.equal(await inverter.getAutomationReserve(), 20);
  modbus.reserve = 25;
  assert.equal(await inverter.getAutomationReserve(), 20);
  assert.equal(reads, 1);
  clock.value = 5000;
  assert.equal(await inverter.getAutomationReserve(), 25);
  assert.equal(reads, 2);
  assert.deepEqual(modbus.calls, [], 'reserve reads must not write battery controls');
});

test('unknown automation reserve returns null without poisoning manual controls or retaining an old reserve', async () => {
  const {inverter, modbus, clock} = setup();
  assert.equal(await inverter.getAutomationReserve(), 20);
  clock.value = 5000;
  modbus.readSafetyState = async () => { throw new Error('Reserve unavailable'); };
  assert.equal(await inverter.getAutomationReserve(), null);
  assert.equal(inverter.getControlStatus().error, undefined);
  await inverter.setBatteryMode(BatteryMode.NORMAL);
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
});

test('disabled automation reserve performs no Modbus reads and malformed reserve remains unknown', async () => {
  const {inverter, modbus} = setup();
  modbus.getControlPolicy = () => ({...policy, enabled: false});
  modbus.readSafetyState = async () => { throw new Error('must not read'); };
  assert.equal(await inverter.getAutomationReserve(), null);
  modbus.getControlPolicy = () => ({...policy});
  modbus.readSafetyState = async () => ({soc: 40, reserve: NaN, maxPower: 10000, rateScale: 0.01, mode: 0, gridChargingAllowed: true});
  assert.equal(await inverter.getAutomationReserve(), null);
});

test('reserve reads share the inverter queue with manual preflight without overlapping safety contexts', async () => {
  const {inverter, modbus} = setup();
  let release!: () => void;
  let ready!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {ready = resolve;});
  const original = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async context => {
    calls++;
    if (calls === 1) {ready(); await gate;}
    return original(context);
  };
  const reserve = inverter.getAutomationReserve();
  await started;
  const manual = inverter.setBatteryChargePower(1000, 60);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(modbus.calls, []);
  release();
  assert.equal(await reserve, 20);
  await manual;
  assert.equal(calls, 2);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
});

test('automation has a finite supervised lease and expires before a late verification can renew it', async () => {
  const {inverter, modbus, clock} = automationSetup();
  const expiresAt = new Date(900_000).toISOString();
  await inverter.setAutomationCharge(6000, 70, expiresAt, 'energy-manager');
  assert.equal(inverter.getControlStatus().automationOwner, 'energy-manager');
  assert.equal(inverter.getControlStatus().expiresAt, expiresAt);
  await clock.tick(300_000);
  assert.equal(inverter.getControlStatus().active, true, 'automation lease outlives manual bounded duration');
  const verifies = modbus.calls.filter(call => call === 'verify').length;
  await clock.tick(600_000);
  assert.equal(inverter.getControlStatus().active, false);
  assert.equal(modbus.calls.filter(call => call === 'verify').length, verifies);
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
});

test('automation renews its own lease but cannot change manual or foreign control', async () => {
  const {inverter, modbus, clock} = automationSetup();
  await inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  await clock.tick(100_000);
  await inverter.setAutomationCharge(6000, 75, new Date(1_000_000).toISOString(), 'energy-manager');
  assert.equal(inverter.getControlStatus().targetSocPercent, 75);
  assert.equal(inverter.getControlStatus().expiresAt, new Date(1_000_000).toISOString());
  const before = [...modbus.calls];
  await assert.rejects(inverter.setAutomationCharge(6000, 80, new Date(1_000_000).toISOString(), 'foreign'), /another battery controller/);
  await assert.rejects(inverter.stopAutomationCharge('foreign'), /another battery controller/);
  assert.deepEqual(modbus.calls, before);
  await inverter.setBatteryChargePower(1000, 60);
  assert.equal(inverter.getControlStatus().automationOwner, undefined);
  const manual = [...modbus.calls];
  await assert.rejects(inverter.stopAutomationCharge('energy-manager'), /another battery controller/);
  await assert.rejects(inverter.setAutomationCharge(6000, 80, new Date(1_000_000).toISOString(), 'energy-manager'), /another battery controller/);
  assert.deepEqual(modbus.calls, manual);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
  await inverter.stopAutomationCharge('energy-manager');
  assert.equal(inverter.getControlStatus().active, false);
});

test('automation malformed inputs cannot touch or cancel a running session', async () => {
  const {inverter, modbus} = automationSetup();
  await inverter.setBatteryChargePower(1000, 60);
  const before = [...modbus.calls];
  for (const [watts, target, expiry, owner] of [
    [0, 70, new Date(900_000).toISOString(), 'energy-manager'],
    [-1, 70, new Date(900_000).toISOString(), 'energy-manager'],
    [6001, 70, new Date(900_000).toISOString(), 'energy-manager'],
    [3000.5, 70, new Date(900_000).toISOString(), 'energy-manager'],
    [NaN, 70, new Date(900_000).toISOString(), 'energy-manager'],
    [6000, 91, new Date(900_000).toISOString(), 'energy-manager'],
    [6000, NaN, new Date(900_000).toISOString(), 'energy-manager'],
    [6000, 70, new Date(960_001).toISOString(), 'energy-manager'],
    [6000, 70, new Date(0).toISOString(), 'energy-manager'],
    [6000, 70, 'invalid', 'energy-manager'],
    [6000, 70, new Date(900_000).toISOString(), 'bad owner'],
  ]) await assert.rejects(inverter.setAutomationCharge(watts, target, expiry, owner));
  assert.deepEqual(modbus.calls, before);
  await inverter.cancelControl();
});

test('automation adjusts its owned charging power without releasing the finite Modbus window', async () => {
  const {inverter, modbus, clock} = automationSetup();
  await inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  const before = modbus.calls.length;
  await clock.tick(100_000);
  await inverter.setAutomationCharge(3000, 70, new Date(1_000_000).toISOString(), 'energy-manager');
  assert.equal(inverter.getControlStatus().watts, 3000);
  assert.equal(inverter.getControlStatus().automationOwner, 'energy-manager');
  assert.equal(inverter.getControlStatus().expiresAt, new Date(1_000_000).toISOString());
  assert.ok(modbus.calls.slice(before).includes('power:3000'));
  assert.equal(modbus.calls.slice(before).includes(`mode:${BatteryMode.NORMAL}`), false);
  assert.equal(modbus.calls.slice(before).includes('hold'), false);
  const unchanged = [...modbus.calls];
  await assert.rejects(inverter.setAutomationCharge(3000, 70, new Date(1_000_000).toISOString(), 'foreign'), /another battery controller/);
  assert.deepEqual(modbus.calls, unchanged);
  await inverter.cancelControl();
});

test('pending manual activation wins over a later automation request', async () => {
  const {inverter, modbus} = automationSetup();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {ready = resolve;});
  const original = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async () => {ready(); await gate; return original();};
  const manual = inverter.setBatteryChargePower(1000, 60);
  await started;
  const automation = inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  release();
  await manual;
  await assert.rejects(automation, /another battery controller/);
  assert.equal(inverter.getControlStatus().watts, 1000);
  assert.equal(modbus.calls.includes('power:6000'), false);
  await inverter.cancelControl();
});

test('manual replacement invalidates pending automation and its old callbacks', async () => {
  const {inverter, modbus, clock} = automationSetup();
  await inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  const obsolete = [...clock.timers.values()];
  await inverter.setBatteryChargePower(1000, 60);
  const before = [...modbus.calls];
  obsolete.forEach(callback => callback());
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(modbus.calls, before);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
});

test('manual request during automated preflight prevents the automated charge write', async () => {
  const {inverter, modbus} = automationSetup();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {ready = resolve;});
  const original = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async () => {ready(); await gate; return original();};
  const automated = inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  await started;
  const manual = inverter.setBatteryChargePower(1000, 60);
  release();
  await assert.rejects(automated, /superseded/);
  await manual;
  assert.equal(modbus.calls.includes('power:6000'), false);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
});

test('automation reaches its requested SOC and holds stored energy without releasing normal mode', async () => {
  const {inverter, modbus, clock} = automationSetup();
  await inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
  modbus.soc = 70;
  await clock.tick();
  assert.equal(inverter.getControlStatus().active, true);
  assert.equal(inverter.getControlStatus().automationOwner, 'energy-manager');
  assert.equal(inverter.getControlStatus().automationMode, 'hold');
  assert.equal(inverter.getControlStatus().watts, 0);
  assert.equal(inverter.getControlStatus().targetSocPercent, undefined);
  assert.equal(inverter.getControlStatus().error, undefined);
  assert.equal(modbus.calls.at(-1), 'hold');
  await inverter.cancelControl();
});

test('all target inputs are finite and bounded before commands', async () => {
  const {inverter,modbus} = setup();
  assert.equal(typeof inverter.cancelControl,'function');
  for (const [watts,target] of [[NaN,60],[1000,NaN],[Infinity,60],[1000,100],[3001,60]]) {
    await assert.rejects(inverter.chargeToTarget(watts,target));
  }
  assert.deepEqual(modbus.calls, []);
});

test('invalid manual targets cannot cancel, replace or activate existing persistent control', async () => {
  const {inverter, modbus, clock} = setup();
  await inverter.setBatteryChargePower(1000, 60);
  const before = [...modbus.calls];
  for (const target of [null, '60', NaN, Infinity, -1, 0, 91]) {
    await assert.rejects(inverter.setBatteryChargePower(1500, target));
  }
  for (const watts of [0, -1000, NaN, Infinity, 3001]) {
    await assert.rejects(inverter.setBatteryChargePower(watts, 60));
  }
  assert.deepEqual(modbus.calls, before);
  assert.equal(inverter.getControlStatus().watts, 1000);
  assert.equal(inverter.getControlStatus().targetSocPercent, 60);
  assert.equal(clock.timers.size, 1);
  await inverter.cancelControl();
});

test('cancellation settles target immediately, clears monitor, restores normal exactly once', async () => {
  const {inverter,modbus,clock} = setup();
  assert.equal(typeof inverter.cancelControl,'function');
  const job = inverter.chargeToTarget(1000,60); const outcome = job.then(()=>undefined,(error: Error)=>error);
  for (let i=0;i<20;i++) await Promise.resolve();
  await inverter.cancelControl();
  assert.ok(await outcome instanceof Error);
  assert.equal(clock.timers.size,0);
  assert.equal(modbus.calls.filter(call => call === `mode:${BatteryMode.NORMAL}`).length,1);
});

test('target completion restores normal before resolving', async () => {
  const {inverter,modbus,clock} = setup(); assert.equal(typeof inverter.cancelControl,'function');
  const job = inverter.chargeToTarget(1000,60);
  for (let i=0;i<20;i++) await Promise.resolve();
  modbus.soc = 60; await clock.tick(); await job;
  assert.equal(inverter.getControlStatus().active,false);
  assert.equal(modbus.calls.at(-1),`mode:${BatteryMode.NORMAL}`);
  assert.equal(clock.timers.size,0);
});

test('explicit normal mode clears cancellation status while still rejecting the cancelled target job', async () => {
  const {inverter, modbus, clock} = setup();
  const outcome = inverter.chargeToTarget(1000, 60).catch((error: Error) => error);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await inverter.setBatteryMode(BatteryMode.NORMAL);
  assert.match((await outcome).message, /cancelled/);
  assert.equal(inverter.getControlStatus().active, false);
  assert.equal(inverter.getControlStatus().error, undefined);
  assert.equal(clock.timers.size, 0);
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
});

test('explicit normal clears prior faults only after a successful normal write', async () => {
  const {inverter, modbus, clock} = setup();
  await inverter.setBatteryChargePower(1000);
  modbus.failure = new Error('Supervision fault');
  await clock.tick();
  assert.match(inverter.getControlStatus().error, /Supervision fault/);
  const original = modbus.setBatteryMode.bind(modbus);
  modbus.setBatteryMode = async () => { throw new Error('Normal write failed'); };
  await assert.rejects(inverter.setBatteryMode(BatteryMode.NORMAL), /Normal write failed/);
  assert.equal(inverter.getControlStatus().active, false);
  assert.match(inverter.getControlStatus().error, /Normal write failed/);
  modbus.setBatteryMode = original;
  await inverter.setBatteryMode(BatteryMode.NORMAL);
  assert.equal(inverter.getControlStatus().error, undefined);
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
});

test('explicit normal preserves failed release errors and closes the transport', async () => {
  const {inverter, modbus, clock} = setup();
  await inverter.setBatteryChargePower(1000);
  modbus.releaseControl = async () => { throw new Error('Normal release failed'); };
  await assert.rejects(inverter.setBatteryMode(BatteryMode.NORMAL), /Normal release failed/);
  assert.equal(inverter.getControlStatus().active, false);
  assert.match(inverter.getControlStatus().error, /Normal release failed/);
  assert.equal(clock.timers.size, 0);
  assert.equal(modbus.calls.at(-1), 'disconnect');
});

test('manual replacement cancels old target before applying new command; old callbacks cannot stop new owner', async () => {
  const {inverter,modbus,clock} = setup(); assert.equal(typeof inverter.cancelControl,'function');
  const job = inverter.chargeToTarget(1000,60); const outcome = job.catch((error: Error)=>error);
  for (let i=0;i<20;i++) await Promise.resolve();
  const oldCallback = [...clock.timers.values()][0];
  await inverter.setBatteryChargePower(-1000);
  assert.ok(await outcome instanceof Error);
  const before = [...modbus.calls]; oldCallback();
  for (let i=0;i<20;i++) await Promise.resolve();
  assert.deepEqual(modbus.calls,before);
  assert.equal(inverter.getControlStatus().watts,-1000);
  await inverter.cancelControl();
});

test('bounded standby and discharge expire before further reads that could refresh inverter fallback', async () => {
  for (const command of ['standby', 'discharge']) {
    const {inverter,modbus,clock} = setup();
    if (command === 'standby') await inverter.setBatteryStandby();
    else await inverter.setBatteryChargePower(-1000);
    await clock.tick(30000);
    assert.equal(inverter.getControlStatus().active,false);
    assert.ok(!modbus.calls.includes('verify'));
    assert.equal(modbus.calls.at(-1),`mode:${BatteryMode.NORMAL}`);
  }
});

test('target charging retains its duration limit', async () => {
  const {inverter,modbus,clock} = setup();
  const job = inverter.chargeToTarget(1000, 60).catch((error: Error) => error);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await clock.tick(30000);
  assert.match((await job).message, /duration expired/);
  assert.equal(inverter.getControlStatus().active, false);
  assert.ok(!modbus.calls.includes('verify'));
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
});

test('a replacement charge at full SOC completes without retaining the cancellation error', async () => {
  const {inverter,modbus} = setup();
  await inverter.setBatteryChargePower(1000);
  modbus.soc = 100;
  await inverter.setBatteryChargePower(1000);
  assert.equal(inverter.getControlStatus().active, false);
  assert.equal(inverter.getControlStatus().error, undefined);
  assert.equal(modbus.calls.filter(call => call === 'power:1000').length, 1);
});

test('watchdog failure restores and closes, prevents additional callbacks', async () => {
  const {inverter,modbus,clock} = setup(); assert.equal(typeof inverter.cancelControl,'function');
  await inverter.setBatteryStandby(); modbus.failure = new Error('Modbus failed'); await clock.tick();
  assert.equal(inverter.getControlStatus().active,false); assert.equal(clock.timers.size,0);
  assert.equal(modbus.calls.at(-1),'disconnect');
  assert.match(inverter.getControlStatus().error,/Modbus failed/);
});

test('read-only shutdown does not request normal mode', async () => {
  const {inverter,modbus} = setup(); await inverter.disconnect();
  assert.deepEqual(modbus.calls,['disconnect']);
});

test('cancellation during asynchronous preflight prevents any later charge write', async () => {
  const {inverter,modbus} = setup();
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve=>ready=resolve);
  const gate = new Promise<void>(resolve=>release=resolve);
  const original = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async () => { ready(); await gate; return original(); };
  const result = inverter.chargeToTarget(1000,60).catch((error:Error)=>error);
  await started;
  const stop = inverter.cancelControl(); release(); await stop;
  assert.ok(await result instanceof Error);
  assert.ok(!modbus.calls.some(call=>call.startsWith('power:')));
});

test('full SOC and minimum reserve stop manual charge/discharge sessions', async () => {
  for (const watts of [1000,-1000]) {
    const {inverter,modbus,clock} = setup(); await inverter.setBatteryChargePower(watts);
    modbus.soc = watts > 0 ? 100 : 20; await clock.tick();
    assert.equal(inverter.getControlStatus().active,false); assert.equal(clock.timers.size,0);
    assert.equal(modbus.calls.at(-1),`mode:${BatteryMode.NORMAL}`);
  }
});

test('discharge below 10% uses the inverter reserve for activation and supervision', async () => {
  const {inverter, modbus, clock} = setup();
  modbus.soc = 7;
  modbus.reserve = 5;
  await inverter.setBatteryChargePower(-500);
  await clock.tick();
  assert.equal(inverter.getControlStatus().active, true);
  assert.ok(modbus.calls.includes('power:-500'));
  modbus.reserve = 7;
  await clock.tick();
  assert.equal(inverter.getControlStatus().active, false);
  assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
  assert.equal(clock.timers.size, 0);
});

test('charging targets below 10% remain valid without an application minimum', async () => {
  for (const bounded of [false, true]) {
    const {inverter, modbus, clock} = setup();
    modbus.soc = 3;
    modbus.reserve = 5;
    const command = bounded ? inverter.chargeToTarget(500, 7) : inverter.setBatteryChargePower(500, 7);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(inverter.getControlStatus().active, true);
    modbus.soc = 7;
    await clock.tick();
    await command;
    assert.equal(inverter.getControlStatus().active, false);
    assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
  }
});

test('discharge at or below the inverter reserve is rejected before applying power', async () => {
  for (const soc of [4, 5, 7]) {
    const {inverter, modbus} = setup();
    modbus.soc = soc;
    modbus.reserve = soc === 7 ? 8 : 5;
    await assert.rejects(inverter.setBatteryChargePower(-500), /SOC limits/);
    assert.ok(!modbus.calls.some(call => call.startsWith('power:')));
  }
});

test('read-only initialization is single-flight and shutdown performs zero control operations', async () => {
  const originalFetch=globalThis.fetch;
  const {inverter,modbus}=setup();
  modbus.getControlPolicy=()=>({...policy,enabled:false});
  let requests=0;
  globalThis.fetch=(async()=>{requests++;return new Response(JSON.stringify({Body:{Data:{Site:{P_PV:0}}}}));}) as typeof fetch;
  try {
    await Promise.all([inverter.initialize(),inverter.initialize()]); await inverter.disconnect();
    assert.equal(requests,1); assert.deepEqual(modbus.calls,['disconnect']);
  } finally { globalThis.fetch=originalFetch; }
});

test('dashboard telemetry shares only in-flight reads and malformed SOC remains unknown', async () => {
  const originalFetch=globalThis.fetch;
  let requests=0;
  globalThis.fetch=(async(url: string|URL|Request)=>{
    requests++;
    const data=String(url).includes('GetStorageRealtimeData') ? {0:{Controller:{StateOfCharge_Relative:'50'}}} : {Site:{P_PV:1500,P_Grid:100,P_Akku:0},Storage:{0:{SOC:NaN}}};
    return {ok:true,json:async()=>({Body:{Data:data}})} as Response;
  }) as typeof fetch;
  try {
    const {inverter}=setup();
    const [overview,battery]=await Promise.all([inverter.getSystemOverview(),inverter.getBatteryData(),inverter.getSolarData(),inverter.getGridData()]);
    assert.equal(requests,2); assert.equal(battery.socPercent,null); assert.ok(!battery.validValues.includes('soc'));
    assert.equal(overview.site.P_PV,1500);
    await inverter.getSystemOverview(); assert.equal(requests,4);
  } finally { globalThis.fetch=originalFetch; }
});

test('sequential telemetry refreshes both power-flow and storage values at the same clock instant', async () => {
  const originalFetch = globalThis.fetch;
  let powerRequests = 0, storageRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('GetStorageRealtimeData')) {
      storageRequests++;
      return Response.json({ Body: { Data: { 0: { Controller: { StateOfCharge_Relative: storageRequests * 10 } } } } });
    }
    powerRequests++;
    return Response.json({ Body: { Data: { Site: { P_PV: powerRequests * 1000, P_Load: -500, P_Grid: 0, P_Akku: 0 } } } });
  }) as typeof fetch;
  try {
    const { inverter, modbus, clock } = setup();
    const first = await inverter.getSystemOverview();
    const second = await inverter.getSystemOverview();
    assert.equal(clock.value, 0, 'no cache-expiry delay advances the clock');
    assert.equal(first.site.P_PV, 1000); assert.equal(first.battery.socPercent, 10);
    assert.equal(second.site.P_PV, 2000); assert.equal(second.battery.socPercent, 20);
    assert.equal(powerRequests, 2); assert.equal(storageRequests, 2);
    assert.deepEqual(modbus.calls, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('failed telemetry drops prior values and both failed HTTP reads retry immediately', async () => {
  const originalFetch = globalThis.fetch;
  let failing = false, requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests++;
    if (failing) return new Response('Unavailable', { status: 503 });
    return Response.json({ Body: { Data: String(input).includes('GetStorageRealtimeData')
      ? { 0: { Controller: { StateOfCharge_Relative: 25 } } }
      : { Site: { P_PV: 2000, P_Load: -500, P_Grid: 0, P_Akku: 0 } } } });
  }) as typeof fetch;
  try {
    const { inverter, modbus } = setup();
    assert.equal((await inverter.getSystemOverview()).site.P_PV, 2000);
    failing = true;
    for (const expectedRequests of [4, 6]) {
      assert.deepEqual(await inverter.getSystemOverview(), { solar: null, grid: null, battery: null });
      assert.equal(requests, expectedRequests, 'failed responses are not retained between sequential calls');
    }
    failing = false;
    const recovered = await inverter.getSystemOverview();
    assert.equal(recovered.site.P_PV, 2000); assert.equal(recovered.battery.socPercent, 25);
    assert.equal(requests, 8);
    assert.deepEqual(modbus.calls, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('GEN24 power-flow inverter SOC supplies battery telemetry when the storage device is absent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => Response.json({
    Body: { Data: String(url).includes('GetStorageRealtimeData') ? {} : {
      Inverters: { '1': { SOC: 5.360000133514404, Battery_Mode: 'nearly depleted' } },
      Site: { P_PV: 1000, P_Load: -500, P_Grid: -500, P_Akku: 0 },
    } },
    Head: { Status: { Code: String(url).includes('GetStorageRealtimeData') ? 12 : 0 } },
  })) as typeof fetch;
  try {
    const { inverter, modbus } = setup();
    const overview = await inverter.getSystemOverview();
    assert.equal(overview.battery.socPercent, 5.360000133514404);
    assert.ok(overview.battery.validValues.includes('soc'));
    assert.deepEqual(modbus.calls, [], 'HTTP monitoring must not issue Modbus operations');
  } finally { globalThis.fetch = originalFetch; }
});

test('power-flow SOC accepts real zero/full values but rejects invalid, inactive or ambiguous batteries', async () => {
  const originalFetch = globalThis.fetch;
  const cases: Array<[unknown, number | null]> = [
    [{ '1': { SOC: 0 } }, 0], [{ '1': { SOC: 100 } }, 100],
    [{ '1': { SOC: '50' } }, null], [{ '1': { SOC: NaN } }, null],
    [{ '1': { SOC: Infinity } }, null], [{ '1': { SOC: -1 } }, null],
    [{ '1': { SOC: 101 } }, null], [{ '1': { SOC: null } }, null],
    [{ '1': { SOC: 0, Battery_Mode: 'disabled' } }, null],
    [{ '1': { SOC: 50, Battery_Mode: 'none operable' } }, null],
    [{ '1': { SOC: 20 }, '2': { SOC: 60 } }, null],
    [{ '1': { SOC: 0, Battery_Mode: 'disabled' }, '2': { SOC: 60 } }, 60],
    [{ '1': null, '2': 'invalid' }, null], [null, null], [[], null],
  ];
  try {
    for (const [Inverters, expected] of cases) {
      globalThis.fetch = (async (url: string | URL | Request) => ({ ok: true,
        json: async () => ({ Body: { Data: String(url).includes('GetStorageRealtimeData') ? {} : { Inverters } } }),
      })) as typeof fetch;
      const { inverter, modbus } = setup();
      const battery = await inverter.getBatteryData();
      assert.equal(battery.socPercent, expected);
      assert.equal(battery.validValues.includes('soc'), expected !== null);
      assert.deepEqual(modbus.calls, []);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('automated hold is owned, zero-watt and finite, including target already reached at activation', async () => {
  for (const alreadyCharged of [true, false]) {
    const {inverter, modbus, clock} = automationSetup();
    if (alreadyCharged) {
      modbus.soc = 75;
      await inverter.setAutomationCharge(6000, 70, new Date(900_000).toISOString(), 'energy-manager');
    } else await inverter.setAutomationHold(new Date(900_000).toISOString(), 'energy-manager');
    assert.equal(inverter.getControlStatus().automationMode, 'hold');
    assert.equal(inverter.getControlStatus().automationOwner, 'energy-manager');
    assert.equal(inverter.getControlStatus().watts, 0);
    assert.equal(inverter.getControlStatus().targetSocPercent, undefined);
    assert.equal(modbus.calls.includes('power:6000'), false);
    assert.equal(modbus.calls.includes('standby'), false);
    await clock.tick(100_000);
    assert.equal(inverter.getControlStatus().active, true);
    await clock.tick(795_000);
    assert.equal(inverter.getControlStatus().active, false);
    assert.equal(modbus.calls.at(-1), `mode:${BatteryMode.NORMAL}`);
  }
});

test('hold cannot override manual control or another owner and manual replacement cancels old hold callbacks', async () => {
  const {inverter, modbus, clock} = automationSetup();
  await inverter.setAutomationHold(new Date(900_000).toISOString(), 'energy-manager');
  await assert.rejects(inverter.setAutomationHold(new Date(900_000).toISOString(), 'foreign'), /another battery controller/);
  const obsolete = [...clock.timers.values()];
  await inverter.setBatteryChargePower(1000, 60);
  const before = [...modbus.calls];
  await assert.rejects(inverter.setAutomationHold(new Date(900_000).toISOString(), 'energy-manager'), /another battery controller/);
  await assert.rejects(inverter.stopAutomationCharge('energy-manager'), /another battery controller/);
  obsolete.forEach(callback => callback());
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.deepEqual(modbus.calls, before);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
});

test('hold malformed leases and insufficient charge ceiling never cancel existing control', async () => {
  const {inverter, modbus} = automationSetup();
  await inverter.setBatteryChargePower(1000, 60);
  const before = [...modbus.calls];
  for (const [expiry, owner] of [[new Date(0).toISOString(), 'energy-manager'], [new Date(960_001).toISOString(), 'energy-manager'],
    ['invalid', 'energy-manager'], [new Date(900_000).toISOString(), 'bad owner']]) {
    await assert.rejects(inverter.setAutomationHold(expiry, owner));
  }
  modbus.getControlPolicy = () => ({...policy});
  await assert.rejects(inverter.setAutomationHold(new Date(900_000).toISOString(), 'energy-manager'), /outside configured limits/);
  assert.deepEqual(modbus.calls, before);
  await inverter.cancelControl();
});

test('manual activation during hold preflight supersedes the hold before its write', async () => {
  const {inverter, modbus} = automationSetup();
  let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const entered = new Promise<void>(resolve => {ready = resolve;});
  const read = modbus.readSafetyState.bind(modbus);
  modbus.readSafetyState = async () => {ready(); await gate; return read();};
  const hold = inverter.setAutomationHold(new Date(900_000).toISOString(), 'energy-manager');
  await entered;
  const manual = inverter.setBatteryChargePower(1000, 60);
  release();
  await assert.rejects(hold, /superseded/);
  await manual;
  assert.equal(modbus.calls.includes('hold'), false);
  assert.equal(inverter.getControlStatus().watts, 1000);
  await inverter.cancelControl();
});
