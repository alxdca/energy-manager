import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastReader, emptySolarForecast, hasUsableForecast, loadForecastConfig, type ForecastConfig } from '../src/forecast.js';

const config: ForecastConfig = { latitude: 12.34, longitude: 56.78, locationName: 'Installation de test', arrayPowerKw: 8.5, performanceRatio: 0.85 };
const instant = '2026-01-15T12:00:00.000Z';
const date = '2026-01-16';
const now = () => new Date(instant);
const payload = (target = date) => ({
  daily_units: { time: 'iso8601', shortwave_radiation_sum: 'MJ/m²', weather_code: 'wmo code', temperature_2m_min: '°C', temperature_2m_max: '°C', temperature_2m_mean: '°C' },
  daily: { time: [target], shortwave_radiation_sum: [10.8], weather_code: [3], temperature_2m_min: [-2.5], temperature_2m_max: [5.1], temperature_2m_mean: [1.3] },
});
const fake = (body: unknown): typeof fetch => async () => Response.json(body);

test('retained forecasts stay usable while missing, offline and future snapshots remain unknown', () => {
  for (const status of ['online', 'stale'] as const) {
    assert.equal(hasUsableForecast({ status, fetchedAt: '2026-01-14T00:00:00Z' }, now().getTime()), true);
    for (const fetchedAt of [null, 'invalid', '2026-01-15T12:00:06Z']) {
      assert.equal(hasUsableForecast({ status, fetchedAt }, now().getTime()), false);
    }
  }
  for (const status of ['offline', 'not_configured'] as const) {
    assert.equal(hasUsableForecast({ status, fetchedAt: instant }, now().getTime()), false);
  }
  assert.equal(hasUsableForecast({ status: 'stale', fetchedAt: instant }, NaN), false);
});

test('unknown scheduled forecasts preserve configured metadata without requesting the provider', t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Must not fetch before the scheduled hour'); });
  const disabled = emptySolarForecast(date, null);
  assert.equal(disabled.status, 'not_configured');
  assert.equal(disabled.date, date);
  assert.equal(disabled.estimatedProductionKwh, null);
  assert.equal(disabled.fetchedAt, null);
  const configured = emptySolarForecast(date, { ...config, panelTiltDegrees: 15, eastFraction: .5, weatherModel: 'meteoswiss_icon_ch2' });
  assert.equal(configured.status, 'offline');
  assert.equal(configured.locationName, config.locationName);
  assert.equal(configured.model, 'east_west_tilted_radiation');
  assert.equal(configured.panelTiltDegrees, 15);
  assert.equal(configured.eastFraction, .5);
  assert.equal(configured.weatherModel, 'meteoswiss_icon_ch2');
  assert.equal(configured.hourly, null);
  assert.equal(configured.estimatedProductionKwh, null);
  assert.equal(configured.fetchedAt, null);
  assert.equal(configured.error, 'Les prévisions météo sont indisponibles.');
  assert.equal(calls, 0);
});

test('clock-hour cache refreshes at the next full hour despite an offset fetch completion', async () => {
  for (const cacheAlignment of ['elapsed', 'clock_hour'] as const) {
    let clock = new Date('2026-01-15T12:00:04Z');
    let calls = 0;
    const read = createForecastReader({ config, cacheAlignment, now: () => clock,
      fetch: async () => { calls++; return Response.json(payload()); } });
    assert.equal((await read()).fetchedAt, '2026-01-15T12:00:04.000Z');
    clock = new Date('2026-01-15T12:45:00Z');
    await read();
    assert.equal(calls, 1);
    clock = new Date('2026-01-15T13:00:00Z');
    const result = await read();
    assert.equal(calls, cacheAlignment === 'clock_hour' ? 2 : 1);
    assert.equal(result.fetchedAt, cacheAlignment === 'clock_hour' ? clock.toISOString() : '2026-01-15T12:00:04.000Z');
    assert.equal(result.status, 'online');
  }
});

test('clock-hour cache distinguishes both repeated Zurich autumn hours', async () => {
  let clock = new Date('2026-10-25T02:00:04+02:00');
  let calls = 0;
  const read = createForecastReader({ config, cacheAlignment: 'clock_hour', now: () => clock,
    fetch: async () => { calls++; return Response.json(payload('2026-10-26')); } });
  const first = await read();
  clock = new Date('2026-10-25T02:00:00+01:00');
  const second = await read();
  assert.equal(calls, 2);
  assert.equal(first.date, second.date);
  assert.equal(first.fetchedAt, '2026-10-25T00:00:04.000Z');
  assert.equal(second.fetchedAt, '2026-10-25T01:00:00.000Z');
});

test('a successful bootstrap near the full hour does not postpone the next clock-hour refresh', async () => {
  let clock = new Date('2026-01-15T12:59:00Z');
  let calls = 0;
  const read = createForecastReader({ config, cacheAlignment: 'clock_hour', now: () => clock,
    fetch: async () => { calls++; return Response.json(payload()); } });
  await read();
  clock = new Date('2026-01-15T13:00:00Z');
  assert.equal((await read()).fetchedAt, clock.toISOString());
  assert.equal(calls, 2);
  clock = new Date('2026-01-15T13:04:00Z');
  assert.equal((await read()).status, 'online');
  assert.equal(calls, 2);
});

test('a failed clock-hour refresh retries at the following full hour despite recent failure', async () => {
  let clock = new Date('2026-01-15T11:59:00Z');
  let calls = 0;
  const read = createForecastReader({ config, cacheAlignment: 'clock_hour', now: () => clock,
    fetch: async () => ++calls === 2 ? new Response('', { status: 503 }) : Response.json(payload()) });
  await read();
  clock = new Date('2026-01-15T12:59:00Z');
  assert.equal((await read()).status, 'stale');
  assert.equal(calls, 2);
  clock = new Date('2026-01-15T13:00:00Z');
  assert.equal((await read()).status, 'online');
  assert.equal(calls, 3);
  clock = new Date('2026-01-15T13:04:00Z');
  assert.equal((await read()).status, 'online');
  assert.equal(calls, 3);
});

test('a failed bootstrap immediately before the hour cannot suppress that full-hour solar attempt', async () => {
  let clock = new Date('2026-01-15T19:59:00Z');
  let calls = 0;
  const read = createForecastReader({ config, cacheAlignment: 'clock_hour', now: () => clock,
    fetch: async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json(payload()) });
  assert.equal((await read()).status, 'offline');
  assert.equal(calls, 1);
  clock = new Date('2026-01-15T20:00:00Z');
  const result = await read();
  assert.equal(result.status, 'online');
  assert.equal(result.fetchedAt, clock.toISOString());
  assert.equal(calls, 2);
});

