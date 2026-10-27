import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast } from '../src/forecast.js';
import { predictHousehold, trainHouseholdModel, householdDaySlots } from '../src/household-model.js';

const script = readFileSync(new URL('../public/forecast.js', import.meta.url), 'utf8');
const decimal = (value: number) => value.toLocaleString('fr-CH', { maximumFractionDigits: 1 });
const integer = (value: number) => value.toLocaleString('fr-CH', { maximumFractionDigits: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const panelIds = ['solar-forecast', 'forecast-date', 'forecast-energy', 'forecast-location', 'forecast-updated', 'forecast-status', 'forecast-consumption'];

class Element {
  textContent = '';
  className = '';
  hidden = false;
  dataset: Record<string, string> = {};
}

function browser(options: { deviceOnly?: boolean; absent?: boolean; hidden?: boolean; page?: string; mobile?: boolean; both?: boolean; now?: string } = {}) {
  const ids = options.absent ? [] : options.deviceOnly ? ['weather-state']
    : options.both ? [...panelIds.map(id => `today-${id}`), ...panelIds] : panelIds;
  const elements = new Map(ids.map(id => [id, new Element()]));
  const events = new Map<string, () => void>();
  const mediaEvents = new Map<string, () => void>();
  const media = {
    matches: !options.mobile,
    addEventListener: (name: string, handler: () => void) => mediaEvents.set(name, handler),
  };
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const requests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void; signal: AbortSignal; url: string }> = [];
  let timerId = 0;
  const document = {
    body: { dataset: { page: options.page ?? (options.deviceOnly ? 'appareils' : 'accueil') } },
    hidden: options.hidden ?? false,
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
  };
  let now = Date.parse(options.now ?? '2026-10-23T12:00:00Z');
  const RuntimeDate = class extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  };
  vm.runInNewContext(script, {
    document, Intl, Date: RuntimeDate, AbortController,
    window: { matchMedia(query: string) { assert.equal(query, '(min-width: 701px)'); return media; } },
    setTimeout(callback: () => void, milliseconds: number) { timers.set(++timerId, { callback, milliseconds }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(url: string, options: { signal: AbortSignal; cache: string }) {
      assert.ok(['/api/forecast', '/api/forecast/today'].includes(url));
      assert.equal(options.cache, 'no-store');
      return new Promise<Response>((resolve, reject) => requests.push({ resolve, reject, signal: options.signal, url }));
    },
  });
  const get = (id: string) => {
    const element = elements.get(id);
    assert.ok(element, `Missing element ${id}`);
    return element;
  };
  const complete = async (body: unknown, index = requests.length - 1, status = 200) => {
    requests[index].resolve(Response.json(body, { status }));
    await tick();
  };
  const fireTimer = (milliseconds: number) => {
    const entry = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
    assert.ok(entry, `Missing ${milliseconds}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  const resize = (desktop: boolean) => {
    media.matches = desktop;
    mediaEvents.get('change')?.();
  };
  return { document, elements, events, requests, timers, get, complete, fireTimer, resize,
    advance: (milliseconds: number) => { now += milliseconds; } };
}

function forecast(overrides: Record<string, unknown> = {}) {
  return {
    status: 'online', date: '2026-10-25', locationName: 'Installation de démonstration', estimatedProductionKwh: 12.6,
    weatherCode: 80, temperatureMinC: 7, temperatureMaxC: 14,
    fetchedAt: '2026-10-24T10:00:00Z', source: 'Open-Meteo', ...overrides,
  };
}

test('forecast renders production, weather and distinct Zurich refresh times for the quarter-hour batch and solar', async () => {
  const b = browser();
  await b.complete(forecast({ estimates: { calculatedAt: '2026-10-24T10:15:00Z' } }));
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
  assert.equal(b.get('forecast-date').textContent, 'dim. 25 oct.');
  assert.equal(b.get('forecast-updated').textContent, 'Bilan : 12:15 · Solaire : 12:00');
  assert.equal(b.get('forecast-location').textContent, 'Installation de démonstration');
  assert.equal(b.get('forecast-status').textContent, 'Averses - 7–14 °C');
  assert.equal(b.get('solar-forecast').dataset.state, 'online');
  b.fireTimer(10000);
  await b.complete(forecast({ estimates: { calculatedAt: '2026-10-24T10:30:00Z' } }));
  assert.equal(b.get('forecast-updated').textContent, 'Bilan : 12:30 · Solaire : 12:00');
});

test('real zero remains visible while missing or invalid energy clears the estimate', async () => {
  const b = browser();
  await b.complete(forecast({ estimatedProductionKwh: 0, weatherCode: null, temperatureMinC: null, temperatureMaxC: null }));
  assert.equal(b.get('forecast-energy').textContent, '≈ 0');
  assert.equal(b.get('forecast-status').textContent, 'Météo indisponible');
  for (const value of [null, -1, '12', undefined]) {
    b.fireTimer(10000);
    await b.complete(forecast({ estimatedProductionKwh: value }));
    assert.equal(b.get('forecast-energy').textContent, '—');
    assert.equal(b.get('forecast-status').textContent, 'Indisponible');
  }
});

test('stale energy retains a visible warning and offline data clears previous values', async () => {
  const b = browser();
  await b.complete(forecast({ status: 'stale' }));
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
  assert.equal(b.get('forecast-status').textContent, 'Averses - 7–14 °C · À actualiser');
  assert.equal(b.get('solar-forecast').dataset.state, 'stale');
  b.fireTimer(10000);
  await b.complete(forecast({ status: 'offline' }));
  assert.equal(b.get('forecast-energy').textContent, '—');
  assert.equal(b.get('forecast-status').textContent, 'Indisponible');
  assert.equal(b.get('forecast-updated').textContent, 'Bilan : — · Solaire : —');
  assert.equal(b.get('forecast-date').textContent, '');
});

test('malformed payloads, invalid dates, HTTP failures and missing configuration have explicit states', async () => {
  const b = browser();
  for (const value of [null, [], {}, forecast({ status: 'unexpected' }), forecast({ date: '2026-02-30' }), forecast({ date: 'tomorrow' })]) {
    await b.complete(value);
    assert.equal(b.get('forecast-energy').textContent, '—');
    assert.equal(b.get('solar-forecast').dataset.state, 'offline');
    b.fireTimer(10000);
  }
  await b.complete({}, undefined, 503);
  assert.equal(b.get('forecast-status').textContent, 'Indisponible');
  b.fireTimer(10000);
  await b.complete(forecast({ status: 'not_configured' }));
  assert.equal(b.get('forecast-status').textContent, 'Localisation à définir');
  assert.equal(b.get('forecast-energy').textContent, '—');
});

test('requests are serialized, retry five seconds after completion and time out after eight seconds', async () => {
  const b = browser();
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  assert.equal([...b.timers.values()].some(timer => timer.milliseconds === 10000), false);
  b.fireTimer(8000);
  await tick();
  assert.equal(b.requests[0].signal.aborted, true);
  assert.equal(b.get('forecast-status').textContent, 'Indisponible');
  b.fireTimer(10000);
  assert.equal(b.requests.length, 2);
  await b.complete(forecast());
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`, 'A late timed-out result must not overwrite the current forecast');
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1);
});

test('hidden pages pause polling and request fresh data when visible again', async () => {
  const b = browser({ hidden: true });
  assert.equal(b.requests.length, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests[0].signal.aborted, true);
  await b.complete(forecast());
  assert.equal(b.get('forecast-energy').textContent, '', 'Hidden request must not render');
  assert.equal(b.timers.size, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(forecast());
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.timers.size, 0);
});

test('mobile home does not poll and desktop resume fetches a fresh forecast', async () => {
  const b = browser({ page: 'accueil', mobile: true });
  assert.equal(b.requests.length, 0);
  assert.equal(b.timers.size, 0);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 0);
  b.resize(true);
  assert.equal(b.requests.length, 1);
  b.resize(true);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1, 'Repeated activation must not overlap requests');
  await b.complete(forecast());
  b.resize(false);
  assert.equal(b.timers.size, 0, 'Hidden home must cancel scheduled polling');
  b.resize(true);
  assert.equal(b.requests.length, 2);
  await b.complete(forecast({ estimatedProductionKwh: 4 }));
  assert.equal(b.get('forecast-energy').textContent, '≈ 4');
});

