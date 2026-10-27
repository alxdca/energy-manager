import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeslaService } from '../src/tesla.js';
import { createTeslaApi } from '../src/tesla-api.js';
import { createApi } from '../src/api.js';

const instant = Date.parse('2026-10-25T12:00:00Z');
const vin = '5YJ3E1EA7KF000001';
const auth = (extra = {}) => ({ access_token: 'access-secret', refresh_token: 'rotated-secret', expires_in: 3600, ...extra });
const products = { response: [{ vin, display_name: 'Model 3' }] };
const summary = (state = 'online') => ({ response: { state } });
const charge = (extra = {}) => ({ response: { charge_state: { battery_level: 64, charge_limit_soc: 80, charging_state: 'Stopped', timestamp: instant, ...extra } } });

function setup(replies: Array<unknown | Response>, time = instant, tokensPath: string | null = null) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let current = time;
  const service = createTeslaService({ tokensPath, vin: '', now: () => new Date(current), fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.ok(replies.length, `Unexpected Tesla call: ${url}`);
    const reply = replies.shift();
    return reply instanceof Response ? reply : Response.json(reply);
  } });
  return { service, calls, advance: (ms: number) => { current += ms; } };
}
async function connected(replies: Array<unknown | Response>) {
  const s = setup([auth(), products, summary(), charge(), ...replies]);
  await s.service.connect('initial-secret');
  await s.service.refresh();
  return s;
}

test('unconfigured Tesla stays offline without outbound requests', async () => {
  const { service, calls } = setup([]);
  await service.refresh();
  assert.deepEqual(await service.readStatus(), { status: 'not_configured', vehicleName: null, socPercent: null,
    chargeLimitPercent: null, chargingState: null, observedAt: null, error: null });
  assert.equal(calls.length, 0);
});

test('refresh token grants access to charge_state only; dashboard reads never trigger polling', async () => {
  const { service, calls } = await connected([]);
  const car = await service.readStatus();
  assert.equal(car.status, 'online');
  assert.equal(car.socPercent, 64);
  assert.equal(car.observedAt, new Date(instant).toISOString());
  assert.equal(car.chargeLimitPercent, 80);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { grant_type: 'refresh_token', client_id: 'ownerapi',
    scope: 'openid email offline_access', refresh_token: 'initial-secret' });
  assert.equal(calls[3].url, `https://owner-api.teslamotors.com/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_state`);
  for (const call of calls) assert.equal(call.init.redirect, 'error');
  await Promise.all([service.refresh(), service.refresh(), service.readStatus(), service.readStatus()]);
  assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(car).includes('secret'));
});

test('sleeping vehicle retains last dated SOC and never receives data or wake commands', async () => {
  const { service, calls, advance } = await connected([products, summary('asleep')]);
  advance(60_000);
  await service.refresh();
  const car = await service.readStatus();
  assert.equal(car.status, 'asleep');
  assert.equal(car.socPercent, 64);
  assert.equal(car.observedAt, new Date(instant).toISOString());
  assert.equal(car.chargingState, null);
  advance(299_999);
  await service.refresh();
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(1).every(call => call.init.method === 'GET'));
});

test('sleep before the first measurement does not invent SOC', async () => {
  const { service, calls } = setup([auth(), products, summary('asleep')]);
  await service.connect('initial-secret'); await service.refresh();
  assert.equal((await service.readStatus()).socPercent, null);
  assert.equal(calls.length, 3);
});

test('stale data keeps the actual vehicle timestamp; 0 percent is a valid observation', async () => {
  const { service } = setup([auth(), products, summary(), charge({ battery_level: 0, timestamp: instant - 601_000 })]);
  await service.connect('initial-secret'); await service.refresh();
  assert.equal((await service.readStatus()).status, 'stale');
  assert.equal((await service.readStatus()).socPercent, 0);
});

