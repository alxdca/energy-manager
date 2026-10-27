/** Finalized observations retain their actual sampled time and one fixed-unit value. */
export const postgresSchema = `
CREATE SCHEMA IF NOT EXISTS energy_history;
CREATE TABLE IF NOT EXISTS energy_history.metadata (key text PRIMARY KEY, value jsonb NOT NULL);
${(['battery', 'house', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_observations (
  observed_at timestamptz PRIMARY KEY CHECK (isfinite(observed_at)),
  value double precision NOT NULL CHECK (value >= 0 AND value < 'Infinity'::double precision${channel === 'battery' ? ' AND value <= 100' : ''})
);`).join('\n')}
CREATE TABLE IF NOT EXISTS energy_history.battery_estimates (
  target_at timestamptz PRIMARY KEY CHECK (isfinite(target_at) AND EXTRACT(EPOCH FROM target_at) % 900 = 0),
  soc_percent double precision NOT NULL CHECK (soc_percent >= 0 AND soc_percent <= 100)
);
${(['house', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_estimates (
  interval_start timestamptz PRIMARY KEY CHECK (isfinite(interval_start) AND EXTRACT(EPOCH FROM interval_start) % 900 = 0),
  energy_kwh double precision NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh < 'Infinity'::double precision)
);`).join('\n')}
INSERT INTO energy_history.metadata (key, value) VALUES ('schema_version', '6'::jsonb)
ON CONFLICT (key) DO NOTHING;
`;

/** Additive v6 → v7 migration. Existing observations and estimates are preserved verbatim. */
export const householdForecastMigration = `
CREATE TABLE IF NOT EXISTS energy_history.house_intervals (
  observed_at timestamptz PRIMARY KEY REFERENCES energy_history.house_observations(observed_at),
  interval_start timestamptz NOT NULL CHECK (isfinite(interval_start)),
  interval_end timestamptz NOT NULL CHECK (isfinite(interval_end) AND interval_end > interval_start),
  nominal_start timestamptz NOT NULL,
  nominal_end timestamptz NOT NULL CHECK (nominal_end - nominal_start = interval '15 minutes'),
  source text NOT NULL CHECK (length(source) > 0),
  available_at timestamptz NOT NULL CHECK (isfinite(available_at) AND available_at >= interval_end)
);
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
CREATE TABLE IF NOT EXISTS energy_history.household_training (
  id uuid PRIMARY KEY,
  trained_at timestamptz NOT NULL CHECK (isfinite(trained_at)),
  model jsonb NOT NULL,
  inputs jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS household_training_latest ON energy_history.household_training (trained_at DESC);
CREATE TABLE IF NOT EXISTS energy_history.household_forecasts (
  issued_at timestamptz NOT NULL CHECK (isfinite(issued_at)),
  target_date date NOT NULL,
  model_version text NOT NULL,
  scope text NOT NULL CHECK (scope = 'household_total'),
  model_id uuid REFERENCES energy_history.household_training(id),
  forecast jsonb NOT NULL,
  inputs jsonb NOT NULL,
  PRIMARY KEY (issued_at, target_date, model_version, scope)
);
CREATE INDEX IF NOT EXISTS household_forecasts_latest ON energy_history.household_forecasts (target_date, issued_at DESC);
UPDATE energy_history.metadata SET value = '7'::jsonb WHERE key = 'schema_version';
`;