test('desktop home aborts hidden reads and ignores late success or failure after resizing', async () => {
  const b = browser({ page: 'accueil' });
  b.resize(false);
  assert.equal(b.requests[0].signal.aborted, true);
  assert.equal(b.timers.size, 0);
  b.resize(true);
  assert.equal(b.requests.length, 2);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  assert.equal(b.get('forecast-energy').textContent, '');
  assert.equal([...b.timers.values()].some(timer => timer.milliseconds === 10000), false);
  await b.complete(forecast({ estimatedProductionKwh: 5 }), 1);
  assert.equal(b.get('forecast-energy').textContent, '≈ 5');
  b.fireTimer(10000);
  b.resize(false);
  b.resize(true);
  await b.complete(forecast({ estimatedProductionKwh: 7 }), 3);
  b.requests[2].reject(new Error('Delayed aborted request'));
  await tick();
  assert.equal(b.get('forecast-energy').textContent, '≈ 7');
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1);
});

test('home forecast requires both desktop width and a visible document to resume', async () => {
  const b = browser({ page: 'accueil', hidden: true });
  b.resize(false);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 0);
  b.document.hidden = true;
  b.resize(true);
  assert.equal(b.requests.length, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests[0].signal.aborted, true);
  assert.equal(b.timers.size, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(forecast(), 1);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  assert.equal(b.get('forecast-energy').textContent, '≈ 12,6');
});

