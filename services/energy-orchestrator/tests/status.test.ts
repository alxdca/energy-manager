import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryReader, resolveControllerUrl } from '../src/status.js';

const timestamp = '2026-01-15T12:00:00.000Z';
const now = () => new Date(timestamp);
const payload = (overrides = {}) => ({
  success: true, timestamp,
  site: { P_PV: 8500, P_Load: -2300, P_Grid: -1200, P_Akku: -5000 },
  battery: { socPercent: 60, validValues: ['soc'], capacityKwh: 82, currentChargeKwh: 49.2 },
  grid: { currentConsumptionKw: 999, currentFeedInKw: 888 },
  ...overrides,
});
const fake = (body: unknown): typeof fetch => async () => Response.json(body);

test('normalizes signed raw watts and verified SOC, ignoring legacy fields', async () => {
  const read = createTelemetryReader({ now, fetch: fake(payload()), controllerUrl: 'http://controller:3001/' });
  assert.deepEqual(await read(), {
    status: 'online', observedAt: timestamp, error: null,
    solarKw: 8.5, householdKw: 2.3, gridImportKw: 0, gridExportKw: 1.2,
    batterySocPercent: 60, batteryChargeKw: 5, batteryDischargeKw: 0,
  });
  const importAndDischarge = await createTelemetryReader({ now, fetch: fake(payload({ site: { P_Grid: 1234, P_Akku: 2000 } })) })();
  assert.equal(importAndDischarge.gridImportKw, 1.234);
  assert.equal(importAndDischarge.gridExportKw, 0);
  assert.equal(importAndDischarge.batteryDischargeKw, 2);
  assert.equal(importAndDischarge.batteryChargeKw, 0);
});

test('missing, invalid, unverified values stay null while genuine zero stays zero', async () => {
  for (const site of [{}, { P_PV: null, P_Load: '0', P_Grid: '10', P_Akku: null }, { P_PV: -1, P_Load: 1, P_Grid: Infinity, P_Akku: NaN }]) {
    const result = await createTelemetryReader({ now, fetch: fake(payload({ site, battery: { socPercent: 101, validValues: ['soc'] } })) })();
    for (const field of ['solarKw', 'householdKw', 'gridImportKw', 'gridExportKw', 'batteryChargeKw', 'batteryDischargeKw', 'batterySocPercent'] as const) {
      assert.equal(result[field], null, field);
    }
  }
  for (const battery of [{ socPercent: 50 }, { socPercent: 50, validValues: [] }, { socPercent: -1, validValues: ['soc'] }, { socPercent: '50', validValues: ['soc'] }]) {
    assert.equal((await createTelemetryReader({ now, fetch: fake(payload({ battery })) })()).batterySocPercent, null);
  }
  const zero = await createTelemetryReader({ now, fetch: fake(payload({ site: { P_PV: 0, P_Load: 0, P_Grid: 0, P_Akku: 0 }, battery: { socPercent: 0, validValues: ['soc'] } })) })();
  assert.equal(zero.solarKw, 0);
  assert.equal(zero.householdKw, 0);
  assert.equal(zero.gridImportKw, 0);
  assert.equal(zero.batterySocPercent, 0);
});

test('simultaneous telemetry reads share one GET; sequential reads fetch fresh values immediately', async () => {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = createTelemetryReader({ now, controllerUrl: 'http://controller:3001', fetch: async (input, init) => {
    count++;
    assert.equal(String(input), 'http://controller:3001/system/status');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal instanceof AbortSignal);
    await gate;
    return Response.json(payload({ site: { P_PV: count * 1000 } }));
  } });
  const requests = [read(), read(), read()];
  release();
  const observations = await Promise.all(requests);
  assert.equal(count, 1);
  assert.ok(observations.every(value => value.solarKw === 1));
  assert.equal((await read()).solarKw, 2);
  assert.equal(count, 2);
  assert.equal((await read()).solarKw, 3);
  assert.equal(count, 3);
});

test('failures retain previous observations only as stale and recover on next refresh', async () => {
  let clock = now();
  let fails = false;
  const read = createTelemetryReader({ now: () => clock, fetch: async () => {
    if (fails) throw new Error('Controller <html>secret upstream response</html>');
    return Response.json(payload({ timestamp: clock.toISOString() }));
  } });
  assert.equal((await read()).status, 'online');
  fails = true;
  const stale = await read();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.observedAt, timestamp);
  assert.equal(stale.solarKw, 8.5);
  assert.equal(stale.error, 'L’état du contrôleur est indisponible');
  fails = false;
  assert.equal((await read()).status, 'online');
});

