import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCalendarDayBounds } from '../src/policy.js';

test('history controls render one joined table, use quarter-hour records directly and apply six-value selection', async t => {
  const ids = [...readFileSync(new URL('../public/pages/history.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  class Element {
    children: Element[] = [];
    listeners = new Map<string, (event?: any) => void>();
    attributes = new Map<string, string>();
    dataset: Record<string, string> = {};
    textContent = ''; className = ''; id = ''; value = ''; max = ''; checked = false; hidden = false; disabled = false;
    rowSpan = 1; colSpan = 1; scope = ''; title = ''; type = ''; name = ''; tabIndex = -1;
    constructor(public tagName: string) {}
    append(...children: Element[]) { this.children.push(...children.flatMap(child => child.tagName === 'fragment' ? child.children : [child])); }
    replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
    addEventListener(name: string, handler: (event?: any) => void) { this.listeners.set(name, handler); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    focus() {}
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
    fire(name: string) { this.listeners.get(name)?.({ preventDefault() {} }); }
  }
  const elements = new Map(ids.map(id => [id, new Element('div')]));
  elements.set('local-date', new Element('span')); elements.set('local-time', new Element('span'));
  const get = (name: string) => elements.get(`history-${name}`)!;
  const windowEvents = new Map<string, (event?: any) => void>();
  const location = { href: 'http://local.test/donnees?date=2026-10-26&step=1' };
  const storage = new Map<string, string>();
  const calls: string[] = [];
  let activeRequests = 0, maximumRequests = 0;
  let failDate = '';
  let delayRequests = false;
  const delayed: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const start = '2026-10-25T23:00:00.000Z', end = '2026-10-26T23:00:00.000Z';
  const day = { date: '2026-10-26', periodStart: start, periodEnd: end,
    observations: { method: 'counter_differences', solar: [{ at: start, value: 0 }, { at: '2026-10-25T23:15:00.000Z', value: 100 },
      { at: '2026-10-25T23:30:00.000Z', value: 200 }, { at: '2026-10-26T00:00:00.000Z', value: 400 }], household: [{ at: start, value: 0 }, { at: '2026-10-25T23:15:00.000Z', value: 100 },
      { at: '2026-10-25T23:30:00.000Z', value: 300 }, { at: '2026-10-26T00:00:00.000Z', value: 500 }] },
    energyEstimates: [], solarEstimates: Array.from({ length: 4 }, (_, index) => ({
      start: new Date(Date.parse(start) + index * 900000).toISOString(),
      end: new Date(Date.parse(start) + (index + 1) * 900000).toISOString(), estimatedProductionKwh: .25,
    })), battery: { points: [{ at: start, socPercent: 50 }, { at: '2026-10-25T23:15:00.000Z', socPercent: 49 },
      { at: '2026-10-25T23:30:00.000Z', socPercent: 48 }, { at: '2026-10-26T00:00:00.000Z', socPercent: 46 }] }, historicalEstimated: { points: [] } };
  const globals: Record<string, unknown> = {
    document: {
      getElementById(id: string) { return elements.get(id) ?? get('results').all().find(node => node.id === id); },
      createElement: (tag: string) => new Element(tag), createElementNS: (_namespace: string, tag: string) => new Element(tag),
      createDocumentFragment: () => new Element('fragment'),
    },
    window: { addEventListener: (name: string, handler: (event?: any) => void) => windowEvents.set(name, handler),
      history: { replaceState(_state: unknown, _title: string, url: URL) { location.href = url.href; },
        pushState(_state: unknown, _title: string, url: URL) { location.href = url.href; } } },
    location,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (input: string, options: { signal: AbortSignal }) => {
      calls.push(input); signals.push(options.signal);
      assert.ok(input.startsWith('/api/history/day'), 'history never requests live data, telemetry or commands');
      activeRequests++; maximumRequests = Math.max(maximumRequests, activeRequests);
      try {
        if (delayRequests) await new Promise<void>((resolve, reject) => {
          delayed.push(resolve);
          options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        });
        else await new Promise(resolve => setImmediate(resolve));
        const date = new URL(input, 'http://test').searchParams.get('date')!;
        if (date === failDate) return Response.json({}, { status: 503 });
        const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
        const shift = (at: string) => new Date(Date.parse(at) - Date.parse(start) + bounds.start.getTime()).toISOString();
        return Response.json({ ...day, date, periodStart: bounds.start.toISOString(), periodEnd: bounds.end.toISOString(),
          observations: { method: 'counter_differences', solar: day.observations.solar.map(point => ({ ...point, at: shift(point.at) })),
            household: day.observations.household.map(point => ({ ...point, at: shift(point.at) })) },
          solarEstimates: day.solarEstimates.map(point => ({ ...point, start: shift(point.start), end: shift(point.end) })),
          battery: { points: day.battery.points.map(point => ({ ...point, at: shift(point.at) })) } });
      } finally { activeRequests--; }

    },
  };
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    windowEvents.get('pagehide')?.();
    for (const key of Object.keys(globals)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!); else Reflect.deleteProperty(globalThis, key);
    }
  });
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  await import(`${new URL('../public/history.js', import.meta.url).href}?controller-test`);
  for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
  const tables = () => get('results').all().filter(node => node.tagName === 'table');
  const checkboxes = get('field-groups').all().filter(node => node.tagName === 'input');
  assert.equal(checkboxes.length, 6);
  assert.equal(elements.has('history-step'), false);
  assert.equal(elements.has('history-aggregation'), true);
  assert.equal(elements.has('history-solar-version'), false);
  assert.equal(new URL(location.href).searchParams.has('step'), false);
  assert.equal(tables().length, 1);
  assert.match(get('status').textContent, /96 pas de 15 min/);
  assert.equal(calls.length, 1);
  assert.equal(get('chart').hidden, false);
  assert.equal(get('chart-status').hidden, true);
  assert.ok(get('chart-svg').children.some(node => node.tagName === 'rect'));
  const series = (name: string) => get('chart-svg').children.filter(node => node.attributes.get('class') === name);
  const solarBars = series('chart-solar-measured');
  assert.equal(solarBars.length, 4, 'Measured solar uses the selected quarter-hour intervals');
  assert.match(solarBars[0].children[0].textContent, /00:00.*0 Wh/);
  assert.match(solarBars[1].children[0].textContent, /00:15.*100 Wh/);
  assert.equal(series('chart-solar').length, 4, 'Solar estimates also use quarter-hour bars');
  assert.match(series('chart-solar')[0].children[0].textContent, /00:00.*250 Wh/);
  assert.ok(Math.abs(Number(solarBars[0].attributes.get('width')) - 608 / 96 * .34) < 1e-9);
  assert.match(get('chart-frequency').textContent, /Solaire, maison et batterie : 15 min/);
  const housePoints = series('chart-demand-measured-point');
  assert.equal(housePoints.length, 4, 'The chart must keep every measured quarter instead of summing by hour');
  assert.match(housePoints[1].children[0].textContent, /00:15.*100 Wh/);
  assert.ok(Math.abs(Number(housePoints[1].attributes.get('cx')) - Number(housePoints[0].attributes.get('cx')) - 608 / 96) < 1e-9);
  assert.equal(series('chart-demand-measured').length, 1);
  assert.equal(series('chart-demand-measured')[0].attributes.get('points')!.split(' ').length, 3, 'Missing quarters break the measured house line');
  assert.equal(series('chart-battery-measured-point').length, 4);
  assert.equal(series('chart-battery-measured')[0].attributes.get('points')!.split(' ').length, 3);
  const body = () => tables()[0].all().find(node => node.tagName === 'tbody')!;
  assert.equal(body().children.length, 96);
  assert.equal(body().children[0].children.length, 7, 'one time column plus six values');
  assert.equal(body().children[0].children[6].textContent, '50', 'battery uses the dedicated quarter-hour history');
  const measuredHouse = checkboxes.find(node => node.value === 'houseMeasured')!;
  measuredHouse.checked = false; measuredHouse.fire('change');
  assert.equal(body().children[0].children.length, 6);
  assert.equal(tables().length, 1);
  get('select-none').fire('click');
  assert.equal(tables().length, 0);
  assert.match(get('status').textContent, /Aucune valeur sélectionnée/);
  get('select-all').fire('click');
  assert.equal(tables().length, 1);
  assert.equal(body().children[0].children.length, 7);
  assert.doesNotMatch(get('day-summary').textContent, /Zurich|UTC|horaire/);
  assert.equal(calls.length, 1);
  const settle = async () => { for (let index = 0; index < 35; index++) await new Promise(resolve => setImmediate(resolve)); };
  const aggregate = get('aggregation');
  aggregate.value = 'hour'; aggregate.fire('change'); await settle();
  assert.equal(body().children.length, 24);
  assert.match(get('status').textContent, /24 heures/);
  assert.equal(new URL(location.href).searchParams.get('view'), 'hour');
  assert.equal(calls.length, 1, 'hourly view aggregates the cached quarters');
  assert.equal(series('chart-solar-measured').length, 2);
  assert.match(series('chart-solar-measured')[0].children[0].textContent, /00:00.*300 Wh/);
  assert.equal(series('chart-solar').length, 1);
  assert.match(series('chart-solar')[0].children[0].textContent, /00:00.*1[  '’]000 Wh/);
  assert.ok(Math.abs(Number(series('chart-solar-measured')[0].attributes.get('width')) - 608 / 24 * .34) < 1e-9);
  assert.match(get('chart-frequency').textContent, /Solaire, maison et batterie : 1 h/);
  assert.equal(series('chart-demand-measured-point').length, 2, 'House and solar use the same hourly totals');
  assert.match(series('chart-demand-measured-point')[0].children[0].textContent, /00:00.*400 Wh/);
  assert.equal(series('chart-battery-measured-point').length, 2, 'Battery points also use the selected hourly intervals');
  assert.match(series('chart-battery-measured-point')[0].children[0].textContent, /01:00.*48 %/);
  assert.ok(maximumRequests <= 1, 'only one day is ever requested at once');
  get('previous').fire('click'); await settle();
  assert.equal(calls.length, 2);
  assert.equal(body().children.length, 25, 'the selected DST day remains a single calendar day');

  failDate = '2026-10-24';
  get('previous').fire('click'); await settle();
  assert.equal(tables().length, 0, 'a failed day never renders incomplete data');
  assert.equal(get('error').hidden, false);
  failDate = ''; get('retry').fire('click'); await settle();
  assert.equal(get('error').hidden, true);
  assert.equal(body().children.length, 24);

  delayRequests = true;
  get('date').value = '2026-08-01'; get('date-form').fire('submit'); await settle();
  const staleSignals = signals.slice(-1);
  assert.equal(delayed.length, 1);
  delayRequests = false;
  aggregate.value = 'hour'; aggregate.fire('change'); await settle();
  assert.ok(staleSignals.every(signal => signal.aborted), 'changing view cancels pending daily requests');
  for (const resolve of delayed) resolve(); await settle();
  assert.equal(body().children.length, 24, 'late daily responses cannot overwrite the new hourly table');
  assert.equal(new URL(location.href).searchParams.get('view'), 'hour');

  location.href = 'http://local.test/donnees?date=2026-10-25&view=hour';
  windowEvents.get('popstate')?.(); await settle();
  assert.equal(body().children.length, 25, 'browser history restores aggregation and DST calendar');
  assert.equal(aggregate.value, 'hour');
  aggregate.value = 'quarter'; aggregate.fire('change'); await settle();
  assert.equal(body().children.length, 100);
  assert.equal(new URL(location.href).searchParams.has('view'), false);
  assert.equal(series('chart-solar').length, 4, 'Switching back restores quarter-hour solar bars on a DST day');
  assert.ok(Math.abs(Number(series('chart-solar-measured')[0].attributes.get('width')) - 608 / 100 * .34) < 1e-9);
  assert.match(get('chart-frequency').textContent, /Solaire, maison et batterie : 15 min/);
  assert.equal(series('chart-demand-measured-point').length, 4, 'Switching back restores quarter-hour house points');
  assert.equal(series('chart-battery-measured-point').length, 4, 'Switching back restores quarter-hour battery points');

  const beforeTrainingRefresh = calls.length;
  windowEvents.get('household-forecast-updated')?.(); await settle();
  assert.equal(calls.length, beforeTrainingRefresh + 1, 'finished training invalidates cached predictions');
  assert.equal(body().children.length, 100, 'training refresh preserves the selected DST day and quarter view');

  assert.equal(elements.has('week-heading'), false, 'there is no separate weekly forecast card');
  const maximum = get('date').max;
  assert.match(maximum, /^\d{4}-\d{2}-\d{2}$/);
  get('date').value = maximum; get('date-form').fire('submit'); await settle();
  assert.equal(get('next').disabled, true);
  const atLimit = calls.length;
  get('next').fire('click'); await settle();
  assert.equal(calls.length, atLimit, 'the next-day arrow stops at the forecast limit');
  get('date').value = '2099-01-01'; get('date-form').fire('submit'); await settle();
  assert.equal(calls.length, atLimit, 'manually typed dates cannot bypass the limit');
  assert.equal(get('date').value, maximum);
  assert.match(get('error-text').textContent, /sept prochains jours/);
  location.href = 'http://local.test/donnees?date=2099-01-01';
  windowEvents.get('popstate')?.(); await settle();
  assert.equal(new URL(location.href).searchParams.get('date'), maximum, 'out-of-range URLs are normalized');
  get('previous').fire('click'); await settle();
  assert.equal(get('next').disabled, false);

});