test('Appareils continues polling on mobile', async () => {
  const b = browser({ mobile: true, deviceOnly: true });
  assert.equal(b.requests.length, 1);
  await b.complete(forecast());
  b.fireTimer(10000);
  assert.equal(b.requests.length, 2);
  await b.complete(forecast());
  assert.equal(b.get('weather-state').textContent, 'Connectée');
});

test('Appareils updates only its weather connection and other pages never poll', async () => {
  const absent = browser({ absent: true });
  assert.equal(absent.requests.length, 0);
  assert.equal(absent.events.size, 0);
  const b = browser({ deviceOnly: true });
  for (const [status, label, className] of [
    ['online', 'Connectée', 'connection-state online'],
    ['stale', 'Ancienne', 'connection-state warning'],
    ['offline', 'Indisponible', 'connection-state'],
    ['not_configured', 'Non configurée', 'connection-state'],
  ]) {
    await b.complete(forecast({ status }));
    assert.equal(b.get('weather-state').textContent, label);
    assert.equal(b.get('weather-state').className, className);
    b.fireTimer(10000);
  }
});

test('unknown weather, partial temperatures and invalid update times do not invent data; location is plain text', async () => {
  const b = browser();
  await b.complete(forecast({ locationName: '<img src=x onerror=alert(1)>', weatherCode: 100, temperatureMinC: null,
    fetchedAt: 'invalid', estimates: { calculatedAt: '2026-10-24T10:15:00Z' } }));
  assert.equal(b.get('forecast-location').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(b.get('forecast-status').textContent, 'Météo indisponible');
  assert.equal(b.get('forecast-updated').textContent, 'Bilan : 12:15 · Solaire : —');
  b.fireTimer(10000);
  await b.complete(forecast({ estimates: { calculatedAt: 'invalid' } }));
  assert.equal(b.get('forecast-updated').textContent, 'Bilan : — · Solaire : 12:00');
});

const consumption = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-10-25', source: 'configured_baseline', excludesCar: true,
  estimatedConsumptionKwh: 12.5,
  ...overrides,
});

