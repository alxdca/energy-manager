import { createHash } from 'node:crypto';
import type pg from 'pg';
import { householdDaySlots, householdModelVersion, type HouseholdForecast, type HouseholdInterval,
  type HouseholdModel, type HouseholdObservation, type HouseholdWeather } from './household-model.js';
import type { HouseholdForecastArchive } from './household-service.js';
import type { HouseholdWeatherArchive } from './household-weather.js';
import type { EnergyEstimatePoint } from './energy-estimate-history.js';

const weatherId = (weather: HouseholdWeather) => createHash('sha256').update(JSON.stringify(weather)).digest('hex');
export function createHouseholdArchive(options: {
  pool: pg.Pool;
  transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}): HouseholdForecastArchive & HouseholdWeatherArchive {
  const { pool, transaction } = options;
  const saveWeather = async (input: HouseholdWeather) => {
    await transaction(async client => {
      await client.query(`INSERT INTO energy_history.household_weather (id, kind, fetched_at, latitude, longitude, model, input)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING`,
      [weatherId(input), input.kind, input.fetchedAt, input.latitude, input.longitude, input.model, JSON.stringify(input)]);
    });
  };
  return {
    async readObservations(start, end, availableAt) {
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start
        || end.getTime() - start.getTime() > 86 * 86_400_000) throw new Error('Invalid training window.');
      const result = await pool.query<{ at: Date; value: number; start: Date | null; end: Date | null;
        nominalStart: Date | null; nominalEnd: Date | null; source: string | null; availableAt: Date | null }>(`
        SELECT o.observed_at AS at, o.value, i.interval_start AS start, i.interval_end AS end,
          i.nominal_start AS "nominalStart", i.nominal_end AS "nominalEnd", i.source, i.available_at AS "availableAt"
        FROM energy_history.house_observations o LEFT JOIN energy_history.house_intervals i USING (observed_at)
        WHERE o.observed_at >= $1 AND o.observed_at < $2
          AND (i.available_at IS NULL OR i.available_at <= $3) ORDER BY o.observed_at`, [start, end, availableAt]);
      return result.rows.map(row => ({ at: row.at.toISOString(), value: row.value,
        ...(row.start ? { interval: { at: row.at.toISOString(), start: row.start.toISOString(), end: row.end!.toISOString(),
          nominalStart: row.nominalStart!.toISOString(), nominalEnd: row.nominalEnd!.toISOString(),
          source: row.source!, availableAt: row.availableAt!.toISOString() } } : {}) }));
    },
    async readModel() {
      const result = await pool.query<{ model: HouseholdModel }>(`SELECT model FROM energy_history.household_training
        WHERE model->>'version' = $1 ORDER BY trained_at DESC, id DESC LIMIT 1`, [householdModelVersion]);
      return result.rows[0]?.model ?? null;
    },
    async saveTraining(run) {
      await transaction(async client => {
        await client.query(`INSERT INTO energy_history.household_training (id, trained_at, model, inputs)
          VALUES ($1,$2,$3::jsonb,$4::jsonb)`, [run.model.id, run.model.trainedAt, JSON.stringify(run.model),
          JSON.stringify({ observations: run.observations, historicalWeather: run.weather ?? null })]);
      });
    },
    saveWeather,
    async readWeather(kind, config, at) {
      const model = kind === 'historical' ? 'era5_land' : config.weatherModel ?? 'best_match';
      const result = await pool.query<{ input: HouseholdWeather }>(`SELECT input FROM energy_history.household_weather
        WHERE kind = $1 AND latitude = $2 AND longitude = $3 AND model = $4 AND fetched_at <= $5
        ORDER BY fetched_at DESC LIMIT 1`, [kind, config.latitude, config.longitude, model, at]);
      return result.rows[0]?.input ?? null;
    },
    async saveForecasts(forecasts, weather) {
      for (const forecast of forecasts) {
        const expected = householdDaySlots(forecast.date);
        if (!Number.isFinite(Date.parse(forecast.issuedAt)) || forecast.slots.length !== expected.length
          || forecast.slots.some((slot, i) => slot.start !== expected[i].start || slot.end !== expected[i].end
            || slot.estimatedConsumptionKwh !== null && (!Number.isFinite(slot.estimatedConsumptionKwh) || slot.estimatedConsumptionKwh < 0))) {
          throw new Error('Invalid household forecast.');
        }
      }
      await transaction(async client => {
        for (const forecast of forecasts) await client.query(`INSERT INTO energy_history.household_forecasts
          (issued_at, target_date, model_version, scope, model_id, forecast, inputs)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT DO NOTHING`,
        [forecast.issuedAt, forecast.date, forecast.modelVersion, forecast.scope, forecast.modelId, JSON.stringify(forecast),
          JSON.stringify({ weatherId: weather ? weatherId(weather) : null, measurementCutoff: forecast.issuedAt,
            alignment: 'nominal_quarter_approximation' })]);
      });
    },
    async readForecast(date) {
      householdDaySlots(date);
      const result = await pool.query<{ forecast: HouseholdForecast }>(`SELECT forecast FROM energy_history.household_forecasts
        WHERE target_date = $1 AND model_version = $2 AND scope = 'household_total'
        ORDER BY issued_at DESC LIMIT 1`, [date, householdModelVersion]);
      return result.rows[0]?.forecast ?? null;
    },
  };
}

/** Same transaction as the delta and sampler checkpoint, so failed flushes cannot leave orphan metadata. */
export async function writeHouseholdIntervals(client: pg.PoolClient, intervals: HouseholdInterval[]) {
  if (!intervals.length) return;
  await client.query(`INSERT INTO energy_history.house_intervals
    (observed_at, interval_start, interval_end, nominal_start, nominal_end, source, available_at)
    SELECT x.at::timestamptz, x.start::timestamptz, x.end::timestamptz, x."nominalStart"::timestamptz,
      x."nominalEnd"::timestamptz, x.source, x."availableAt"::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS x(at text, start text, "end" text, "nominalStart" text,
      "nominalEnd" text, source text, "availableAt" text) ON CONFLICT DO NOTHING`, [JSON.stringify(intervals)]);
}

/** As-issued predictions for a historical chart: only versions issued before each slot started. */
export async function readHouseholdPredictionHistory(pool: pg.Pool, date: string, now: Date): Promise<EnergyEstimatePoint[]> {
  const result = await pool.query<{ at: string; value: number | null; source: EnergyEstimatePoint['source'] | null }>(`SELECT DISTINCT ON (slot->>'start')
      slot->>'start' AS at, (slot->>'estimatedConsumptionKwh')::double precision * 1000 AS value, slot->>'source' AS source
    FROM energy_history.household_forecasts f, LATERAL jsonb_array_elements(f.forecast->'slots') slot
    WHERE f.target_date = $1 AND f.issued_at <= $2 AND f.issued_at <= (slot->>'start')::timestamptz
      AND f.model_version = $3
    ORDER BY slot->>'start', f.issued_at DESC`, [date, now, householdModelVersion]);
  return result.rows.map(point => ({ start: point.at, end: new Date(Date.parse(point.at) + 900_000).toISOString(),
    estimatedConsumptionKwh: point.value === null ? null : point.value / 1000,
    ...(point.source ? { source: point.source } : {}) }));
}
