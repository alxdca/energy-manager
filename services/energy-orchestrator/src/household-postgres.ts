import { createHash } from 'node:crypto';
import type pg from 'pg';
import { householdDaySlots, householdModelVersion, type HouseholdForecast,
  type HouseholdModel, type HouseholdWeather } from './household-model.js';
import type { HouseholdForecastArchive } from './household-service.js';
import type { HouseholdWeatherArchive } from './household-weather.js';
import type { EnergyEstimatePoint } from './energy-estimate-history.js';

const weatherId = (weather: HouseholdWeather) => createHash('sha256').update(JSON.stringify(weather)).digest('hex');
const householdModelKey = 'household_model_v1';
export const householdForecastKey = 'household_forecast_v1';
type ForecastContext = Omit<HouseholdForecast, 'slots' | 'hourly' | 'estimatedConsumptionKwh' | 'updatedTotal'> & {
  slots: Array<Omit<HouseholdForecast['slots'][number], 'estimatedConsumptionKwh'>>;
  updatedTotal: Omit<NonNullable<HouseholdForecast['updatedTotal']>, 'futureKwh' | 'estimatedConsumptionKwh'> | null;
};
export interface HouseholdPublication { calculatedAt: string; forecasts: ForecastContext[] }

/** Numerical forecasts have one durable home: house_forecasts. Metadata holds only the latest context. */
export function householdForecastFromEstimates(publication: HouseholdPublication | null, date: string, points: EnergyEstimatePoint[]): HouseholdForecast | null {
  const context = publication?.forecasts.find(forecast => forecast.date === date);
  if (!context || context.modelVersion !== householdModelVersion || context.scope !== 'household_excluding_car') return null;
  const values = new Map(points.map(point => [point.start, point.estimatedConsumptionKwh]));
  const slots = context.slots.map(slot => ({ ...slot, estimatedConsumptionKwh: values.get(slot.start) ?? null }));
  const sum = (items: typeof slots) => items.some(slot => slot.estimatedConsumptionKwh === null) ? null
    : items.reduce((total, slot) => total + slot.estimatedConsumptionKwh!, 0);
  const total = sum(slots), cutoff = Date.parse(context.issuedAt);
  const future = slots.filter(slot => Date.parse(slot.end) > cutoff);
  const futureKwh = sum(future) === null ? null : future.reduce((energy, slot) => energy + slot.estimatedConsumptionKwh!
    * (Date.parse(slot.end) - Math.max(cutoff, Date.parse(slot.start))) / 900_000, 0);
  const updatedTotal = context.updatedTotal ? { ...context.updatedTotal, futureKwh,
    estimatedConsumptionKwh: context.updatedTotal.status === 'incomplete' || futureKwh === null ? null : context.updatedTotal.measuredKwh + futureKwh } : null;
  return { ...context, slots, hourly: Array.from({ length: slots.length / 4 }, (_, i) => ({
    start: slots[i * 4].start, end: slots[i * 4 + 3].end, estimatedConsumptionKwh: sum(slots.slice(i * 4, i * 4 + 4)),
  })), estimatedConsumptionKwh: total, status: total === null ? 'unavailable' : context.status, updatedTotal };
}
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
    async readObservations(start, end, finalizedThrough) {
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start
        || end.getTime() - start.getTime() > 86 * 86_400_000) throw new Error('Invalid training window.');
      const result = await pool.query<{ at: Date; value: number }>(`
        SELECT observed_at AS at, value FROM energy_history.house_observations
        WHERE observed_at >= $1 AND observed_at < $2
          AND date_bin('15 minutes', observed_at, '1970-01-01T00:00:00Z'::timestamptz)
            + interval '15 minutes' <= $3
        ORDER BY observed_at`, [start, end, finalizedThrough]);
      return result.rows.map(row => ({ at: row.at.toISOString(), value: row.value }));
    },
    async readModel() {
      const result = await pool.query<{ model: HouseholdModel }>(`SELECT value AS model FROM energy_history.metadata
        WHERE key = $1 AND value->>'version' = $2 AND value->>'scope' = $3`,
      [householdModelKey, householdModelVersion, 'household_excluding_car']);
      return result.rows[0]?.model ?? null;
    },
    async saveModel(model) {
      await transaction(async client => {
        await client.query(`INSERT INTO energy_history.metadata (key, value) VALUES ($1, $2::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [householdModelKey, JSON.stringify(model)]);
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
    async saveForecasts(forecasts) {
      if (!forecasts.length || new Set(forecasts.map(forecast => forecast.date)).size !== forecasts.length) throw new Error('Invalid household forecast.');
      const cutoff = Date.parse(forecasts[0].issuedAt);
      for (const forecast of forecasts) {
        const expected = householdDaySlots(forecast.date);
        if (!Number.isFinite(cutoff) || Date.parse(forecast.issuedAt) !== cutoff || forecast.scope !== 'household_excluding_car'
          || forecast.modelVersion !== householdModelVersion || forecast.excludesCar !== true || forecast.slots.length !== expected.length
          || forecast.slots.some((slot, i) => slot.start !== expected[i].start || slot.end !== expected[i].end
            || slot.estimatedConsumptionKwh !== null && (!Number.isFinite(slot.estimatedConsumptionKwh) || slot.estimatedConsumptionKwh < 0))) {
          throw new Error('Invalid household forecast.');
        }
      }
      await transaction(async client => {
        const saved = await client.query<{ key: string; value: HouseholdPublication }>('SELECT key, value FROM energy_history.metadata WHERE key = ANY($1::text[])',
          [[householdForecastKey, 'forecast_batch_v1']]);
        const previous = saved.rows.find(row => row.key === householdForecastKey)?.value;
        if (saved.rows.some(row => Date.parse(row.value.calculatedAt) > cutoff)) throw new Error('Household forecast is older than the saved publication.');
        const activeStart = new Date(Math.floor(cutoff / 900_000) * 900_000);
        const firstStart = forecasts.map(forecast => forecast.slots[0].start).sort()[0];
        const existing = await client.query<{ start: Date }>(`SELECT interval_start AS start FROM energy_history.house_forecasts
          WHERE interval_start >= $1 AND interval_start <= $2`, [firstStart, activeStart]);
        const frozen = new Set(existing.rows.map(point => point.start.toISOString()));
        const contexts = forecasts.map(forecast => {
          const { estimatedConsumptionKwh: _total, hourly: _hourly, slots, updatedTotal, ...context } = forecast;
          const oldSlots = new Map(previous?.forecasts.find(old => old.date === forecast.date)?.slots.map(slot => [slot.start, slot]));
          return { ...context, updatedTotal: updatedTotal ? { measuredKwh: updatedTotal.measuredKwh,
            status: updatedTotal.status, measuredThrough: updatedTotal.measuredThrough } : null,
            slots: slots.map(({ estimatedConsumptionKwh: _energy, ...slot }) => frozen.has(slot.start)
              ? oldSlots.get(slot.start) ?? { ...slot, source: 'configured_baseline' as const, observations: 0,
                matchingWeekdays: 0, weekdayFactor: 1 as const, weekdayWeightShare: null, weatherAdjustmentKwh: null }
              : slot) };
        });
        await client.query('DELETE FROM energy_history.house_forecasts WHERE interval_start > $1', [activeStart]);
        const points = forecasts.flatMap(forecast => forecast.slots).filter(slot => Date.parse(slot.end) > cutoff && slot.estimatedConsumptionKwh !== null);
        if (points.length) await client.query(`INSERT INTO energy_history.house_forecasts (interval_start, energy_kwh)
          SELECT x.start::timestamptz, x."estimatedConsumptionKwh" FROM jsonb_to_recordset($1::jsonb)
            AS x(start text, "estimatedConsumptionKwh" double precision) ON CONFLICT (interval_start) DO NOTHING`, [JSON.stringify(points)]);
        await client.query(`INSERT INTO energy_history.metadata (key, value) VALUES ($1, $2::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [householdForecastKey,
          JSON.stringify({ calculatedAt: forecasts[0].issuedAt, forecasts: contexts } satisfies HouseholdPublication)]);
      });
    },
    async readForecast(date) {
      const slots = householdDaySlots(date);
      const result = await pool.query<{ publication: HouseholdPublication | null; points: Array<{ start: string; estimatedConsumptionKwh: number }> }>(`
        SELECT (SELECT value FROM energy_history.metadata WHERE key = $1) AS publication,
          COALESCE((SELECT json_agg(json_build_object('start', interval_start, 'estimatedConsumptionKwh', energy_kwh) ORDER BY interval_start)
            FROM energy_history.house_forecasts WHERE interval_start >= $2 AND interval_start < $3), '[]'::json) AS points`,
      [householdForecastKey, slots[0].start, slots.at(-1)!.end]);
      const row = result.rows[0];
      return householdForecastFromEstimates(row.publication, date, row.points.map(point => ({ ...point,
        start: new Date(point.start).toISOString(), end: new Date(Date.parse(point.start) + 900_000).toISOString() })));
    },
  };
}