test('configured household consumption shows one rounded daily estimate', async () => {
  const b = browser();
  await b.complete(forecast({ consumption: consumption() }));
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(12.5)}`);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
});

test('consumption remains available independently of missing solar or weather configuration', async () => {
  const b = browser();
  for (const status of ['offline', 'not_configured']) {
    await b.complete(forecast({ status, estimatedProductionKwh: null, consumption: consumption() }));
    assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(12.5)}`);
    assert.equal(b.get('forecast-energy').textContent, '—');
    assert.equal(b.get('forecast-date').textContent, 'dim. 25 oct.');
    assert.equal(b.get('forecast-status').textContent, status === 'offline' ? 'Solaire indisponible' : 'Solaire à configurer');
    b.fireTimer(10000);
  }
});

test('missing, malformed or wrong-date consumption never invents a zero or changes solar', async () => {
  const b = browser();
  for (const value of [undefined, null, {}, consumption({ date: '2026-10-26' }),
    consumption({ estimatedConsumptionKwh: null }), consumption({ estimatedConsumptionKwh: '12.5' }),
    consumption({ estimatedConsumptionKwh: -1 }), consumption({ estimatedConsumptionKwh: Infinity }),
    consumption({ estimatedConsumptionKwh: NaN }), consumption({ source: 'measured' }), consumption({ excludesCar: false })]) {
    await b.complete(forecast({ consumption: value }));
    assert.equal(b.get('forecast-consumption').textContent, '—');
    assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
    b.fireTimer(10000);
  }
});

test('real zero consumption is valid and a transport failure clears old configured estimates', async () => {
  const b = browser();
  await b.complete(forecast({ consumption: consumption({ estimatedConsumptionKwh: 0 }) }));
  assert.equal(b.get('forecast-consumption').textContent, '≈ 0');
  b.fireTimer(10000);
  await b.complete({}, undefined, 503);
  assert.equal(b.get('forecast-consumption').textContent, '—');
  assert.equal(b.get('forecast-date').textContent, '');
});


test('baseline consumption remains available regardless of solar weather status', async () => {
  const b = browser();
  for (const status of ['online', 'stale', 'offline', 'not_configured'] as const) {
    await b.complete(forecast({ status, consumption: consumption() }));
    assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(12.5)}`);
    b.fireTimer(10000);
  }
  await b.complete({}, undefined, 503);
  assert.equal(b.get('forecast-consumption').textContent, '—');
});


test('daily production keeps its available decimal regardless of the selected model', async () => {
  const b = browser();
  await b.complete(forecast({ estimatedProductionKwh: 3.14, weatherModel: 'meteoswiss_icon_ch2' }));
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(3.14)}`);
  b.fireTimer(10000);
  await b.complete(forecast({ estimatedProductionKwh: 0.04, weatherModel: 'best_match' }));
  assert.equal(b.get('forecast-energy').textContent, '≈ 0');
  b.fireTimer(10000);
  await b.complete(forecast({ status: 'offline', estimatedProductionKwh: null }));
  assert.equal(b.get('forecast-energy').textContent, '—');
});

test('today and tomorrow render separate full-day production and consumption estimates', async () => {
  const b = browser({ both: true });
  assert.deepEqual(b.requests.map(request => request.url), ['/api/forecast/today', '/api/forecast']);
  await b.complete(forecast({ date: '2026-10-24', estimatedProductionKwh: 18.3, weatherCode: 61, temperatureMinC: 6, temperatureMaxC: 12,
    consumption: consumption({ date: '2026-10-24', estimatedConsumptionKwh: 29 }) }), 0);
  await b.complete(forecast({ estimatedProductionKwh: 3.5, consumption: consumption() }), 1);
  assert.equal(b.get('today-forecast-energy').textContent, `≈ ${decimal(18.3)}`);
  assert.equal(b.get('today-forecast-consumption').textContent, `≈ ${integer(29.0)}`);
  assert.equal(b.get('today-forecast-date').textContent, 'sam. 24 oct.');
  assert.equal(b.get('today-forecast-status').textContent, 'Pluie - 6–12 °C');
  assert.equal(b.get('forecast-status').textContent, 'Averses - 7–14 °C');
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(3.5)}`);
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(12.5)}`);
  assert.equal(b.get('forecast-date').textContent, 'dim. 25 oct.');
});

