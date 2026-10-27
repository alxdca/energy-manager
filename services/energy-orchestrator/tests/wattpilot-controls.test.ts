import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { createControlsService } from '../src/controls.js';

const timestamp = '2026-10-25T20:00:00.000Z';
const now = () => new Date(timestamp);
const charger = (changes: Record<string, unknown> = {}) => ({
  status: 'online', configured: true, connected: true, ready: true, stale: false,
  observedAt: timestamp, powerObservedAt: timestamp, error: null, controlEnabled: true,
  mode: 'eco', carConnected: true, charging: false, allowedCharging: false,
  currentAmps: 6, powerWatts: 0, sessionEnergyWh: 0, totalEnergyWh: 1000,
  phaseMode: 'auto' as 'auto' | 1 | 3 | null, phaseSwitchingSupported: true,
  limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false, ...changes,
});
type Call = { path: string; method: string; body: unknown; signal?: AbortSignal | null };
function fixture(options: {
  charger?: Record<string, unknown>;
  grid?: Record<string, unknown>;
  respond?: (call: Call) => Response | undefined | Promise<Response | undefined>;
} = {}) {
  const calls: Call[] = [];
  const manualOverrides: boolean[] = [];
  let state = charger(options.charger);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal };
    calls.push(call);
    assert.equal(init?.redirect, 'error');
    const custom = await options.respond?.(call);
    if (custom) return custom;
    if (call.path.endsWith('/wattpilot/status')) return Response.json({ success: true, wattpilot: state });
    if (call.path.endsWith('/wattpilot/set-control')) {
      const command = call.body as { phases?: 1 | 3 };
      state = { ...state, ...call.body as Record<string, unknown>, ...(command.phases === undefined ? {} : { phaseMode: command.phases }) };
      return Response.json({ success: true, wattpilot: state });
    }
    if (call.path.endsWith('/system/status')) return Response.json({ success: true, timestamp,
      site: { P_Grid: 500, P_Akku: 0, P_Load: -500, P_PV: 0 },
      battery: { socPercent: 50, validValues: ['soc'] }, ...options.grid });
    if (call.path.endsWith('/inverter/control-status')) return Response.json({ success: true,
      control: { enabled: true, active: false }, capabilities: { automationCharge: true, automationHold: true },
      limits: { maxPowerWatts: 7000, minSocPercent: 0, maxSocPercent: 90, reserveSocPercent: 5 } });
    return Response.json({ success: true });
  };
  const service = createControlsService({ controllerUrl: 'http://controller.test/base', fetch, now,
    automation: { enabled: () => true, owns: () => false,
      async setManualOverride(value) { manualOverrides.push(value); } },
  });
  const post = (value: unknown, signal?: AbortSignal, device = 'car') => service.api.request(`/${device}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal,
  });
  const writes = () => calls.filter(call => call.method === 'POST');
  return { service, calls, post, writes, manualOverrides, fetch,
    setCharger(changes: Record<string, unknown>) { state = charger(changes); } };
}

test('control reads expose actual Wattpilot state and amperes without any device writes', async () => {
  const f = fixture({ charger: { mode: 'normal', currentAmps: 10, charging: true, powerWatts: 4200 } });
  const result = await (await f.service.api.request('/')).json();
  assert.equal(result.car.available, true);
  assert.equal(result.car.canPause, true);
  assert.equal(result.car.mode, 'normal');
  assert.equal(result.car.currentAmps, 10);
  assert.equal(result.car.powerKw, 4.2);
  assert.equal(result.wattpilot.status, 'online');
  assert.equal(f.writes().length, 0);
});

test('manual car modes forward amperes after fresh charger and site checks, independently of Tesla and battery override', async () => {
  for (const mode of ['normal', 'eco']) {
    const f = fixture();
    const response = await f.post({ mode, currentAmps: 10 });
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.map(call => [call.path, call.method]), [
      ['/base/wattpilot/status', 'GET'], ['/base/system/status', 'GET'], ['/base/inverter/control-status', 'GET'], ['/base/wattpilot/set-control', 'POST'],
    ]);
    assert.deepEqual(f.writes()[0]!.body, { mode, currentAmps: 10 });
    assert.deepEqual(f.manualOverrides, []);
  }
});

test('manual phase selection passes through with controller confirmation without changing site checks', async () => {
  for (const phases of [1, 3] as const) {
    const f = fixture();
    const response = await f.post({ mode: 'normal', currentAmps: 6, phases });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.car.phaseMode, phases);
    assert.deepEqual(f.writes()[0]!.body, { mode: 'normal', currentAmps: 6, phases });
  }
});

test('phase settings never reduce headroom reservation without physical transition verification', async () => {
  for (const phaseMode of ['auto', 1, 3]) {
    const f = fixture({ charger: { phaseMode }, grid: { site: { P_Grid: 12_000, P_Akku: 0, P_Load: -12000 } } });
    assert.equal((await f.post({ mode: 'normal', currentAmps: 6, phases: 1 })).status, 409);
    assert.equal(f.writes().length, 0);
  }
  const battery = fixture({ charger: { phaseMode: 1, mode: 'normal', currentAmps: 10 },
    grid: { site: { P_Grid: 4000, P_Akku: 0, P_Load: -4000 } } });
  assert.equal((await battery.post({ mode: 'manual', powerKw: 6 }, undefined, 'battery')).status, 409);
  assert.equal(battery.writes().length, 0);
});

test('pause needs no GEN24 telemetry, vehicle presence or known cable limit', async () => {
  const f = fixture({ charger: { carConnected: false, limits: { minCurrentAmps: 6, maxCurrentAmps: null } },
    respond: call => call.path.includes('/system/') ? Response.json({}, { status: 503 }) : undefined });
  assert.equal((await f.post({ mode: 'pause' })).status, 200);
  assert.deepEqual(f.writes()[0]!.body, { mode: 'pause' });
  assert.equal(f.calls.some(call => call.path.includes('/system/') || call.path.includes('/inverter/')), false);
});

test('new car starts require a fresh enabled charger, connected vehicle and effective current ceiling', async () => {
  for (const changed of [
    { controlEnabled: false }, { carConnected: false }, { carConnected: null },
    { status: 'stale', ready: false, stale: true }, { observedAt: '2026-10-25T19:59:00.000Z' },
    { limits: { minCurrentAmps: 6, maxCurrentAmps: null } },
  ]) {
    const f = fixture({ charger: changed });
    assert.equal((await f.post({ mode: 'normal', currentAmps: 6 })).status, 503);
    assert.equal(f.writes().length, 0);
    assert.equal(f.calls.some(call => call.path.endsWith('/system/status')), false);
  }
  const f = fixture({ charger: { limits: { minCurrentAmps: 6, maxCurrentAmps: 8 } } });
  assert.equal((await f.post({ mode: 'normal', currentAmps: 10 })).status, 400);
  assert.equal(f.writes().length, 0);
});

test('manual car starts reserve conservative three-phase headroom including current home-battery discharge', async () => {
  for (const site of [{ P_Grid: 12_000, P_Akku: 0, P_Load: -12000 }, { P_Grid: 10_000, P_Akku: 2000, P_Load: -12000 }]) {
    const f = fixture({ grid: { site } });
    assert.equal((await f.post({ mode: 'normal', currentAmps: 6 })).status, 409);
    assert.equal(f.writes().length, 0);
  }
  const f = fixture({ grid: { site: { P_Grid: 10_000, P_Akku: -6000, P_Load: -4000 } } });
  assert.equal((await f.post({ mode: 'normal', currentAmps: 6 })).status, 200);
});

test('existing measured car load is credited only when synchronized with the site reading', async () => {
  const f = fixture({ charger: { powerWatts: 4000 }, grid: { site: { P_Grid: 14_000, P_Akku: 0, P_Load: -14000 } } });
  assert.equal((await f.post({ mode: 'normal', currentAmps: 6 })).status, 200);
  const old = fixture({ charger: { powerWatts: 4000, powerObservedAt: '2026-10-25T19:59:50.000Z' },
    grid: { site: { P_Grid: 14_000, P_Akku: 0, P_Load: -14000 } } });
  assert.equal((await old.post({ mode: 'normal', currentAmps: 6 })).status, 409);
  assert.equal(old.writes().length, 0);
});

test('missing, malformed, stale and future grid readings never start a new car charge', async () => {
  for (const grid of [{ site: {} }, { timestamp: 'invalid' }, { timestamp: '2026-10-25T19:59:00.000Z' },
    { timestamp: '2026-10-25T20:01:00.000Z' }, { timestamp: '2026-02-30T20:00:00.000Z' }]) {
    const f = fixture({ grid });
    assert.equal((await f.post({ mode: 'normal', currentAmps: 6 })).status, 503);
    assert.equal(f.writes().length, 0);
  }
});

test('the site mutation lock blocks battery commands during car preflight and releases after completion', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ respond: async call => {
    if (call.path.endsWith('/system/status')) { entered(); await gate; }
    return undefined;
  } });
  const pending = f.post({ mode: 'normal', currentAmps: 6 });
  await ready;
  assert.equal((await f.post({ mode: 'manual', powerKw: 3 }, undefined, 'battery')).status, 409);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(f.writes().length, 1);
});

test('cancellation during the site preflight prevents any later charger write', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ respond: async call => {
    if (call.path.endsWith('/system/status')) { entered(); await gate; }
    return undefined;
  } });
  const controller = new AbortController();
  const pending = f.post({ mode: 'normal', currentAmps: 6 }, controller.signal);
  await ready;
  controller.abort(); release();
  assert.equal((await pending).status, 409);
  assert.equal(f.writes().length, 0);
});

test('unknown write outcomes propagate without retries or losing the site mutation lock', async () => {
  const f = fixture({ respond: call => call.method === 'POST'
    ? Response.json({ error: 'private upstream text', outcome: 'unknown' }, { status: 503 }) : undefined });
  const response = await f.post({ mode: 'normal', currentAmps: 6 });
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.outcome, 'unknown');
  assert.doesNotMatch(result.error, /private/);
  assert.equal(f.writes().length, 1);
  await f.service.api.request('/');
  assert.equal(f.writes().length, 1);
});

test('snapshot reports online Wattpilot independently of failed GEN24 without issuing writes', async () => {
  const f = fixture({ respond: call => call.path.includes('/system/') || call.path.includes('/inverter/')
    ? Response.json({}, { status: 503 }) : undefined });
  const api = createApi({ controllerUrl: 'http://controller.test/base', fetch: f.fetch, now,
    forecast: { config: null }, tesla: { tokensPath: null, vin: '' } });
  const result = await (await api.request('/api/status')).json();
  assert.equal(result.wattpilot.status, 'online');
  assert.equal(result.integrations.wattpilot, 'online');
  assert.equal(result.telemetry.status, 'offline');
  assert.equal(result.car.status, 'not_configured');
  assert.equal(f.writes().length, 0);
});

test('battery charging reserves the car current while its measured power is still ramping', async () => {
  for (const mode of ['normal', 'eco']) {
    const f = fixture({ charger: { mode, currentAmps: 10, powerWatts: 0 }, grid: { site: { P_Grid: 4000, P_Akku: 0, P_Load: -4000 } } });
    assert.equal((await f.post({ mode: 'manual', powerKw: 6 }, undefined, 'battery')).status, 409);
    assert.equal(f.writes().length, 0);
    await assert.rejects(f.service.automationController.charge('test-owner', 70, '2026-10-25T20:10:00.000Z', () => true), /16 kW/);
    assert.equal(f.writes().length, 0);
  }
});

test('battery preflight credits synchronized actual car consumption and requires a known charger state', async () => {
  const f = fixture({ charger: { mode: 'normal', currentAmps: 10, powerWatts: 7000 },
    grid: { site: { P_Grid: 8000, P_Akku: 0, P_Load: -8000 } } });
  assert.equal((await f.post({ mode: 'manual', powerKw: 6 }, undefined, 'battery')).status, 200);
  for (const changed of [{ status: 'stale', ready: false, stale: true }, { mode: 'unknown' },
    { currentAmps: null }, { carConnected: null }]) {
    const bad = fixture({ charger: changed });
    assert.equal((await bad.post({ mode: 'manual', powerKw: 3 }, undefined, 'battery')).status, 503);
    assert.equal(bad.writes().length, 0);
  }
});

test('car starts reserve an active battery target while measured battery power ramps', async () => {
  for (const [gridWatts, batteryWatts] of [[4000, 0], [7000, -3000], [10_000, -6000]]) {
    const f = fixture({ grid: { site: { P_Grid: gridWatts, P_Akku: batteryWatts, P_Load: -Math.max(0, gridWatts + batteryWatts) } }, respond: call =>
      call.path.endsWith('/inverter/control-status') ? Response.json({ success: true,
        control: { enabled: true, active: true, watts: 6000 } }) : undefined });
    assert.equal((await f.post({ mode: 'normal', currentAmps: 10 })).status, 409);
    assert.equal(f.writes().length, 0);
  }
});

test('car preflight never double counts already measured battery charging and rejects unknown active target', async () => {
  const good = fixture({ grid: { site: { P_Grid: 7000, P_Akku: -6000, P_Load: -1000 } }, respond: call =>
    call.path.endsWith('/inverter/control-status') ? Response.json({ success: true,
      control: { enabled: true, active: true, watts: 6000 } }) : undefined });
  assert.equal((await good.post({ mode: 'normal', currentAmps: 10 })).status, 200);
  const bad = fixture({ respond: call => call.path.endsWith('/inverter/control-status')
    ? Response.json({ success: true, control: { enabled: true, active: true } }) : undefined });
  assert.equal((await bad.post({ mode: 'normal', currentAmps: 6 })).status, 503);
  assert.equal(bad.writes().length, 0);
});