test('readStatus marks cached online measurements stale as time passes', async () => {
  const { service, advance } = await connected([]);
  advance(601_000);
  assert.equal((await service.readStatus()).status, 'stale');
});

test('bad SOC and future timestamps retain the last good measurement as an error', async () => {
  for (const invalid of [{ battery_level: 101 }, { battery_level: '64' }, { timestamp: null }, { timestamp: instant + 90_000 }]) {
    const { service, advance } = await connected([products, summary(), charge(invalid)]);
    advance(60_000); await service.refresh();
    const car = await service.readStatus();
    assert.equal(car.status, 'error');
    assert.equal(car.socPercent, 64);
    assert.equal(car.observedAt, new Date(instant).toISOString());
  }
});

test('multiple cars require an explicit VIN and never silently select the first one', async () => {
  const { service, calls } = setup([auth(), { response: [...products.response, { vin: '5YJ3E1EA7KF000002' }] }]);
  await service.connect('initial-secret'); await service.refresh();
  assert.match((await service.readStatus()).error!, /TESLA_VIN/);
  assert.equal(calls.length, 2);
});

test('one API 401 renews the token and retries without leaking credentials', async () => {
  const { service, advance, calls } = await connected([new Response('', { status: 401 }), auth({ access_token: 'new-access-secret' }), products, summary(), charge()]);
  advance(60_000); await service.refresh();
  assert.equal((await service.readStatus()).status, 'online');
  assert.equal(calls.filter(c => c.url.includes('/token')).length, 2);
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>).authorization, 'Bearer new-access-secret');
});

test('invalid refresh token requires reconnection and stops automatic retries', async () => {
  const { service, advance, calls } = await connected([new Response('', { status: 401 }), Response.json({ error: 'invalid_grant', error_description: 'private-secret' }, { status: 400 })]);
  advance(60_000); await service.refresh();
  assert.equal((await service.readStatus()).status, 'auth_required');
  assert.ok(!JSON.stringify(await service.readStatus()).includes('private-secret'));
  advance(24 * 3600_000); await service.refresh();
  assert.equal(calls.length, 6);
});

test('403 never loops token renewal and response errors are redacted', async () => {
  const { service, advance, calls } = await connected([Response.json({ error: 'Bearer private-secret' }, { status: 403 })]);
  advance(60_000); await service.refresh();
  assert.equal((await service.readStatus()).status, 'auth_required');
  assert.equal(calls.length, 5);
  assert.ok(!JSON.stringify(await service.readStatus()).includes('private-secret'));
});

test('Tesla EXCEEDED_LIMIT 403 backs off for fifteen minutes and automatically recovers', async () => {
  const { service, advance, calls } = await connected([Response.json({ error: 'account disabled: EXCEEDED_LIMIT' }, { status: 403 }), products, summary(), charge({ timestamp: instant + 960_000 })]);
  advance(60_000); await service.refresh();
  assert.equal((await service.readStatus()).status, 'error');
  advance(899_999); await service.refresh(); assert.equal(calls.length, 5);
  advance(1); await service.refresh(); assert.equal(calls.length, 8);
  assert.equal((await service.readStatus()).status, 'online');
});

test('rate limiting respects Retry-After even with frequent dashboard reads', async () => {
  const { service, advance, calls } = await connected([new Response('', { status: 429, headers: { 'Retry-After': '900' } }), products, summary(), charge()]);
  advance(60_000); await service.refresh();
  advance(899_999); await service.refresh();
  assert.equal(calls.length, 5);
  advance(1); await service.refresh();
  assert.equal(calls.length, 8);
});

