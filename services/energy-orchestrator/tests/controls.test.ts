import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { createTelemetryReader } from '../src/status.js';
import { createControlsService } from '../src/controls.js';
import type { BatteryChargeEstimate } from '../src/charge-estimate.js';
import type { Telemetry } from '../src/status.js';
import { unavailableWattpilot } from '../src/wattpilot.js';

const timestamp = '2026-10-24T12:00:00.000Z';
const now = () => new Date(timestamp);
const control = (overrides = {}) => ({ success: true, control: { enabled: true, active: false }, limits: { maxPowerWatts: 10_000, minSocPercent: 5, maxSocPercent: 95 }, ...overrides });
const status = (overrides = {}) => ({ success: true, timestamp, site: { P_Grid: 5000, P_Akku: 2000, P_Load: -7000 }, ...overrides });
const manual = { mode: 'manual', powerKw: 5, targetSocPercent: 80 };
const auto = { mode: 'auto' };

function publishedEstimateFixture(onWrite?: () => Promise<void>) {
  const origin = Date.parse(timestamp);
  let clock = origin;
  let active = true;
  let telemetryChange: Partial<Telemetry> = {};
  let publicationCalls = 0;
  let published: BatteryChargeEstimate | null = { status: 'available', targetSocPercent: 60,
    estimatedCompletionAt: '2026-10-24T12:30:00.000Z', remainingMinutes: 30, observedAt: timestamp, method: 'soc_trend' };
  const service = createControlsService({ controllerUrl: 'http://controller.test', now: () => new Date(clock),
    readPublishedChargeEstimate(battery) {
      publicationCalls++;
      assert.equal(battery.mode, 'manual');
      assert.equal(battery.powerKw, 3);
      assert.equal(battery.targetSocPercent, 60);
      return published;
    },
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/wattpilot/status')) return Response.json({ success: true, wattpilot: unavailableWattpilot() });
      if (init?.method === 'POST') {
        assert.ok(onWrite, 'Read-only tests must never issue commands');
        await onWrite();
        active = false;
        return Response.json({ success: true });
      }
      assert.equal(init?.method, 'GET');
      return Response.json(control({ control: { enabled: true, active, watts: 3000, targetSocPercent: 60 } }));
    },
  }, async () => ({ status: 'online', observedAt: new Date(clock).toISOString(), error: null,
    solarKw: 0, householdKw: .5, gridImportKw: 3.5, gridExportKw: 0,
    batterySocPercent: 50 + (clock - origin) / 60_000 * .05, batteryChargeKw: 3, batteryDischargeKw: 0, ...telemetryChange }));
  return { service, get published() { return published; }, get publicationCalls() { return publicationCalls; },
    advance(ms: number) { clock += ms; }, setActive(value: boolean) { active = value; },
    setTelemetry(value: Partial<Telemetry>) { telemetryChange = value; },
    setPublished(value: BatteryChargeEstimate | null) { published = value; },
  };
}

test('published charge estimates stay frozen while ordinary status reads continue learning the SOC trend', async () => {
  const f = publishedEstimateFixture();
  for (let seconds = 0; seconds <= 120; seconds += 5) {
    if (seconds > 0) f.advance(5000);
    assert.deepEqual((await f.service.readStatus()).battery.chargeEstimate, f.published);
  }
  const calls = f.publicationCalls;
  const live = (await f.service.readStatus({ liveEstimate: true })).battery.chargeEstimate;
  assert.equal(f.publicationCalls, calls, 'The quarter-hour coordinator bypasses publication');
  assert.equal(live.status, 'available');
  assert.notEqual(live.estimatedCompletionAt, f.published!.estimatedCompletionAt);
  assert.notEqual(live.remainingMinutes, f.published!.remainingMinutes);
  const response = await f.service.api.request('/');
  assert.deepEqual((await response.json()).battery.chargeEstimate, f.published);
});

