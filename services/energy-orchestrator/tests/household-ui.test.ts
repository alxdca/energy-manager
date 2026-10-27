import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderPage } from '../src/pages.js';

const script = readFileSync(new URL('../public/household.js', import.meta.url), 'utf8');
const html = await renderPage('apprentissage');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const events = new Map<string, () => void>(), clicks = new Map<string, () => void>();
  const element = () => ({ textContent: '', hidden: false, disabled: false,
    addEventListener(name: string, handler: () => void) { clicks.set(name, handler); } });
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  const button = nodes.get('household-train')!, status = nodes.get('household-training-status')!, error = nodes.get('household-training-error')!;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requests: Array<{ method: string; resolve: (value: Response) => void }> = [];
  const updates: string[] = [];
  const forecastRequests: string[] = [];
  let forecast: unknown = null, forecastFails = false;
  let now = Date.parse('2026-10-27T11:00:00Z');
  class RuntimeDate extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  }
  const document = { hidden: false, getElementById: (id: string) => nodes.get(id),
    addEventListener: (name: string, handler: () => void) => events.set(name, handler) };
  let timerId = 0;
  vm.runInNewContext(script, { document, Intl, Date: RuntimeDate, AbortSignal, Event, window: { dispatchEvent(event: Event) { updates.push(event.type); } },
    fetch: (url: string, options: { method: string }) => {
      if (url.startsWith('/api/household/forecast?date=')) {
        forecastRequests.push(url);
        return Promise.resolve(Response.json({ forecast }, { status: forecastFails ? 503 : 200 }));
      }
      assert.equal(url, '/api/household/training');
      return new Promise<Response>(resolve => requests.push({ method: options.method, resolve }));
    },
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const complete = async (body: unknown, httpStatus = 200) => { requests.at(-1)!.resolve(Response.json(body, { status: httpStatus })); await tick(); };
  const fire = (delay: number) => { const entry = [...timers].find(([, t]) => t.delay === delay); assert.ok(entry);
    timers.delete(entry[0]); entry[1].callback(); };
  return { button, status, error, document, events, requests, timers, complete, fire, updates, forecastRequests,
    get: (id: string) => { assert.ok(nodes.has(id)); return nodes.get(id)!; },
    setForecast: (value: unknown, fails = false) => { forecast = value; forecastFails = fails; },
    setTime: (value: string) => { now = Date.parse(value); }, click: () => clicks.get('click')!() };
}

test('manual training sends one POST, shows progress and polls status without retriggering training', async () => {
  const b = browser(); assert.equal(b.requests[0].method, 'GET');
  await b.complete({ state: 'idle', lastTrainedAt: '2026-10-27T11:00:00Z', training: { completeSamplingDays: 21 }, weatherStatus: 'insufficient_history' });
  assert.equal(b.get('learning-complete-days').textContent, '21'); assert.equal(b.button.disabled, false);
  assert.doesNotMatch(b.status.textContent, /correction météo en attente/);
  b.click(); b.click(); assert.equal(b.requests.length, 2); assert.equal(b.requests[1].method, 'POST');
  assert.equal(b.button.disabled, true);
  await b.complete({ state: 'training', accepted: true });
  assert.match(b.status.textContent, /en cours/);
  b.fire(2000); assert.equal(b.requests[2].method, 'GET');
  await b.complete({ state: 'idle', lastTrainedAt: '2026-10-27T11:05:00Z', training: { completeSamplingDays: 22 }, weatherStatus: 'calibrated' });
  assert.equal(b.button.disabled, false); assert.match(b.status.textContent, /correction météo apprise/);
  assert.equal(b.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(b.updates, ['household-forecast-updated']);
});

test('training errors remain visible and retryable; hidden pages pause status polling', async () => {
  const b = browser(); await b.complete({ error: 'indisponible' }, 503);
  assert.equal(b.error.hidden, false); assert.equal(b.button.disabled, false);
  b.document.hidden = true; b.events.get('visibilitychange')!(); assert.equal(b.timers.size, 0);
  b.document.hidden = false; b.events.get('visibilitychange')!(); assert.equal(b.requests.length, 2);
  await b.complete({ state: 'error', error: 'Échec de l’apprentissage.' });
  assert.equal(b.error.textContent, 'Échec de l’apprentissage.'); assert.equal(b.button.disabled, false);
});

test('learning settings use runtime values and absent metrics stay unknown while valid zeros are shown', async () => {
  const b = browser();
  await b.complete({ state: 'idle', training: null, settings: { automaticTraining: 'daily', historyDays: 84,
    halfLifeDays: 14, stepMinutes: 15, weekdayFactor: 4, minimumCompleteDays: 14, minimumMatchingWeekdays: 4,
    minimumWeatherDays: 42, fallback: { windowHours: 48, baselinePowerW: 0 } } });
  assert.equal(b.get('learning-frequency').textContent, 'Chaque jour · Zurich');
  assert.equal(b.get('learning-fallback-window').textContent, '48 h');
  assert.equal(b.get('learning-fallback-power').textContent, '0 W');
  assert.equal(b.get('learning-observations').textContent, '—');
  assert.equal(b.get('learning-weather-threshold').textContent, '—');
  assert.equal(b.get('learning-forecast-learned').textContent, '—');
  assert.equal(b.get('learning-forecast-kwh').textContent, '—');
  b.fire(30000);
  await b.complete({ state: 'idle', training: { usableDays: 0, completeSamplingDays: 0, observations: 0, weatherDays: 0 } });
  assert.equal(b.get('learning-observations').textContent, '0');
  assert.equal(b.get('learning-state').textContent, 'En attente de mesures');
  assert.match(b.status.textContent, /Aucune mesure maison hors recharge voiture/);
});

test('saved forecast coverage distinguishes learned and fallback slots and clears failed reads', async () => {
  const b = browser();
  b.setForecast({ date: '2026-10-27', issuedAt: '2026-10-27T11:00:00Z', status: 'fallback', estimatedConsumptionKwh: 0,
    slots: [{ source: 'learned_profile' }, { source: 'recent_average' }],
    fallback: { source: 'recent_average', averagePowerW: 0, samples: 4 } });
  await b.complete({ state: 'idle' });
  assert.equal(b.get('learning-forecast-learned').textContent, '1 / 2');
  assert.equal(b.get('learning-forecast-fallback').textContent, '1 / 2');
  assert.equal(b.get('learning-forecast-source').textContent, 'Moyenne récente');
  assert.equal(b.get('learning-forecast-kwh').textContent, '0 kWh');
  assert.equal(b.get('learning-forecast-average').textContent, '0 W');
  b.setForecast(null, true); b.fire(30000); await b.complete({ state: 'idle' });
  assert.equal(b.get('learning-forecast-learned').textContent, '—');
  assert.equal(b.get('learning-forecast-kwh').textContent, '—');
  assert.match(b.get('learning-forecast-status').textContent, /indisponible/);
});

test('forecast reads follow Zurich midnight and refuse a saved forecast for a different date', async () => {
  const b = browser();
  b.setTime('2026-10-27T23:05:00Z');
  b.setForecast({ date: '2026-10-27', slots: [], estimatedConsumptionKwh: 20 });
  await b.complete({ state: 'idle' });
  assert.deepEqual(b.forecastRequests, ['/api/household/forecast?date=2026-10-28']);
  assert.equal(b.get('learning-forecast-kwh').textContent, '—');
});