test('each card isolates transport failure, timeout, retries and late completions', async () => {
  const b = browser({ both: true });
  await b.complete(forecast({ consumption: consumption() }), 1);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
  b.fireTimer(8000);
  await tick();
  assert.equal(b.requests[0].signal.aborted, true);
  assert.equal(b.get('today-forecast-status').textContent, 'Indisponible');
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(12.5)}`);
  b.fireTimer(10000);
  assert.equal(b.requests[2].url, '/api/forecast');
  b.fireTimer(10000);
  assert.equal(b.requests[3].url, '/api/forecast/today');
  await b.complete(forecast({ date: '2026-10-24', estimatedProductionKwh: 5 }), 3);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  assert.equal(b.get('today-forecast-energy').textContent, `≈ ${decimal(5.0)}`);
  await b.complete({}, 2, 503);
  assert.equal(b.get('forecast-energy').textContent, '—');
  assert.equal(b.get('today-forecast-energy').textContent, `≈ ${decimal(5.0)}`);
});

test('desktop home hides both readers on mobile and rejects their late results after resize', async () => {
  const b = browser({ both: true, page: 'accueil', mobile: true });
  assert.equal(b.requests.length, 0);
  b.resize(true);
  assert.equal(b.requests.length, 2);
  b.resize(true);
  assert.equal(b.requests.length, 2);
  b.resize(false);
  assert.ok(b.requests.every(request => request.signal.aborted));
  assert.equal(b.timers.size, 0);
  b.resize(true);
  assert.equal(b.requests.length, 4);
  await b.complete(forecast({ date: '2026-10-24', estimatedProductionKwh: 8 }), 2);
  await b.complete(forecast({ estimatedProductionKwh: 9 }), 3);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  b.requests[1].reject(new Error('Late hidden failure'));
  await tick();
  assert.equal(b.get('today-forecast-energy').textContent, '≈ 8');
  assert.equal(b.get('forecast-energy').textContent, '≈ 9');
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 2);
});

test('document visibility pauses both readers and reloads both independently', async () => {
  const b = browser({ both: true, hidden: true });
  assert.equal(b.requests.length, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.ok(b.requests.every(request => request.signal.aborted));
  assert.equal(b.timers.size, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  await b.complete(forecast({ date: '2026-10-24', estimatedProductionKwh: 7 }), 2);
  await b.complete(forecast({ estimatedProductionKwh: 8 }), 3);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 0);
  await b.complete(forecast({ estimatedProductionKwh: 99 }), 1);
  assert.equal(b.get('today-forecast-energy').textContent, `≈ ${decimal(7.0)}`);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(8.0)}`);
});

test('today uses the same zero, stale, source and fallback validation as tomorrow', async () => {
  const b = browser({ both: true });
  await b.complete(forecast({ date: '2026-10-24', status: 'stale', estimatedProductionKwh: 0,
    consumption: consumption({ date: '2026-10-24' }) }), 0);
  assert.equal(b.get('today-forecast-energy').textContent, '≈ 0');
  assert.equal(b.get('today-forecast-status').textContent, 'Averses - 7–14 °C · À actualiser');
  b.fireTimer(10000);
  await b.complete(forecast({ date: '2026-10-24', status: 'offline', estimatedProductionKwh: null,
    consumption: consumption({ date: '2026-10-24' }) }), 2);
  assert.equal(b.get('today-forecast-energy').textContent, '—');
  assert.equal(b.get('today-forecast-consumption').textContent, `≈ ${integer(12.5)}`);
  b.fireTimer(10000);
  await b.complete(forecast({ date: '2026-10-24', consumption: consumption({ date: '2026-10-24', source: 'measured' }) }), 3);
  assert.equal(b.get('today-forecast-consumption').textContent, '—');
});