test('failed clock-hour requests retain the five-minute retry backoff within the same hour', async () => {
  let clock = new Date('2026-01-15T12:00:00Z');
  let calls = 0;
  const read = createForecastReader({ config, cacheAlignment: 'clock_hour', now: () => clock,
    fetch: async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json(payload()) });
  assert.equal((await read()).status, 'offline');
  clock = new Date('2026-01-15T12:04:59Z');
  assert.equal((await read()).status, 'offline');
  assert.equal(calls, 1);
  clock = new Date('2026-01-15T12:05:00Z');
  assert.equal((await read()).status, 'online');
  assert.equal(calls, 2);
});

test('loads explicit location and solar defaults without assuming a house location', () => {
  assert.equal(loadForecastConfig({}), null);
  assert.equal(loadForecastConfig({ FORECAST_LATITUDE: ' ', FORECAST_LONGITUDE: '' }), null);
  assert.deepEqual(loadForecastConfig({ FORECAST_LATITUDE: '12.34', FORECAST_LONGITUDE: '56.78' }), { ...config, locationName: 'Installation', weatherModel: 'best_match' });
  assert.deepEqual(loadForecastConfig({
    FORECAST_LATITUDE: '-90', FORECAST_LONGITUDE: '180', FORECAST_SOLAR_CAPACITY_KW: '10',
    FORECAST_PERFORMANCE_RATIO: '.9', FORECAST_LOCATION_NAME: '  Ma maison  ',
  }), { latitude: -90, longitude: 180, arrayPowerKw: 10, performanceRatio: 0.9, locationName: 'Ma maison', weatherModel: 'best_match' });
});

test('rejects partial, nonnumeric and out of range configuration', () => {
  for (const env of [
    { FORECAST_LATITUDE: '46' }, { FORECAST_LONGITUDE: '7' },
    { FORECAST_LATITUDE: '91', FORECAST_LONGITUDE: '7' },
    { FORECAST_LATITUDE: '46', FORECAST_LONGITUDE: '-181' },
    { FORECAST_LATITUDE: 'NaN', FORECAST_LONGITUDE: '7' },
    { FORECAST_LATITUDE: '0x20', FORECAST_LONGITUDE: '7' },
    { FORECAST_LATITUDE: '46foo', FORECAST_LONGITUDE: '7' },
    ...['0', '-1', '101', 'Infinity', 'NaN'].map(FORECAST_SOLAR_CAPACITY_KW => ({ FORECAST_LATITUDE: '46', FORECAST_LONGITUDE: '7', FORECAST_SOLAR_CAPACITY_KW })),
    ...['0', '-0.1', '1.01', 'false'].map(FORECAST_PERFORMANCE_RATIO => ({ FORECAST_LATITUDE: '46', FORECAST_LONGITUDE: '7', FORECAST_PERFORMANCE_RATIO })),
  ]) assert.throws(() => loadForecastConfig(env));
  assert.throws(() => createForecastReader({ config: { ...config, arrayPowerKw: 0 } }));
});

test('weather-model selection is explicit, validated and applied to every request', async () => {
  const env = { FORECAST_LATITUDE: '12.34', FORECAST_LONGITUDE: '56.78' };
  assert.equal(loadForecastConfig(env)?.weatherModel, 'best_match');
  assert.equal(loadForecastConfig({ ...env, FORECAST_WEATHER_MODEL: ' meteoswiss_icon_ch2 ' })?.weatherModel, 'meteoswiss_icon_ch2');
  for (const model of ['icon_ch2', 'gfs', 'BEST_MATCH', 'false']) {
    assert.throws(() => loadForecastConfig({ ...env, FORECAST_WEATHER_MODEL: model }), /WEATHER_MODEL/);
    assert.throws(() => createForecastReader({ config: { ...config, weatherModel: model as ForecastConfig['weatherModel'] } }), /WEATHER_MODEL/);
  }
  for (const weatherModel of ['best_match', 'meteoswiss_icon_ch2'] as const) {
    let count = 0;
    const result = await createForecastReader({ config: { ...eastWestConfig, weatherModel }, now, fetch: async input => {
      count++;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('models'), weatherModel === 'best_match' ? null : weatherModel);
      return Response.json(providerPayload(url));
    } })();
    assert.equal(count, 3);
    assert.equal(result.status, 'online');
    assert.equal(result.weatherModel, weatherModel);
  }
});

test('disabling the forecast performs no HTTP and keeps production unknown', async () => {
  const result = await createForecastReader({ config: null, now, fetch: async () => { throw new Error('Must not fetch'); } })();
  assert.deepEqual(result, {
    status: 'not_configured', date, locationName: null, estimatedProductionKwh: null, hourly: null,
    weatherCode: null, temperatureMinC: null, temperatureMaxC: null, temperatureMeanC: null, fetchedAt: null,
    source: 'Open-Meteo', model: 'horizontal_radiation', arrayPowerKw: 8.5, performanceRatio: 0.85, panelTiltDegrees: null, eastFraction: null, weatherModel: 'best_match', productionPeriodStart: null, productionPeriodEnd: null,
    error: 'Configurez la localisation pour afficher les prévisions météo.',
  });
});

test('requests only tomorrow daily weather and converts MJ/m² into approximate PV kWh', async () => {
  const read = createForecastReader({ config, now, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      latitude: '12.34', longitude: '56.78', daily: 'shortwave_radiation_sum,weather_code,temperature_2m_min,temperature_2m_max,temperature_2m_mean',
      timezone: 'Europe/Zurich', start_date: date, end_date: date,
    });
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(payload());
  } });
  assert.deepEqual(await read(), {
    status: 'online', date, locationName: config.locationName, estimatedProductionKwh: 21.7, hourly: null,
    weatherCode: 3, temperatureMinC: -2.5, temperatureMaxC: 5.1, temperatureMeanC: 1.3, fetchedAt: instant,
    source: 'Open-Meteo', model: 'horizontal_radiation', arrayPowerKw: 8.5, performanceRatio: 0.85, panelTiltDegrees: null, eastFraction: null, weatherModel: 'best_match', productionPeriodStart: null, productionPeriodEnd: null, error: null,
  });
});

