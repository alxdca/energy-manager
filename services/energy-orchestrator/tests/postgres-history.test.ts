import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPostgresHistory } from '../src/postgres-history.js';
import { createApi } from '../src/api.js';
import { emptySolarForecast, type SolarForecast } from '../src/forecast.js';
import { estimateConsumption } from '../src/consumption.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { ObservationSample } from '../src/observation-types.js';
import type { Telemetry } from '../src/status.js';
import type { BatteryProjection } from '../src/battery-projection.js';
import { createHouseholdService } from '../src/household-service.js';
import { householdDaySlots, trainHouseholdModel } from '../src/household-model.js';
import { createEstimateService } from '../src/estimate-service.js';
import { forecastDayOffsets } from '../src/forecast-horizon.js';
import type { AutomationStatus } from '../src/automation.js';

// Only this explicitly supplied disposable database authorizes schema deletion.
// Operational DATABASE_URL is never read by the integration suite.
const databaseUrl = process.env.TEST_DATABASE_URL;
const at = '2026-01-15T12:00:00.000Z';
const date = '2026-01-15';
const advance = (seconds: number, origin = at) => new Date(Date.parse(origin) + seconds * 1000).toISOString();
type History = Awaited<ReturnType<typeof createPostgresHistory>>;
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function sample(seconds: number, solar = 1000, household = 5000, soc = 50, source = 'inverter-1', origin = at): ObservationSample {
  const time = advance(seconds, origin);
  return { battery: { at: time, value: soc }, solar: { at: time, value: solar, source },
    household: { at: time, value: household, source: `${source}/meter-1` } };
}
function telemetry(time: string, soc = 50): Telemetry {
  return { status: 'online', observedAt: time, error: null, solarKw: 2, householdKw: 1,
    gridImportKw: 0, gridExportKw: 1, batterySocPercent: soc, batteryChargeKw: 1, batteryDischargeKw: 0 };
}
function projection(time = at, target = advance(900), socPercent = 60): BatteryProjection {
  return { status: 'available', reason: null, assumption: 'automatic_planning', observedAt: time,
    points: [{ at: target, socPercent }] };
}
function solar(time = at): SolarForecast {
  const consumption = estimateConsumption(date, { baselinePowerW: 500 });
  return { ...emptySolarForecast(date, null), status: 'online', fetchedAt: time, estimatedProductionKwh: 12,
    hourly: consumption.hourly.map(point => ({ start: point.start, end: point.end,
      estimatedProductionKwh: point.start === at ? 12 : 0, temperatureC: 10 })),
    quarterHourly: consumption.quarterHourly.map(point => ({ start: point.start, end: point.end,
      estimatedProductionKwh: point.start >= at && point.start < advance(3600) ? 3 : 0, temperatureC: 10 })),
  };
}
async function database(t: TestContext) {
  assert.ok(databaseUrl);
  const admin = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS energy_history CASCADE');
  const histories = new Set<History>();
  t.after(async () => {
    for (const history of histories) await history.close().catch(() => {});
    try {
      await admin.query('DROP SCHEMA IF EXISTS energy_history CASCADE');
    } finally { await admin.end(); }
  });
  async function open(now = () => new Date(at)) {
    const history = await createPostgresHistory({ connectionString: databaseUrl!, now });
    histories.add(history); return history;
  }
  const count = async (table: string) => Number((await admin.query(`SELECT count(*) FROM energy_history.${table}`)).rows[0].count);
  const checkpoint = async () => (await admin.query("SELECT value FROM energy_history.metadata WHERE key = 'observation_checkpoint_v1'")).rows[0]?.value;
  return { admin, open, count, checkpoint };
}
async function terminateWriter(admin: pg.Client) {
  const result = await admin.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 735902 AND objid = 1 AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  assert.equal(result.rows.length, 1);
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()', [result.rows[0].pid]);
  await new Promise(resolve => setTimeout(resolve, 25));
}

async function createLegacyTraining(admin: pg.Client) {
  await admin.query(`CREATE TABLE energy_history.household_training (
    id uuid PRIMARY KEY, trained_at timestamptz NOT NULL, model jsonb NOT NULL, inputs jsonb NOT NULL)`);
}
function savedModel(id = '00000000-0000-4000-8000-000000000003', trainedAt = at) {
  return trainHouseholdModel({ id, at: new Date(trainedAt), observations: [{ at: advance(-900), value: 250 }] });
}

