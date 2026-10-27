import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { BatteryHistorySummary } from './battery-history.js';
import type { BatteryProjection } from './battery-projection.js';
import type { ForecastBatch, PublishedForecast } from './forecast-publication.js';
import type { ConsumptionForecast } from './consumption.js';
import { consumptionIntervals, estimateConsumption } from './consumption.js';
import type { CarChargingForecast } from './car-types.js';
import { getCalendarDayBounds, getLocalDate, timeZone } from './policy.js';
import type { Telemetry } from './status.js';
import type { AsyncDailyEnergyReader, HistoryReader } from './history-reader.js';
import { postgresSchema, householdForecastMigration, forecastTableRenameMigration, householdModelMetadataMigration, carEnergyMigration, carForecastMigration } from './postgres-schema.js';
import { carEstimatePoints, type CarEstimatePoint } from './car-forecast-history.js';
import { createHouseholdArchive, householdForecastKey, type HouseholdPublication } from './household-postgres.js';
import { createBatteryOrigin } from './battery-origin.js';
import { hasUsableForecast, type SolarForecast } from './forecast.js';
import { energyEstimatePoints, solarEstimatePoints, type EnergyEstimatePoint, type SolarEstimatePoint } from './energy-estimate-history.js';
import { summarizeRecordedEnergy, summarizeSeparatedEnergy } from './recorded-energy.js';
import { createCarEnergySampler } from './car-energy.js';
import { createObservationSampler } from './observation-sampler.js';
import type { ObservationPoint, ObservationSample } from './observation-types.js';

const { Pool } = pg;
const observationCheckpointKey = 'observation_checkpoint_v1';
const originCheckpointKey = 'battery_origin_checkpoint_v1';
const forecastBatchKey = 'forecast_batch_v1';
const bucketMs = 900_000;
const carCheckpointKey = 'car_observation_checkpoint_v1';
const separationStartKey = 'car_separation_started_at';

type SolarContext = Omit<SolarForecast, 'estimatedProductionKwh' | 'hourly' | 'quarterHourly'>;
type ConsumptionContext = Omit<ConsumptionForecast, 'estimatedConsumptionKwh' | 'baselineKwh' | 'hourly' | 'quarterHourly'>;
interface ForecastContext {
  date: string;
  solar: SolarContext;
  temperatures: Array<{ start: string; temperatureC: number | null }>;
  consumption: ConsumptionContext | null;
}
interface ForecastMetadata {
  calculatedAt: string;
  forecasts: ForecastContext[];
  projection: Omit<BatteryProjection, 'points' | 'energyBalance'>;
}
interface SavedEstimates {
  metadata: ForecastMetadata | null;
  household: HouseholdPublication | null;
  battery: Array<{ at: string; socPercent: number }>;
  solar: SolarEstimatePoint[];
  house: EnergyEstimatePoint[];
  car: CarEstimatePoint[];
}

function groupedHours<T extends { start: string; end: string }>(quarters: T[], key: keyof T): T[] {
  const hours = new Map<number, T>();
  for (const point of quarters) {
    const at = Math.floor(Date.parse(point.start) / 3_600_000);
    const previous = hours.get(at);
    hours.set(at, previous ? { ...point, start: previous.start,
      [key]: (previous[key] as number) + (point[key] as number) } : { ...point });
  }
  return [...hours.values()];
}

