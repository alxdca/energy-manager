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
    assert.equal((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key = 'schema_version'")).rows[0].value, 6);
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
      'battery_estimates', 'house_estimates', 'solar_estimates']) assert.equal(await f.count(table), 0);
    const tables = await f.admin.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'energy_history' ORDER BY table_name`);
    assert.deepEqual(tables.rows.map(row => row.table_name), ['battery_estimates', 'battery_observations',
      'house_estimates', 'house_observations', 'metadata', 'solar_estimates', 'solar_observations']);
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

  for (const version of [1, 2, 3, 4, 5, 7, '6', null]) await t.test(`unsupported schema ${JSON.stringify(version)} fails without changing stored data`, async t => {
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
    assert.equal(day.energyEstimates.find(point => point.start === advance(900))!.estimatedConsumptionKwh, .25);
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
    assert.equal((await history.readForecast(date))!.forecast.consumption!.quarterHourly[0].estimatedConsumptionKwh, .5);
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

  await t.test('malformed finalized checkpoints fail closed without resetting durable data', async t => {
    const f = await database(t); const history = await f.open(); await history.close();
    await f.admin.query(`INSERT INTO energy_history.metadata VALUES ('observation_checkpoint_v1','{"version":999}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    await assert.rejects(f.open(), /préservées/);
    assert.deepEqual((await f.admin.query("SELECT value FROM energy_history.metadata WHERE key='observation_checkpoint_v1'")).rows[0].value, { version: 999 });
  });
});