test('Appareils never fetches today and shared markup identifies the published forecasts', async () => {
  const b = browser({ deviceOnly: true });
  assert.deepEqual(b.requests.map(request => request.url), ['/api/forecast']);
  await b.complete(forecast());
  b.fireTimer(10000);
  assert.ok(b.requests.every(request => request.url === '/api/forecast'));
  const markup = readFileSync(new URL('../public/pages/forecast.html', import.meta.url), 'utf8');
  assert.ok(markup.indexOf('id="today-solar-forecast"') < markup.indexOf('id="solar-forecast"'));
  assert.match(markup, /id="today-forecast-heading">Aujourd’hui /);
  assert.match(markup, /id="forecast-heading">Demain /);
  assert.match(markup, /Production prévue/);
  assert.equal((markup.match(/Production estimée/g) ?? []).length, 1);
  assert.match(markup, /Consommation prévue/);
  assert.equal((markup.match(/Consommation estimée/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /Solaire et météo|Open-Meteo|ICON-CH2|CC BY|estimation dérivée|forecast-consumption-source|forecast-weather-model/);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [...panelIds, ...panelIds.map(id => `today-${id}`)]) assert.ok(ids.includes(id));
  assert.doesNotMatch(markup, /Actualisation|Auto inactive|GEN24 connecté/);
});

function hourlyForecast(date = '2026-10-25', start = '2026-10-24T22:00:00Z', count = 25) {
  const hourly = Array.from({ length: count }, (_, index) => ({
    start: new Date(Date.parse(start) + index * 3600000).toISOString(),
    end: new Date(Date.parse(start) + (index + 1) * 3600000).toISOString(),
    estimatedProductionKwh: index >= 9 && index < 17 ? 1 : 0,
    temperatureC: 10,
  }));
  const demand = hourly.map((hour, index) => ({
    start: hour.start, end: hour.end, estimatedConsumptionKwh: .5 + index / 100,
    temperatureC: 10,
  }));
  return { ...forecast(),
    date, hourly, estimatedProductionKwh: 8,
    consumption: consumption({ date, hourly: demand, hourlyMethod: 'baseline_only',
      estimatedConsumptionKwh: demand.reduce((sum, row) => sum + row.estimatedConsumptionKwh, 0) }),
  };
}

test('incomplete, unsorted, wrong-day and inconsistent series never masquerade as known daily energy', async () => {
  const b = browser();
  const valid = hourlyForecast();
  const original = valid.hourly as Array<Record<string, unknown>>;
  const invalid = [
    original.slice(1),
    [...original.slice(0, 3), ...original.slice(4)],
    [original[1], original[0], ...original.slice(2)],
    original.map((row, index) => index === 0 ? { ...row, estimatedProductionKwh: -1 } : row),
    original.map((row, index) => index === 0 ? { ...row, start: '2026-10-25T00:00:00Z' } : row),
    original.map(row => ({ ...row, estimatedProductionKwh: 10 })),
  ];
  for (const hourly of invalid) {
    await b.complete({ ...valid, hourly, consumption: null });
    assert.equal(b.get('forecast-energy').textContent, '—');
    b.fireTimer(10000);
  }
});

test('forecast keeps a ten-second start cadence after two-second reads and bounds overruns', async () => {
  const b = browser();
  b.advance(2000);
  await b.complete(forecast());
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 8000).length, 1);
  b.advance(8000);
  b.fireTimer(8000);
  assert.equal(b.requests.length, 2);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2, 'An in-flight read cannot overlap');
  b.advance(11000);
  await b.complete(forecast());
  b.fireTimer(1000);
  assert.equal(b.requests.length, 3, 'Overruns wait at least one second before retrying');
  b.advance(2000);
  b.advance(-60000);
  await b.complete(forecast());
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1,
    'A backward wall-clock correction cannot postpone polling beyond ten seconds');
});