test('true zero sunlight stays zero, optional missing weather remains unknown', async () => {
  const body = { daily_units: { time: 'iso8601', shortwave_radiation_sum: 'MJ/m²' }, daily: { time: [date], shortwave_radiation_sum: [0] } };
  const result = await createForecastReader({ config, now, fetch: fake(body) })();
  assert.equal(result.status, 'online');
  assert.equal(result.estimatedProductionKwh, 0);
  assert.equal(result.weatherCode, null);
  assert.equal(result.temperatureMinC, null);
  assert.equal(result.temperatureMaxC, null);
  assert.equal(result.temperatureMeanC, null);
  const nullWeather = payload();
  for (const key of ['weather_code', 'temperature_2m_min', 'temperature_2m_max', 'temperature_2m_mean'] as const) (nullWeather.daily[key] as unknown[]) = [null];
  assert.equal((await createForecastReader({ config, now, fetch: fake(nullWeather) })()).status, 'online');
});

test('malformed dates, values and units never become zero production', async () => {
  const invalid: unknown[] = [null, {}, { daily: {} }, payload('2026-01-17')];
  const mutate = (change: (body: any) => void) => { const body = payload(); change(body); invalid.push(body); };
  for (const radiation of [null, -1, '10', 'NaN', Infinity, NaN, Number.MAX_VALUE]) mutate(body => { body.daily.shortwave_radiation_sum = [radiation]; });
  mutate(body => { body.daily_units.shortwave_radiation_sum = 'kWh/m²'; });
  mutate(body => { body.daily_units.time = 'unixtime'; });
  mutate(body => { body.daily.time = [date, '2026-01-17']; });
  mutate(body => { delete body.daily.shortwave_radiation_sum; });
  mutate(body => { body.daily.shortwave_radiation_sum = []; });
  mutate(body => { body.daily_units.temperature_2m_min = '°F'; });
  mutate(body => { body.daily_units.temperature_2m_min = '°F'; body.daily.temperature_2m_min = [null]; });
  mutate(body => { body.daily.temperature_2m_min = [-101]; });
  mutate(body => { body.daily.temperature_2m_max = [71]; });
  mutate(body => { body.daily.temperature_2m_min = [10]; });
  mutate(body => { body.daily.weather_code = [100]; });
  mutate(body => { body.daily.weather_code = [1.5]; });
  mutate(body => { body.daily_units.weather_code = 'unknown'; });
  mutate(body => { body.daily_units.temperature_2m_mean = '°F'; });
  for (const mean of [-101, 71, '10', -3, 6]) mutate(body => { body.daily.temperature_2m_mean = [mean]; });
  for (const body of invalid) {
    const result = await createForecastReader({ config, now, fetch: fake(body) })();
    assert.equal(result.status, 'offline', JSON.stringify(body));
    assert.equal(result.estimatedProductionKwh, null);
    assert.equal(result.fetchedAt, null);
  }
  for (const [fetch, error] of [
    [async () => new Response('private HTML'), 'La réponse du fournisseur météo contient du JSON invalide.'],
    [async () => new Response('secret', { status: 503 }), 'Les prévisions météo sont indisponibles (HTTP 503).'],
    [async () => { throw new Error('private upstream details'); }, 'Les prévisions météo sont indisponibles.'],
  ] as const) {
    const result = await createForecastReader({ config, now, fetch })();
    assert.equal(result.status, 'offline');
    assert.equal(result.error, error);
  }
});

test('tomorrow follows Zurich calendar midnight and both daylight-saving boundaries', async () => {
  for (const [timestamp, expected] of [
    ['2026-01-15T22:59:59Z', '2026-01-16'], ['2026-01-15T23:00:00Z', '2026-01-17'],
    ['2026-03-28T22:59:59Z', '2026-03-29'], ['2026-03-28T23:00:00Z', '2026-03-30'],
    ['2026-03-29T21:59:59Z', '2026-03-30'], ['2026-03-29T22:00:00Z', '2026-03-31'],
    ['2026-10-24T21:59:59Z', '2026-10-25'], ['2026-10-24T22:00:00Z', '2026-10-26'],
    ['2026-10-25T22:59:59Z', '2026-10-26'], ['2026-10-25T23:00:00Z', '2026-10-27'],
    ['2026-12-31T23:00:00Z', '2027-01-02'],
  ]) {
    const result = await createForecastReader({ config, now: () => new Date(timestamp), fetch: fake(payload(expected)) })();
    assert.equal(result.date, expected, timestamp);
    assert.equal(result.status, 'online', timestamp);
  }
});

test('coalesces simultaneous requests and caches successful readings for an hour', async () => {
  let clock = now();
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = createForecastReader({ config, now: () => clock, fetch: async () => { count++; await gate; return Response.json(payload()); } });
  const requests = [read(), read(), read()];
  assert.equal(count, 1);
  release();
  for (const result of await Promise.all(requests)) assert.equal(result.status, 'online');
  clock = new Date(now().getTime() + 3_599_999);
  await read();
  assert.equal(count, 1);
  clock = new Date(now().getTime() + 3_600_000);
  await read();
  assert.equal(count, 2);
});

test('failed attempts back off for five minutes, retain the last forecast beyond six hours and recover', async () => {
  let clock = now();
  let fails = false;
  let count = 0;
  const read = createForecastReader({ config, now: () => clock, fetch: async () => {
    count++;
    if (fails) throw new Error('upstream');
    return Response.json(payload());
  } });
  assert.equal((await read()).status, 'online');
  fails = true;
  clock = new Date(now().getTime() + 3_600_000);
  const stale = await read();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fetchedAt, instant);
  assert.equal(stale.estimatedProductionKwh, 21.7);
  assert.ok(stale.error);
  clock = new Date(clock.getTime() + 299_999);
  assert.equal((await read()).status, 'stale');
  assert.equal(count, 2);
  clock = new Date(clock.getTime() + 1);
  await read();
  assert.equal(count, 3);
  clock = new Date(now().getTime() + 6 * 3_600_000);
  assert.equal((await read()).status, 'stale');
  clock = new Date(clock.getTime() + 1);
  const retained = await read();
  assert.equal(retained.status, 'stale');
  assert.equal(retained.fetchedAt, instant);
  assert.equal(retained.estimatedProductionKwh, 21.7);
  fails = false;
  clock = new Date(clock.getTime() + 300_000);
  assert.equal((await read()).status, 'online');
});

