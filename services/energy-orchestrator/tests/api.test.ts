import test from 'node:test';
import assert from 'node:assert/strict';
import app, { createApi } from '../src/api.js';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast } from '../src/forecast.js';
import { getCalendarDayBounds } from '../src/policy.js';

function assertSingleConsumption(value: Record<string, any>) {
  for (const field of ['minConsumptionKwh', 'maxConsumptionKwh', 'heatPumpMinKwh', 'heatPumpMaxKwh',
    'heatPumpEnabled', 'heatPumpKwh', 'heatPumpModel', 'heatPumpWeatherStatus', 'heatPumpScale',
    'heatPumpReferenceTemperatureC', 'heatingThresholdC']) {
    assert.equal(Object.hasOwn(value, field), false, `consumption must not expose ${field}`);
  }
  for (const hour of value.hourly) {
    assert.equal(Object.hasOwn(hour, 'minConsumptionKwh'), false);
    assert.equal(Object.hasOwn(hour, 'maxConsumptionKwh'), false);
  }
}

test('health reports readiness without implicitly starting automation', async () => {
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: 'energy-orchestrator',
    status: 'ready',
    automationEnabled: false,
  });
});

test('status is informational and includes the complete dashboard contract', async () => {
  const api = createApi({ controllerUrl: null, tesla: { tokensPath: null, vin: '' }, now: () => new Date('2026-01-15T05:00:00Z') });
  const response = await api.request('/api/status');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.deepEqual(Object.keys(status).sort(), ['dailyEnergy', 'batteryChargeEstimate', 'automation', 'carAutomation', 'carTarget', 'car', 'wattpilot', 'charging', 'integrations', 'policy', 'tariff', 'telemetry', 'timeZone', 'updatedAt'].sort());
  assert.deepEqual(status.automation, { enabled: false, status: 'disabled', lastEvaluatedAt: null,
    nextEvaluationAt: null, targetSocPercent: null, reason: 'disabled', plan: null, error: null, holdUntil: null });
  assert.equal(status.timeZone, 'Europe/Zurich');
  assert.equal(status.tariff.kind, 'low');
  assert.equal(status.charging.allowed, true);
  assert.equal(status.telemetry.status, 'not_configured');
  assert.equal(status.policy.totalConsumptionLimitKw, 16);
  assert.equal(status.policy.batteryPowerLimitKw, 7);
  assert.equal(status.policy.homeBatteryCapacityKwh, 60);
  assert.equal(status.policy.carMorningMinimumSocPercent, 60);
  assert.equal(status.carTarget.weekday, 'Thursday');
  assert.equal(status.carTarget.minimumSocPercent, 60);
  assert.equal(status.carTarget.gridChargingEndsAt, '2026-01-15T05:55:00.000Z');
  assert.equal(status.policy.carMorningMinimumSocPercentByWeekday.Friday, 50);
  assert.equal(status.wattpilot.status, 'not_configured');
  assert.deepEqual(status.integrations, { tesla: 'not_connected', wattpilot: 'not_configured', weather: 'not_connected', planner: 'disabled' });
});

test('dashboard and its explicit static assets use module-relative paths', async () => {
  const api = createApi({ controllerUrl: null });
  for (const [path, contentType] of [['/', 'text/html'], ['/dashboard', 'text/html'], ['/dashboard.css', 'text/css'], ['/dashboard.js', 'text/javascript'], ['/theme.js', 'text/javascript'], ['/controls.js', 'text/javascript'], ['/forecast.js', 'text/javascript']]) {
    const response = await api.request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type')?.startsWith(contentType), path);
    assert.ok((await response.text()).length > 20, path);
  }
  for (const path of ['/README.md', '/src/api.ts', '/public/index.html', '/.env', '/api/status']) {
    assert.equal((await api.request(path, { method: 'POST' })).status, 404);
  }
  for (const path of ['/README.md', '/src/api.ts', '/public/index.html', '/public/pages/controls.html', '/pages/controls.html', '/.env', '/dashboard/../api.ts', '/unknown']) {
    assert.equal((await api.request(path)).status, 404);
  }
});