function futureSource(date = '2026-10-24') {
  const house = estimateConsumption(date, { baselinePowerW: 1000 });
  const hourly = house.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 6, temperatureC: 10 }));
  return { ...emptySolarForecast(date, null), status: 'online' as const, fetchedAt: '2026-10-24T10:00:00.000Z',
    estimatedProductionKwh: hourly.length * 6, hourly,
    quarterHourly: hourly.flatMap(hour => [0, 1, 2, 3].map((energy, index) => ({
      start: new Date(Date.parse(hour.start) + index * 900000).toISOString(),
      end: new Date(Date.parse(hour.start) + (index + 1) * 900000).toISOString(), estimatedProductionKwh: energy, temperatureC: 10,
    }))),
    consumption: { ...house, quarterHourly: house.hourly.flatMap(hour => [0, .1, .3, .6].map((energy, index) => ({
      start: new Date(Date.parse(hour.start) + index * 900000).toISOString(),
      end: new Date(Date.parse(hour.start) + (index + 1) * 900000).toISOString(), estimatedConsumptionKwh: energy,
    }))) },
  };
}

// Test payloads model the committed database horizon, including its full first clock hour.
function committedForecast(source: ReturnType<typeof futureSource>, at: Date) {
  const start = Date.parse(source.hourly[0].start), end = Date.parse(source.hourly.at(-1)!.end);
  const from = Math.max(start, Math.min(end, Math.floor(at.getTime() / 3600000) * 3600000));
  const quarterHourly = source.quarterHourly.filter(point => Date.parse(point.start) >= from);
  const houseQuarters = source.consumption.quarterHourly.filter(point => Date.parse(point.start) >= from);
  const hourly = source.hourly.filter(hour => Date.parse(hour.end) > from).map(hour => {
    const quarters = quarterHourly.filter(point => point.start >= hour.start && point.end <= hour.end);
    return { ...hour, start: quarters[0].start,
      estimatedProductionKwh: quarters.reduce((sum, point) => sum + point.estimatedProductionKwh, 0) };
  });
  const houseHours = source.consumption.hourly.filter(hour => Date.parse(hour.end) > from).map(hour => {
    const quarters = houseQuarters.filter(point => point.start >= hour.start && point.end <= hour.end);
    return { ...hour, start: quarters[0].start,
      estimatedConsumptionKwh: quarters.reduce((sum, point) => sum + point.estimatedConsumptionKwh, 0) };
  });
  const consumptionKwh = houseQuarters.reduce((sum, point) => sum + point.estimatedConsumptionKwh, 0);
  return { ...source, hourly, quarterHourly,
    estimatedProductionKwh: quarterHourly.reduce((sum, point) => sum + point.estimatedProductionKwh, 0),
    forecastPeriod: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), from: new Date(from).toISOString() },
    consumption: { ...source.consumption, hourly: houseHours, quarterHourly: houseQuarters,
      estimatedConsumptionKwh: consumptionKwh, baselineKwh: consumptionKwh } };
}

test('the same committed forecast keeps its displayed energy when browser time advances', async () => {
  const at = '2026-10-24T12:22:30Z';
  const b = browser({ now: at });
  const value = committedForecast(futureSource(), new Date(at));
  await b.complete(value);
  const energy = b.get('forecast-energy').textContent;
  const consumption = b.get('forecast-consumption').textContent;
  b.advance(60 * 60_000);
  b.fireTimer(10000);
  await b.complete(value);
  assert.equal(b.get('forecast-energy').textContent, energy);
  assert.equal(b.get('forecast-consumption').textContent, consumption);
});

