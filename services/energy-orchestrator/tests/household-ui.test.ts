import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/household.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const events = new Map<string, () => void>(), clicks = new Map<string, () => void>();
  const element = () => ({ textContent: '', hidden: false, disabled: false,
    addEventListener(name: string, handler: () => void) { clicks.set(name, handler); } });
  const button = element(), status = element(), error = element();
  const nodes = new Map([['household-train', button], ['household-training-status', status], ['household-training-error', error]]);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requests: Array<{ method: string; resolve: (value: Response) => void }> = [];
  const updates: string[] = [];
  const document = { hidden: false, getElementById: (id: string) => nodes.get(id),
    addEventListener: (name: string, handler: () => void) => events.set(name, handler) };
  let timerId = 0;
  vm.runInNewContext(script, { document, Intl, Date, AbortSignal, Event, window: { dispatchEvent(event: Event) { updates.push(event.type); } },
    fetch: (url: string, options: { method: string }) => {
      assert.equal(url, '/api/household/training');
      return new Promise<Response>(resolve => requests.push({ method: options.method, resolve }));
    },
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const complete = async (body: unknown, httpStatus = 200) => { requests.at(-1)!.resolve(Response.json(body, { status: httpStatus })); await tick(); };
  const fire = (delay: number) => { const entry = [...timers].find(([, t]) => t.delay === delay); assert.ok(entry);
    timers.delete(entry[0]); entry[1].callback(); };
  return { button, status, error, document, events, requests, timers, complete, fire, updates, click: () => clicks.get('click')!() };
}

test('manual training sends one POST, shows progress and polls status without retriggering training', async () => {
  const b = browser(); assert.equal(b.requests[0].method, 'GET');
  await b.complete({ state: 'idle', lastTrainedAt: '2026-10-27T11:00:00Z', training: { completeSamplingDays: 21 }, weatherStatus: 'insufficient_history' });
  assert.match(b.status.textContent, /21 jours complets/); assert.equal(b.button.disabled, false);
  b.click(); b.click(); assert.equal(b.requests.length, 2); assert.equal(b.requests[1].method, 'POST');
  assert.equal(b.button.disabled, true);
  await b.complete({ state: 'training', accepted: true });
  assert.match(b.status.textContent, /en cours/);
  b.fire(2000); assert.equal(b.requests[2].method, 'GET');
  await b.complete({ state: 'idle', lastTrainedAt: '2026-10-27T11:05:00Z', training: { completeSamplingDays: 22 }, weatherStatus: 'calibrated' });
  assert.equal(b.button.disabled, false); assert.match(b.status.textContent, /correction météo apprise/);
  assert.equal(b.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(b.updates, ['household-forecast-updated'], 'completed training refreshes the selected history chart');
});

test('training errors remain visible and retryable; hidden pages pause status polling', async () => {
  const b = browser(); await b.complete({ error: 'indisponible' }, 503);
  assert.equal(b.error.hidden, false); assert.equal(b.button.disabled, false);
  b.document.hidden = true; b.events.get('visibilitychange')!(); assert.equal(b.timers.size, 0);
  b.document.hidden = false; b.events.get('visibilitychange')!(); assert.equal(b.requests.length, 2);
  await b.complete({ state: 'error', error: 'Échec de l’apprentissage.' });
  assert.equal(b.error.textContent, 'Échec de l’apprentissage.'); assert.equal(b.button.disabled, false);
});