/** One writer publishes forecast batches and persists finalized observations. */
export async function createPostgresHistory(options: { connectionString: string; now?: () => Date; batteryCapacityKwh?: number }) {
  const clock = options.now ?? (() => new Date());
  try {
    const url = new URL(options.connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
  } catch { throw new Error('DATABASE_URL doit désigner une base PostgreSQL.'); }
  const pool = new Pool({ connectionString: options.connectionString, max: 4,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 10_000, query_timeout: 15_000 });
  // node-postgres emits idle connection errors separately from rejected queries.
  pool.on('error', () => {});
  let writer: pg.PoolClient;
  try { writer = await pool.connect(); }
  catch { await pool.end(); throw new Error('Connexion à PostgreSQL impossible. Vérifier DATABASE_URL et le serveur.'); }
  let writerFailed = false;
  let writerReleased = false;
  const writerIdentity = randomUUID();
  function watchWriter(client: pg.PoolClient) {
    client.on('error', () => { if (writer === client) writerFailed = true; });
  }
  watchWriter(writer);
  function releaseWriter() {
    if (!writerReleased) { writerReleased = true; writer.release(true); }
  }
  async function recoverWriter() {
    if (!writerFailed) return;
    releaseWriter();
    writer = await pool.connect();
    writerReleased = false;
    watchWriter(writer);
    try {
      const lock = await writer.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(735902, 1) AS locked');
      if (!lock.rows[0].locked) throw new Error('Un autre collecteur possède la base.');
      const identity = await writer.query('SELECT value FROM energy_history.metadata WHERE key = $1', ['writer_identity']);
      // Another collector may have advanced the checkpoint while this connection was down.
      // Never overwrite its data with this process's stale working cache.
      if (identity.rows[0]?.value !== writerIdentity) throw new Error('Le propriétaire de la collecte a changé. Redémarrer le service.');
      writerFailed = false;
    } catch (error) {
      releaseWriter();
      throw error;
    }
  }
  let closed = false;
  let tail = Promise.resolve();
  function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const operation = tail.then(async () => {
      if (closed) throw new Error('Historique PostgreSQL fermé.');
      await recoverWriter();
      try { await writer.query('BEGIN'); }
      catch (error) { writerFailed = true; throw error; }
      try {
        const value = await run(writer);
        await writer.query('COMMIT');
        return value;
      } catch (error) {
        await writer.query('ROLLBACK').catch(() => { writerFailed = true; });
        throw error;
      }
    });
    tail = operation.then(() => {}, () => {});
    return operation;
  }
  try {
    const lock = await writer.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(735902, 1) AS locked');
    if (!lock.rows[0].locked) throw new Error('Un autre collecteur utilise déjà cette base PostgreSQL.');
    await transaction(async client => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS energy_history;
        CREATE TABLE IF NOT EXISTS energy_history.metadata (key text PRIMARY KEY, value jsonb NOT NULL)`);
      const version = await client.query('SELECT value FROM energy_history.metadata WHERE key = $1', ['schema_version']);
      const currentVersion = version.rows[0]?.value;
      if (currentVersion !== undefined && ![6, 7, 8, 9, 10, 11].includes(currentVersion)) throw new Error('Version de schéma PostgreSQL non prise en charge.');
      if (currentVersion === undefined || currentVersion === 6 || currentVersion === 7) await client.query(forecastTableRenameMigration);
      await client.query(postgresSchema);
      if (currentVersion === undefined || currentVersion === 6) await client.query(householdForecastMigration);
      if (currentVersion === undefined || currentVersion <= 8) await client.query(householdModelMetadataMigration);
      if (currentVersion === undefined || currentVersion <= 9) await client.query(carEnergyMigration);
      if (currentVersion !== 11) {
        await client.query(carForecastMigration);
        // Retain the last plan's known ongoing/future predictions at its ORIGINAL publication cutoff.
        // Earlier quarters have no archived forecast; never reconstruct them from a later plan.
        type LegacyMetadata = Omit<ForecastMetadata, 'forecasts'> & {
          forecasts: Array<ForecastContext & { carCharging?: CarChargingForecast }>;
        };
        const legacy = (await client.query<{ value: LegacyMetadata }>(
          'SELECT value FROM energy_history.metadata WHERE key = $1', [forecastBatchKey])).rows[0]?.value;
        if (legacy?.forecasts?.some(context => context.carCharging !== undefined)) {
          const points = carEstimatePoints(legacy.forecasts, new Date(legacy.calculatedAt));
          if (points.length) await client.query(`INSERT INTO energy_history.car_forecasts (interval_start, energy_kwh)
            SELECT x.start::timestamptz, x."estimatedChargingKwh" FROM jsonb_to_recordset($1::jsonb)
              AS x(start text, "estimatedChargingKwh" double precision) ON CONFLICT (interval_start) DO NOTHING`, [JSON.stringify(points)]);
          await writeMetadata(client, forecastBatchKey, JSON.stringify({ ...legacy,
            forecasts: legacy.forecasts.map(({ carCharging: _car, ...context }) => context) }));
        }
      }
      await client.query(`INSERT INTO energy_history.metadata (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO NOTHING`, [separationStartKey, JSON.stringify(clock().toISOString())]);
      await client.query(`INSERT INTO energy_history.metadata (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['writer_identity', JSON.stringify(writerIdentity)]);
    });
  } catch (error) {
    releaseWriter();
    await pool.end();
    throw error instanceof Error && /collecteur|schéma/.test(error.message) ? error
      : new Error('Initialisation de l’historique PostgreSQL impossible.');
  }

  let sampler: ReturnType<typeof createObservationSampler>;
  let batteryOrigin: ReturnType<typeof createBatteryOrigin>;
  let savedObservationState: string;
  let carSampler: ReturnType<typeof createCarEnergySampler>;
  let savedCarState: string;
  let separationStartedAt: string;
  let savedOriginState: string;
  let storageError: string | null = null;
  try {
    const checkpoints = await pool.query('SELECT key, value FROM energy_history.metadata WHERE key = ANY($1::text[])',
      [[observationCheckpointKey, originCheckpointKey, carCheckpointKey, separationStartKey]]);
    sampler = createObservationSampler({ now: clock,
      state: checkpoints.rows.find(row => row.key === observationCheckpointKey)?.value });
    savedObservationState = JSON.stringify(sampler.pending().state);
    carSampler = createCarEnergySampler({ now: clock,
      state: checkpoints.rows.find(row => row.key === carCheckpointKey)?.value });
    savedCarState = JSON.stringify(carSampler.pending().state);
    separationStartedAt = checkpoints.rows.find(row => row.key === separationStartKey)!.value;
    batteryOrigin = createBatteryOrigin({ capacityKwh: options.batteryCapacityKwh, now: clock,
      checkpoint: checkpoints.rows.find(row => row.key === originCheckpointKey)?.value });
    savedOriginState = JSON.stringify(batteryOrigin.checkpoint());
  } catch {
    releaseWriter();
    await pool.end();
    throw new Error('Chargement de l’historique PostgreSQL impossible. Les données existantes sont préservées.');
  }

  let closing: Promise<void> | undefined;
  function writable() {
    if (closed || closing) throw new Error('Historique PostgreSQL fermé.');
  }
  async function writePoints(client: pg.PoolClient, channel: 'battery' | 'solar' | 'house' | 'car' | 'house_only', points: ObservationPoint[]) {
    if (points.length) await client.query(`INSERT INTO energy_history.${channel}_observations (observed_at, value)
      SELECT x.at::timestamptz, x.value FROM jsonb_to_recordset($1::jsonb) AS x(at text, value double precision)
      ON CONFLICT (observed_at) DO NOTHING`, [JSON.stringify(points)]);
  }
  async function writeMetadata(client: pg.PoolClient, key: string, value: string) {
    await client.query(`INSERT INTO energy_history.metadata (key, value) VALUES ($1, $2::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }
  function record(sample: ObservationSample, at = clock()) {
    writable(); sampler.record(sample, at); carSampler.record(sample, at);
  }
  /** Independent fast safety accounting; this never supplies observation candidates. */
  function recordTelemetry(telemetry: Telemetry, at = clock()) {
    writable(); batteryOrigin.record(telemetry, at);
  }
  let flushTail = Promise.resolve();
  function flush() {
    const operation = flushTail.then(async () => {
      if (closed) throw new Error('Historique PostgreSQL fermé.');
      sampler.finalize(clock());
      carSampler.finalize(clock());
      const snapshot = sampler.pending();
      const separated = carSampler.pending(), carCheckpoint = JSON.stringify(separated.state);
      const checkpoint = JSON.stringify(snapshot.state), origin = JSON.stringify(batteryOrigin.checkpoint());
      if (snapshot.battery.length || snapshot.solar.length || snapshot.household.length
        || separated.solar.length || separated.household.length || carCheckpoint !== savedCarState
        || checkpoint !== savedObservationState || origin !== savedOriginState) {
        await transaction(async client => {
          await writePoints(client, 'battery', snapshot.battery);
          await writePoints(client, 'solar', snapshot.solar);
          await writePoints(client, 'house', snapshot.household);
          await writePoints(client, 'car', separated.solar);
          await writePoints(client, 'house_only', separated.household);
          if (carCheckpoint !== savedCarState) await writeMetadata(client, carCheckpointKey, carCheckpoint);
          if (checkpoint !== savedObservationState) await writeMetadata(client, observationCheckpointKey, checkpoint);
          if (origin !== savedOriginState) await writeMetadata(client, originCheckpointKey, origin);
        });
        sampler.acknowledge(snapshot);
        carSampler.acknowledge(separated); savedCarState = carCheckpoint;
        savedObservationState = checkpoint; savedOriginState = origin;
      }
    });
    const result = operation.then(() => { storageError = null; }, error => {
      storageError = 'L’enregistrement de l’historique PostgreSQL a échoué.';
      throw error;
    });
    flushTail = result.catch(() => {});
    return result;
  }
  function dayBounds(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date de relevé invalide.');
    const day = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error('Date de relevé invalide.');
    return getCalendarDayBounds(day);
  }
  async function readPoints(channel: 'battery' | 'solar' | 'household' | 'car' | 'house_only', date: string, now: Date): Promise<ObservationPoint[]> {
    const { start, end } = dayBounds(date), table = channel === 'household' ? 'house' : channel;
    const result = await pool.query<{ at: Date; value: number }>(`SELECT observed_at AS at, value
      FROM energy_history.${table}_observations WHERE observed_at >= $1 AND observed_at < $2 AND observed_at <= $3 ORDER BY observed_at`,
    [start, end, now]);
    const values = new Map(result.rows.map(row => [row.at.toISOString(), { at: row.at.toISOString(), value: row.value }]));
    const pending = channel === 'car' ? carSampler.pending().solar
      : channel === 'house_only' ? carSampler.pending().household : sampler.pending()[channel];
    for (const point of pending) {
      const at = Date.parse(point.at);
      if (at >= start.getTime() && at < end.getTime() && at <= now.getTime()) values.set(point.at, point);
    }
    return [...values.values()].sort((a, b) => a.at.localeCompare(b.at));
  }
  async function energyDay(date: string, now = clock()) {
    const [solar, totalHousehold, houseOnly, car] = await Promise.all([readPoints('solar', date, now), readPoints('household', date, now),
      readPoints('house_only', date, now), readPoints('car', date, now)]);
    const legacy = date < getLocalDate(new Date(separationStartedAt));
    const household = legacy ? totalHousehold : houseOnly;
    const summary = legacy ? summarizeRecordedEnergy(date, { solar, household }, now)
      : summarizeSeparatedEnergy(date, { solar, household, car, totalHousehold }, now);
    if (storageError) for (const value of [summary.dailyEnergy, summary.measurements]) {
      value.storageStatus = 'error'; value.error = storageError;
    }
    return { ...summary, solar, household, car, totalHousehold };
  }
  const dateSources = `SELECT (observed_at AT TIME ZONE 'Europe/Zurich')::date AS date FROM energy_history.solar_observations
    UNION SELECT (observed_at AT TIME ZONE 'Europe/Zurich')::date AS date FROM energy_history.house_observations
    UNION SELECT (observed_at AT TIME ZONE 'Europe/Zurich')::date AS date FROM energy_history.car_observations
    UNION SELECT (observed_at AT TIME ZONE 'Europe/Zurich')::date AS date FROM energy_history.house_only_observations`;
  const dailyEnergyStore: AsyncDailyEnergyReader = {
    async summary(date, now = clock()) { return (await energyDay(date, now)).dailyEnergy; },
    async hourly(date, now = clock()) { return (await energyDay(date, now)).measurements; },
    async days(limit = 366, now = clock(), before) {
      const count = Math.min(366, Math.max(1, limit));
      const result = await pool.query<{ date: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date
        FROM (${dateSources}) dates WHERE ($1::date IS NULL OR date < $1::date) ORDER BY date DESC LIMIT $2`, [before ?? null, count]);
      const pending = sampler.pending();
      const dates = new Set([...result.rows.map(row => row.date), ...[...pending.solar, ...pending.household, ...carSampler.pending().solar, ...carSampler.pending().household].map(point => getLocalDate(new Date(point.at)))]);
      return Promise.all([...dates].filter(date => !before || date < before).sort().reverse().slice(0, count)
        .map(async date => (await energyDay(date, now)).dailyEnergy));
    },
  };
  const batteryHistory = {
    async summary(date: string, now = clock()): Promise<BatteryHistorySummary> {
      const { start, end } = dayBounds(date);
      return { date, timeZone, dayHours: (end.getTime() - start.getTime()) / 3_600_000 as 23 | 24 | 25,
        periodStart: start.toISOString(), periodEnd: end.toISOString(), status: storageError ? 'error' : 'ready', error: storageError,
        points: (await readPoints('battery', date, now)).map(point => ({ at: point.at, socPercent: point.value })) };
    },
  };
  /** One SQL statement gives metadata and all estimate channels the same MVCC snapshot. */
  async function savedEstimates(date: string): Promise<SavedEstimates> {
    const { start, end } = dayBounds(date);
    const result = await pool.query<{
      metadata: ForecastMetadata | null;
      household: HouseholdPublication | null;
      battery: Array<{ at: string; socPercent: number }>;
      solar: Array<{ start: string; estimatedProductionKwh: number }>;
      house: Array<{ start: string; estimatedConsumptionKwh: number; excludesCar: boolean }>;
      car: Array<{ start: string; estimatedChargingKwh: number }>;
    }>(`SELECT (SELECT value FROM energy_history.metadata WHERE key = $3) AS metadata,
      (SELECT value FROM energy_history.metadata WHERE key = $4) AS household,
      COALESCE((SELECT json_agg(json_build_object('at', target_at, 'socPercent', soc_percent) ORDER BY target_at)
        FROM energy_history.battery_forecasts WHERE target_at >= $1 AND target_at <= $2), '[]'::json) AS battery,
      COALESCE((SELECT json_agg(json_build_object('start', interval_start, 'estimatedProductionKwh', energy_kwh) ORDER BY interval_start)
        FROM energy_history.solar_forecasts WHERE interval_start >= $1 AND interval_start < $2), '[]'::json) AS solar,
      COALESCE((SELECT json_agg(json_build_object('start', interval_start, 'estimatedConsumptionKwh', energy_kwh, 'excludesCar', excludes_car) ORDER BY interval_start)
        FROM energy_history.house_forecasts WHERE interval_start >= $1 AND interval_start < $2), '[]'::json) AS house,
      COALESCE((SELECT json_agg(json_build_object('start', interval_start, 'estimatedChargingKwh', energy_kwh) ORDER BY interval_start)
        FROM energy_history.car_forecasts WHERE interval_start >= $1 AND interval_start < $2), '[]'::json) AS car`, [start, end, forecastBatchKey, householdForecastKey]);
    const row = result.rows[0];
    const interval = <T extends { start: string }>(point: T) => ({ ...point,
      start: new Date(point.start).toISOString(), end: new Date(Date.parse(point.start) + bucketMs).toISOString() });
    const sources = new Map(row.household?.forecasts.find(forecast => forecast.date === date)?.slots.map(slot => [slot.start, slot.source]));
    return { metadata: row.metadata, household: row.household, battery: row.battery.map(point => ({ ...point, at: new Date(point.at).toISOString() })),
      solar: row.solar.map(interval), car: row.car.map(interval), house: row.house.map(point => {
        const value = interval(point), source = sources.get(value.start);
        return { ...value, ...(source ? { source } : {}) };
      }) };
  }

  async function publishForecasts(input: ForecastBatch): Promise<void> {
    writable();
    const batch = structuredClone(input);
    const cutoff = Date.parse(batch.calculatedAt);
    if (!Number.isFinite(cutoff) || !Array.isArray(batch.forecasts) || batch.forecasts.length === 0 || new Set(batch.forecasts.map(value => value.date)).size !== batch.forecasts.length) {
      throw new Error('Le bilan des estimations est invalide.');
    }
    const at = new Date(cutoff);
    const contexts: ForecastContext[] = batch.forecasts.map(forecast => {
      dayBounds(forecast.date);
      const { estimatedProductionKwh: _solarEnergy, hourly: _solarHours, quarterHourly: quarters, consumption,
        carCharging: _car, carChargingContext: _carContext, ...solar } = forecast;
      const { estimatedConsumptionKwh: _houseEnergy, baselineKwh: _baselineEnergy, hourly: _houseHours,
        quarterHourly: _houseQuarters, ...house } = consumption;
      return { date: forecast.date, solar, temperatures: quarters?.map(point => ({ start: point.start, temperatureC: point.temperatureC })) ?? [],
        consumption: consumption.date === forecast.date && consumptionIntervals(consumption) ? house : null };
    });
    const solar = solarEstimatePoints(batch.forecasts, at);
    const house = energyEstimatePoints(batch.forecasts, at);
    const car = carEstimatePoints(batch.forecasts, at);
    const projection = batch.projection;
    const observedAt = Date.parse(projection.observedAt ?? '');
    const validProjection = projection.status === 'available' && ['automatic_planning', 'passive_operation', 'manual_charging'].includes(projection.assumption)
      && Number.isFinite(observedAt) && cutoff - observedAt <= 30_000 && observedAt - cutoff <= 5000
      && projection.points.every((point, index) => Number.isFinite(Date.parse(point.at))
        && typeof point.socPercent === 'number' && Number.isFinite(point.socPercent) && point.socPercent >= 0 && point.socPercent <= 100
        && (index === 0 || Date.parse(point.at) > Date.parse(projection.points[index - 1].at)));
    const battery = validProjection ? projection.points.filter(point => Date.parse(point.at) > cutoff && Date.parse(point.at) % bucketMs === 0) : [];
    const metadata: ForecastMetadata = { calculatedAt: at.toISOString(), forecasts: contexts,
      projection: validProjection ? { status: 'available', reason: projection.reason, assumption: projection.assumption, observedAt: projection.observedAt }
        : { status: 'unavailable', reason: projection.reason ?? 'projection_unavailable', assumption: projection.assumption, observedAt: null } };
    await transaction(async client => {
      const previous = await client.query<{ value: ForecastMetadata }>('SELECT value FROM energy_history.metadata WHERE key = $1', [forecastBatchKey]);
      if (Date.parse(previous.rows[0]?.value.calculatedAt ?? '') > cutoff) throw new Error('Le bilan est antérieur aux estimations déjà enregistrées.');
      const household = await client.query('SELECT 1 FROM energy_history.metadata WHERE key = $1', [householdForecastKey]);
      // The active quarter is immutable once it starts. Replace only later targets;
      // ON CONFLICT below still lets a first-ever batch fill a missing active quarter.
      const horizon = new Date((Math.floor(cutoff / bucketMs) + 1) * bucketMs);
      await client.query('DELETE FROM energy_history.solar_forecasts WHERE interval_start >= $1', [horizon]);
      await client.query('DELETE FROM energy_history.car_forecasts WHERE interval_start >= $1', [horizon]);
      if (!household.rowCount) await client.query('DELETE FROM energy_history.house_forecasts WHERE interval_start >= $1', [horizon]);
      await client.query('DELETE FROM energy_history.battery_forecasts WHERE target_at > $1', [at]);
      for (const [table, points, field] of [
        ['solar_forecasts', solar, 'estimatedProductionKwh'], ['house_forecasts', house, 'estimatedConsumptionKwh'],
        ['car_forecasts', car, 'estimatedChargingKwh'],
      ] as const) if (points.length && (table !== 'house_forecasts' || !household.rowCount)) await client.query(`INSERT INTO energy_history.${table} (interval_start, energy_kwh${table === 'house_forecasts' ? ', excludes_car' : ''})
        SELECT x.start::timestamptz, x."${field}"${table === 'house_forecasts' ? ', true' : ''} FROM jsonb_to_recordset($1::jsonb) AS x(start text, "${field}" double precision)
        ON CONFLICT (interval_start) DO NOTHING`, [JSON.stringify(points)]);
      if (battery.length) await client.query(`INSERT INTO energy_history.battery_forecasts (target_at, soc_percent)
        SELECT x.at::timestamptz, x."socPercent" FROM jsonb_to_recordset($1::jsonb) AS x(at text, "socPercent" double precision)`, [JSON.stringify(battery)]);
      await writeMetadata(client, forecastBatchKey, JSON.stringify(metadata));
    });
  }

  async function readForecast(date: string): Promise<PublishedForecast | null> {
    const saved = await savedEstimates(date);
    const context = saved.metadata?.forecasts.find(value => value.date === date);
    if (!context || !saved.metadata) return null;
    const calculatedAt = saved.metadata.calculatedAt;
    const { start, end } = dayBounds(date);
    const cutoff = Date.parse(calculatedAt);
    // Hourly consumers need a complete first clock hour rather than a subtotal
    // beginning at the active quarter.
    const from = Math.min(end.getTime(), Math.max(start.getTime(), Math.floor(cutoff / 3_600_000) * 3_600_000));
    const inHorizon = (point: { start: string }) => Date.parse(point.start) >= from;
    // Learned estimates remain in observation mode. Reconstruct the controller's baseline
    // from its saved configuration instead of promoting the learned series into planning.
    const baseline = saved.household && context.consumption
      ? estimateConsumption(date, { baselinePowerW: context.consumption.baselinePowerW }).quarterHourly : saved.house;
    const solar = saved.solar.filter(inHorizon), house = baseline.filter(inHorizon)
      .map(point => ({ ...point, estimatedConsumptionKwh: point.estimatedConsumptionKwh! }));
    const complete = (points: Array<{ start: string; end: string }>) => points.length === (end.getTime() - from) / bucketMs
      && points.every((point, index) => Date.parse(point.start) === from + index * bucketMs && Date.parse(point.end) === from + (index + 1) * bucketMs);
    const temperatures = new Map(context.temperatures.map(point => [point.start, point.temperatureC]));
    const quarterHourly = hasUsableForecast(context.solar, cutoff) && complete(solar)
      ? solar.map(point => ({ ...point, temperatureC: temperatures.get(point.start) ?? null })) : null;
    const consumption: ConsumptionForecast | null = context.consumption && complete(house)
      ? { ...context.consumption, quarterHourly: house, hourly: groupedHours(house, 'estimatedConsumptionKwh'),
        estimatedConsumptionKwh: house.reduce((sum, point) => sum + point.estimatedConsumptionKwh!, 0),
        baselineKwh: house.reduce((sum, point) => sum + point.estimatedConsumptionKwh!, 0) } : null;
    return { calculatedAt, forecast: { ...context.solar, quarterHourly,
      hourly: quarterHourly ? groupedHours(quarterHourly, 'estimatedProductionKwh') : null,
      productionPeriodStart: quarterHourly ? new Date(from).toISOString() : null,
      productionPeriodEnd: quarterHourly ? end.toISOString() : null,
      estimatedProductionKwh: quarterHourly ? quarterHourly.reduce((sum, point) => sum + point.estimatedProductionKwh, 0) : null,
      consumption, carEstimates: saved.car.filter(inHorizon),
      forecastPeriod: { start: start.toISOString(), end: end.toISOString(), from: new Date(from).toISOString() } },
    projection: { ...saved.metadata.projection,
      points: saved.metadata.projection.status === 'available' ? saved.battery.filter(point => Date.parse(point.at) > cutoff) : [] } };
  }

  const historyReader: HistoryReader = {
    async day(date, now = clock()) {
      const { start, end } = dayBounds(date);
      const [energy, observed, saved] = await Promise.all([
        energyDay(date, now), batteryHistory.summary(date, now), savedEstimates(date),
      ]);
      const solar = saved.metadata?.forecasts.find(value => value.date === date)?.solar;
      return { date, timeZone, periodStart: start.toISOString(), periodEnd: end.toISOString(),
        dailyEnergy: energy.dailyEnergy, measurements: energy.measurements, battery: observed,
        historicalEstimated: { status: 'ready', error: null, points: saved.battery,
          projection: saved.metadata?.projection ?? { status: 'unavailable', reason: 'awaiting_evaluation', assumption: 'automatic_planning' } },
        observations: { method: 'counter_differences' as const, solar: energy.solar, household: energy.household,
          car: energy.car, totalHousehold: energy.totalHousehold },
        solarEstimates: saved.solar, energyEstimates: saved.house, carEstimates: saved.car,
        householdPredictions: saved.house, ...(solar ? { solarForecast: { status: solar.status, error: solar.error,
          fetchedAt: solar.fetchedAt, weatherModel: solar.weatherModel } } : {}) };
    },
  };
  function close() {
    if (closing) return closing;
    closing = (async () => {
      try { await flush(); }
      finally { await tail; closed = true; releaseWriter(); await pool.end(); }
    })();
    return closing;
  }
  const householdArchive = createHouseholdArchive({ pool, transaction });
  return { dailyEnergyStore, batteryHistory, batteryOrigin, historyReader, householdArchive,
    record, recordTelemetry, publishForecasts, readForecast, flush, close };
}
