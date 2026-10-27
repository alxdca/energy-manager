import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyCounterReader } from '../src/energy-counters.js';

const at = '2026-10-26T10:45:24.000Z';
const snapshot = () => ({ status: 'online', error: null, solar: { at, value: 300, source: 'pv:one' },
  household: { at, value: -100, source: 'house:one:meter' } });

test('the counter reader makes GET-only requests and preserves real timestamps, Wh and source identities', async () => {
  let calls = 0;
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test/prefix', now: () => new Date(at), fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://controller.test/prefix/system/energy-counters');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    return Response.json(snapshot());
  } });
  assert.deepEqual(await read(), snapshot());
  assert.deepEqual(await read(), snapshot());
  assert.equal(calls, 2, 'completed responses are not reused as fresh observations');
});

test('stale, future, invalid and failed counter reads never reuse a previous good sample', async () => {
  let body: unknown = snapshot(), failed = false;
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test', now: () => new Date(at), fetch: async () => {
    if (failed) throw new Error('network unavailable');
    return Response.json(body);
  } });
  assert.equal((await read()).solar?.value, 300);
  for (const timestamp of ['bad', '2026-10-26T10:44:00.000Z', '2026-10-26T10:45:30.000Z']) {
    const value = snapshot(); value.solar.at = timestamp; value.household.at = timestamp; body = value;
    const result = await read(); assert.equal(result.status, 'offline'); assert.equal(result.solar, null); assert.equal(result.household, null);
  }
  body = { ...snapshot(), status: 'stale' };
  assert.equal((await read()).solar, null);
  failed = true;
  assert.equal((await read()).solar, null);
});

test('partial counter failures preserve an independent valid series and zero remains known', async () => {
  const body = snapshot(); body.solar.value = 0;
  let payload: unknown = { ...body, household: null, error: 'meter unavailable' };
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test', now: () => new Date(at), fetch: async () => Response.json(payload) });
  assert.equal((await read()).solar?.value, 0);
  payload = { ...body, solar: { ...body.solar, value: -1 } };
  const result = await read();
  assert.equal(result.solar, null); assert.equal(result.household?.value, -100);
});

test('coalescing applies only to overlapping reads and returned snapshots are isolated', async () => {
  let calls = 0, resolve!: (response: Response) => void;
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test', now: () => new Date(at), fetch: async () => {
    calls++; return new Promise<Response>(done => { resolve = done; });
  } });
  const a = read(), b = read(); resolve(Response.json(snapshot()));
  const [one, two] = await Promise.all([a, b]); one.solar!.value = 999;
  assert.equal(calls, 1); assert.equal(two.solar!.value, 300);
});

test('an unconfigured controller leaves counters unknown without a request', async () => {
  const read = createEnergyCounterReader({ controllerUrl: null, fetch: async () => { throw new Error('must not fetch'); } });
  const result = await read(); assert.equal(result.status, 'offline'); assert.equal(result.solar, null); assert.equal(result.household, null);
});

test('native counter components survive acquisition for reset checks and malformed maps cannot fabricate deltas', async () => {
  const solar = { at, value: 300, source: 'pv:one', components: { pv1Wh: 100, pv2Wh: 200 } };
  const household = { at, value: 1340, source: 'house:one:meter', components: {
    acProduced01Wh: 100, acProduced02Wh: 200, acProduced03Wh: 300,
    acConsumed01Wh: 10, acConsumed02Wh: 20, acConsumed03Wh: 30, gridImportWh: 1000, gridExportWh: 200,
  } };
  let body: unknown = { status: 'online', error: null, solar, household };
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test', now: () => new Date(at), fetch: async () => Response.json(body) });
  assert.deepEqual(await read(), body);
  for (const components of [{ pv1Wh: 100 }, { pv1Wh: -1, pv2Wh: 301 }, { pv1Wh: 100, pv2Wh: 201 }, { pv1Wh: 100, pv2Wh: 200, extra: 0 }]) {
    body = { status: 'online', error: null, solar: { ...solar, components }, household };
    const result = await read();
    assert.equal(result.solar, null); assert.equal(result.household?.value, 1340);
  }
});

test('SOC preserves its real component time independently of energy availability and never uses response time', async () => {
  const storageAt = new Date(Date.parse(at) - 2000).toISOString();
  let body: unknown = { status: 'online', error: 'inverter counters unavailable', solar: null, household: null,
    battery: { at: storageAt, value: 0 } };
  const read = createEnergyCounterReader({ controllerUrl: 'http://controller.test', now: () => new Date(at), fetch: async () => Response.json(body) });
  const result = await read();
  assert.equal(result.status, 'online'); assert.deepEqual(result.battery, { at: storageAt, value: 0 });
  for (const battery of [{ at: storageAt, value: 101 }, { at: storageAt, value: -1 },
    { at: '2026-10-26T10:44:00.000Z', value: 50 }, { at: '2026-10-26T10:45:30.000Z', value: 50 }]) {
    body = { status: 'online', error: null, solar: null, household: null, battery };
    const value = await read(); assert.equal(value.battery, null); assert.equal(value.status, 'offline');
  }
});
