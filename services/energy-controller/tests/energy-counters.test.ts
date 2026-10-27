import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyCounterReader } from '../src/devices/energy-counters.js';
import { createApi } from '../src/api/api.js';
import type { FroniusInverter } from '../src/devices/fronius-inverter.js';
import type { Battery } from '../src/devices/battery.js';
import { config } from '../src/config/index.js';

const at = '2026-10-26T10:45:24.000Z';
const seconds = Date.parse(at) / 1000;
function fixture() {
  return { Head: { Timestamp: at }, Body: { Data: {
    storage_abc: { attributes: { 'device-class': 'Storage', '[ENABLE]': 'true' }, channels: {
      COMPONENTS_TIME_STAMP_U64: seconds - 2, BAT_VALUE_STATE_OF_CHARGE_RELATIVE_F32: 53.5,
    } },
    inverter_abc: { attributes: { manufacturer: 'Fronius', model: 'Fronius Gen24' }, channels: {
      COMPONENTS_TIME_STAMP_U64: seconds,
      PV_ENERGYACTIVE_ACTIVE_SUM_01_U64: 360_000, PV_ENERGYACTIVE_ACTIVE_SUM_02_U64: 720_000,
      ACBRIDGE_ENERGYACTIVE_PRODUCED_SUM_01_U64: 360_000, ACBRIDGE_ENERGYACTIVE_PRODUCED_SUM_02_U64: 720_000,
      ACBRIDGE_ENERGYACTIVE_PRODUCED_SUM_03_U64: 1_080_000,
      ACBRIDGE_ENERGYACTIVE_ACTIVECONSUMED_SUM_01_U64: 36_000, ACBRIDGE_ENERGYACTIVE_ACTIVECONSUMED_SUM_02_U64: 72_000,
      ACBRIDGE_ENERGYACTIVE_ACTIVECONSUMED_SUM_03_U64: 108_000,
    } },
    meter_xyz: { attributes: { manufacturer: 'Fronius', model: 'Smart Meter 63A', '[ENABLE]': 'true', 'meter-location': '0' }, channels: {
      COMPONENTS_TIME_STAMP_U64: seconds - 1, SMARTMETER_ENERGYACTIVE_ABSOLUT_PLUS_F64: 1000,
      SMARTMETER_ENERGYACTIVE_ABSOLUT_MINUS_F64: 200,
    } },
  } } };
}

test('component counters preserve actual times and convert Ws to Wh without averaging or battery double counting', async () => {
  const body = fixture();
  const read = createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async (url, init) => {
    assert.equal(String(url), 'http://inverter.test/components/readable');
    assert.equal(init?.method, 'GET');
    return Response.json(body);
  } });
  const result = await read();
  assert.equal(result.status, 'online');
  assert.deepEqual(result.battery, { at: new Date((seconds - 2) * 1000).toISOString(), value: 53.5 },
    'SOC uses the storage component time, not the later response timestamp');
  assert.equal(result.solar?.value, 300);
  assert.equal(result.solar?.at, at);
  assert.equal(result.household?.value, 1340, '600 AC produced - 60 AC consumed + 1000 import - 200 export');
  assert.equal(result.household?.at, at, 'a composite counter cannot be timestamped before a newer component input');
  assert.match(result.solar!.source, /inverter_abc/);
  assert.match(result.household!.source, /inverter_abc.*meter_xyz/);
  assert.deepEqual(result.solar!.components, { pv1Wh: 100, pv2Wh: 200 });
  assert.deepEqual(result.household!.components, { acProduced01Wh: 100, acConsumed01Wh: 10,
    acProduced02Wh: 200, acConsumed02Wh: 20, acProduced03Wh: 300, acConsumed03Wh: 30,
    gridImportWh: 1000, gridExportWh: 200 });
});

test('missing PV fields do not fabricate zero or hide an independent valid household counter', async () => {
  const body = fixture();
  delete (body.Body.Data.inverter_abc.channels as Partial<typeof body.Body.Data.inverter_abc.channels>).PV_ENERGYACTIVE_ACTIVE_SUM_02_U64;
  const result = await createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(body) })();
  assert.equal(result.solar, null);
  assert.equal(result.household?.value, 1340);
});

test('GEN24 inverter attributes need no enable flag, but an explicit disabled or invisible source is rejected', async () => {
  for (const flag of ['[ENABLE]', '[VISIBLE]']) {
    const body = fixture();
    Object.assign(body.Body.Data.inverter_abc.attributes, { [flag]: 'false' });
    const result = await createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(body) })();
    assert.equal(result.status, 'online'); assert.equal(result.solar, null); assert.equal(result.household, null);
    assert.equal(result.battery?.value, 53.5, 'SOC remains available independently of inverter counters');
  }
});

