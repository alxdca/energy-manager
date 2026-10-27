import { householdModelVersion } from './household-model.js';

/** Finalized observations retain their actual sampled time and one fixed-unit value. */
export const postgresSchema = `
CREATE SCHEMA IF NOT EXISTS energy_history;
CREATE TABLE IF NOT EXISTS energy_history.metadata (key text PRIMARY KEY, value jsonb NOT NULL);
${(['battery', 'house', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_observations (
  observed_at timestamptz PRIMARY KEY CHECK (isfinite(observed_at)),
  value double precision NOT NULL CHECK (value >= 0 AND value < 'Infinity'::double precision${channel === 'battery' ? ' AND value <= 100' : ''})
);`).join('\n')}
CREATE TABLE IF NOT EXISTS energy_history.battery_forecasts (
  target_at timestamptz PRIMARY KEY CHECK (isfinite(target_at) AND EXTRACT(EPOCH FROM target_at) % 900 = 0),
  soc_percent double precision NOT NULL CHECK (soc_percent >= 0 AND soc_percent <= 100)
);
${(['house', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_forecasts (
  interval_start timestamptz PRIMARY KEY CHECK (isfinite(interval_start) AND EXTRACT(EPOCH FROM interval_start) % 900 = 0),
  energy_kwh double precision NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh < 'Infinity'::double precision)
);`).join('\n')}
INSERT INTO energy_history.metadata (key, value) VALUES ('schema_version', '9'::jsonb)
ON CONFLICT (key) DO NOTHING;
`;

/** Additive v6 → v7 migration. Existing observations and estimates are preserved verbatim. */
export const householdForecastMigration = `
CREATE TABLE IF NOT EXISTS energy_history.household_weather (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('historical', 'forecast')),
  fetched_at timestamptz NOT NULL CHECK (isfinite(fetched_at)),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  model text NOT NULL,
  input jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS household_weather_lookup ON energy_history.household_weather (kind, fetched_at DESC);
`;

/** v6/v7 → v8: rename in place before creating current tables, retaining rows and constraints. */
export const forecastTableRenameMigration = `
DO $migration$
BEGIN
${(['battery', 'house', 'solar'] as const).map(channel => `
  IF to_regclass('energy_history.${channel}_estimates') IS NOT NULL THEN
    IF to_regclass('energy_history.${channel}_forecasts') IS NOT NULL THEN
      RAISE EXCEPTION 'Conflit de schéma PostgreSQL : ${channel}_estimates et ${channel}_forecasts existent ensemble.';
    END IF;
    ALTER TABLE energy_history.${channel}_estimates RENAME TO ${channel}_forecasts;
  END IF;`).join('\n')}
END;
$migration$;
UPDATE energy_history.metadata SET value = '8'::jsonb WHERE key = 'schema_version';
`;

/** v8 → v9: retain the latest compatible model and remove the unused training/input archive. */
export const householdModelMetadataMigration = `
DO $migration$
DECLARE legacy_foreign_key record;
BEGIN
  IF to_regclass('energy_history.household_training') IS NOT NULL THEN
    INSERT INTO energy_history.metadata (key, value)
      SELECT 'household_model_v1', model FROM energy_history.household_training
      WHERE model->>'version' = '${householdModelVersion}' ORDER BY trained_at DESC, id DESC LIMIT 1
      ON CONFLICT (key) DO NOTHING;
    -- The retired forecast archive can retain its rows without a reference to training runs.
    FOR legacy_foreign_key IN SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND conrelid = to_regclass('energy_history.household_forecasts')
        AND confrelid = 'energy_history.household_training'::regclass
    LOOP
      EXECUTE format('ALTER TABLE energy_history.household_forecasts DROP CONSTRAINT %I', legacy_foreign_key.conname);
    END LOOP;
    DROP TABLE energy_history.household_training;
  END IF;
END;
$migration$;
UPDATE energy_history.metadata SET value = '9'::jsonb WHERE key = 'schema_version';
`;

/** v9 → v10: preserve total observations and add independently measured car/house channels. */
export const carEnergyMigration = `
${(['car', 'house_only'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_observations (
  observed_at timestamptz PRIMARY KEY CHECK (isfinite(observed_at)),
  value double precision NOT NULL CHECK (value >= 0 AND value < 'Infinity'::double precision)
);`).join('\n')}
ALTER TABLE energy_history.house_forecasts ADD COLUMN IF NOT EXISTS excludes_car boolean NOT NULL DEFAULT false;
UPDATE energy_history.metadata SET value = '10'::jsonb WHERE key = 'schema_version';
`;

/** v10 → v11: car forecasts have the same immutable quarter-hour energy contract as solar/house. */
export const carForecastMigration = `
CREATE TABLE IF NOT EXISTS energy_history.car_forecasts (
  interval_start timestamptz PRIMARY KEY CHECK (isfinite(interval_start) AND EXTRACT(EPOCH FROM interval_start) % 900 = 0),
  energy_kwh double precision NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh < 'Infinity'::double precision)
);
UPDATE energy_history.metadata SET value = '11'::jsonb WHERE key = 'schema_version';
`;