test('initial outages back off and never relabel the previous target on day rollover', async () => {
  let clock = new Date('2026-01-15T22:59:00Z');
  let count = 0;
  let fails = true;
  const read = createForecastReader({ config, now: () => clock, fetch: async () => {
    count++;
    if (fails) throw new Error('down');
    return Response.json(payload());
  } });
  assert.equal((await read()).status, 'offline');
  await read();
  assert.equal(count, 1);
  clock = new Date('2026-01-15T22:59:30Z');
  await read();
  assert.equal(count, 1);
  clock = new Date('2026-01-15T23:04:30Z');
  const wrongDate = await read();
  assert.equal(wrongDate.date, '2026-01-17');
  assert.equal(wrongDate.status, 'offline');
  assert.equal(count, 2);

  clock = new Date('2026-01-15T22:55:00Z');
  fails = false;
  assert.equal((await read()).status, 'online');
  clock = new Date('2026-01-15T23:00:00Z');
  fails = true;
  const nextDay = await read();
  assert.equal(nextDay.date, '2026-01-17');
  assert.equal(nextDay.status, 'offline');
  assert.equal(nextDay.estimatedProductionKwh, null);
});

test('failed refresh reports the HTTP status while preserving the complete last successful snapshot', async () => {
  let clock = now();
  let failure = false;
  const read = createForecastReader({ config: eastWestConfig, now: () => clock, fetch: async input => {
    if (failure) return new Response('private provider response', { status: 429 });
    return Response.json(providerPayload(new URL(String(input))));
  } });
  const original = await read();
  failure = true;
  clock = new Date(clock.getTime() + 8 * 3_600_000);
  const retained = await read();
  assert.deepEqual({ ...retained, status: original.status, error: original.error }, original);
  assert.equal(retained.status, 'stale');
  assert.equal(retained.error, 'Les prévisions météo sont indisponibles (HTTP 429).');
  assert.doesNotMatch(retained.error, /private/);
});

test('invalid JSON has a useful diagnostic without exposing the provider response', async () => {
  const result = await createForecastReader({ config, now, fetch: async () => new Response('private HTML') })();
  assert.equal(result.status, 'offline');
  assert.equal(result.error, 'La réponse du fournisseur météo contient du JSON invalide.');
});

test('four-second timeout covers both hanging fetches and hanging JSON, aborting each', async () => {
  await Promise.all(['fetch', 'json'].map(async kind => {
    let signal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      signal = init?.signal;
      if (kind === 'fetch') return new Promise<Response>(() => {});
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    };
    const result = await createForecastReader({ config, now, fetch })();
    assert.equal(signal?.aborted, true);
    assert.equal(result.status, 'offline');
    assert.equal(result.estimatedProductionKwh, null);
    assert.equal(result.error, 'Le délai de réponse des prévisions météo a dépassé 4 secondes.');
  }));
});

test('a request spanning Zurich midnight cannot return the old target as tomorrow', async () => {
  let clock = new Date('2026-10-24T21:59:59Z');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const targets: string[] = [];
  const read = createForecastReader({ config, now: () => clock, fetch: async input => {
    const target = new URL(String(input)).searchParams.get('start_date')!;
    targets.push(target);
    await gate;
    return Response.json(payload(target));
  } });
  const pending = read();
  clock = new Date('2026-10-24T22:00:01Z');
  release();
  const result = await pending;
  assert.equal(result.date, '2026-10-26');
  assert.equal(result.status, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.fetchedAt, null);
  const refreshed = await read();
  assert.deepEqual(targets, ['2026-10-25', '2026-10-26']);
  assert.equal(refreshed.date, '2026-10-26');
  assert.equal(refreshed.status, 'online');
});

const tilt = 15;
const eastWestConfig: ForecastConfig = { ...config, panelTiltDegrees: tilt, eastFraction: 0.5 };
const tiltedPayload = (radiation: number, url: URL) => {
  const start = Date.parse(`${url.searchParams.get('start_minutely_15')}Z`) / 1000;
  const end = Date.parse(`${url.searchParams.get('end_minutely_15')}Z`) / 1000;
  const time = Array.from({ length: (end - start) / 900 + 1 }, (_, index) => start + index * 900);
  return {
    minutely_15_units: { time: 'unixtime', global_tilted_irradiance: 'W/m²', temperature_2m: '°C' },
    minutely_15: {
      time,
      temperature_2m: time.map((_, index): number => index < 48 ? 5 : 10),
      global_tilted_irradiance: time.map(timestamp => {
        const hour = new Date(Math.ceil(timestamp / 3600) * 3600 * 1000).getUTCHours();
        return hour >= 8 && hour < 16 ? radiation : 0;
      }),
    },
  };
};
const providerPayload = (url: URL, radiation = 100) => url.searchParams.has('minutely_15')
  ? tiltedPayload(radiation, url) : payload(url.searchParams.get('start_date')!);

test('east-west configuration uses degrees, validates ranges and defaults to an equal split', () => {
  const env = { FORECAST_LATITUDE: '12.34', FORECAST_LONGITUDE: '56.78', FORECAST_PANEL_TILT_DEG: String(tilt) };
  assert.deepEqual(loadForecastConfig(env), { ...eastWestConfig, locationName: 'Installation', weatherModel: 'best_match' });
  assert.equal(loadForecastConfig({ ...env, FORECAST_EAST_FRACTION: '.25' })?.eastFraction, 0.25);
  for (const value of ['-1', '91', 'NaN', '15%', '0x10']) {
    assert.throws(() => loadForecastConfig({ ...env, FORECAST_PANEL_TILT_DEG: value }));
  }
  for (const value of ['-.01', '1.01', 'NaN', '50%']) {
    assert.throws(() => loadForecastConfig({ ...env, FORECAST_EAST_FRACTION: value }));
  }
  assert.throws(() => loadForecastConfig({ ...env, FORECAST_PANEL_TILT_DEG: '', FORECAST_EAST_FRACTION: '.5' }));
  assert.throws(() => createForecastReader({ config: { ...eastWestConfig, panelTiltDegrees: NaN } }));
  assert.throws(() => createForecastReader({ config: { ...eastWestConfig, eastFraction: 2 } }));
  assert.equal(loadForecastConfig({ ...env, FORECAST_PANEL_TILT_DEG: '0' })?.panelTiltDegrees, 0);
  assert.equal(loadForecastConfig({ ...env, FORECAST_PANEL_TILT_DEG: '90' })?.panelTiltDegrees, 90);
});

