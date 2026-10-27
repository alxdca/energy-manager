import type { ForecastConfig } from './forecast.js';
import { shiftDate, type HouseholdWeather } from './household-model.js';
import { getLocalDate } from './policy.js';

export interface HouseholdWeatherArchive {
  readWeather(kind: HouseholdWeather['kind'], config: ForecastConfig, at: Date): Promise<HouseholdWeather | null>;
  saveWeather(input: HouseholdWeather): Promise<void>;
}
/** Temperature collection is independent of solar geometry and preserves its original hourly resolution. */
export function createHouseholdWeather(options: {
  config: ForecastConfig | null; archive: HouseholdWeatherArchive; fetch?: typeof fetch; now?: () => Date;
}) {
  const now = options.now ?? (() => new Date()), request = options.fetch ?? fetch;
  const cache = new Map<HouseholdWeather['kind'], HouseholdWeather>();
  const attempts = new Map<HouseholdWeather['kind'], number>();
  const pending = new Map<HouseholdWeather['kind'], Promise<HouseholdWeather | undefined>>();
  async function refresh(kind: HouseholdWeather['kind'], force: boolean): Promise<HouseholdWeather | undefined> {
    const config = options.config!, at = now(), date = getLocalDate(at);
    if (!cache.has(kind)) {
      const saved = await options.archive.readWeather(kind, config, at);
      if (saved) cache.set(kind, saved);
    }
    const saved = cache.get(kind), fetched = Date.parse(saved?.fetchedAt ?? '');
    if (!force && saved && (kind === 'forecast' ? Math.floor(fetched / 3_600_000) === Math.floor(at.getTime() / 3_600_000)
      : getLocalDate(new Date(fetched)) === date)) return saved;
    const attempted = attempts.get(kind);
    if (attempted !== undefined && at.getTime() - attempted < 15 * 60_000) return saved;
    attempts.set(kind, at.getTime());
    try {
      const historical = kind === 'historical';
      const model = historical ? 'era5_land' : config.weatherModel ?? 'best_match';
      const url = new URL(historical ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: String(config.latitude), longitude: String(config.longitude),
        hourly: 'temperature_2m', timezone: 'GMT', timeformat: 'unixtime',
        // Reanalysis has a publication lag. Boundary days permit interpolation through local midnight.
        start_date: shiftDate(date, historical ? -85 : -1), end_date: shiftDate(date, historical ? -6 : 3),
        ...(model === 'best_match' ? {} : { models: model }) }).toString();
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Weather provider unavailable.');
      const body = await response.json() as { hourly_units?: { time?: string; temperature_2m?: string };
        hourly?: { time?: unknown[]; temperature_2m?: unknown[] } };
      const times = body.hourly?.time, temperatures = body.hourly?.temperature_2m;
      if (body.hourly_units?.time !== 'unixtime' || body.hourly_units.temperature_2m !== '°C'
        || !Array.isArray(times) || !Array.isArray(temperatures) || times.length < 2 || times.length !== temperatures.length) {
        throw new Error('Invalid temperature series.');
      }
      const points = times.map((time, i) => {
        const temperatureC = temperatures[i];
        if (typeof time !== 'number' || !Number.isFinite(time) || time % 3600 !== 0
          || i > 0 && time !== (times[i - 1] as number) + 3600
          || temperatureC !== null && (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC) || temperatureC < -100 || temperatureC > 70)) {
          throw new Error('Invalid temperature value.');
        }
        return { at: new Date(time * 1000).toISOString(), temperatureC: temperatureC as number | null };
      });
      const fetchedAt = now().toISOString();
      const input: HouseholdWeather = { kind, source: 'Open-Meteo', model, latitude: config.latitude, longitude: config.longitude,
        fetchedAt, availableAt: fetchedAt, originalStepMinutes: 60, points };
      await options.archive.saveWeather(input);
      cache.set(kind, input);
      return input;
    } catch { return saved; }
  }
  return { read(kind: HouseholdWeather['kind'], force = false): Promise<HouseholdWeather | undefined> {
    if (!options.config) return Promise.resolve(undefined);
    const existing = pending.get(kind);
    if (existing) return existing;
    const task = refresh(kind, force).finally(() => pending.delete(kind)); pending.set(kind, task); return task;
  } };
}