test('a saved daily total does not change when the browser crosses Zurich midnight', async () => {
  const b = browser({ now: '2026-10-24T21:59:59Z' });
  const payload = forecast();
  await b.complete(payload);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
  b.advance(2000);
  b.fireTimer(10000);
  await b.complete(payload);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(12.6)}`);
});

test('a new committed batch replaces forecast quarters while the same batch remains unchanged', async () => {
  const at = '2026-10-24T12:22:30Z';
  const b = browser({ now: at });
  const value = committedForecast(futureSource(), new Date(at));
  await b.complete(value);
  b.advance(30 * 60_000);
  b.fireTimer(10000);
  await b.complete(value);
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(60.0)}`);
  b.fireTimer(10000);
  await b.complete(committedForecast(futureSource(), new Date('2026-10-24T12:52:30Z')));
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(60.0)}`);
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(10.0)}`);
  b.advance(7.5 * 60_000);
  b.fireTimer(10000);
  await b.complete(committedForecast(futureSource(), new Date('2026-10-24T13:00:00Z')));
  assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(54.0)}`);
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(9.0)}`);
});

test('remaining windows reject missing hours, malformed quarter coverage and inconsistent totals', async () => {
  const at = '2026-10-24T12:22:30Z';
  const value = committedForecast(futureSource(), new Date(at));
  const changes: Array<(data: typeof value) => void> = [
    data => { data.hourly!.splice(1, 1); },
    data => { data.hourly!.reverse(); },
    data => { data.quarterHourly!.splice(1, 1); },
    data => { data.quarterHourly![0].estimatedProductionKwh = 999; },
    data => { data.estimatedProductionKwh = 999; },
    data => { data.forecastPeriod.from = '2026-10-24T12:30:00.000Z'; },
  ];
  for (const change of changes) {
    const b = browser({ now: at });
    const data = structuredClone(value); change(data);
    await b.complete(data);
    assert.equal(b.get('forecast-energy').textContent, '—');
    if (data.forecastPeriod.from === value.forecastPeriod.from) {
      assert.notEqual(b.get('forecast-consumption').textContent, '—', 'Valid household predictions remain independent');
    } else {
      assert.equal(b.get('forecast-consumption').textContent, '—', 'Invalid shared coverage cannot validate either prediction');
    }
  }
});



test('full-hour forecasts preserve valid 23/25-hour Zurich calendars in daily totals', async () => {
  for (const [date, at, count] of [['2026-03-29', '2026-03-29T00:30:00Z', 23],
    ['2026-10-25', '2026-10-25T00:30:00Z', 25]] as const) {
    const b = browser({ now: at });
    const source = futureSource(date);
    assert.equal(source.hourly.length, count);
    const value = committedForecast(source, new Date(at));
    await b.complete(value);
    const remaining = (Date.parse(value.forecastPeriod.end) - Date.parse(value.forecastPeriod.from)) / 3600000;
    assert.equal(b.get('forecast-energy').textContent, `≈ ${decimal(remaining * 6)}`);
    assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(remaining)}`);
  }
});

test('learned household totals use their full-day slots independently of solar remaining periods and never fall back to baseline', async () => {
  const at = new Date('2026-10-24T12:00:00Z');
  const observations = householdDaySlots('2026-10-23').map(s => ({ at: new Date(Date.parse(s.end) - 30000).toISOString(), value: 500 }));
  const model = trainHouseholdModel({ id: 'ui', at, observations });
  const householdForecast = predictHousehold({ date: '2026-10-24', at, model });
  const b = browser();
  const source = committedForecast(futureSource(), at);
  await b.complete({ ...source, householdForecast });
  assert.equal(b.get('forecast-consumption').textContent, `≈ ${integer(48)}`);
  b.fireTimer(10000);
  await b.complete({ ...source, householdForecast: null });
  assert.equal(b.get('forecast-consumption').textContent, '—');
  b.fireTimer(10000);
  const invalid = structuredClone(householdForecast); invalid.slots.splice(1, 1);
  await b.complete({ ...source, householdForecast: invalid });
  assert.equal(b.get('forecast-consumption').textContent, '—');
});