test('background charge samples publish an ETA without browser reads or a forecast batch', async () => {
  const origin = Date.parse(timestamp);
  let clock = origin;
  let soc = 40;
  let target = 80;
  let stale = false;
  let reads = 0;
  const service = createControlsService({ controllerUrl: 'http://controller.test', now: () => new Date(clock),
    readPublishedChargeEstimate: battery => service.readChargeEstimate(battery),
    fetch: async (input, init) => {
      assert.equal(init?.method, 'GET');
      assert.ok(new URL(String(input)).pathname.endsWith('/control-status'));
      return Response.json(control({ control: { enabled: true, active: true, watts: 6000, targetSocPercent: target } }));
    },
  }, async () => { reads++; return observation(); });
  const observation = (): Telemetry => ({ status: stale ? 'stale' : 'online', observedAt: new Date(clock).toISOString(), error: null,
    solarKw: 0, householdKw: 1, gridImportKw: 7, gridExportKw: 0,
    batterySocPercent: soc, batteryChargeKw: 6, batteryDischargeKw: 0 });
  for (let second = 0; second <= 180; second += 5) {
    clock = origin + second * 1000;
    soc = 40 + Math.floor(second / 90) * .26;
    await service.sampleChargeEstimate(observation());
  }
  assert.equal(reads, 0, 'Sampling reuses the existing background telemetry');
  const estimate = (await service.readStatus({ includeCar: false })).battery.chargeEstimate;
  assert.equal(estimate.status, 'available');
  assert.ok(estimate.remainingMinutes! > 0);
  assert.ok(Date.parse(estimate.estimatedCompletionAt!) > clock);
  assert.equal(estimate.observedAt, new Date(clock).toISOString());

  // The publication updates on another background observation, without a forecast run.
  clock += 5000; soc += .26;
  await service.sampleChargeEstimate(observation());
  assert.notDeepEqual((await service.readStatus({ includeCar: false })).battery.chargeEstimate, estimate);
  clock += 5000; target = 85;
  assert.equal((await service.readStatus({ includeCar: false })).battery.chargeEstimate.status, 'unavailable', 'Changed controls retire the old publication');
  await service.sampleChargeEstimate(observation());
  assert.equal((await service.readStatus({ includeCar: false })).battery.chargeEstimate.status, 'estimating');
  clock += 5000; stale = true;
  await service.sampleChargeEstimate(observation());
  assert.equal((await service.readStatus({ includeCar: false })).battery.chargeEstimate.status, 'unavailable');
});

test('automatic ETA uses the Zurich charging window, independently of technical leases', async () => {
  for (const [at, endsAt, status] of [
    ['2026-10-24T12:00:00Z', '2026-10-24T14:55:00.000Z', 'estimating'],
    ['2026-10-26T12:00:00Z', '2026-10-26T15:55:00.000Z', 'estimating'],
    ['2026-10-25T00:30:00Z', '2026-10-25T05:55:00.000Z', 'estimating'],
    ['2026-10-26T23:30:00Z', '2026-10-27T05:55:00.000Z', 'estimating'],
    ['2026-10-26T15:55:00Z', '2026-10-26T15:55:00.000Z', 'not_charging'],
  ]) {
    const service = createControlsService({ controllerUrl: 'http://controller.test', now: () => new Date(at),
      automation: { enabled: () => true, owns: owner => owner === 'planner', setManualOverride: async () => {} },
      readPublishedChargeEstimate: battery => service.readChargeEstimate(battery),
      fetch: async () => Response.json(control({
        control: { enabled: true, active: true, watts: 6000, targetSocPercent: 80,
          automationOwner: 'planner', automationMode: 'charge', expiresAt: new Date(Date.parse(at) + 16 * 60_000).toISOString() },
        capabilities: { automationCharge: true, automationHold: true },
      })),
    }, async () => ({ status: 'online', observedAt: at, error: null,
      solarKw: 0, householdKw: 1, gridImportKw: 7, gridExportKw: 0,
      batterySocPercent: 40, batteryChargeKw: 6, batteryDischargeKw: 0 }));
    const estimate = (await service.readStatus({ liveEstimate: true, includeCar: false })).battery.chargeEstimate;
    assert.equal(estimate.chargingEndsAt, endsAt, at);
    assert.equal(estimate.status, status, at);
    // At the cutoff a previous publication must not promise a future completion.
    assert.equal((await service.readStatus({ includeCar: false })).battery.chargeEstimate.status,
      status === 'not_charging' ? 'not_charging' : 'unavailable');
  }
});