test('dashboard pages keep their content separate except desktop home controls below the flows', async () => {
  const api = createApi({ controllerUrl: null });
  const destinations = [
    { path: '/', key: 'accueil', title: 'Accueil', content: 'flow-heading' },
    { path: '/pilotage', key: 'pilotage', title: 'Pilotage', content: 'controls-heading' },
    { path: '/donnees', key: 'donnees', title: 'Données', content: 'history-day-heading' },
    { path: '/planification', key: 'planification', title: 'Planification', content: 'planner-current-heading' },
    { path: '/tarifs', key: 'tarifs', title: 'Tarifs', content: 'tariff-heading' },
    { path: '/appareils', key: 'appareils', title: 'Appareils', content: 'connections-heading' },
  ];
  for (const destination of destinations) {
    // A new document request works both when navigating directly and when reloading.
    for (let load = 0; load < 2; load++) {
      const response = await api.request(destination.path);
      assert.equal(response.status, 200, destination.path);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      const html = await response.text();
      assert.ok(html.includes(`<body data-page="${destination.key}">`));
      assert.ok(html.includes(`<title>${destination.title} · Energy Manager</title>`));
      assert.ok(html.includes(`<strong>${destination.title}</strong>`), 'breadcrumb matches the page');
      assert.ok(html.includes(`<h1 id="page-title">${destination.title}</h1>`));
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
      assert.equal((html.match(/class="nav-link active"/g) ?? []).length, 1);
      assert.ok(html.includes(`class="nav-link active" href="${destination.path}" aria-current="page"`));
      assert.match(html, /href="\/donnees"[^>]*>[\s\S]*?<span class="nav-label">Données<\/span>/);
      assert.doesNotMatch(html, /href="\/previsions"|>Suivi<\/span>/);
      for (const other of destinations) {
        const sharedHomePanel = destination.key === 'accueil' && other.key === 'pilotage';
        assert.equal(html.includes(`id="${other.content}"`), other.key === destination.key || sharedHomePanel, `${destination.path}: ${other.content}`);
      }
      const hasControls = destination.key === 'pilotage' || destination.key === 'accueil';
      assert.equal(html.includes('src="/controls.js"'), hasControls);
      assert.equal(html.includes('src="/forecast.js"'), destination.key === 'accueil' || destination.key === 'appareils');
      assert.equal(html.includes('id="solar-forecast"'), destination.key === 'accueil');
      assert.equal(html.includes('id="today-solar-forecast"'), destination.key === 'accueil');
      if (destination.key === 'accueil') assert.ok(html.indexOf('id="today-solar-forecast"') < html.indexOf('id="solar-forecast"'));
      assert.equal(html.includes('id="weather-state"'), destination.key === 'appareils');
      assert.equal(html.includes('src="/dashboard.js"'), destination.key !== 'donnees');
      assert.ok(html.indexOf('src="/theme.js"') < html.indexOf('href="/dashboard.css"'));
      assert.ok(html.includes('href="/" aria-label="Energy Manager — Accueil"'));
      for (const route of destinations) assert.ok(html.includes(`href="${route.path}"`));
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      assert.equal(ids.length, new Set(ids).size, 'rendered pages have unique IDs');
      assert.doesNotMatch(html, /href="#(?:overview|controls|schedule|connections)"|\{\{[A-Z_]+\}\}/);
      assert.equal(html.includes('id="schedule-heading"'), destination.key === 'tarifs');
      assert.equal(html.includes('id="limits-heading"'), destination.key === 'tarifs');
      if (hasControls) {
        assert.ok(html.includes('<fieldset id="battery-control-fields" disabled>'));
        assert.ok(html.includes('<fieldset id="car-control-fields" disabled>'));
        assert.match(html, /id="battery-charge"[^>]*disabled/);
        assert.match(html, /id="car-charge"[^>]*disabled/);
        assert.equal((html.match(/id="battery-control-form"/g) ?? []).length, 1);
      }
      if (destination.key === 'accueil') {
        assert.ok(html.includes('class="desktop-home-controls"'));
        assert.ok(html.includes('class="home-overview"'));
        assert.ok(html.includes('class="desktop-home-forecast"'));
        assert.ok(html.indexOf('id="flow-heading"') < html.indexOf('id="forecast-heading"'));
        assert.ok(html.indexOf('id="forecast-heading"') < html.indexOf('id="controls-heading"'));
        assert.ok(html.indexOf('id="flow-heading"') < html.indexOf('id="controls-heading"'));
      }
    }
  }
  assert.equal(await (await api.request('/dashboard')).text(), await (await api.request('/')).text());
});

