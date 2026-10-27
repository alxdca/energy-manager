import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeslaService } from '../src/tesla.js';

const origin = Date.parse('2026-10-25T22:05:00Z');
const vin = '5YJ3E1EA7KF000001';
const products = { response: [{ vin, display_name: 'Model 3' }] };
const summary = (state: string) => ({ response: { state } });
const auth = { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 };
type Reply = unknown | (() => unknown);

async function fixture(replies: Reply[], sleepHook?: (ms: number, signal: AbortSignal) => Promise<void>) {
  let clock = origin;
  const calls: Array<{ url: string; method: string }> = [];
  const sleeps: number[] = [];
  const data = () => ({ response: { charge_state: { battery_level: 40, charge_limit_soc: 80,
    charging_state: 'Stopped', timestamp: clock } } });
  const queue: Reply[] = [auth, products, summary('asleep'), ...replies];
  const service = createTeslaService({ tokensPath: null, vin: '', now: () => new Date(clock),
    sleep: async (ms, signal) => { sleeps.push(ms); if (sleepHook) await sleepHook(ms, signal); clock += ms; },
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), method: init.method ?? 'GET' });
      assert.equal(init.redirect, 'error');
      assert.ok(queue.length, 'Unexpected Tesla request');
      let reply = queue.shift();
      if (typeof reply === 'function') reply = reply();
      if (reply === 'charge') reply = data();
      return reply instanceof Response ? reply : Response.json(reply);
    },
  });
  await service.connect('initial-refresh');
  await service.refresh();
  return { service, calls, sleeps, advance(ms: number) { clock += ms; } };
}

test('explicit charging refresh sends one wake and verifies a new original charge-state observation', async () => {
  const f = await fixture([products, summary('asleep'), summary('online'), summary('asleep'), summary('online'), 'charge']);
  const first = f.service.refreshForCharging();
  const second = f.service.refreshForCharging();
  const [car, shared] = await Promise.all([first, second]);
  assert.equal(car.status, 'online');
  assert.equal(car.socPercent, 40);
  assert.deepEqual(car, shared);
  assert.equal(car.observedAt, new Date(origin + 4300).toISOString());
  assert.deepEqual(f.sleeps, [2000, 2300]);
  assert.equal(f.calls.filter(call => call.url.endsWith('/wake_up')).length, 1);
  assert.equal(f.calls.find(call => call.url.endsWith('/wake_up'))!.method, 'POST');
  assert.equal(f.calls.at(-1)!.url, `https://owner-api.teslamotors.com/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_state`);
  await f.service.readStatus(); await f.service.refresh();
  assert.equal(f.calls.filter(call => call.url.endsWith('/wake_up')).length, 1);
  await f.service.stop();
});

test('wake acknowledgement and online summary cannot turn stale charge-state data into fresh SOC', async () => {
  const f = await fixture([products, summary('asleep'), summary('online'), summary('online'),
    { response: { charge_state: { battery_level: 40, charge_limit_soc: 80, charging_state: 'Stopped', timestamp: origin - 700_000 } } }]);
  const car = await f.service.refreshForCharging();
  assert.equal(car.status, 'stale');
  assert.equal(car.observedAt, new Date(origin - 700_000).toISOString());
  assert.equal(f.calls.filter(call => call.url.endsWith('/wake_up')).length, 1);
  await f.service.stop();
});

test('denied wake preserves a sanitized authentication failure and never repeats the POST', async () => {
  const f = await fixture([products, summary('asleep'), Response.json({ error: 'private-access' }, { status: 403 })]);
  const car = await f.service.refreshForCharging();
  assert.equal(car.status, 'auth_required');
  assert.doesNotMatch(JSON.stringify(car), /private-access/);
  const count = f.calls.length;
  f.advance(3_600_000);
  await f.service.refreshForCharging();
  assert.equal(f.calls.length, count);
  await f.service.stop();
});

test('rate-limited wake honors Retry-After beyond the fifteen-minute cooldown', async () => {
  const f = await fixture([products, summary('asleep'), Response.json({}, { status: 429, headers: { 'retry-after': '1800' } })]);
  assert.equal((await f.service.refreshForCharging()).status, 'error');
  const count = f.calls.length;
  f.advance(900_000);
  await f.service.refreshForCharging();
  assert.equal(f.calls.length, count);
  await f.service.stop();
});

test('a sleeping vehicle reaches a bounded deadline without a wake storm', async () => {
  const f = await fixture([products, summary('asleep'), summary('asleep'), ...Array.from({ length: 20 }, () => summary('asleep'))]);
  const car = await f.service.refreshForCharging();
  assert.equal(car.status, 'asleep');
  assert.match(car.error!, /expiré/);
  assert.equal(f.sleeps.reduce((sum, value) => sum + value, 0), 60_000);
  assert.equal(f.calls.filter(call => call.url.endsWith('/wake_up')).length, 1);
  const count = f.calls.length;
  await f.service.refreshForCharging();
  assert.equal(f.calls.length, count);
  await f.service.stop();
});

test('cancellation during wake polling prevents later reads and leaves status reads passive', async () => {
  let entered!: () => void;
  const polling = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture([products, summary('asleep'), summary('online')], async (_ms, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const controller = new AbortController();
  const pending = f.service.refreshForCharging(controller.signal);
  await polling;
  controller.abort();
  await assert.rejects(pending, /annulée/);
  const count = f.calls.length;
  await f.service.readStatus();
  assert.equal(f.calls.length, count);
  await f.service.stop();
});

test('shutdown interrupts an in-flight wake without waiting for its sixty-second budget', async () => {
  let entered!: () => void;
  const polling = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture([products, summary('asleep'), summary('online')], async (_ms, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const pending = f.service.refreshForCharging();
  await polling;
  await f.service.stop();
  await assert.rejects(pending, /annulée/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/wake_up')).length, 1);
});