test('PostgreSQL finalized observation persistence', { skip: !databaseUrl }, async t => {
  await t.test('fresh observation tables have exactly a real timestamp and value, with valid fixed units', async t => {
    const f = await database(t); await f.open();
    for (const table of ['battery_observations', 'solar_observations', 'house_observations']) {
      const columns = await f.admin.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'energy_history' AND table_name = $1 ORDER BY ordinal_position`, [table]);
      assert.deepEqual(columns.rows.map(row => row.column_name), ['observed_at', 'value']);
      await f.admin.query(`INSERT INTO energy_history.${table} VALUES ($1, 0)`, [advance(29.125)]);
      for (const value of [-1, Infinity, NaN]) await assert.rejects(f.admin.query(`INSERT INTO energy_history.${table} VALUES ($1, $2)`, [advance(30), value]), { code: '23514' });
    }
    await assert.rejects(f.admin.query('INSERT INTO energy_history.battery_observations VALUES ($1,101)', [advance(31)]), { code: '23514' });
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key = 'schema_version'")).rows[0].value, 9);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.energy_days') AS name")).rows[0].name, null);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.telemetry_samples') AS name")).rows[0].name, null);
  });

  await t.test('thirty-second candidates stay in RAM and only the last strictly-before-target samples finalize', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    for (const [seconds, energy, soc] of [[0, 1000, 40], [30, 1010, 41], [870, 1200, 42]]) {
      now = new Date(advance(seconds)); history.record(sample(seconds, energy, energy + 4000, soc), now); await history.flush();
      assert.equal(await f.count('battery_observations'), 0);
      assert.equal(await f.count('solar_observations'), 0);
      assert.equal(await f.count('house_observations'), 0);
      assert.deepEqual((await history.historyReader.day(date, now)).battery.points, []);
      const state = await f.checkpoint();
      assert.ok(!state || state.solar === null, 'unfinalized counters cannot leak into metadata');
    }
    now = new Date(advance(900)); history.record(sample(900, 1250, 5250, 99), now);
    const pending = await history.historyReader.day(date, now);
    assert.deepEqual(pending.battery.points, [{ at: advance(870), socPercent: 42 }]);
    await history.flush();
    assert.equal(await f.count('battery_observations'), 1);
    assert.equal(await f.count('solar_observations'), 0, 'the first counter selection establishes a baseline');
    assert.equal((await f.checkpoint()).solar.sample.value, 1200);
    now = new Date(advance(1770)); history.record(sample(1770, 1500, 5600, 45), now);
    now = new Date(advance(1800)); history.record(sample(1800, 1550, 5650, 46), now);
    const day = await history.historyReader.day(date, now);
    assert.deepEqual(day.observations!.solar, [{ at: advance(1770), value: 300 }]);
    assert.deepEqual(day.observations!.household, [{ at: advance(1770), value: 400 }]);
    assert.equal(await f.count('solar_observations'), 0, 'finalized pending data is readable before durable flush');
    await history.flush(); await history.flush();
    const rows = await f.admin.query('SELECT observed_at, value FROM energy_history.solar_observations');
    assert.deepEqual(rows.rows, [{ observed_at: new Date(advance(1770)), value: 300 }]);
    assert.equal(await f.count('battery_observations'), 2);
    assert.equal((await f.admin.query("SELECT count(*) FROM energy_history.metadata WHERE key = 'energy_checkpoint'")).rows[0].count, '0');
    near(day.dailyEnergy.solar.energyKwh, .3);
    assert.equal(day.dailyEnergy.method, 'recorded_energy');
    assert.equal(day.dailyEnergy.solar.coverageSeconds, 0, 'counter differences do not invent measured power coverage');
  });

  await t.test('shutdown discards current candidates and restart resumes only from finalized counter baselines', async t => {
    const f = await database(t); let now = new Date(at); let history = await f.open(() => now);
    now = new Date(advance(870)); history.record(sample(870, 1200), now);
    now = new Date(advance(900)); await history.flush();
    now = new Date(advance(1200)); history.record(sample(1200, 1300), now);
    await history.close();
    assert.equal((await f.checkpoint()).solar.sample.value, 1200);
    assert.equal(await f.count('solar_observations'), 0);
    now = new Date(advance(1500)); history = await f.open(() => now);
    now = new Date(advance(1770)); history.record(sample(1770, 1500), now);
    now = new Date(advance(1800)); await history.flush();
    assert.deepEqual((await history.historyReader.day(date, now)).observations!.solar, [{ at: advance(1770), value: 300 }]);
    await history.close();
    now = new Date(advance(4000)); history = await f.open(() => now);
    now = new Date(advance(4470)); history.record(sample(4470, 3000), now);
    now = new Date(advance(4500)); await history.flush();
    assert.equal(await f.count('solar_observations'), 1, 'a multi-quarter gap is rebaselined instead of saved as one quarter');
    now = new Date(advance(5370)); history.record(sample(5370, 3200), now);
    now = new Date(advance(5400)); await history.flush();
    assert.deepEqual((await history.historyReader.day(date, now)).observations!.solar.map(point => point.value), [300, 200]);
  });

  await t.test('counter resets and source changes rebaseline independently without invented zeroes', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    for (const [seconds, pv, load, identity] of [[870, 1000, 5000, 'a'], [1770, 100, 5100, 'a'], [2670, 150, 20, 'b'], [3570, 200, 80, 'b']] as const) {
      now = new Date(advance(seconds)); history.record(sample(seconds, pv, load, 50, identity), now);
      now = new Date(advance(seconds + 30)); await history.flush();
    }
    const day = await history.historyReader.day(date, now);
    assert.deepEqual(day.observations!.solar.map(point => point.value), [50]);
    assert.deepEqual(day.observations!.household.map(point => point.value), [100, 60]);
    assert.equal(day.battery.points.length, 4);
  });

  await t.test('failed transactions retain pending rows and atomically retry their finalized baseline', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    now = new Date(advance(870)); history.record(sample(870, 1000), now);
    now = new Date(advance(900)); await history.flush();
    const baseline = await f.checkpoint();
    now = new Date(advance(1770)); history.record(sample(1770, 1250), now);
    now = new Date(advance(1800));
    await f.admin.query(`CREATE FUNCTION energy_history.reject_observation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test observation outage'; END $$`);
    await f.admin.query(`CREATE TRIGGER reject_observation BEFORE INSERT ON energy_history.house_observations
      FOR EACH ROW EXECUTE FUNCTION energy_history.reject_observation()`);
    await assert.rejects(history.flush(), /test observation outage/);
    assert.equal(await f.count('house_observations'), 0);
    assert.equal(await f.count('solar_observations'), 0);
    assert.equal(await f.count('battery_observations'), 1);
    assert.deepEqual(await f.checkpoint(), baseline);
    assert.equal((await history.dailyEnergyStore.summary(date, now)).storageStatus, 'error');
    assert.deepEqual((await history.historyReader.day(date, now)).observations!.solar, [{ at: advance(1770), value: 250 }]);
    await f.admin.query('DROP TRIGGER reject_observation ON energy_history.house_observations');
    await Promise.all([history.flush(), history.flush()]);
    assert.equal(await f.count('solar_observations'), 1);
    assert.equal(await f.count('house_observations'), 1);
    assert.equal(await f.count('battery_observations'), 2);
    assert.equal((await f.checkpoint()).solar.sample.value, 1250);
    assert.equal((await history.dailyEnergyStore.summary(date, now)).storageStatus, 'ready');
  });

  await t.test('fast safety telemetry stays separate from observation candidates', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    for (const seconds of [0, 5, 10, 15, 30]) {
      now = new Date(advance(seconds)); history.recordTelemetry(telemetry(now.toISOString()), now); await history.flush();
    }
    for (const table of ['battery_observations', 'solar_observations', 'house_observations']) assert.equal(await f.count(table), 0);
    const state = await f.checkpoint();
    assert.ok(!state || state.solar === null);
    assert.equal((await f.admin.query("SELECT count(*) FROM energy_history.metadata WHERE key = 'energy_checkpoint'")).rows[0].count, '0');
    assert.equal((await f.admin.query("SELECT count(*) FROM energy_history.metadata WHERE key = 'battery_origin_checkpoint_v1'")).rows[0].count, '1');
  });

  await t.test('physical sample dates drive energy summaries at midnight and on DST days without redistribution', async t => {
    const f = await database(t); const now = new Date('2026-10-27T00:00:00Z'); const history = await f.open(() => now);
    await f.admin.query(`INSERT INTO energy_history.solar_observations VALUES
      ('2026-10-24T21:59:30Z', 100), ('2026-10-24T22:14:30Z', 200), ('2026-10-25T00:14:30Z', 300), ('2026-10-25T01:14:30Z', 400)`);
    near((await history.dailyEnergyStore.summary('2026-10-24', now)).solar.energyKwh, .1);
    const day = await history.historyReader.day('2026-10-25', now);
    near(day.dailyEnergy.solar.energyKwh, .9);
    assert.equal(day.measurements.hours.length, 25);
    assert.deepEqual(day.observations!.solar.map(point => point.at), ['2026-10-24T22:14:30.000Z', '2026-10-25T00:14:30.000Z', '2026-10-25T01:14:30.000Z']);
    const listed = await history.dailyEnergyStore.days(1, now);
    assert.equal(listed[0].date, '2026-10-25');
    assert.equal((await history.dailyEnergyStore.days(1, now, listed[0].date))[0].date, '2026-10-24');
    assert.deepEqual((await history.historyReader.day('2020-01-01', now)).observations!.solar, []);
  });

  await t.test('empty startup and restart retain only the current schema without creating observations', async t => {
    const f = await database(t); let history = await f.open();
    for (const table of ['battery_observations', 'house_observations', 'solar_observations',
      'battery_forecasts', 'house_forecasts', 'solar_forecasts']) assert.equal(await f.count(table), 0);
    const tables = await f.admin.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'energy_history' ORDER BY table_name`);
    assert.deepEqual(tables.rows.map(row => row.table_name), ['battery_forecasts', 'battery_observations',
      'house_forecasts', 'house_observations', 'household_weather',
      'metadata', 'solar_forecasts', 'solar_observations']);
    assert.deepEqual(await history.dailyEnergyStore.days(), []);
    const day = await history.historyReader.day(date);
    assert.equal(day.dailyEnergy.status, 'unavailable');
    assert.deepEqual(day.battery.points, []);
    assert.deepEqual(day.observations, { method: 'counter_differences', solar: [], household: [] });
    assert.deepEqual(day.historicalEstimated.points, []);
    assert.deepEqual(day.energyEstimates, []);
    assert.deepEqual(day.solarEstimates, []);
    await history.close(); history = await f.open();
    assert.deepEqual(await history.historyReader.day(date), day);
  });

  await t.test('v6 migration preserves the two-column observations without creating an interval table', async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    await f.admin.query(`DROP TABLE energy_history.household_weather;
      UPDATE energy_history.metadata SET value = '6'::jsonb WHERE key = 'schema_version'`);
    await f.admin.query('INSERT INTO energy_history.house_observations VALUES ($1, 250)', [advance(-30)]);
    const upgraded = await f.open();
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key = 'schema_version'")).rows[0].value, 9);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.house_intervals') AS name")).rows[0].name, null);
    const observations = await upgraded.householdArchive.readObservations(new Date(advance(-900)), new Date(at), new Date(at));
    assert.deepEqual(observations, [{ at: advance(-30), value: 250 }]);
  });

  await t.test('training reads finalized fixed quarters directly from unmodified observations', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    now = new Date(advance(870)); history.record(sample(870, 1000, 5000), now);
    now = new Date(advance(1770)); history.record(sample(1770, 1250, 5500), now);
    now = new Date(advance(1800)); await history.flush();
    const observations = await history.householdArchive.readObservations(new Date(at), now, now);
    assert.deepEqual(observations, [{ at: advance(1770), value: 500 }]);
    assert.deepEqual(await history.householdArchive.readObservations(new Date(at), now, new Date(advance(1790))), []);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.house_intervals') AS name")).rows[0].name, null);
  });

  await t.test('existing interval tables are ignored and preserved on restart and collection', async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    // An incompatible legacy table proves neither collection nor training depends on it.
    await f.admin.query('CREATE TABLE energy_history.house_intervals (observed_at timestamptz PRIMARY KEY)');
    await f.admin.query('INSERT INTO energy_history.house_intervals VALUES ($1)', [at]);
    let now = new Date(at); const history = await f.open(() => now);
    now = new Date(advance(870)); history.record(sample(870, 1000, 5000), now);
    now = new Date(advance(1770)); history.record(sample(1770, 1250, 5500), now);
    now = new Date(advance(1800)); await history.flush();
    assert.deepEqual(await history.householdArchive.readObservations(new Date(at), now, now), [{ at: advance(1770), value: 500 }]);
    assert.deepEqual((await f.admin.query('SELECT * FROM energy_history.house_intervals')).rows, [{ observed_at: new Date(at) }]);
  });

  await t.test('household training and canonical estimates survive restart separately from battery control', async t => {
    const f = await database(t); let now = new Date(at); let history = await f.open(() => now);
    const observations = householdDaySlots('2026-01-14').map(slot => ({ at: new Date(Date.parse(slot.end) - 30000).toISOString(), value: 250 }));
    await f.admin.query(`INSERT INTO energy_history.house_observations (observed_at,value)
      SELECT x.at::timestamptz,x.value FROM jsonb_to_recordset($1::jsonb) x(at text,value double precision)`, [JSON.stringify(observations)]);
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now, weather: { async read() { return undefined; } },
      finalizeMeasurements: history.flush });
    await service.train();
    const original = await history.householdArchive.readForecast('2026-01-16');
    assert.ok(original); assert.equal(original.estimatedConsumptionKwh, 24); assert.equal(original.scope, 'household_total');
    assert.ok(await f.count('house_forecasts') > 0);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.household_forecasts') AS name")).rows[0].name, null);
    const day = await history.historyReader.day('2026-01-16', now);
    assert.equal(day.householdPredictions!.length, 96);
    near(day.householdPredictions![0].estimatedConsumptionKwh!, .25);
    const today = await history.historyReader.day(date, now);
    assert.ok(today.householdPredictions!.every(p => p.start >= at), 'no retroactive forecasts');
    now = new Date(advance(60)); await service.train();
    const stored = (await f.admin.query("SELECT value FROM energy_history.metadata WHERE key = 'household_model_v1'")).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.id, service.status().modelId);
    assert.notEqual(stored[0].value.id, original.modelId);
    assert.equal('inputs' in stored[0].value, false);
    assert.equal('observations' in stored[0].value, false);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.household_training') AS name")).rows[0].name, null);
    assert.deepEqual((await history.historyReader.day('2026-01-16', now)).energyEstimates, day.energyEstimates);
    const latest = await history.householdArchive.readForecast('2026-01-16');
    await history.close(); history = await f.open(() => now);
    assert.deepEqual(await history.householdArchive.readForecast('2026-01-16'), latest);
    assert.equal((await history.householdArchive.readModel())!.id, latest!.modelId);
    const restored = createHouseholdService({ archive: history.householdArchive, now: () => now, weather: { async read() { return undefined; } } });
    await restored.refresh();
    assert.equal(restored.status().modelId, service.status().modelId, 'restart reuses the saved model');
    assert.deepEqual(restored.status().training, service.status().training);
    assert.equal(restored.status().lastTrainedAt, service.status().lastTrainedAt);
  });

  await t.test('baseline and recent-average fallback provenance persists with immutable as-issued predictions', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now,
      fallback: { baselinePowerW: 1250, windowHours: 24 }, weather: { async read() { return undefined; } } });
    await service.train();
    const baseline = await history.householdArchive.readForecast('2026-01-16');
    assert.equal(baseline!.source, 'configured_baseline'); near(baseline!.estimatedConsumptionKwh, 30);
    assert.equal((await history.historyReader.day('2026-01-16', now)).householdPredictions![0].source, 'configured_baseline');
    for (let i = 0; i < 4; i++) await f.admin.query('INSERT INTO energy_history.house_observations VALUES ($1,500)', [advance(-30 - i * 900)]);
    now = new Date(advance(60)); await service.train();
    const average = await history.householdArchive.readForecast('2026-01-16');
    assert.equal(average!.source, 'mixed');
    assert.equal(average!.fallback!.source, 'recent_average'); near(average!.estimatedConsumptionKwh, 48);
    const chart = await history.historyReader.day('2026-01-16', now);
    assert.equal(chart.householdPredictions!.length, 96);
    assert.ok(chart.householdPredictions!.every(p => ['learned_profile', 'recent_average'].includes(p.source!) && p.estimatedConsumptionKwh === .5));
    assert.equal(chart.householdPredictions!.filter(p => p.source === 'learned_profile').length, 4);
    assert.deepEqual(chart.householdPredictions, chart.energyEstimates);
    assert.ok((await history.historyReader.day(date, now)).householdPredictions!.every(p => p.start >= at), 'fallback never backfills past forecasts');
  });

  await t.test('household estimates freeze started quarters, replace future quarters and reject older batches after restart', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    const fallback = { baselinePowerW: 1000, windowHours: 24 };
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now,
      fallback, weather: { async read() { return undefined; } } });
    await service.train();
    const old = (await history.householdArchive.readForecast('2026-01-16'))!;
    const originalCount = await f.count('house_forecasts');
    fallback.baselinePowerW = 2000;
    now = new Date(advance(900)); await service.refresh();
    const day = await history.historyReader.day(date, now);
    near(day.energyEstimates.find(p => p.start === at)!.estimatedConsumptionKwh, .25);
    near(day.energyEstimates.find(p => p.start === advance(900))!.estimatedConsumptionKwh, .25);
    near(day.energyEstimates.find(p => p.start === advance(1800))!.estimatedConsumptionKwh, .5);
    assert.deepEqual(day.householdPredictions, day.energyEstimates);
    assert.equal(await f.count('house_forecasts'), originalCount);
    const latest = await history.householdArchive.readForecast('2026-01-16');
    near(latest!.estimatedConsumptionKwh, 48);
    const metadata = JSON.stringify((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key = 'household_forecast_v1'")).rows[0].value);
    assert.doesNotMatch(metadata, /"estimatedConsumptionKwh"|"hourly"|"futureKwh"/, 'metadata must not duplicate numerical forecasts');
    await history.close(); const restarted = await f.open(() => now);
    await assert.rejects(restarted.householdArchive.saveForecasts([old]), /older/);
    assert.deepEqual(await restarted.householdArchive.readForecast('2026-01-16'), latest);
  });

  await t.test('planning publication cannot overwrite learned estimates or restore them as a car-free baseline', async t => {
    const f = await database(t); const now = new Date(at); const history = await f.open(() => now);
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now,
      fallback: { baselinePowerW: 2000, windowHours: 24 }, weather: { async read() { return undefined; } } });
    await service.train();
    const forecast = { ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) };
    await history.publishForecasts({ calculatedAt: at, forecasts: [forecast], projection: projection() });
    const day = await history.historyReader.day(date, now);
    assert.ok(day.energyEstimates.every(point => point.estimatedConsumptionKwh === .5));
    const published = (await history.readForecast(date))!;
    assert.ok(published.forecast.consumption!.quarterHourly.every(point => point.estimatedConsumptionKwh === .125));
    await f.admin.query('UPDATE energy_history.house_forecasts SET energy_kwh = .75 WHERE interval_start = $1', [advance(900)]);
    const learned = (await history.householdArchive.readForecast(date))!;
    near(learned.slots.find(slot => slot.start === advance(900))!.estimatedConsumptionKwh, .75);
    assert.equal(learned.estimatedConsumptionKwh, null, 'missing past quarters are never backfilled');
    const columns = await f.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='energy_history' AND table_name='house_forecasts' ORDER BY ordinal_position`);
    assert.deepEqual(columns.rows.map(row => row.column_name), ['interval_start', 'energy_kwh']);
  });

  await t.test('household publication rolls back estimates and context together', async t => {
    const f = await database(t); let now = new Date(at); const history = await f.open(() => now);
    const fallback = { baselinePowerW: 1000, windowHours: 24 };
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now,
      fallback, weather: { async read() { return undefined; } } });
    await service.train();
    const previous = await history.householdArchive.readForecast('2026-01-16');
    await f.admin.query(`CREATE FUNCTION energy_history.reject_household_context() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.key = 'household_forecast_v1' THEN RAISE EXCEPTION 'test context outage'; END IF; RETURN NEW; END $$`);
    await f.admin.query(`CREATE TRIGGER reject_household_context BEFORE INSERT OR UPDATE ON energy_history.metadata
      FOR EACH ROW EXECUTE FUNCTION energy_history.reject_household_context()`);
    fallback.baselinePowerW = 2000; now = new Date(advance(900));
    await assert.rejects(service.refresh(), /apprentissage/);
    assert.deepEqual(await history.householdArchive.readForecast('2026-01-16'), previous);
    await f.admin.query('DROP TRIGGER reject_household_context ON energy_history.metadata');
    await service.refresh();
    near((await history.householdArchive.readForecast('2026-01-16'))!.estimatedConsumptionKwh, 48);
  });

  await t.test('legacy forecast tables are preserved but never used', async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    await f.admin.query('CREATE TABLE energy_history.household_forecasts (legacy text PRIMARY KEY)');
    await f.admin.query("INSERT INTO energy_history.household_forecasts VALUES ('preserved')");
    const now = new Date(at); const history = await f.open(() => now);
    const service = createHouseholdService({ archive: history.householdArchive, now: () => now,
      fallback: { baselinePowerW: 1000, windowHours: 24 }, weather: { async read() { return undefined; } } });
    await service.train();
    near((await history.householdArchive.readForecast('2026-01-16'))!.estimatedConsumptionKwh, 24);
    assert.deepEqual((await f.admin.query('SELECT * FROM energy_history.household_forecasts')).rows, [{ legacy: 'preserved' }]);
  });

  for (const version of [7, 8]) await t.test(`v${version} migrates the latest compatible model and removes training inputs while preserving legacy forecast rows`, async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    await createLegacyTraining(f.admin);
    const selected = savedModel();
    const runs = [savedModel('00000000-0000-4000-8000-000000000001', advance(-900)), selected,
      savedModel('00000000-0000-4000-8000-000000000002'),
      { ...savedModel('00000000-0000-4000-8000-000000000004', advance(900)), version: 'household-profile-v1' }];
    for (const model of runs) await f.admin.query('INSERT INTO energy_history.household_training VALUES ($1, $2, $3::jsonb, $4::jsonb)',
      [model.id, model.trainedAt, JSON.stringify(model), JSON.stringify({ observations: [{ at, value: 999 }], historicalWeather: { duplicated: true } })]);
    await f.admin.query('CREATE TABLE energy_history.household_forecasts (model_id uuid REFERENCES energy_history.household_training(id))');
    await f.admin.query('INSERT INTO energy_history.household_forecasts VALUES ($1)', [selected.id]);
    if (version === 7) for (const channel of ['battery', 'house', 'solar']) {
      await f.admin.query(`ALTER TABLE energy_history.${channel}_forecasts RENAME TO ${channel}_estimates`);
    }
    await f.admin.query("UPDATE energy_history.metadata SET value=$1::jsonb WHERE key='schema_version'", [JSON.stringify(version)]);
    const upgraded = await f.open();
    assert.deepEqual(await upgraded.householdArchive.readModel(), selected);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.household_training') AS name")).rows[0].name, null);
    assert.deepEqual((await f.admin.query('SELECT * FROM energy_history.household_forecasts')).rows, [{ model_id: selected.id }]);
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='schema_version'")).rows[0].value, 9);
    await upgraded.close(); const restarted = await f.open();
    const service = createHouseholdService({ archive: restarted.householdArchive, now: () => new Date(at), weather: { async read() { return undefined; } } });
    await service.refresh();
    assert.equal(service.status().modelId, selected.id);
    assert.deepEqual(service.status().training, selected.training);
    assert.equal(service.status().lastTrainedAt, selected.trainedAt);
  });

  for (const state of ['empty', 'incompatible', 'existing']) await t.test(`model migration handles ${state} state without replacing existing metadata`, async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    await createLegacyTraining(f.admin);
    const model = savedModel();
    if (state !== 'empty') await f.admin.query('INSERT INTO energy_history.household_training VALUES ($1, $2, $3::jsonb, $4::jsonb)',
      [model.id, model.trainedAt, JSON.stringify({ ...model, version: state === 'incompatible' ? 'household-profile-v1' : model.version }), '{}']);
    const existing = savedModel('00000000-0000-4000-8000-000000000005');
    if (state === 'existing') await f.admin.query("INSERT INTO energy_history.metadata VALUES ('household_model_v1', $1::jsonb)", [JSON.stringify(existing)]);
    await f.admin.query("UPDATE energy_history.metadata SET value='8'::jsonb WHERE key='schema_version'");
    const upgraded = await f.open();
    assert.deepEqual(await upgraded.householdArchive.readModel(), state === 'existing' ? existing : null);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.household_training') AS name")).rows[0].name, null);
  });

  await t.test('model migration rolls back its copy and preserves the archive when an unexpected dependency prevents removal', async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    await createLegacyTraining(f.admin);
    const model = savedModel();
    await f.admin.query('INSERT INTO energy_history.household_training VALUES ($1, $2, $3::jsonb, $4::jsonb)',
      [model.id, model.trainedAt, JSON.stringify(model), '{}']);
    await f.admin.query('CREATE TABLE energy_history.unexpected_reference (model_id uuid REFERENCES energy_history.household_training(id))');
    await f.admin.query("UPDATE energy_history.metadata SET value='8'::jsonb WHERE key='schema_version'");
    await assert.rejects(f.open(), /Initialisation/);
    assert.deepEqual((await f.admin.query('SELECT model FROM energy_history.household_training')).rows, [{ model }]);
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='schema_version'")).rows[0].value, 8);
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='household_model_v1'")).rowCount, 0);
  });

  await t.test('failed model saves preserve the last successful model and incompatible versions are ignored', async t => {
    const f = await database(t); const history = await f.open(); const model = savedModel();
    await history.householdArchive.saveModel(model);
    await f.admin.query(`CREATE FUNCTION energy_history.reject_model() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.key = 'household_model_v1' THEN RAISE EXCEPTION 'test model outage'; END IF; RETURN NEW; END $$`);
    await f.admin.query(`CREATE TRIGGER reject_model BEFORE INSERT OR UPDATE ON energy_history.metadata
      FOR EACH ROW EXECUTE FUNCTION energy_history.reject_model()`);
    await assert.rejects(history.householdArchive.saveModel(savedModel('00000000-0000-4000-8000-000000000006')), /test model outage/);
    assert.deepEqual(await history.householdArchive.readModel(), model);
    await f.admin.query('DROP TRIGGER reject_model ON energy_history.metadata');
    await f.admin.query("UPDATE energy_history.metadata SET value=jsonb_set(value, '{version}', '\"household-profile-v1\"'::jsonb) WHERE key='household_model_v1'");
    assert.equal(await history.householdArchive.readModel(), null);
  });

  for (const version of [6, 7]) await t.test(`v${version} renames forecast tables in place, preserving rows and constraints across restart`, async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    const snapshots = new Map<string, unknown>();
    for (const channel of ['battery', 'house', 'solar']) {
      await f.admin.query(`ALTER TABLE energy_history.${channel}_forecasts RENAME TO ${channel}_estimates`);
      await f.admin.query(`INSERT INTO energy_history.${channel}_estimates VALUES ($1, $2)`, [at, channel === 'battery' ? 50 : .25]);
      snapshots.set(channel, (await f.admin.query(`SELECT tableoid::oid AS table_id, * FROM energy_history.${channel}_estimates`)).rows);
    }
    if (version === 6) await f.admin.query('DROP TABLE energy_history.household_weather');
    await f.admin.query("UPDATE energy_history.metadata SET value=$1::jsonb WHERE key='schema_version'", [JSON.stringify(version)]);
    const upgraded = await f.open();
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='schema_version'")).rows[0].value, 9);
    for (const channel of ['battery', 'house', 'solar']) {
      assert.equal((await f.admin.query('SELECT to_regclass($1) AS name', [`energy_history.${channel}_estimates`])).rows[0].name, null);
      assert.deepEqual((await f.admin.query(`SELECT tableoid::oid AS table_id, * FROM energy_history.${channel}_forecasts`)).rows, snapshots.get(channel));
      await assert.rejects(f.admin.query(`INSERT INTO energy_history.${channel}_forecasts VALUES ($1, -1)`, [advance(900)]), { code: '23514' });
      await assert.rejects(f.admin.query(`INSERT INTO energy_history.${channel}_forecasts VALUES ($1, 1)`, [at]), { code: '23505' });
    }
    await upgraded.close(); const restarted = await f.open();
    for (const channel of ['battery', 'house', 'solar']) assert.equal(await f.count(`${channel}_forecasts`), 1);
    await restarted.close();
  });

  await t.test('conflicting old and new names roll back all renames and preserve the schema version', async t => {
    const f = await database(t); const first = await f.open(); await first.close();
    for (const channel of ['battery', 'house', 'solar']) await f.admin.query(`ALTER TABLE energy_history.${channel}_forecasts RENAME TO ${channel}_estimates`);
    await f.admin.query('CREATE TABLE energy_history.solar_forecasts (LIKE energy_history.solar_estimates INCLUDING ALL)');
    await f.admin.query("UPDATE energy_history.metadata SET value='7'::jsonb WHERE key='schema_version'");
    await assert.rejects(f.open(), /Conflit de schéma/);
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='schema_version'")).rows[0].value, 7);
    for (const channel of ['battery', 'house', 'solar']) assert.equal(await f.count(`${channel}_estimates`), 0);
    assert.equal((await f.admin.query("SELECT to_regclass('energy_history.battery_forecasts') AS name")).rows[0].name, null);
  });

  for (const version of [1, 2, 3, 4, 5, 10, '6', null]) await t.test(`unsupported schema ${JSON.stringify(version)} fails without changing stored data`, async t => {
    const f = await database(t); const history = await f.open(); await history.close();
    await f.admin.query('INSERT INTO energy_history.battery_observations VALUES ($1,50)', [advance(5)]);
    await f.admin.query("UPDATE energy_history.metadata SET value=$1::jsonb WHERE key='schema_version'", [JSON.stringify(version)]);
    const before = (await f.admin.query('SELECT * FROM energy_history.metadata ORDER BY key')).rows;
    await assert.rejects(f.open(), /Version de schéma/);
    assert.deepEqual((await f.admin.query('SELECT * FROM energy_history.metadata ORDER BY key')).rows, before);
    assert.deepEqual((await f.admin.query('SELECT observed_at, value FROM energy_history.battery_observations')).rows,
      [{ observed_at: new Date(advance(5)), value: 50 }]);
  });

  await t.test('one committed forecast batch supplies identical canonical estimates to Suivi and History', async t => {
    const f = await database(t); let now = new Date(advance(7 * 60)); let history = await f.open(() => now);
    assert.equal(await history.readForecast(date), null);
    const forecast = { ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) };
    await history.publishForecasts({ calculatedAt: now.toISOString(), forecasts: [forecast], projection: projection(now.toISOString()) });
    const published = await history.readForecast(date);
    assert.ok(published);
    const day = await history.historyReader.day(date, now);
    assert.equal(published.calculatedAt, now.toISOString());
    assert.equal(published.forecast.forecastPeriod.from, at, 'the full current clock hour is canonical');
    assert.deepEqual(published.forecast.quarterHourly!.map(point => ({ start: point.start, end: point.end, estimatedProductionKwh: point.estimatedProductionKwh })), day.solarEstimates);
    assert.deepEqual(published.forecast.consumption!.quarterHourly, day.energyEstimates);
    assert.deepEqual(published.projection.points, day.historicalEstimated.points);
    assert.equal(published.forecast.consumption!.quarterHourly[0].estimatedConsumptionKwh, .125);
    assert.equal(await f.count('battery_observations'), 0);
    const api = createApi({ controllerUrl: null, forecast: { config: null, fetch: async () => { throw new Error('GET cannot fetch weather'); } },
      now: () => now, forecastStore: history, historyReader: history.historyReader, batteryHistory: history.batteryHistory,
      dailyEnergyStore: history.dailyEnergyStore,
      estimates: { planner: () => null, projection: () => projection(now.toISOString()),
        status: () => ({ calculatedAt: published.calculatedAt, nextEvaluationAt: advance(900) }) },
    });
    const forecastResponse = await api.request('/api/forecast/today');
    const historyResponse = await api.request(`/api/history/day?date=${date}`);
    assert.equal(forecastResponse.status, 200); assert.equal(historyResponse.status, 200);
    const shown = await forecastResponse.json(), archived = await historyResponse.json();
    assert.deepEqual(shown.quarterHourly.map(({ temperatureC: _temperature, ...point }: { temperatureC: number }) => point), archived.solarEstimates);
    assert.deepEqual(shown.consumption.quarterHourly, archived.energyEstimates);
    assert.deepEqual(shown.battery.estimated.points, archived.historicalEstimated.points);
    now = new Date(advance(9 * 60));
    const later = await (await api.request('/api/forecast/today')).json();
    assert.deepEqual(later.quarterHourly, shown.quarterHourly);
    assert.deepEqual(later.consumption, shown.consumption, 'API reads cannot prorate committed quarters');
    const metadata = JSON.stringify((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='forecast_batch_v1'")).rows[0].value);
    assert.doesNotMatch(metadata, /estimatedProductionKwh|estimatedConsumptionKwh|socPercent/, 'numerical authority is only in estimate rows');
    await history.close(); history = await f.open(() => now);
    assert.deepEqual(await history.readForecast(date), published, 'restart reads the committed forecast without recalculation');
    await history.flush();
    assert.deepEqual(await history.readForecast(date), published, 'observation flush never revises estimates');
  });

  await t.test('manual charging forecasts persist canonical SOC rows and their explicit assumption', async t => {
    const f = await database(t); const history = await f.open();
    const manual: BatteryProjection = { ...projection(), assumption: 'manual_charging' };
    await history.publishForecasts({ calculatedAt: at,
      forecasts: [{ ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) }], projection: manual });
    const published = await history.readForecast(date);
    assert.ok(published);
    assert.deepEqual(published.projection, manual);
    assert.deepEqual((await history.historyReader.day(date, new Date(at))).historicalEstimated.points, manual.points);
  });

  await t.test('future replacement freezes completed history and rejects older publications after restart', async t => {
    const f = await database(t); let now = new Date(at); let history = await f.open(() => now);
    const first = { ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) };
    await history.publishForecasts({ calculatedAt: now.toISOString(), forecasts: [first], projection: projection() });
    now = new Date(advance(900));
    const changedSolar = solar(now.toISOString());
    changedSolar.quarterHourly!.forEach(point => { point.estimatedProductionKwh *= 2; });
    changedSolar.hourly!.forEach(point => { point.estimatedProductionKwh *= 2; });
    changedSolar.estimatedProductionKwh! *= 2;
    const second = { ...changedSolar, consumption: estimateConsumption(date, { baselinePowerW: 1000 }) };
    await history.publishForecasts({ calculatedAt: now.toISOString(), forecasts: [second], projection: projection(now.toISOString(), advance(1800), 70) });
    const day = await history.historyReader.day(date, now);
    assert.equal(day.energyEstimates.find(point => point.start === at)!.estimatedConsumptionKwh, .125);
    assert.equal(day.energyEstimates.find(point => point.start === advance(900))!.estimatedConsumptionKwh, .125,
      'the active household quarter stays frozen, like solar');
    assert.equal(day.energyEstimates.find(point => point.start === advance(1800))!.estimatedConsumptionKwh, .25);
    assert.equal(day.solarEstimates.find(point => point.start === at)!.estimatedProductionKwh, 3);
    assert.equal(day.solarEstimates.find(point => point.start === advance(900))!.estimatedProductionKwh, 3,
      'the quarter that has just started remains immutable');
    assert.equal(day.solarEstimates.find(point => point.start === advance(1800))!.estimatedProductionKwh, 6,
      'only a future quarter is replaced');
    assert.deepEqual(day.historicalEstimated.points, [{ at: advance(900), socPercent: 60 }, { at: advance(1800), socPercent: 70 }]);
    await history.close(); history = await f.open(() => now);
    const before = await history.readForecast(date);
    await assert.rejects(history.publishForecasts({ calculatedAt: now.toISOString(), forecasts: [], projection: projection() }), /invalide/);
    assert.deepEqual(await history.readForecast(date), before, 'empty batches cannot clear future estimates');
    await assert.rejects(history.publishForecasts({ calculatedAt: at, forecasts: [first], projection: projection() }), /ancien|antérieur|older/i);
    assert.deepEqual(await history.readForecast(date), before);
    assert.deepEqual(await history.historyReader.day(date, now), day);
  });

  await t.test('publication rolls back solar, consumption, battery and metadata together and retries cleanly', async t => {
    const f = await database(t); const history = await f.open();
    const initial = { ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) };
    await history.publishForecasts({ calculatedAt: at, forecasts: [initial], projection: projection() });
    const before = await history.readForecast(date), day = await history.historyReader.day(date);
    await f.admin.query(`CREATE FUNCTION energy_history.reject_forecast_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.key = 'forecast_batch_v1' THEN RAISE EXCEPTION 'test publication failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_forecast_metadata BEFORE INSERT OR UPDATE ON energy_history.metadata FOR EACH ROW EXECUTE FUNCTION energy_history.reject_forecast_metadata()`);
    const next = { calculatedAt: advance(1), forecasts: [{ ...initial, consumption: estimateConsumption(date, { baselinePowerW: 2000 }) }], projection: projection(advance(1), advance(900), 80) };
    await assert.rejects(history.publishForecasts(next), /test publication failure/);
    assert.deepEqual(await history.readForecast(date), before);
    assert.deepEqual(await history.historyReader.day(date), day);
    await history.flush();
    assert.deepEqual(await history.readForecast(date), before, 'the observation collector cannot leak a failed forecast later');
    await f.admin.query('DROP TRIGGER reject_forecast_metadata ON energy_history.metadata');
    await history.publishForecasts(next);
    const consumption = (await history.readForecast(date))!.forecast.consumption!.quarterHourly;
    assert.equal(consumption[0].estimatedConsumptionKwh, .125, 'a successful retry preserves the active quarter');
    assert.equal(consumption[1].estimatedConsumptionKwh, .5, 'the retry publishes the changed future quarters');
    assert.deepEqual((await history.readForecast(date))!.projection.points, [{ at: advance(900), socPercent: 80 }]);
  });

  await t.test('unavailable channels clear obsolete future targets while stale usable solar shares the same writer', async t => {
    const f = await database(t); const history = await f.open();
    const initial = { ...solar(), consumption: estimateConsumption(date, { baselinePowerW: 500 }) };
    await history.publishForecasts({ calculatedAt: at, forecasts: [initial], projection: projection() });
    const stale = { ...initial, status: 'stale' as const };
    await history.publishForecasts({ calculatedAt: advance(1), forecasts: [stale], projection: projection(advance(1)) });
    assert.equal((await history.readForecast(date))!.forecast.status, 'stale');
    assert.equal((await history.historyReader.day(date)).solarEstimates.length, 44);
    const offline = { ...initial, status: 'offline' as const };
    await history.publishForecasts({ calculatedAt: advance(900), forecasts: [offline], projection: { status: 'unavailable', reason: 'manual_override', assumption: 'automatic_planning', observedAt: null, points: [] } });
    const current = await history.readForecast(date), day = await history.historyReader.day(date);
    assert.equal(current!.forecast.estimatedProductionKwh, null);
    assert.equal(current!.forecast.quarterHourly, null);
    assert.deepEqual(current!.projection.points, []);
    assert.equal(day.solarEstimates.length, 2, 'completed and active solar quarters are preserved');
    assert.equal(day.historicalEstimated.points.length, 1, 'passed battery targets are preserved');
    assert.ok(current!.forecast.consumption!.quarterHourly.length > 0, 'consumption is independent of solar availability');
  });

  await t.test('publication preserves distinct canonical quarter horizons through both Zurich DST transitions', async t => {
    const f = await database(t); const history = await f.open();
    for (const [targetDate, hours] of [['2026-03-29', 23], ['2026-10-25', 25]] as const) {
      const { start, end } = getCalendarDayBounds(new Date(`${targetDate}T00:00:00Z`));
      const consumption = estimateConsumption(targetDate, { baselinePowerW: 125 });
      const forecast = { ...emptySolarForecast(targetDate, null), status: 'online' as const, fetchedAt: start.toISOString(),
        estimatedProductionKwh: hours * .5, consumption,
        hourly: consumption.hourly.map(point => ({ start: point.start, end: point.end, estimatedProductionKwh: .5, temperatureC: 10 })),
        quarterHourly: consumption.quarterHourly.map(point => ({ start: point.start, end: point.end, estimatedProductionKwh: .125, temperatureC: 10 })),
      };
      await history.publishForecasts({ calculatedAt: start.toISOString(), forecasts: [forecast],
        projection: projection(start.toISOString(), new Date(start.getTime() + 900_000).toISOString()) });
      const current = await history.readForecast(targetDate), day = await history.historyReader.day(targetDate);
      assert.equal(current!.forecast.hourly!.length, hours);
      assert.equal(current!.forecast.quarterHourly!.length, hours * 4);
      assert.equal(day.energyEstimates.length, hours * 4);
      assert.equal(current!.forecast.forecastPeriod.end, end.toISOString());
      assert.equal(new Set(current!.forecast.quarterHourly!.map(point => point.start)).size, hours * 4);
      near(current!.forecast.estimatedProductionKwh, hours * .5);
      near(current!.forecast.consumption!.estimatedConsumptionKwh, hours * .125);
    }
  });

  await t.test('single-writer locking, reconnect recovery and identity fencing preserve finalized data', async t => {
    const f = await database(t); let now = new Date(at); const first = await f.open(() => now);
    await assert.rejects(f.open(), /collecteur/);
    now = new Date(advance(870)); first.record(sample(870), now);
    now = new Date(advance(900)); await first.flush();
    await terminateWriter(f.admin);
    now = new Date(advance(1770)); first.record(sample(1770, 1250), now);
    now = new Date(advance(1800)); await first.flush();
    assert.equal(await f.count('solar_observations'), 1);
    await terminateWriter(f.admin);
    const second = await f.open(() => now);
    await second.close();
    now = new Date(advance(2670)); first.record(sample(2670, 1500), now);
    now = new Date(advance(2700)); await assert.rejects(first.flush(), /propriétaire/);
    assert.equal(await f.count('solar_observations'), 1);
    const third = await f.open(() => now);
    assert.equal((await third.historyReader.day(date, now)).observations!.solar[0].value, 250);
  });

  await t.test('saved solar gaps recover after restart and battery targets reach the seventh history day', async t => {
    const f = await database(t); let now = new Date('2026-10-27T12:00:00Z'); let history = await f.open(() => now);
    const config = { latitude: 47.3, longitude: 8.5, locationName: 'Test', arrayPowerKw: 8.5,
      performanceRatio: .85, panelTiltDegrees: 15, eastFraction: .5 };
    const automation: AutomationStatus = { enabled: false, status: 'disabled', lastEvaluatedAt: null,
      nextEvaluationAt: null, targetSocPercent: null, holdUntil: null, reason: 'disabled', plan: null, error: null };
    const targetDate = (offset: number) => new Date(Date.parse(`2026-10-27T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    let failSomeDays = false;
    const service = () => createEstimateService({ forecastConfig: config, consumption: { baselinePowerW: 1000 },
      automationConfig: { enabled: false, socCapacityKwh: 60, reserveSocPercent: 5, energyBufferPercent: 5,
        minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 }, now: () => now,
      async readSolar(offset) {
        if (failSomeDays && [2, 3, 4].includes(offset)) throw new Error('Temporary provider failure');
        const consumption = estimateConsumption(targetDate(offset), { baselinePowerW: 1000 });
        return { ...emptySolarForecast(targetDate(offset), config), status: 'online' as const, fetchedAt: now.toISOString(),
          hourly: consumption.hourly.map(p => ({ start: p.start, end: p.end, estimatedProductionKwh: 1, temperatureC: null })),
          quarterHourly: consumption.quarterHourly.map(p => ({ start: p.start, end: p.end, estimatedProductionKwh: .25, temperatureC: null })),
          estimatedProductionKwh: consumption.dayHours };
      },
      readSavedSolarForecast: async day => (await history.readForecast(day))?.forecast ?? null,
      readTelemetry: async () => telemetry(now.toISOString(), 50),
      readControl: async () => ({ available: true, mode: 'auto' as const, powerKw: null, targetSocPercent: null,
        limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 }, error: null }),
      readAutomation: () => automation, evaluateAutomation: async () => {},
      publishForecasts: batch => history.publishForecasts(batch),
    });
    await service().recalculate();
    await history.close(); history = await f.open(() => now);
    now = new Date(now.getTime() + 900000); failSomeDays = true;
    const restarted = service(); await restarted.recalculate();
    assert.equal(restarted.projection().status, 'available');
    assert.equal(restarted.projection().reason, null);
    assert.equal(restarted.projection().assumption, 'passive_operation');
    for (const offset of forecastDayOffsets.slice(1, 8)) {
      const day = await history.historyReader.day(targetDate(offset), now);
      assert.equal(day.solarEstimates.length, 96, `solar coverage for day ${offset}`);
      assert.ok(day.historicalEstimated.points.length >= 96, `battery coverage for day ${offset}`);
      assert.ok(day.historicalEstimated.points.every(p => p.socPercent === 50));
      assert.equal(day.historicalEstimated.projection?.status, 'available');
    }
    assert.equal((await history.readForecast(targetDate(2)))!.forecast.status, 'stale');
    assert.equal((await history.readForecast(targetDate(3)))!.forecast.status, 'stale');
    assert.equal((await history.readForecast(targetDate(4)))!.forecast.status, 'stale');
    assert.equal((await history.readForecast(targetDate(5)))!.forecast.status, 'online');
  });

  await t.test('malformed finalized checkpoints fail closed without resetting durable data', async t => {
    const f = await database(t); const history = await f.open(); await history.close();
    await f.admin.query(`INSERT INTO energy_history.metadata VALUES ('observation_checkpoint_v1','{"version":999}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    await assert.rejects(f.open(), /préservées/);
    assert.deepEqual((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='observation_checkpoint_v1'")).rows[0].value, { version: 999 });
  });
});
