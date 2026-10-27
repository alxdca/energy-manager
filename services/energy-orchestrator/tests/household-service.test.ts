import test from 'node:test';
import assert from 'node:assert/strict';
import { createHouseholdService, type HouseholdTrainingRun } from '../src/household-service.js';
import { householdDaySlots, shiftDate, type HouseholdForecast, type HouseholdModel, type HouseholdObservation } from '../src/household-model.js';
import { createHouseholdWeather } from '../src/household-weather.js';
import { createApi } from '../src/api.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(initialModel: HouseholdModel | null = null) {
  let at = new Date('2026-10-27T11:00:00Z');
  let saved = initialModel, failRead = false, trainingGate: ReturnType<typeof deferred> | undefined;
  const models: HouseholdTrainingRun[] = [], forecasts = new Map<string, HouseholdForecast>();
  const observations: HouseholdObservation[] = householdDaySlots('2026-10-26').map(s => ({ at: new Date(Date.parse(s.end) - 30000).toISOString(), value: 250 }));
  let reads = 0, finalized = 0, weatherReads = 0;
  const service = createHouseholdService({ now: () => new Date(at),
    fallback: { baselinePowerW: 800, windowHours: 24 },
    finalizeMeasurements: async () => { finalized++; },
    archive: {
      async readObservations(start, end) { reads++; if (failRead) throw new Error('database offline');
        return observations.filter(p => Date.parse(p.at) >= start.getTime() && Date.parse(p.at) < end.getTime()); },
      async readModel() { return saved; },
      async saveTraining(run) { await trainingGate?.promise; models.push(structuredClone(run)); saved = structuredClone(run.model); },
      async saveForecasts(values) { for (const value of values) forecasts.set(value.date, structuredClone(value)); },
      async readForecast(date) { return structuredClone(forecasts.get(date) ?? null); },
    },
    weather: { async read() { weatherReads++; return undefined; } },
  });
  return { service, models, forecasts, observations,
    counts: () => ({ reads, finalized, weatherReads }), now: () => at,
    setTime: (value: string) => { at = new Date(value); },
    failRead: () => { failRead = true; },
    blockTraining: () => { trainingGate = deferred(); return trainingGate; },
  };
}

test('quarter-hour updates reuse trained profiles; a new Zurich day trains once', async () => {
  const f = fixture(); await f.service.refresh();
  assert.equal(f.models.length, 1); assert.equal(f.forecasts.size, 9);
  const id = f.service.status().modelId;
  f.setTime('2026-10-27T11:15:00Z'); await f.service.refresh();
  f.setTime('2026-10-27T11:30:00Z'); await f.service.refresh();
  assert.equal(f.models.length, 1); assert.equal(f.counts().finalized, 1);
  assert.equal(f.forecasts.get('2026-10-28')!.modelId, id);
  f.setTime('2026-10-27T23:00:00Z'); await f.service.refresh();
  assert.equal(f.models.length, 2); assert.notEqual(f.service.status().modelId, id);
});

test('manual learning incorporates today’s available household readings into the saved forecasts', async () => {
  const f = fixture(); await f.service.refresh();
  f.observations.push({ at: '2026-10-27T07:14:30Z', value: 1000 },
    { at: '2026-10-27T11:15:30Z', value: 999999 });
  await f.service.train();
  const trained = f.models.at(-1)!.model;
  assert.equal(trained.training.to, '2026-10-27');
  assert.equal(trained.training.observations, 97);
  assert.equal(trained.training.completeSamplingDays, 1);
  const slot = f.forecasts.get('2026-10-28')!.slots.find(s => s.start === '2026-10-28T07:00:00.000Z')!;
  assert.equal(slot.observations, 2);
  const weight = 2 ** (-1 / 14);
  assert.ok(Math.abs(slot.estimatedConsumptionKwh! - (1 + .25 * weight) / (1 + weight)) < 1e-8);
});

test('saved models from before current-day learning rebuild once, then reuse the updated model', async () => {
  const original = fixture(); await original.service.refresh();
  const legacy = structuredClone(original.models[0].model);
  legacy.training.to = '2026-10-26';
  const upgraded = fixture(legacy); await upgraded.service.refresh(); await upgraded.service.refresh();
  assert.equal(upgraded.models.length, 1);
  assert.equal(upgraded.models[0].model.training.to, '2026-10-27');
  const restarted = fixture(upgraded.models[0].model); await restarted.service.refresh();
  assert.equal(restarted.models.length, 0);
});