test('old observations are stale even when a fresh fetch succeeds', async () => {
  let clock = new Date(now().getTime() + 30_000);
  const read = createTelemetryReader({ now: () => clock, fetch: fake(payload()) });
  assert.equal((await read()).status, 'online');
  clock = new Date(clock.getTime() + 1);
  const result = await read();
  assert.equal(result.status, 'stale');
  assert.equal(result.observedAt, timestamp);
});

test('invalid JSON, responses, and timestamps never become current telemetry', async () => {
  const readers = [
    fake(null), fake({ success: false, timestamp }), fake({ success: true, timestamp }),
    fake(payload({ site: '<html>invalid</html>' })), fake(payload({ timestamp: 'today' })),
    fake(payload({ timestamp: '2026-01-15T12:00:05.001Z' })), fake(payload({ timestamp: '2026-13-32T00:00:00Z' })),
    fake(payload({ timestamp: '2025-02-30T00:00:00Z' })),
    async () => new Response('<html>private details</html>'),
    async () => new Response('<html>private details</html>', { status: 503 }),
  ] as typeof fetch[];
  for (const fetch of readers) {
    const result = await createTelemetryReader({ now, fetch })();
    assert.equal(result.status, 'offline');
    assert.equal(result.observedAt, null);
    assert.equal(result.solarKw, null);
    assert.ok(result.error);
    assert.doesNotMatch(result.error!, /html|private/);
  }
});

test('small controller clock skew is tolerated while the original observation time is preserved', async () => {
  const future = '2026-01-15T12:00:05.000Z';
  const result = await createTelemetryReader({ now, fetch: fake(payload({ timestamp: future })) })();
  assert.equal(result.status, 'online');
  assert.equal(result.observedAt, future);
  assert.equal(result.solarKw, 8.5);
});

test('timeouts abort the GET and report offline', async () => {
  let signal: AbortSignal | undefined;
  const result = await createTelemetryReader({ now, fetch: async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } })();
  assert.equal(signal?.aborted, true);
  assert.equal(result.status, 'offline');
  assert.equal(result.error, 'La demande d’état du contrôleur a expiré');
});

test('disabled configuration makes no requests; invalid URLs fail clearly', async () => {
  const fetch: typeof globalThis.fetch = async () => { throw new Error('Must not fetch'); };
  for (const controllerUrl of [null, '']) {
    const result = await createTelemetryReader({ controllerUrl, fetch })();
    assert.equal(result.status, 'not_configured');
    assert.equal(result.observedAt, null);
  }
  for (const controllerUrl of ['file:///etc/passwd', 'ftp://controller', 'not a URL', 'https://user:secret@controller', 'http://controller/?token=secret']) {
    assert.throws(() => createTelemetryReader({ controllerUrl }), /ENERGY_CONTROLLER_URL doit être une URL de base HTTP\(S\)/);
  }
});

test('controller URL uses current configuration and explicit overrides', t => {
  const keys = ['ENERGY_CONTROLLER_URL', 'GEN24_CONTROLLER_URL'] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
  for (const key of keys) delete process.env[key];
  assert.equal(resolveControllerUrl()?.href, 'http://127.0.0.1:3001/');

  process.env.GEN24_CONTROLLER_URL = 'http://legacy:3001';
  assert.equal(resolveControllerUrl()?.href, 'http://127.0.0.1:3001/');
  process.env.ENERGY_CONTROLLER_URL = 'http://energy:3001';
  assert.equal(resolveControllerUrl()?.href, 'http://energy:3001/');
  assert.equal(resolveControllerUrl({ controllerUrl: 'http://explicit:3001' })?.href, 'http://explicit:3001/');
  assert.equal(resolveControllerUrl({ controllerUrl: null }), null);
  assert.equal(resolveControllerUrl({ controllerUrl: '' }), null);

  process.env.ENERGY_CONTROLLER_URL = '';
  assert.equal(resolveControllerUrl(), null, 'An explicitly empty URL disables the connection');
  process.env.ENERGY_CONTROLLER_URL = 'file:///etc/passwd';
  assert.throws(() => resolveControllerUrl(), /ENERGY_CONTROLLER_URL/);
});