test('zero SOC remains known with no inverter source and malformed or stale storage samples remain unknown', async () => {
  const body = fixture();
  delete (body.Body.Data as Partial<typeof body.Body.Data>).inverter_abc;
  body.Body.Data.storage_abc.channels.BAT_VALUE_STATE_OF_CHARGE_RELATIVE_F32 = 0;
  const read = createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(body) });
  const result = await read();
  assert.equal(result.status, 'online'); assert.equal(result.battery?.value, 0); assert.equal(result.solar, null); assert.equal(result.household, null);
  for (const soc of [-1, 101, NaN]) {
    body.Body.Data.storage_abc.channels.BAT_VALUE_STATE_OF_CHARGE_RELATIVE_F32 = soc;
    assert.equal((await read()).battery, null);
  }
  body.Body.Data.storage_abc.channels.BAT_VALUE_STATE_OF_CHARGE_RELATIVE_F32 = 50;
  for (const stamp of [seconds - 50, seconds + 6]) {
    body.Body.Data.storage_abc.channels.COMPONENTS_TIME_STAMP_U64 = stamp;
    assert.equal((await read()).battery, null, 'a fresh response does not refresh an old or future SOC observation');
  }
});

test('a non-grid, disabled or stale meter cannot silently become a household-energy source', async () => {
  for (const change of [
    (body: ReturnType<typeof fixture>) => { body.Body.Data.meter_xyz.attributes['meter-location'] = '1'; },
    (body: ReturnType<typeof fixture>) => { body.Body.Data.meter_xyz.attributes['[ENABLE]'] = 'false'; },
    (body: ReturnType<typeof fixture>) => { body.Body.Data.meter_xyz.channels.COMPONENTS_TIME_STAMP_U64 -= 50; },
    (body: ReturnType<typeof fixture>) => { body.Body.Data.meter_xyz.channels.SMARTMETER_ENERGYACTIVE_ABSOLUT_PLUS_F64 = -1; },
  ]) {
    const body = fixture(); change(body);
    const result = await createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(body) })();
    assert.equal(result.solar?.value, 300);
    assert.equal(result.household, null);
  }
});

test('zero counters are valid, negative household offsets remain usable, and stale/future snapshots are rejected', async () => {
  const body = fixture();
  body.Body.Data.inverter_abc.channels.PV_ENERGYACTIVE_ACTIVE_SUM_01_U64 = 0;
  body.Body.Data.inverter_abc.channels.PV_ENERGYACTIVE_ACTIVE_SUM_02_U64 = 0;
  body.Body.Data.meter_xyz.channels.SMARTMETER_ENERGYACTIVE_ABSOLUT_MINUS_F64 = 5000;
  const result = await createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(body) })();
  assert.equal(result.solar?.value, 0);
  assert.equal(result.household?.value, -3460);
  for (const timestamp of ['bad', new Date(Date.parse(at) + 6000).toISOString(), new Date(Date.parse(at) - 50_000).toISOString()]) {
    const stale = fixture(); stale.Head.Timestamp = timestamp;
    const value = await createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => Response.json(stale) })();
    assert.equal(value.status, 'offline');
    assert.equal(value.solar, null);
    assert.equal(value.household, null);
  }
});

test('only concurrent requests coalesce and caller mutation cannot alter another result', async () => {
  let calls = 0;
  let resolve!: (value: Response) => void;
  const read = createEnergyCounterReader({ baseUrl: 'http://inverter.test', now: () => new Date(at), fetch: async () => {
    calls++; return new Promise<Response>(done => { resolve = done; });
  } });
  const first = read(), second = read();
  resolve(Response.json(fixture()));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  a.solar!.value = 999;
  assert.equal(b.solar!.value, 300);
  const third = read(); resolve(Response.json(fixture())); await third;
  assert.equal(calls, 2);
});

test('the dedicated controller counter endpoint performs read-only monitoring without issuing a control command', async () => {
  let counters = 0, writes = 0;
  const value = { status: 'online' as const, error: null, solar: { at, value: 300, source: 'inverter_abc' }, household: null };
  const inverter = { initialize: async () => {}, disconnect: async () => {},
    getEnergyCounters: async () => { counters++; return value; },
    setBatteryMode: async () => { writes++; },
  } as unknown as FroniusInverter;
  const battery = { initialize: async () => {}, cleanup: async () => {} } as unknown as Battery;
  const api = createApi({ settings: config, createInverter: () => inverter, createBattery: () => battery });
  const response = await api.app.request('/system/energy-counters');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), value);
  assert.equal(counters, 1); assert.equal(writes, 0);
  assert.equal((await api.app.request('/system/energy-counters', { method: 'POST' })).status, 404);
  await api.shutdown();
});