test('a missing published charge estimate never falls back to the newly learned estimate', async () => {
  const f = publishedEstimateFixture();
  f.setPublished(null);
  for (let seconds = 0; seconds <= 120; seconds += 5) {
    if (seconds > 0) f.advance(5000);
    const estimate = (await f.service.readStatus()).battery.chargeEstimate;
    assert.equal(estimate.status, 'unavailable');
    assert.equal(estimate.estimatedCompletionAt, null);
    assert.equal(estimate.remainingMinutes, null);
  }
  assert.equal((await f.service.readStatus({ liveEstimate: true })).battery.chargeEstimate.status, 'available');
});

test('invalid current control or telemetry clears the publication without replacing it with a live estimate', async () => {
  const f = publishedEstimateFixture();
  assert.equal((await f.service.readStatus()).battery.chargeEstimate.status, 'available');
  const calls = f.publicationCalls;
  for (const invalid of [{ status: 'stale' as const }, { batterySocPercent: null }, { batteryChargeKw: null }]) {
    f.setTelemetry(invalid);
    const estimate = (await f.service.readStatus()).battery.chargeEstimate;
    assert.equal(estimate.status, 'unavailable');
    assert.equal(estimate.estimatedCompletionAt, null);
    assert.equal(f.publicationCalls, calls, 'Invalid observations cannot consult the old publication');
  }
  f.setTelemetry({});
  f.setActive(false); f.advance(5000);
  assert.equal((await f.service.readStatus()).battery.chargeEstimate.status, 'unavailable');
  assert.equal(f.publicationCalls, calls);
});

