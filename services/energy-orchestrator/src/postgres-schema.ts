/** Canonical observations are separate domains: house excludes car charging. No migrations run. */
export const postgresSchema = `
CREATE SCHEMA IF NOT EXISTS energy_history;
CREATE TABLE IF NOT EXISTS energy_history.metadata (key text PRIMARY KEY, value jsonb NOT NULL);
${(['battery', 'house', 'car', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_observations (
  observed_at timestamptz PRIMARY KEY CHECK (isfinite(observed_at)),
  value double precision NOT NULL CHECK (value >= 0 AND value < 'Infinity'::double precision${channel === 'battery' ? ' AND value <= 100' : ''})
);`).join('\n')}
CREATE TABLE IF NOT EXISTS energy_history.battery_forecasts (
  target_at timestamptz PRIMARY KEY CHECK (isfinite(target_at) AND EXTRACT(EPOCH FROM target_at) % 900 = 0),
  soc_percent double precision NOT NULL CHECK (soc_percent >= 0 AND soc_percent <= 100)
);
${(['house', 'car', 'solar'] as const).map(channel => `
CREATE TABLE IF NOT EXISTS energy_history.${channel}_forecasts (
  interval_start timestamptz PRIMARY KEY CHECK (isfinite(interval_start) AND EXTRACT(EPOCH FROM interval_start) % 900 = 0),
  energy_kwh double precision NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh < 'Infinity'::double precision)
);`).join('\n')}
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
INSERT INTO energy_history.metadata (key, value) VALUES ('schema_version', '11'::jsonb)
ON CONFLICT (key) DO NOTHING;
`;