test('combines east and west hourly irradiation without doubling installed capacity', async () => {
  const requests: Array<number | null> = [];
  const read = createForecastReader({ config: eastWestConfig, now, fetch: async input => {
    const url = new URL(String(input));
    const azimuth = url.searchParams.has('azimuth') ? Number(url.searchParams.get('azimuth')) : null;
    requests.push(azimuth);
    if (azimuth === null) return Response.json(providerPayload(url));
    assert.equal(url.searchParams.get('minutely_15'), azimuth === -90 ? 'global_tilted_irradiance,temperature_2m' : 'global_tilted_irradiance');
    assert.equal(url.searchParams.get('tilt'), String(tilt));
    assert.equal(url.searchParams.get('start_minutely_15'), '2026-01-15T23:15');
    assert.equal(url.searchParams.get('end_minutely_15'), '2026-01-16T23:00');
    assert.equal(url.searchParams.get('timezone'), 'GMT');
    assert.equal(url.searchParams.get('timeformat'), 'unixtime');
    return Response.json(providerPayload(url, azimuth === -90 ? 100 : 200));
  } });
  const result = await read();
  assert.deepEqual(requests, [null, -90, 90]);
  // (0.8 + 1.6) kWh/m² × 4.25 kWp × 0.85, not 8.5 kWp on both faces.
  assert.equal(result.estimatedProductionKwh, 8.7);
  assert.equal(result.model, 'east_west_tilted_radiation');
  assert.equal(result.panelTiltDegrees, tilt);
  assert.equal(result.eastFraction, 0.5);
  assert.equal(result.weatherCode, 3);
  assert.equal(result.temperatureMinC, -2.5);
  assert.equal(result.status, 'online');
});

test('weights unequal roof capacities and preserves real zero irradiance', async () => {
  const fetch: typeof globalThis.fetch = async input => { const url = new URL(String(input)); return Response.json(providerPayload(url, url.searchParams.get('azimuth') === '-90' ? 100 : 200)); };
  for (const [eastFraction, expected] of [[0, 11.6], [0.25, 10.1], [1, 5.8]]) {
    const result = await createForecastReader({ config: { ...eastWestConfig, eastFraction }, now, fetch })();
    assert.equal(result.estimatedProductionKwh, expected);
  }
  const zero = await createForecastReader({ config: eastWestConfig, now, fetch: async input => Response.json(providerPayload(new URL(String(input)), 0)) })();
  assert.equal(zero.status, 'online');
  assert.equal(zero.estimatedProductionKwh, 0);
  assert.equal(zero.hourly?.length, 24);
  assert.equal(zero.quarterHourly?.length, 96);
  assert.ok(zero.quarterHourly?.every(slot => slot.estimatedProductionKwh === 0));
  assert.ok(zero.hourly?.every(slot => slot.estimatedProductionKwh === 0));
});

test('hourly solar preserves genuine night zeros, weather and unrounded energy with complete local intervals', async () => {
  const result = await createForecastReader({ config: eastWestConfig, now, fetch: async input => Response.json(providerPayload(new URL(String(input)), 100)) })();
  assert.equal(result.hourly?.length, 24);
  assert.equal(result.hourly?.[0].start, '2026-01-15T23:00:00.000Z');
  assert.equal(result.hourly?.at(-1)?.end, '2026-01-16T23:00:00.000Z');
  assert.equal(result.hourly?.[0].estimatedProductionKwh, 0);
  assert.equal(result.hourly?.[0].temperatureC, 5);
  assert.equal(result.hourly?.[12].temperatureC, 10);
  assert.ok(result.hourly?.some(slot => slot.estimatedProductionKwh === 0.7225));
  assert.equal(Math.round(result.hourly!.reduce((sum, slot) => sum + slot.estimatedProductionKwh, 0) * 10) / 10, result.estimatedProductionKwh);
  for (let index = 1; index < result.hourly!.length; index++) assert.equal(result.hourly![index].start, result.hourly![index - 1].end);
});

test('unusable hourly temperatures retain solar without inventing heating weather', async () => {
  for (const change of [
    (body: any) => { delete body.minutely_15.temperature_2m; },
    (body: any) => { body.minutely_15.temperature_2m.pop(); },
    (body: any) => { body.minutely_15_units.temperature_2m = '°F'; },
    ...[null, '10', -101, 71].map(value => (body: any) => { body.minutely_15.temperature_2m[3] = value; }),
  ]) {
    const result = await createForecastReader({ config: eastWestConfig, now, fetch: async input => {
      const url = new URL(String(input));
      const body = providerPayload(url);
      if (url.searchParams.get('azimuth') === '-90') change(body);
      return Response.json(body);
    } })();
    assert.equal(result.status, 'online');
    assert.equal(result.estimatedProductionKwh, 5.8);
    assert.ok(result.hourly?.every(slot => slot.temperatureC === null));
  }
});

test('rejects incomplete, wrong-day or malformed tilted data from either roof face', async () => {
  const changes: Array<(body: any) => void> = [
    body => { delete body.minutely_15; },
    body => { body.minutely_15_units.global_tilted_irradiance = 'MJ/m²'; },
    body => { body.minutely_15_units.time = 'iso8601'; },
    body => { body.minutely_15.time[12] += 86_400; },
    body => { body.minutely_15.time[12] = body.minutely_15.time[11]; },
    body => { body.minutely_15.time.pop(); },
    body => { body.minutely_15.global_tilted_irradiance.pop(); },
    ...[null, '100', -1, Infinity, Number.MAX_VALUE].map(value => (body: any) => { body.minutely_15.global_tilted_irradiance.fill(value); }),
  ];
  for (const azimuth of ['-90', '90']) {
    for (const change of changes) {
      const result = await createForecastReader({ config: eastWestConfig, now, fetch: async input => {
        const url = new URL(String(input));
        const body = providerPayload(url);
        if (url.searchParams.get('azimuth') === azimuth) change(body);
        return Response.json(body);
      } })();
      assert.equal(result.status, 'offline');
      assert.equal(result.estimatedProductionKwh, null);
    }
  }
});

test('coalesces roof requests, caches the combined estimate and keeps only complete stale pairs', async () => {
  let clock = now();
  let requests = 0;
  let westFails = false;
  let radiation = 100;
  const read = createForecastReader({ config: eastWestConfig, now: () => clock, fetch: async input => {
    requests++;
    if (westFails && new URL(String(input)).searchParams.get('azimuth') === '90') throw new Error('west unavailable');
    return Response.json(providerPayload(new URL(String(input)), radiation));
  } });
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(requests, 3);
  for (const result of results) assert.equal(result.estimatedProductionKwh, 5.8);
  await read();
  assert.equal(requests, 3);
  clock = new Date(now().getTime() + 3_600_000);
  westFails = true;
  radiation = 200;
  const stale = await read();
  assert.equal(requests, 6);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.estimatedProductionKwh, 5.8, 'never combine a fresh half with a stale half');
  assert.equal(stale.fetchedAt, instant);
  await read();
  assert.equal(requests, 6, 'shared failure backoff applies to the roof pair');
  clock = new Date(clock.getTime() + 300_000);
  westFails = false;
  assert.equal((await read()).estimatedProductionKwh, 11.6);
  assert.equal(requests, 9);
});