test('a command in progress invalidates the published estimate before its control acknowledgement', async () => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const f = publishedEstimateFixture(async () => { entered(); await waiting; });
  assert.equal((await f.service.readStatus()).battery.chargeEstimate.status, 'available');
  const calls = f.publicationCalls;
  const command = f.service.api.request('/battery', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(auto) });
  await writing;
  assert.equal((await f.service.readStatus()).battery.chargeEstimate.status, 'unavailable');
  assert.equal(f.publicationCalls, calls);
  release();
  assert.equal((await command).status, 200);
  assert.equal((await f.service.readStatus()).battery.chargeEstimate.status, 'unavailable');
});
interface Call { path: string; method: string; body: unknown; signal: AbortSignal | null | undefined }
function fixture(respond?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const api = createApi({ controllerUrl: 'http://controller:3001/base/', now, fetch: async (input, init) => {
    const call = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal };
    assert.equal(init?.redirect, 'error');
    calls.push(call);
    if (call.path.endsWith('/wattpilot/status')) return Response.json({ success: true, wattpilot: unavailableWattpilot() });
    if (respond) return respond(call);
    return Response.json(call.path.endsWith('/control-status') ? control() : call.path.endsWith('/system/status') ? status() : { success: true });
  } });
  return { api, calls, post: (body: unknown, path = 'battery', headers = {}) => api.request(`/api/controls/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}

test('read-only controls report configured limits and unavailable car without any mutation', async () => {
  const { api, calls } = fixture();
  const response = await api.request('/api/controls');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result.battery, { chargeEstimate: { status: 'unavailable', targetSocPercent: null, estimatedCompletionAt: null, remainingMinutes: null, observedAt: null, method: 'soc_trend' }, available: true, canReturnToAuto: true, mode: 'auto', powerKw: null, targetSocPercent: null, limits: { minPowerKw: 0.1, maxPowerKw: 7, minSocPercent: 5, maxSocPercent: 95 }, error: null });
  assert.equal(result.automationEnabled, false);
  assert.equal(result.car.available, false);
  assert.equal(result.car.canPause, false);
  assert.equal(result.car.mode, 'unknown');
  assert.match(result.car.error, /Wattpilot/);
  await api.request('/api/controls');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls.filter(call => call.path.endsWith('/control-status')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/system/status')).length, 2);
});

test('active zero standby and signed discharge remain manual, rather than claiming auto', async () => {
  for (const watts of [0, -2500, 3000]) {
    const { api } = fixture(() => Response.json(control({ control: { enabled: true, active: true, watts, targetSocPercent: 80 } })));
    const { battery } = await (await api.request('/api/controls')).json();
    assert.equal(battery.mode, 'manual');
    assert.equal(battery.powerKw, watts / 1000);
    assert.equal(battery.targetSocPercent, 80);
  }
});

test('manual status preserves requested power separately from temporary site curtailment', async () => {
  const { api, calls } = fixture(() => Response.json(control({ control: {
    enabled: true, active: true, watts: 0, requestedWatts: 3000, targetSocPercent: 100,
  } })));
  const { battery } = await (await api.request('/api/controls')).json();
  assert.equal(battery.powerKw, 0);
  assert.equal(battery.requestedPowerKw, 3);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('disabled, offline, invalid capabilities and control errors do not become auto', async () => {
  for (const payload of [control({ control: { enabled: false, active: false } }), control({ limits: { maxPowerWatts: null, minSocPercent: 0, maxSocPercent: 100 } }), control({ control: { enabled: true, active: false, error: 'private upstream detail' } }), null]) {
    const { api, post, calls } = fixture(() => Response.json(payload));
    const { battery } = await (await api.request('/api/controls')).json();
    assert.equal(battery.mode, 'unknown');
    const enabled = payload !== null && payload.control.enabled === true;
    assert.equal(battery.available, false);
    assert.equal(battery.canReturnToAuto, enabled);
    assert.ok(battery.error);
    assert.doesNotMatch(battery.error, /private/);
    assert.notEqual((await post(manual)).status, 200);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  }
  const api = createApi({ controllerUrl: null });
  const unconfigured = (await (await api.request('/api/controls')).json()).battery;
  assert.equal(unconfigured.available, false);
  assert.equal(unconfigured.canReturnToAuto, false);
});

test('malformed commands are rejected before contacting the controller', async () => {
  const { post, calls } = fixture();
  for (const invalid of [null, [], {}, { mode: 'wat' }, { mode: ['manual'], powerKw: 5 }, { mode: ['auto'] }, { mode: 'manual', powerKw: '5' }, { mode: 'manual', powerKw: 0 }, { mode: 'manual', powerKw: 7.001 }, { ...manual, targetSocPercent: -1 }, { ...manual, targetSocPercent: 0 }, { ...manual, targetSocPercent: '80' }, { ...manual, targetSocPercent: 101 }, { ...auto, powerKw: 5 }, { ...manual, extra: true }]) {
    assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal(calls.length, 0);
});

test('manual command forwards rounded watts and optional SOC after fresh battery, grid and charger preflights', async () => {
  for (const target of [undefined, null, 80]) {
    const { post, calls } = fixture();
    const response = await post({ mode: 'manual', powerKw: 3.4564, ...(target === undefined ? {} : { targetSocPercent: target }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.deepEqual(calls.map(call => [call.path, call.method]), [['/base/inverter/control-status', 'GET'], ['/base/system/status', 'GET'], ['/base/wattpilot/status', 'GET'], ['/base/inverter/set-charge-power', 'POST']]);
    assert.deepEqual(calls.at(-1)!.body, { powerWatts: 3456, ...(target == null ? {} : { targetSocPercent: target }) });
  }
});

test('fresh effective device power and SOC limits are enforced before a write', async () => {
  const { post, calls } = fixture(() => Response.json(control({ limits: { maxPowerWatts: 4000, minSocPercent: 10, maxSocPercent: 90 } })));
  for (const invalid of [manual, { ...manual, powerKw: 3, targetSocPercent: 10 }, { ...manual, powerKw: 3, targetSocPercent: 91 }]) {
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('replacement headroom uses household load without counting battery charge twice', async () => {
  for (const [grid, battery, requested, expected] of [[12000, -4000, 7, 200], [11000, 3000, 3, 409], [11000, 3000, 2, 200], [-3000, 1000, 7, 200]]) {
    const { post, calls } = fixture(call => Response.json(call.path.endsWith('/control-status') ? control() : call.path.endsWith('/system/status') ? status({ site: { P_Grid: grid, P_Akku: battery, P_Load: -Math.max(0, grid + battery) } }) : { success: true }));
    assert.equal((await post({ mode: 'manual', powerKw: requested })).status, expected);
    assert.equal(calls.filter(call => call.method === 'POST').length, expected === 200 ? 1 : 0);
  }
});

test('manual refuses stale, missing, malformed and far-future raw measurements', async () => {
  const samples = [status({ timestamp: '2026-10-24T11:59:49.999Z' }), status({ timestamp: '2026-10-24T12:00:05.001Z' }), status({ timestamp: '2026-02-30T12:00:00Z' }), status({ timestamp: 'today' }), status({ site: { P_Grid: 1 } }), status({ site: { P_Grid: '1', P_Akku: 0 } }), status({ success: false })];
  for (const payload of samples) {
    const { post, calls } = fixture(call => Response.json(call.path.endsWith('/control-status') ? control() : payload));
    assert.equal((await post(manual)).status, 503);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('auto needs fresh enabled controller but no grid telemetry, and invalidates read cache', async () => {
  let active = true;
  const { api, post, calls } = fixture(call => {
    if (call.method === 'POST') { active = false; return Response.json({ success: true }); }
    return Response.json(control({ control: { enabled: true, active, watts: 5000 } }));
  });
  assert.equal((await (await api.request('/api/controls')).json()).battery.mode, 'manual');
  const beforeAuto = calls.length;
  const response = await post(auto);
  const autoCalls = calls.slice(beforeAuto);
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /fonctionnement normal.*pas encore disponible/);
  assert.equal((await (await api.request('/api/controls')).json()).battery.mode, 'auto');
  assert.equal(autoCalls.some(call => call.path.endsWith('/system/status')), false);
  assert.deepEqual(calls.find(call => call.method === 'POST')?.body, { mode: 'normal' });
});

test('auto can restore normal operation when enabled but charging capabilities are unavailable', async () => {
  const { post, calls } = fixture(call => Response.json(call.method === 'GET' ? { success: true, control: { enabled: true, active: false } } : { success: true }));
  assert.equal((await post(auto)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/base/inverter/set-mode');
});

test('mutation lock includes preflight and protects auto from overlap', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { post, calls } = fixture(async call => {
    if (call.path.endsWith('/control-status')) { started(); await gate; return Response.json(control()); }
    return Response.json(call.path.endsWith('/system/status') ? status() : { success: true });
  });
  const first = post(manual);
  await entered;
  assert.equal((await post(auto)).status, 409);
  assert.equal((await post(manual)).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('JSON content type, body bounds and same-origin protection run before upstream reads', async () => {
  const { api, post, calls } = fixture();
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await post(manual, 'battery', headers)).status, 403);
  assert.equal((await api.request('/api/controls/battery', { method: 'POST', body: JSON.stringify(manual) })).status, 415);
  assert.equal((await api.request('/api/controls/battery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await api.request('/api/controls/battery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(4097) })).status, 413);
  assert.equal(calls.length, 0);
  assert.equal((await post(auto, 'battery', { origin: 'http://localhost' })).status, 200);
});

test('legacy car power/SOC commands are rejected and missing Auto capability stays unavailable without contacting devices', async () => {
  const { post, calls } = fixture();
  assert.equal((await post(auto, 'car')).status, 503);
  for (const body of [{ mode: 'manual', powerKw: 1.4 }, { mode: 'manual', powerKw: 11, targetSocPercent: 60 }]) {
    const response = await post(body, 'car');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /courant/);
  }
  assert.equal((await post({ mode: 'manual', powerKw: 1 }, 'car')).status, 400);
  assert.equal(calls.length, 0);
});

test('ambiguous acknowledgements and network failures never retry commands or leak errors', async () => {
  for (const failure of ['network', 'http', 'json', 'ack']) {
    const { post, calls } = fixture(call => {
      if (call.method !== 'POST') return Response.json(control());
      if (failure === 'network') throw new Error('secret device address');
      if (failure === 'http') return new Response('secret', { status: 503 });
      if (failure === 'json') return new Response('secret');
      return Response.json({ success: false, error: 'secret' });
    });
    const response = await post(auto);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.outcome, 'unknown');
    assert.doesNotMatch(result.error, /secret/);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('write timeout aborts upstream once, reports unknown outcome, and releases mutation lock', async () => {
  let stuck = true;
  const { post, calls } = fixture(call => call.method === 'POST' && stuck ? new Promise<Response>(() => {}) : Response.json(call.method === 'GET' ? control() : { success: true }));
  const response = await post(auto);
  assert.equal(response.status, 504);
  const result = await response.json();
  assert.equal(result.outcome, 'unknown');
  assert.match(result.error, /résultat est inconnu/);
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].signal?.aborted, true);
  stuck = false;
  assert.equal((await post(auto)).status, 200);
});

test('cancelled browser preflight cannot activate a write', async () => {
  const abort = new AbortController();
  const { api, calls } = fixture(() => {
    abort.abort();
    return Response.json(control());
  });
  const response = await api.request(new Request('http://localhost/api/controls/battery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(auto), signal: abort.signal }));
  assert.equal(response.status, 409);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('parallel dashboard reads share one bounded read and cannot issue control writes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { api, calls } = fixture(async () => { await gate; return Response.json(control()); });
  const reads = [api.request('/api/controls'), api.request('/api/controls'), api.request('/api/controls')];
  release();
  for (const response of await Promise.all(reads)) assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls.filter(call => call.path.endsWith('/control-status')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/system/status')).length, 1);
});

test('an activated command is independent of a later browser disconnect', async () => {
  const abort = new AbortController();
  const { api, calls } = fixture(call => {
    if (call.method === 'POST') { abort.abort(); assert.equal(call.signal?.aborted, false); }
    return Response.json(call.method === 'GET' ? control() : { success: true });
  });
  const response = await api.request(new Request('http://localhost/api/controls/battery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(auto), signal: abort.signal }));
  assert.equal(response.status, 200);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});


test('post-command reads replace an older pending generation and old completion cannot clear them', async () => {
  let oldStarted!: () => void;
  let releaseOld!: () => void;
  let freshStarted!: () => void;
  let releaseFresh!: () => void;
  const oldEntered = new Promise<void>(resolve => { oldStarted = resolve; });
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const freshEntered = new Promise<void>(resolve => { freshStarted = resolve; });
  const freshGate = new Promise<void>(resolve => { releaseFresh = resolve; });
  let controlReads = 0;
  const { api, post, calls } = fixture(async call => {
    if (call.path.endsWith('/control-status')) {
      controlReads++;
      if (controlReads === 1) { oldStarted(); await oldGate; return Response.json(control()); }
      if (controlReads === 2) return Response.json(control()); // Uncached mutation preflight.
      freshStarted();
      await freshGate;
      return Response.json(control({ control: { enabled: true, active: true, watts: 5000, targetSocPercent: 80 } }));
    }
    return Response.json(call.path.endsWith('/system/status') ? status() : { success: true });
  });
  const oldRead = api.request('/api/controls');
  await oldEntered;
  assert.equal((await post(manual)).status, 200);
  const freshRead = api.request('/api/controls');
  await freshEntered;
  releaseOld();
  assert.equal((await (await oldRead).json()).battery.mode, 'auto');
  const sharedFreshRead = api.request('/api/controls');
  // The old finally must not discard the current generation's pending read.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controlReads, 3);
  releaseFresh();
  for (const response of await Promise.all([freshRead, sharedFreshRead])) {
    const { battery } = await response.json();
    assert.equal(battery.mode, 'manual');
    assert.equal(battery.powerKw, 5);
  }
  assert.equal((await (await api.request('/api/controls')).json()).battery.mode, 'manual');
  assert.equal(controlReads, 3);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});


test('enabled controller with unusable charging capabilities or state still offers Auto recovery', async () => {
  for (const payload of [
    { success: true, control: { enabled: true, active: false } },
    control({ limits: { maxPowerWatts: null, minSocPercent: 0, maxSocPercent: 100 } }),
    control({ control: { enabled: true, active: 'unknown' } }),
    control({ control: { enabled: true, active: true } }),
  ]) {
    const { api, post, calls } = fixture(call => Response.json(call.method === 'POST' ? { success: true } : payload));
    const { battery } = await (await api.request('/api/controls')).json();
    assert.equal(battery.available, false);
    assert.equal(battery.canReturnToAuto, true);
    assert.equal(battery.mode, 'unknown');
    assert.ok(battery.error);
    assert.equal((await post(manual)).status, 503);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    assert.equal((await post(auto)).status, 200);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('status and control views share one observed-SOC estimate and never issue writes', async () => {
  const origin = new Date('2026-10-24T12:00:00Z');
  let clock = origin;
  let charging = true;
  let target = 60;
  const calls: Array<{ path: string; method: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? 'GET' });
    assert.equal(init?.method, 'GET');
    if (path.endsWith('/control-status')) return Response.json(control({ control: { enabled: true, active: true, watts: 3000, targetSocPercent: target } }));
    if (path === '/wattpilot/status') return Response.json({ success: true });
    assert.equal(path, '/system/status');
    return Response.json({ success: true, timestamp: clock.toISOString(), site: { P_Akku: charging ? -3000 : 0, P_Grid: 3500, P_Load: -500, P_PV: 0 },
      battery: { socPercent: 50 + (clock.getTime() - origin.getTime()) / 60_000 * .05, validValues: ['soc'] } });
  };
  const telemetry = createTelemetryReader({ controllerUrl: 'http://controller.test', now: () => clock, fetch });
  const api = createApi({ controllerUrl: 'http://controller.test', now: () => clock, forecast: { config: null }, fetch,
    telemetryReader: telemetry, displayTelemetryReader: telemetry });
  let last: any;
  for (let seconds = 0; seconds <= 120; seconds += 5) {
    clock = new Date(origin.getTime() + seconds * 1000);
    const [statusResponse, controlResponse] = await Promise.all([api.request('/api/status'), api.request('/api/controls')]);
    const state = await statusResponse.json();
    const controls = await controlResponse.json();
    assert.deepEqual(state.batteryChargeEstimate, controls.battery.chargeEstimate);
    last = state.batteryChargeEstimate;
  }
  assert.equal(last.status, 'available');
  assert.equal(last.targetSocPercent, 60);
  assert.equal(last.remainingMinutes, 200);
  assert.equal(last.estimatedCompletionAt, '2026-10-24T15:22:00.000Z');
  assert.equal(calls.length, 75, 'both views share one telemetry, battery control and charger read per sample');
  clock = new Date(clock.getTime() + 5000);
  target = 70;
  const changed = await (await api.request('/api/controls')).json();
  assert.equal(changed.battery.chargeEstimate.status, 'estimating');
  assert.equal(changed.battery.chargeEstimate.targetSocPercent, 70);
  clock = new Date(clock.getTime() + 5000);
  charging = false;
  const paused = await (await api.request('/api/status')).json();
  assert.equal(paused.batteryChargeEstimate.status, 'not_charging');
  assert.equal(paused.batteryChargeEstimate.estimatedCompletionAt, null);
  assert.ok(calls.every(call => call.method === 'GET'));
});