test('training freezes its cutoff after weather and finalization, including across Zurich midnight and slow history I/O', async () => {
  let clock = new Date('2026-10-27T22:59:59Z');
  const cutoff = '2026-10-27T23:15:00.000Z';
  const observations = [{ at: '2026-10-27T22:59:30Z', value: 250 },
    { at: '2026-10-27T23:14:30Z', value: 500 }, { at: '2026-10-27T23:29:30Z', value: 999999 }];
  const models: HouseholdTrainingRun[] = [];
  const reads: Array<{ start: string; end: string; availableAt: string }> = [];
  const service = createHouseholdService({ now: () => new Date(clock),
    finalizeMeasurements: async () => {
      assert.equal(clock.toISOString(), '2026-10-27T23:00:00.000Z');
      clock = new Date(cutoff);
    },
    weather: { async read(kind) {
      if (kind !== 'historical') return undefined;
      clock = new Date('2026-10-27T23:00:00Z');
      return { kind, source: 'Open-Meteo' as const, model: 'era5_land', latitude: 47, longitude: 8,
        fetchedAt: clock.toISOString(), availableAt: clock.toISOString(), originalStepMinutes: 60 as const, points: [] };
    } },
    archive: {
      async readModel() { return null; },
      async readObservations(start, end, availableAt) {
        reads.push({ start: start.toISOString(), end: end.toISOString(), availableAt: availableAt.toISOString() });
        clock = new Date('2026-10-27T23:30:00Z');
        return observations.filter(p => Date.parse(p.at) >= start.getTime() && Date.parse(p.at) < end.getTime());
      },
      async saveTraining(run) { models.push(run); }, async saveForecasts() {}, async readForecast() { return null; },
    },
  });
  await service.train();
  assert.equal(reads[0].end, cutoff); assert.equal(reads[0].availableAt, cutoff);
  assert.equal(reads[0].start, '2026-08-04T22:00:00.000Z');
  assert.equal(models[0].model.trainedAt, cutoff);
  assert.equal(models[0].model.trainingDate, '2026-10-28');
  assert.equal(models[0].model.training.to, '2026-10-28');
  assert.equal(models[0].model.training.observations, 2);
  assert.equal(models[0].model.weatherStatus, 'insufficient_history');
  assert.deepEqual(models[0].model.weatherLocation, { latitude: 47, longitude: 8 });
  assert.deepEqual(models[0].observations, observations.slice(0, 2));
});

test('manual full training reloads history and recalculates today plus the next two days immediately', async () => {
  const f = fixture(); await f.service.refresh(); const id = f.service.status().modelId;
  f.observations.forEach(p => { p.value = 500; }); f.setTime('2026-10-27T11:05:00Z');
  await f.service.train();
  assert.equal(f.models.length, 2); assert.equal(f.counts().finalized, 2);
  assert.notEqual(f.service.status().modelId, id);
  for (const date of ['2026-10-27', '2026-10-28', '2026-10-29']) {
    assert.equal(f.forecasts.get(date)!.estimatedConsumptionKwh, 48);
    assert.equal(f.forecasts.get(date)!.issuedAt, f.now().toISOString());
  }
});

test('concurrent manual and scheduled training requests share a single training job', async () => {
  const f = fixture(), gate = f.blockTraining();
  const first = f.service.train(); await tick();
  assert.equal(f.service.status().state, 'training');
  const second = f.service.train(), third = f.service.refresh();
  assert.equal(first, second); assert.equal(first, third);
  gate.resolve(); await Promise.all([first, second, third]);
  assert.equal(f.models.length, 1); assert.equal(f.service.status().state, 'idle');
});

test('training failures remain visible and use a labeled baseline instead of an expired learned model', async () => {
  const f = fixture(); await f.service.refresh();
  f.failRead(); f.setTime('2026-10-28T11:00:00Z');
  await assert.rejects(f.service.train(), /apprentissage/);
  assert.equal(f.service.status().state, 'error');
  assert.ok(Math.abs(f.forecasts.get('2026-10-28')!.estimatedConsumptionKwh! - 19.2) < 1e-8);
  assert.equal(f.forecasts.get('2026-10-28')!.source, 'configured_baseline');
  assert.equal(f.forecasts.get('2026-10-28')!.modelId, null);
  assert.equal(f.forecasts.get('2026-10-28')!.fallbackReason, 'training_failed');
});

