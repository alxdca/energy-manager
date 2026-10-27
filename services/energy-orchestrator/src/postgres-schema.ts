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