test('tilted totals cover actual Zurich days, including preceding-quarter ending samples at DST and year boundaries', async () => {
  for (const [timestamp, expected, start, end, hours] of [
    ['2026-01-15T12:00:00Z', '2026-01-16', '2026-01-15T23:00:00.000Z', '2026-01-16T23:00:00.000Z', 24],
    ['2026-03-28T22:59:59Z', '2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-24T21:59:59Z', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
    ['2026-12-30T23:00:00Z', '2027-01-01', '2026-12-31T23:00:00.000Z', '2027-01-01T23:00:00.000Z', 24],
  ] as const) {
    const result = await createForecastReader({ config: eastWestConfig, now: () => new Date(timestamp), fetch: async input => {
      const url = new URL(String(input));
      if (!url.searchParams.has('minutely_15')) {
        assert.equal(url.searchParams.get('start_date'), expected);
        return Response.json(providerPayload(url));
      }
      assert.equal(url.searchParams.get('start_minutely_15'), new Date(Date.parse(start) + 900_000).toISOString().slice(0, 16));
      assert.equal(url.searchParams.get('end_minutely_15'), end.slice(0, 16));
      const body = tiltedPayload(100, url);
      assert.equal(body.minutely_15.time.length, hours * 4);
      assert.equal(body.minutely_15.time[0], Date.parse(start) / 1000 + 900);
      assert.equal(body.minutely_15.time.at(-1), Date.parse(end) / 1000);
      // Every preceding-quarter sample, including the final local-midnight sample, contributes once.
      body.minutely_15.global_tilted_irradiance.fill(100);
      return Response.json(body);
    } })();
    assert.equal(result.date, expected);
    assert.equal(result.status, 'online');
    assert.equal(result.productionPeriodStart, start);
    assert.equal(result.productionPeriodEnd, end);
    assert.equal(result.hourly?.length, hours);
    assert.equal(result.quarterHourly?.length, hours * 4);
    assert.equal(result.quarterHourly?.[0].start, start);
    assert.equal(result.quarterHourly?.at(-1)?.end, end);
    assert.ok(result.quarterHourly?.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 900_000));
    assert.equal(result.hourly?.[0].start, start);
    assert.equal(result.hourly?.at(-1)?.end, end);
    assert.ok(Math.abs(result.hourly!.reduce((sum, slot) => sum + slot.estimatedProductionKwh, 0) - hours * 0.1 * 8.5 * 0.85) < 1e-10);
    assert.equal(result.estimatedProductionKwh, Math.round(hours * 0.1 * 8.5 * 0.85 * 10) / 10);
  }
});

test('failure on one roof face aborts its pending peer and never returns partial production', async () => {
  const signals: AbortSignal[] = [];
  const result = await createForecastReader({ config: eastWestConfig, now, fetch: async (input, init) => {
    const signal = init!.signal!;
    signals.push(signal);
    if (new URL(String(input)).searchParams.get('azimuth') === '90') return new Response('private upstream detail', { status: 503 });
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } })();
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(result.status, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.error, 'Les prévisions météo sont indisponibles (HTTP 503).');
});

test('failure or malformed data in any of the three reads aborts all pending peers', async () => {
  for (const failedSource of ['daily', '-90', '90']) {
    for (const kind of ['http', 'data']) {
      const signals: AbortSignal[] = [];
      const result = await createForecastReader({ config: eastWestConfig, now, fetch: async (input, init) => {
        const signal = init!.signal!;
        signals.push(signal);
        const source = new URL(String(input)).searchParams.get('azimuth') ?? 'daily';
        if (source === failedSource) return kind === 'http' ? new Response('private upstream detail', { status: 503 }) : Response.json({});
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      } })();
      assert.equal(signals.length, 3);
      assert.ok(signals.every(signal => signal.aborted));
      assert.equal(result.status, 'offline');
      assert.equal(result.estimatedProductionKwh, null);
      assert.equal(result.productionPeriodStart, null);
      assert.equal(result.productionPeriodEnd, null);
      assert.equal(result.error, kind === 'http'
        ? 'Les prévisions météo sont indisponibles (HTTP 503).' : 'Les prévisions météo sont indisponibles.');
    }
  }
});

test('any failed input preserves only the previous complete weather and production snapshot', async () => {
  for (const failedSource of ['daily', '-90', '90']) {
    let clock = now();
    let fail = false;
    const read = createForecastReader({ config: eastWestConfig, now: () => clock, fetch: async input => {
      const url = new URL(String(input));
      if (fail && (url.searchParams.get('azimuth') ?? 'daily') === failedSource) return new Response('', { status: 503 });
      const body = providerPayload(url, fail ? 200 : 100);
      if (fail && 'daily' in body) body.daily.temperature_2m_mean = [2];
      return Response.json(body);
    } });
    const original = await read();
    clock = new Date(now().getTime() + 3_600_000);
    fail = true;
    const stale = await read();
    assert.equal(stale.status, 'stale');
    assert.equal(stale.estimatedProductionKwh, original.estimatedProductionKwh);
    assert.equal(stale.temperatureMeanC, original.temperatureMeanC);
    assert.equal(stale.fetchedAt, original.fetchedAt);
    assert.equal(stale.productionPeriodStart, original.productionPeriodStart);
    assert.equal(stale.productionPeriodEnd, original.productionPeriodEnd);
    assert.deepEqual(stale.hourly, original.hourly);
    assert.deepEqual(stale.quarterHourly, original.quarterHourly);
  }
});