test('rotated refresh tokens are private, durable, reused after restart, and deleted on disconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-'));
  const path = join(dir, 'tokens.json');
  try {
    // Use the same mock fetch with real persistence.
    const service = createTeslaService({ tokensPath: path, vin: '', now: () => new Date(instant), fetch: async url => {
      if (String(url).includes('/token')) return Response.json(auth());
      return Response.json(String(url).endsWith('/products') ? products : summary('asleep'));
    } });
    await service.connect('initial-secret'); await service.refresh(); await service.stop();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).refreshToken, 'rotated-secret');
    const calls: string[] = [];
    const restarted = createTeslaService({ tokensPath: path, vin: '', now: () => new Date(instant + 3600_000), fetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).includes('/token')) {
        assert.equal(JSON.parse(String(init?.body)).refresh_token, 'rotated-secret');
        return Response.json(auth({ refresh_token: 'second-secret' }));
      }
      return Response.json(String(url).endsWith('/products') ? products : summary('asleep'));
    } });
    await restarted.refresh();
    assert.equal(calls.length, 3);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).refreshToken, 'second-secret');
    await restarted.disconnect();
    assert.equal((await restarted.readStatus()).status, 'not_configured');
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('last charge survives restart and unavailable vehicles with its original date, including zero percent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-charge-'));
  try {
    for (const soc of [0, 64]) {
      const path = join(dir, `tokens-${soc}.json`);
      const first = setup([auth(), products, summary(), charge({ battery_level: soc })], instant, path);
      await first.service.connect('initial-secret'); await first.service.refresh(); await first.service.stop();
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      for (const reply of [summary('asleep'), summary('offline'), new Response('', { status: 503 })]) {
        const restarted = setup([products, reply], instant + 120_000, path);
        const cached = await restarted.service.readStatus();
        assert.equal(cached.status, 'stale');
        assert.equal(cached.socPercent, soc);
        assert.equal(cached.observedAt, new Date(instant).toISOString());
        assert.equal(cached.vehicleName, 'Model 3');
        assert.equal(cached.chargeLimitPercent, 80);
        assert.equal(cached.chargingState, null);
        assert.equal(restarted.calls.length, 0);
        await restarted.service.refresh();
        const unavailable = await restarted.service.readStatus();
        assert.equal(unavailable.status, reply instanceof Response ? 'error' : reply.response.state);
        assert.equal(unavailable.socPercent, soc);
        assert.equal(unavailable.observedAt, cached.observedAt);
        await restarted.service.stop();
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new charge replaces the persisted observation and token renewal preserves it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-charge-'));
  const path = join(dir, 'tokens.json');
  try {
    const first = setup([auth(), products, summary(), charge(), products, summary(),
      charge({ battery_level: 72, timestamp: instant + 60_000 })], instant, path);
    await first.service.connect('initial-secret'); await first.service.refresh();
    first.advance(60_000); await first.service.refresh(); await first.service.stop();
    const renewed = setup([auth(), products, summary('asleep')], instant + 3600_000, path);
    await renewed.service.refresh(); await renewed.service.stop();
    const restarted = setup([], instant + 3600_000, path);
    assert.equal((await restarted.service.readStatus()).socPercent, 72);
    assert.equal((await restarted.service.readStatus()).observedAt, new Date(instant + 60_000).toISOString());
    await restarted.service.disconnect(); await restarted.service.stop();
    const disconnected = setup([], instant + 3600_000, path);
    assert.equal((await disconnected.service.readStatus()).socPercent, null);
    assert.equal((await disconnected.service.readStatus()).status, 'not_configured');
    await disconnected.service.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cached charge is cleared when reconnecting or discovering a different vehicle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-charge-'));
  try {
    for (const reconnect of [true, false]) {
      const path = join(dir, `tokens-${reconnect}.json`);
      const first = setup([auth(), products, summary(), charge()], instant, path);
      await first.service.connect('initial-secret'); await first.service.refresh(); await first.service.stop();
      const otherProducts = { response: [{ vin: '5YJ3E1EA7KF000002', display_name: 'Other Tesla' }] };
      const next = setup([...(reconnect ? [auth()] : []), otherProducts, summary('asleep')], instant, path);
      if (reconnect) await next.service.connect('another-secret');
      await next.service.refresh(); await next.service.stop();
      assert.equal((await next.service.readStatus()).socPercent, null);
      const restarted = setup([], instant, path);
      assert.equal((await restarted.service.readStatus()).socPercent, null);
      await restarted.service.stop();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid cached observations are ignored without invalidating saved credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-charge-'));
  const path = join(dir, 'tokens.json');
  try {
    const first = setup([auth(), products, summary(), charge()], instant, path);
    await first.service.connect('initial-secret'); await first.service.refresh(); await first.service.stop();
    const stored = JSON.parse(await readFile(path, 'utf8'));
    for (const invalid of [null, {}, { ...stored.lastCharge, socPercent: 101 },
      { ...stored.lastCharge, socPercent: '64' }, { ...stored.lastCharge, vin: 'invalid' },
      { ...stored.lastCharge, observedAt: '2026-02-30T12:00:00.000Z' },
      { ...stored.lastCharge, observedAt: new Date(instant + 60_000).toISOString() }]) {
      await writeFile(path, JSON.stringify({ ...stored, lastCharge: invalid }));
      const restarted = setup([products, summary('asleep')], instant, path);
      assert.equal((await restarted.service.readStatus()).socPercent, null);
      await restarted.service.refresh();
      assert.equal((await restarted.service.readStatus()).status, 'asleep');
      assert.equal(restarted.calls.length, 2);
      await restarted.service.stop();
    }
    await writeFile(path, JSON.stringify(stored));
    const otherVin = createTeslaService({ tokensPath: path, vin: '5YJ3E1EA7KF000002', now: () => new Date(instant) });
    assert.equal((await otherVin.readStatus()).socPercent, null);
    await otherVin.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refresh without replacement refresh token keeps the previous token', async () => {
  const { service } = setup([auth({ refresh_token: undefined }), products, summary('offline')]);
  await service.connect('initial-secret'); await service.refresh();
  assert.equal((await service.readStatus()).status, 'offline');
});

test('unexpired persisted tokens are reused for passive and charging reads without renewal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-'));
  try {
    for (const mode of ['passive', 'charging']) {
      const path = join(dir, `${mode}.json`);
      const credentials = { accessToken: 'saved-access-secret', refreshToken: 'saved-refresh-secret', expiresAt: instant + 3600_000 };
      const bytes = JSON.stringify(credentials);
      await writeFile(path, bytes);
      const calls: string[] = [];
      let renewals = 0;
      const service = createTeslaService({ tokensPath: path, vin: '', now: () => new Date(instant),
        authFetch: async () => { renewals++; throw new Error('Unexpired credentials must be reused.'); },
        fetch: async (url, init) => {
          assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer saved-access-secret');
          const endpoint = String(url).endsWith('/products') ? 'products'
            : String(url).includes('/vehicle_data?') ? 'charge' : 'summary';
          calls.push(endpoint);
          return Response.json(endpoint === 'products' ? products : endpoint === 'charge' ? charge() : summary(mode === 'passive' ? 'asleep' : 'online'));
        },
      });
      try {
        if (mode === 'passive') await service.refresh();
        else await service.refreshForCharging();
        assert.equal(renewals, 0);
        assert.deepEqual(calls, mode === 'passive' ? ['products', 'summary'] : ['products', 'summary', 'charge']);
        assert.equal((await service.readStatus()).status, mode === 'passive' ? 'asleep' : 'online');
        const stored = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(stored.accessToken, credentials.accessToken);
        assert.equal(stored.refreshToken, credentials.refreshToken);
        assert.equal(stored.expiresAt, credentials.expiresAt);
        assert.deepEqual(Object.keys(stored).sort(), mode === 'passive'
          ? ['accessToken', 'expiresAt', 'refreshToken'] : ['accessToken', 'expiresAt', 'lastCharge', 'refreshToken']);
        await service.refresh();
        assert.equal(calls.length, mode === 'passive' ? 2 : 3);
        if (mode === 'passive') assert.equal(await readFile(path, 'utf8'), bytes);
      } finally { await service.stop(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt token storage is actionable and never silently overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'energy-tesla-'));
  try {
    const path = join(dir, 'tokens.json'); await writeFile(path, 'private-secret');
    const service = createTeslaService({ tokensPath: path, vin: '' });
    assert.equal((await service.readStatus()).status, 'error');
    assert.ok(!JSON.stringify(await service.readStatus()).includes('private-secret'));
    assert.equal(await readFile(path, 'utf8'), 'private-secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shutdown waits for an ongoing token exchange/save and rejects new mutations', async () => {
  let deliver!: (response: Response) => void;
  const service = createTeslaService({ tokensPath: null, vin: '', fetch: async () => new Promise<Response>(resolve => { deliver = resolve; }) });
  const connection = service.connect('initial-secret');
  await new Promise(resolve => setImmediate(resolve));
  let finished = false;
  const stopping = service.stop().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  deliver(Response.json(auth()));
  await connection; await stopping;
  assert.equal(finished, true);
  await assert.rejects(service.connect('another-secret'), /arrêt/);
  await assert.rejects(service.disconnect(), /arrêt/);
});

test('concurrent refreshes share a collection and disconnect waits without restoring old credentials', async () => {
  let deliver!: (response: Response) => void;
  let calls = 0;
  const service = createTeslaService({ tokensPath: null, vin: '', now: () => new Date(instant), fetch: async url => {
    calls++;
    if (String(url).includes('/token')) return Response.json(auth());
    if (String(url).endsWith('/products')) return new Promise<Response>(resolve => { deliver = resolve; });
    return Response.json(summary('asleep'));
  } });
  await service.connect('initial-secret');
  const refreshes = Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.readStatus()).status, 'connecting');
  assert.equal(calls, 2);
  const disconnecting = service.disconnect();
  deliver(Response.json(products));
  await refreshes; await disconnecting;
  assert.equal((await service.readStatus()).status, 'not_configured');
  assert.equal(calls, 3);
  await service.refresh(); assert.equal(calls, 3);
});

test('connection routes enforce origin, JSON, size and fields before touching Tesla', async () => {
  const { service, calls } = setup([]);
  const api = createTeslaApi(service);
  for (const [headers, body, expected] of [
    [{ 'content-type': 'application/json', origin: 'https://evil.example' }, '{}', 403],
    [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, '{}', 403],
    [{ 'content-type': 'text/plain' }, '{}', 415],
    [{ 'content-type': 'application/json' }, '{', 400],
    [{ 'content-type': 'application/json' }, JSON.stringify({ refreshToken: 'valid-token', password: 'secret' }), 400],
    [{ 'content-type': 'application/json' }, JSON.stringify({ refreshToken: 'bad token' }), 400],
    [{ 'content-type': 'application/json' }, JSON.stringify({ refreshToken: 'x'.repeat(13_000) }), 413],
  ] as const) {
    assert.equal((await api.request('/connect', { method: 'POST', headers, body })).status, expected);
  }
  assert.equal(calls.length, 0);
});

test('Tesla endpoints and status expose no access/refresh tokens; car controls stay disabled', async () => {
  const { service } = await connected([]);
  const api = createApi({ controllerUrl: null, teslaService: service });
  for (const path of ['/api/tesla', '/api/status']) {
    const response = await api.request(path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.ok(!body.includes('secret'));
    assert.ok(!body.includes('refreshToken'));
    assert.ok(!body.includes('accessToken'));
    assert.match(body, /"socPercent":64/);
  }
  const controls = await (await api.request('/api/controls')).json();
  assert.equal(controls.car.available, false);
  assert.equal((await api.request('/data/tesla-tokens.json')).status, 404);
  const disconnected = await api.request('/api/tesla/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(disconnected.status, 200);
  assert.equal((await disconnected.json()).car.status, 'not_configured');
});