test('Données exposes one read-only day with its chart, table and isolated assets', async () => {
  const api = createApi({ controllerUrl: null,
    telemetryReader: async () => { throw new Error('history must not contact devices'); },
  });
  const response = await api.request('/donnees?date=2026-10-25');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /href="\/donnees" aria-current="page"/);
  assert.match(html, /src="\/history.js" type="module"/);
  assert.match(html, /href="\/history.css"/);
  assert.match(html, /id="history-aggregation"/);
  assert.match(html, /Par heure/);
  assert.match(html, /id="history-chart-svg"/);
  assert.doesNotMatch(html, /Par jour · 14 jours/);
  assert.doesNotMatch(html, /id="history-step"|id="history-solar-version"/);
  assert.doesNotMatch(html, /Europe\/Zurich|UTC[+-]|Fuseau horaire|history-select-default/);
  assert.doesNotMatch(html, /src="\/(?:dashboard|controls|forecast|tesla)\.js"/);
  for (const [path, type] of [['/history.js', 'text/javascript'], ['/history-data.js', 'text/javascript'], ['/history.css', 'text/css']]) {
    const asset = await api.request(path);
    assert.equal(asset.status, 200, path);
    assert.ok(asset.headers.get('content-type')?.startsWith(type), path);
  }
});

test('removed tracking and renamed history URLs preserve bookmarks through Données', async () => {
  const api = createApi({ controllerUrl: null });
  for (const path of ['/previsions', '/historique?date=2026-10-25&view=hour']) {
    const response = await api.request(path);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), `/donnees${new URL(path, 'http://local').search}`);
  }
});

test('placeholder exposes no battery or car control endpoints', async () => {
  for (const path of ['/inverter/set-charge-power', '/battery/charge', '/car/charge']) {
    const response = await app.request(path, { method: 'POST' });
    assert.equal(response.status, 404);
  }
});


test('home keeps daily summaries while Données owns the single-day chart', async () => {
  const api = createApi({ controllerUrl: null });
  const home = await (await api.request('/')).text();
  const data = await (await api.request('/donnees')).text();
  assert.match(home, /id="today-forecast-energy">—<\/strong><span>kWh<\/span>/);
  assert.doesNotMatch(home + data, /\{\{ENERGY_UNIT\}\}/);
  assert.doesNotMatch(home, /forecast-hourly/);
  assert.match(data, /id="history-chart-svg"/);
  assert.equal(data.includes('id="flow-heading"'), false);
  assert.equal(data.includes('src="/forecast.js"'), false);
  assert.equal(data.includes('id="forecast-consumption"'), false);
});



test('forecast endpoints return saved provenance and consumption without contacting providers', async () => {
  const dates: string[] = [];
  const consumption = estimateConsumption('2026-10-25', { baselinePowerW: 500 });
  const bounds = getCalendarDayBounds(new Date('2026-10-25T00:00:00Z'));
  const source = { ...emptySolarForecast('2026-10-25', null), status: 'stale' as const,
    fetchedAt: '2026-10-24T09:00:00.000Z', model: 'east_west_tilted_radiation' as const,
    temperatureMeanC: 13, consumption,
    forecastPeriod: { start: bounds.start.toISOString(), end: bounds.end.toISOString(), from: bounds.start.toISOString() } };
  const api = createApi({ controllerUrl: null, now: () => new Date('2026-10-24T12:00:00Z'),
    forecast: { config: null, fetch: async () => { throw new Error('GET must not contact a forecast provider'); } },
    forecastStore: { async readForecast(date) {
      dates.push(date);
      return date === source.date ? { calculatedAt: '2026-10-24T10:00:00.000Z', forecast: source,
        projection: { status: 'unavailable', reason: 'disabled', assumption: 'automatic_planning', observedAt: null, points: [] } } : null;
    } },
  });
  for (let read = 0; read < 2; read++) {
    const response = await api.request('/api/forecast');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.date, '2026-10-25');
    assert.equal(data.model, source.model);
    assert.equal(data.status, 'stale');
    assert.equal(data.fetchedAt, source.fetchedAt);
    assert.equal(data.temperatureMeanC, 13);
    assert.deepEqual(data.consumption, consumption);
    assertSingleConsumption(data.consumption);
    assert.equal(data.consumption.dayHours, 25);
    assert.equal(data.consumption.excludesCar, true);
  }
  const unpublished = await (await api.request('/api/forecast/today')).json();
  assert.equal(unpublished.date, '2026-10-24');
  assert.equal(unpublished.estimatedProductionKwh, null);
  assert.equal(unpublished.consumption, null);
  assert.deepEqual(dates, ['2026-10-25', '2026-10-25', '2026-10-24']);
  assert.equal((await api.request('/api/forecast', { method: 'POST' })).status, 404);
});