test('shared four-second timeout aborts all three tilted reads even if JSON ignores cancellation', async () => {
  const signals: AbortSignal[] = [];
  const result = await createForecastReader({ config: eastWestConfig, now, fetch: async (_input, init) => {
    signals.push(init!.signal!);
    return { ok: true, json: () => new Promise(() => {}) } as Response;
  } })();
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(result.status, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
});


test('missing daily mean remains unknown rather than substituting temperature extremes', async () => {
  const body = payload();
  delete (body.daily as Partial<typeof body.daily>).temperature_2m_mean;
  const result = await createForecastReader({ config, now, fetch: fake(body) })();
  assert.equal(result.status, 'online');
  assert.equal(result.estimatedProductionKwh, 21.7);
  assert.equal(result.temperatureMeanC, null);
});

test('today and tomorrow readers request distinct local dates and keep independent caches', async () => {
  const requests: string[] = [];
  let todayFails = false;
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    const target = url.searchParams.get('start_date')!;
    requests.push(target);
    assert.equal(url.searchParams.get('end_date'), target);
    if (todayFails && target === '2026-01-15') throw new Error('today unavailable');
    const body = payload(target);
    body.daily.shortwave_radiation_sum = [target === '2026-01-15' ? 3.6 : 10.8];
    return Response.json(body);
  };
  let clock = now();
  const today = createForecastReader({ config, dayOffset: 0, now: () => clock, fetch });
  const tomorrow = createForecastReader({ config, now: () => clock, fetch });
  const [current, next] = await Promise.all([today(), tomorrow()]);
  assert.equal(current.date, '2026-01-15');
  assert.equal(current.estimatedProductionKwh, 7.2);
  assert.equal(next.date, date);
  assert.equal(next.estimatedProductionKwh, 21.7);
  await Promise.all([today(), tomorrow()]);
  assert.deepEqual(requests.sort(), ['2026-01-15', date]);
  clock = new Date(clock.getTime() + 3_600_000);
  todayFails = true;
  const [staleCurrent, freshNext] = await Promise.all([today(), tomorrow()]);
  assert.equal(staleCurrent.status, 'stale');
  assert.equal(staleCurrent.estimatedProductionKwh, 7.2);
  assert.equal(freshNext.status, 'online');
  assert.equal(freshNext.estimatedProductionKwh, 21.7);
});

test('two-day planning lookahead follows Zurich calendar dates across DST and year boundaries', async () => {
  for (const [timestamp, expected] of [
    ['2026-10-24T12:00:00Z', '2026-10-26'],
    ['2026-03-28T23:00:00Z', '2026-03-31'],
    ['2026-10-24T22:00:00Z', '2026-10-27'],
    ['2026-12-31T23:00:00Z', '2027-01-03'],
  ]) {
    const result = await createForecastReader({ config, dayOffset: 2, now: () => new Date(timestamp), fetch: async input => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('start_date'), expected);
      assert.equal(url.searchParams.get('end_date'), expected);
      return Response.json(payload(expected));
    } })();
    assert.equal(result.date, expected);
    assert.equal(result.status, 'online');
  }
});

test('two-day lookahead supplies complete tilted hourly data and keeps its own provider cache', async () => {
  let calls = 0;
  const read = createForecastReader({ config: eastWestConfig, dayOffset: 2, now, fetch: async input => {
    calls++;
    return Response.json(providerPayload(new URL(String(input)), 100));
  } });
  const result = await read();
  assert.equal(result.date, '2026-01-17');
  assert.equal(result.status, 'online');
  assert.equal(result.hourly!.length, 24);
  assert.equal(result.productionPeriodStart, '2026-01-16T23:00:00.000Z');
  assert.equal(result.productionPeriodEnd, '2026-01-17T23:00:00.000Z');
  await read();
  assert.equal(calls, 3, 'weather and both roof faces are fetched once for this target');
});

test('today follows the Zurich date even when UTC is still on the previous day', async () => {
  for (const [timestamp, expected] of [
    ['2026-01-15T22:59:59Z', '2026-01-15'], ['2026-01-15T23:00:00Z', '2026-01-16'],
    ['2026-03-28T23:00:00Z', '2026-03-29'], ['2026-03-29T22:00:00Z', '2026-03-30'],
    ['2026-10-24T22:00:00Z', '2026-10-25'], ['2026-10-25T23:00:00Z', '2026-10-26'],
    ['2026-12-31T23:00:00Z', '2027-01-01'],
  ]) {
    const result = await createForecastReader({ config, dayOffset: 0, now: () => new Date(timestamp), fetch: fake(payload(expected)) })();
    assert.equal(result.date, expected, timestamp);
    assert.equal(result.status, 'online', timestamp);
  }
  const disabled = await createForecastReader({ config: null, dayOffset: 0, now, fetch: async () => { throw new Error('must not fetch'); } })();
  assert.equal(disabled.date, '2026-01-15');
  assert.equal(disabled.status, 'not_configured');
  assert.equal(disabled.estimatedProductionKwh, null);
});

test('today rejects tomorrow daily data rather than displaying it for the current day', async () => {
  const result = await createForecastReader({ config, dayOffset: 0, now, fetch: fake(payload()) })();
  assert.equal(result.date, '2026-01-15');
  assert.equal(result.status, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.fetchedAt, null);
});

test('today integrates the full local day on both DST transitions rather than only remaining hours', async () => {
  for (const [timestamp, expected, start, end, hours] of [
    ['2026-03-29T12:00:00Z', '2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-25T12:00:00Z', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
  ] as const) {
    let count = 0;
    const result = await createForecastReader({ config: eastWestConfig, dayOffset: 0, now: () => new Date(timestamp), fetch: async input => {
      count++;
      const url = new URL(String(input));
      if (!url.searchParams.has('minutely_15')) {
        assert.equal(url.searchParams.get('start_date'), expected);
        return Response.json(providerPayload(url));
      }
      assert.equal(url.searchParams.get('start_minutely_15'), new Date(Date.parse(start) + 900_000).toISOString().slice(0, 16));
      assert.equal(url.searchParams.get('end_minutely_15'), end.slice(0, 16));
      const body = tiltedPayload(100, url);
      assert.equal(body.minutely_15.time.length, hours * 4);
      body.minutely_15.global_tilted_irradiance.fill(100);
      return Response.json(body);
    } })();
    assert.equal(count, 3);
    assert.equal(result.status, 'online');
    assert.equal(result.date, expected);
    assert.equal(result.productionPeriodStart, start);
    assert.equal(result.productionPeriodEnd, end);
    assert.equal(result.hourly?.length, hours);
    assert.equal(result.quarterHourly?.length, hours * 4);
    assert.equal(result.quarterHourly?.[0].start, start);
    assert.equal(result.quarterHourly?.at(-1)?.end, end);
    assert.ok(result.quarterHourly?.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 900_000));
    assert.equal(result.hourly?.[0].start, start);
    assert.equal(result.hourly?.at(-1)?.end, end);
    assert.ok(Math.abs(result.hourly!.reduce((sum, slot) => sum + slot.estimatedProductionKwh, 0) - hours * 0.1 * 8.5 * 0.85) < 1e-10);
    assert.equal(result.estimatedProductionKwh, Math.round(hours * 0.1 * 8.5 * 0.85 * 10) / 10);
  }
});