test('recent fallback readings cross midnight and refresh every quarter without retraining', async () => {
  const f = fixture();
  f.setTime('2026-10-26T23:15:00Z'); // 00:15 in Zurich: the window must include the previous local day.
  f.observations.splice(0, f.observations.length, ...Array.from({ length: 4 }, (_, i) => ({
    at: new Date(f.now().getTime() - i * 900000 - 30000).toISOString(), value: 500,
  })));
  await f.service.refresh();
  const original = f.forecasts.get('2026-10-28')!;
  assert.equal(original.fallback!.samples, 4);
  // Some local slots already have learned references; the remaining ones use the average.
  assert.ok(original.fallback!.appliedSlots > 0); assert.equal(original.fallback!.source, 'recent_average');
  f.setTime('2026-10-26T23:30:00Z');
  f.observations.push({ at: '2026-10-26T23:29:30Z', value: 1500 });
  await f.service.refresh();
  const refreshed = f.forecasts.get('2026-10-28')!;
  assert.ok(Math.abs(refreshed.fallback!.averagePowerW! - 2800) < 1e-8);
  assert.equal(f.models.length, 1, 'refreshing the fallback must not run daily training again');
});

test('household API GETs only read; POST starts full training asynchronously and rejects cross-origin requests', async () => {
  const f = fixture(); await f.service.refresh();
  const api = createApi({ controllerUrl: null, household: f.service, now: f.now, tesla: { tokensPath: null } });
  const counts = f.counts();
  assert.equal((await api.request('/api/household/training')).status, 200);
  assert.equal((await api.request('/api/household/forecast?date=2026-10-28')).status, 200);
  assert.equal((await api.request('/api/household/forecast?date=2026-02-30')).status, 400);
  assert.deepEqual(f.counts(), counts);
  const foreign = await api.request('/api/household/training', { method: 'POST', headers: { Origin: 'https://foreign.example' } });
  assert.equal(foreign.status, 403); assert.equal(f.models.length, 1);
  const crossSite = await api.request('/api/household/training', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const gate = f.blockTraining();
  const response = await api.request('/api/household/training', { method: 'POST' });
  assert.equal(response.status, 202); assert.equal((await response.json()).accepted, true);
  assert.equal(f.service.status().state, 'training');
  gate.resolve(); await f.service.stop();
  assert.equal(f.models.length, 2);
});

test('temperature requests are independent of panel geometry, hourly cached, validated and archived', async () => {
  let at = new Date('2026-10-27T11:00:00Z');
  const requests: URL[] = [], stored: unknown[] = [], archiveModels: string[] = [];
  let bad = false;
  const reader = createHouseholdWeather({ config: { latitude: 47, longitude: 8, locationName: 'home', arrayPowerKw: 8, performanceRatio: .85, weatherModel: 'meteoswiss_icon_ch2' },
    now: () => new Date(at), archive: { async readWeather(_kind, config) { archiveModels.push(config.weatherModel!); return null; }, async saveWeather(w) { stored.push(w); } },
    fetch: async url => { requests.push(new URL(String(url))); return Response.json({ hourly_units: { time: 'unixtime', temperature_2m: bad ? 'K' : '°C' },
      hourly: { time: [1793098800, 1793102400], temperature_2m: [10, 11] } }); },
  });
  const initial = await reader.read('forecast'); assert.ok(initial); assert.equal(initial.originalStepMinutes, 60);
  assert.equal(requests[0].searchParams.get('hourly'), 'temperature_2m');
  assert.equal(requests[0].searchParams.get('end_date'), '2026-11-05');
  assert.equal(requests[0].searchParams.get('models'), null);
  assert.equal(archiveModels[0], 'best_match');
  await reader.read('forecast'); at = new Date('2026-10-27T11:15:00Z'); await reader.read('forecast');
  assert.equal(requests.length, 1);
  at = new Date('2026-10-27T12:00:00Z'); bad = true;
  assert.equal((await reader.read('forecast'))!.fetchedAt, initial.fetchedAt);
  assert.equal(requests.length, 2); assert.equal(stored.length, 1);
  bad = false; await reader.read('historical');
  assert.equal(requests[2].hostname, 'archive-api.open-meteo.com');
  assert.equal(requests[2].searchParams.get('models'), 'era5_land');
  assert.equal(requests[2].searchParams.get('end_date'), shiftDate('2026-10-27', -6));
});