test('today never relabels a pending forecast when Zurich midnight changes its target', async () => {
  let clock = new Date('2026-10-24T21:59:59Z');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const targets: string[] = [];
  const read = createForecastReader({ config, dayOffset: 0, now: () => clock, fetch: async input => {
    const target = new URL(String(input)).searchParams.get('start_date')!;
    targets.push(target);
    await gate;
    return Response.json(payload(target));
  } });
  const pending = read();
  clock = new Date('2026-10-24T22:00:01Z');
  release();
  const result = await pending;
  assert.equal(result.date, '2026-10-25');
  assert.equal(result.status, 'offline');
  assert.equal(result.estimatedProductionKwh, null);
  assert.equal(result.fetchedAt, null);
  const refreshed = await read();
  assert.deepEqual(targets, ['2026-10-24', '2026-10-25']);
  assert.equal(refreshed.date, '2026-10-25');
  assert.equal(refreshed.status, 'online');
});

test('hourly snapshots survive prolonged outages and rollover atomically with the daily forecast', async () => {
  let clock = new Date('2026-10-24T12:00:00Z');
  let fails = false;
  const read = createForecastReader({ config: eastWestConfig, now: () => clock, fetch: async input => {
    if (fails) throw new Error('unavailable');
    return Response.json(providerPayload(new URL(String(input))));
  } });
  const original = await read();
  assert.equal(original.hourly?.length, 25);
  fails = true;
  clock = new Date('2026-10-24T13:00:00Z');
  const stale = await read();
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.hourly, original.hourly);
  clock = new Date('2026-10-24T18:00:00.001Z');
  const retained = await read();
  assert.equal(retained.status, 'stale');
  assert.equal(retained.fetchedAt, original.fetchedAt);
  assert.deepEqual(retained.hourly, original.hourly);
  assert.equal(retained.estimatedProductionKwh, original.estimatedProductionKwh);
  clock = new Date('2026-10-24T22:00:00Z');
  const rolled = await read();
  assert.equal(rolled.date, '2026-10-26');
  assert.equal(rolled.hourly, null);
  assert.equal(rolled.estimatedProductionKwh, null);
  fails = false;
  clock = new Date('2026-10-24T22:05:00Z');
  const fresh = await read();
  assert.equal(fresh.status, 'online');
  assert.equal(fresh.hourly?.length, 24);
  assert.equal(fresh.hourly?.[0].start, '2026-10-25T23:00:00.000Z');
});

test('independent quarter-hour irradiance preserves unequal targets and aggregates only for hourly display', async () => {
  const read = createForecastReader({ config: { ...eastWestConfig, arrayPowerKw: 1, performanceRatio: 1, eastFraction: .25 }, now,
    fetch: async input => {
      const url = new URL(String(input));
      if (!url.searchParams.has('minutely_15')) return Response.json(payload(url.searchParams.get('start_date')!));
      const body = tiltedPayload(0, url);
      body.minutely_15.global_tilted_irradiance.splice(0, 4, ...(url.searchParams.get('azimuth') === '-90' ? [0, 100, 200, 300] : [400, 300, 200, 100]));
      body.minutely_15.temperature_2m.splice(0, 4, 1, 2, 3, 4);
      return Response.json(body);
    } });
  const result = await read();
  assert.equal(result.status, 'online');
  assert.equal(result.quarterHourly?.length, 96);
  assert.deepEqual(result.quarterHourly!.slice(0, 4).map(slot => slot.estimatedProductionKwh), [.075, .0625, .05, .0375]);
  assert.equal(new Set(result.quarterHourly!.slice(0, 4).map(slot => slot.estimatedProductionKwh)).size, 4);
  assert.ok(Math.abs(result.hourly![0].estimatedProductionKwh - .225) < 1e-12);
  assert.equal(result.hourly![0].temperatureC, 4);
  assert.equal(result.quarterHourly![0].start, result.productionPeriodStart);
  assert.equal(result.quarterHourly!.at(-1)!.end, result.productionPeriodEnd);
  assert.equal(result.estimatedProductionKwh, .2);
  for (let index = 0; index < result.hourly!.length; index++) {
    const sum: number = result.quarterHourly!.slice(index * 4, (index + 1) * 4).reduce((total, slot) => total + slot.estimatedProductionKwh, 0);
    assert.ok(Math.abs(sum - result.hourly![index].estimatedProductionKwh) < 1e-12);
  }
});

test('independent quarters are retained by hourly cache and refresh together without extra quarter requests', async () => {
  let clock = now(), requests = 0;
  const read = createForecastReader({ config: eastWestConfig, now: () => clock, cacheAlignment: 'clock_hour', fetch: async input => {
    requests++;
    return Response.json(providerPayload(new URL(String(input))));
  } });
  const initial = await read();
  for (const minutes of [15, 30, 45]) {
    clock = new Date(now().getTime() + minutes * 60_000);
    const cached = await read();
    assert.equal(requests, 3);
    assert.deepEqual(cached.quarterHourly, initial.quarterHourly);
  }
  clock = new Date(now().getTime() + 3_600_000);
  const refreshed = await read();
  assert.equal(requests, 6);
  assert.equal(refreshed.quarterHourly?.length, 96);
  assert.equal(refreshed.fetchedAt, clock.toISOString());
});

test('long-range readers target all seven future days and report the longer-range weather model', async () => {
  for (const dayOffset of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    const target = `2026-01-${String(15 + dayOffset).padStart(2, '0')}`;
    const urls: URL[] = [];
    const read = createForecastReader({ config: { ...config, weatherModel: 'meteoswiss_icon_ch2' }, dayOffset, now,
      fetch: async url => { urls.push(new URL(String(url))); return Response.json(payload(target)); } });
    const result = await read();
    assert.equal(result.status, 'online'); assert.equal(result.date, target);
    assert.equal(result.weatherModel, dayOffset < 3 ? 'meteoswiss_icon_ch2' : 'best_match');
    assert.equal(urls[0].searchParams.get('start_date'), target);
    assert.equal(urls[0].searchParams.get('models'), dayOffset < 3 ? 'meteoswiss_icon_ch2' : null);
  }
});

test('the final forecast and lookahead days retain complete tilted quarter profiles with the long-range model', async () => {
  for (const dayOffset of [7, 8] as const) {
    let requests = 0;
    const read = createForecastReader({ config: { ...eastWestConfig, weatherModel: 'meteoswiss_icon_ch2' }, dayOffset, now,
      fetch: async input => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get('models'), null);
        return Response.json(url.searchParams.has('minutely_15') ? tiltedPayload(100, url) : providerPayload(url));
      } });
    const result = await read();
    assert.equal(result.status, 'online'); assert.equal(result.weatherModel, 'best_match');
    assert.equal(result.date, `2026-01-${15 + dayOffset}`);
    assert.equal(result.quarterHourly?.length, 96); assert.equal(result.hourly?.length, 24);
    await read(); assert.equal(requests, 3);
  }
});
