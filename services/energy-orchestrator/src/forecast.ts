import type { ForecastDayOffset } from './forecast-horizon.js';
import { getCalendarDayBounds, policy, timeZone } from './policy.js';

export interface ForecastConfig {
  latitude: number;
  longitude: number;
  locationName: string;
  arrayPowerKw: number;
  performanceRatio: number;
  panelTiltDegrees?: number;
  eastFraction?: number;
  weatherModel?: 'best_match' | 'meteoswiss_icon_ch2';
}

export interface SolarForecast {
  status: 'online' | 'stale' | 'offline' | 'not_configured';
  date: string;
  locationName: string | null;
  estimatedProductionKwh: number | null;
  hourly: Array<{ start: string; end: string; estimatedProductionKwh: number; temperatureC: number | null }> | null;
  /** Per-target solar energy from the provider's preceding-quarter irradiance means. */
  quarterHourly?: Array<{ start: string; end: string; estimatedProductionKwh: number; temperatureC: number | null }> | null;
  weatherCode: number | null;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  temperatureMeanC: number | null;
  fetchedAt: string | null;
  source: 'Open-Meteo';
  model: 'horizontal_radiation' | 'east_west_tilted_radiation';
  arrayPowerKw: number;
  performanceRatio: number;
  panelTiltDegrees: number | null;
  eastFraction: number | null;
  weatherModel: 'best_match' | 'meteoswiss_icon_ch2';
  productionPeriodStart: string | null;
  productionPeriodEnd: string | null;
  error: string | null;
}

export interface ForecastOptions {
  config?: ForecastConfig | null;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  dayOffset?: ForecastDayOffset;
  cacheAlignment?: 'elapsed' | 'clock_hour';
}

/** A retained forecast remains usable for its original date after a provider outage. */
export function hasUsableForecast(forecast: Pick<SolarForecast, 'status' | 'fetchedAt'>, now: number): boolean {
  const fetched = Date.parse(forecast.fetchedAt ?? '');
  return (forecast.status === 'online' || forecast.status === 'stale')
    && Number.isFinite(now) && Number.isFinite(fetched) && fetched - now <= 5000;
}

class ForecastProviderError extends Error {}

function validNumber(value: unknown, minimum: number, maximum: number, exclusiveMinimum = false): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && (exclusiveMinimum ? value > minimum : value >= minimum) && value <= maximum;
}

function validateConfig(config: ForecastConfig): ForecastConfig {
  if (config.weatherModel !== undefined && config.weatherModel !== 'best_match' && config.weatherModel !== 'meteoswiss_icon_ch2') {
    throw new Error('FORECAST_WEATHER_MODEL doit être best_match ou meteoswiss_icon_ch2.');
  }
  if (!validNumber(config.latitude, -90, 90) || !validNumber(config.longitude, -180, 180)) {
    throw new Error('FORECAST_LATITUDE et FORECAST_LONGITUDE doivent être des coordonnées valides.');
  }
  if (!validNumber(config.arrayPowerKw, 0, 100, true)) {
    throw new Error('FORECAST_SOLAR_CAPACITY_KW doit être supérieur à 0 et inférieur ou égal à 100.');
  }
  if (!validNumber(config.performanceRatio, 0, 1, true)) {
    throw new Error('FORECAST_PERFORMANCE_RATIO doit être supérieur à 0 et inférieur ou égal à 1.');
  }
  if (config.panelTiltDegrees === undefined && config.eastFraction !== undefined) {
    throw new Error('FORECAST_EAST_FRACTION nécessite FORECAST_PANEL_TILT_DEG.');
  }
  if (config.panelTiltDegrees !== undefined) {
    if (!validNumber(config.panelTiltDegrees, 0, 90)) {
      throw new Error('FORECAST_PANEL_TILT_DEG doit être compris entre 0 et 90 degrés.');
    }
    if (!validNumber(config.eastFraction ?? 0.5, 0, 1)) {
      throw new Error('FORECAST_EAST_FRACTION doit être compris entre 0 et 1.');
    }
    config = { ...config, eastFraction: config.eastFraction ?? 0.5 };
  }
  return { ...config, locationName: config.locationName.trim() || 'Installation', weatherModel: config.weatherModel ?? 'best_match' };
}

// Accept decimal notation only: Number('') and hexadecimal are not configuration values.
function decimal(value: string | undefined, fallback?: number): number {
  if (value === undefined || value.trim() === '') return fallback ?? NaN;
  const trimmed = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : NaN;
}

export function loadForecastConfig(env: Record<string, string | undefined> = process.env): ForecastConfig | null {
  const latitude = env.FORECAST_LATITUDE?.trim();
  const longitude = env.FORECAST_LONGITUDE?.trim();
  if (!latitude && !longitude) return null;
  return validateConfig({
    latitude: decimal(latitude), longitude: decimal(longitude),
    locationName: env.FORECAST_LOCATION_NAME ?? 'Installation',
    arrayPowerKw: decimal(env.FORECAST_SOLAR_CAPACITY_KW, policy.solarCapacityKw),
    performanceRatio: decimal(env.FORECAST_PERFORMANCE_RATIO, 0.85),
    weatherModel: (env.FORECAST_WEATHER_MODEL?.trim() || 'best_match') as ForecastConfig['weatherModel'],
    ...(env.FORECAST_PANEL_TILT_DEG?.trim() ? { panelTiltDegrees: decimal(env.FORECAST_PANEL_TILT_DEG) } : {}),
    ...(env.FORECAST_EAST_FRACTION?.trim() ? { eastFraction: decimal(env.FORECAST_EAST_FRACTION) } : {}),
  });
}

const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});
function targetDate(now: Date, dayOffset: ForecastDayOffset): string {
  const parts = Object.fromEntries(localDate.formatToParts(now).map(part => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset)).toISOString().slice(0, 10);
}

type ForecastValues = Pick<SolarForecast, 'estimatedProductionKwh' | 'hourly' | 'quarterHourly' | 'weatherCode' | 'temperatureMinC' | 'temperatureMaxC' | 'temperatureMeanC' | 'productionPeriodStart' | 'productionPeriodEnd'>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function productionEstimate(radiationKwh: number, config: ForecastConfig): number {
  const production = radiationKwh * config.arrayPowerKw * config.performanceRatio;
  if (!Number.isFinite(production) || !Number.isFinite(production * 10)) throw new Error('invalid production');
  return Math.round(production * 10) / 10;
}

function parseForecast(body: unknown, date: string, config: ForecastConfig): ForecastValues {
  if (!record(body) || !record(body.daily) || !record(body.daily_units)) throw new Error('invalid forecast');
  const daily = body.daily;
  const units = body.daily_units;
  const value = (key: string): unknown => {
    const values = daily[key];
    if (!Array.isArray(values) || values.length !== 1) throw new Error('invalid daily values');
    return values[0];
  };
  if (units.time !== 'iso8601' || value('time') !== date || units.shortwave_radiation_sum !== 'MJ/m²') {
    throw new Error('invalid date or radiation unit');
  }
  const radiation = value('shortwave_radiation_sum');
  if (!validNumber(radiation, 0, Number.MAX_VALUE)) throw new Error('invalid radiation');
  const optional = (key: string, unit: string, min: number, max: number): number | null => {
    if (daily[key] === undefined) return null;
    const result = value(key);
    if (units[key] !== unit) throw new Error('invalid weather unit');
    if (result === null) return null;
    if (!validNumber(result, min, max)) throw new Error('invalid weather value');
    return result;
  };
  const weatherCode = optional('weather_code', 'wmo code', 0, 99);
  if (weatherCode !== null && !Number.isInteger(weatherCode)) throw new Error('invalid weather code');
  const temperatureMinC = optional('temperature_2m_min', '°C', -100, 70);
  const temperatureMaxC = optional('temperature_2m_max', '°C', -100, 70);
  const temperatureMeanC = optional('temperature_2m_mean', '°C', -100, 70);
  if (temperatureMinC !== null && temperatureMaxC !== null && temperatureMinC > temperatureMaxC) {
    throw new Error('invalid temperature range');
  }
  if (temperatureMeanC !== null && ((temperatureMinC !== null && temperatureMeanC < temperatureMinC)
    || (temperatureMaxC !== null && temperatureMeanC > temperatureMaxC))) throw new Error('invalid mean temperature');
  return { estimatedProductionKwh: productionEstimate(radiation / 3.6, config), weatherCode, temperatureMinC, temperatureMaxC, temperatureMeanC,
    hourly: null, productionPeriodStart: null, productionPeriodEnd: null };
}

function tiltedRadiation(body: unknown, start: Date, end: Date): { radiation: number[]; temperature: Array<number | null> } {
  if (!record(body) || !record(body.minutely_15) || !record(body.minutely_15_units)) throw new Error('invalid quarter-hour forecast');
  const times = body.minutely_15.time;
  const radiation = body.minutely_15.global_tilted_irradiance;
  const quarters = (end.getTime() - start.getTime()) / 900_000;
  if (![92, 96, 100].includes(quarters) || body.minutely_15_units.time !== 'unixtime' || body.minutely_15_units.global_tilted_irradiance !== 'W/m²'
    || !Array.isArray(times) || !Array.isArray(radiation) || times.length !== quarters || radiation.length !== quarters) {
    throw new Error('invalid quarter-hour radiation');
  }
  let sum = 0;
  for (let quarter = 0; quarter < quarters; quarter++) {
    // Values are preceding-15-minute means; midnight closes the day that just ended.
    if (times[quarter] !== start.getTime() / 1000 + (quarter + 1) * 900
      || !validNumber(radiation[quarter], 0, Number.MAX_VALUE)) throw new Error('invalid quarter-hour value');
    sum += radiation[quarter];
  }
  if (!Number.isFinite(sum)) throw new Error('invalid radiation sum');
  const temperatures = body.minutely_15.temperature_2m;
  const validTemperatures = body.minutely_15_units.temperature_2m === '°C' && Array.isArray(temperatures)
    && temperatures.length === quarters && temperatures.every(value => validNumber(value, -100, 70));
  return { radiation: radiation as number[], temperature: validTemperatures ? temperatures as number[] : Array(quarters).fill(null) };
}

const cacheMs = 60 * 60 * 1000;
const retryMs = 5 * 60 * 1000;
const unavailable = 'Les prévisions météo sont indisponibles.';

/** Unknown forecast before a scheduled provider refresh, without performing any I/O. */
export function emptySolarForecast(date: string, config: ForecastConfig | null): SolarForecast {
  return {
    status: config ? 'offline' : 'not_configured', date, locationName: config?.locationName ?? null,
    estimatedProductionKwh: null, hourly: null, weatherCode: null, temperatureMinC: null, temperatureMaxC: null, temperatureMeanC: null,
    fetchedAt: null, source: 'Open-Meteo', model: config?.panelTiltDegrees === undefined ? 'horizontal_radiation' : 'east_west_tilted_radiation',
    arrayPowerKw: config?.arrayPowerKw ?? policy.solarCapacityKw, performanceRatio: config?.performanceRatio ?? 0.85,
    panelTiltDegrees: config?.panelTiltDegrees ?? null, eastFraction: config?.eastFraction ?? null,
    weatherModel: config?.weatherModel ?? 'best_match', productionPeriodStart: null, productionPeriodEnd: null,
    error: config ? unavailable : 'Configurez la localisation pour afficher les prévisions météo.',
  };
}

interface ForecastState {
  date: string;
  success: { values: ForecastValues; at: Date } | null;
  lastAttempt: number | null;
  error: string | null;
  inFlight: Promise<void> | null;
}

export function createForecastReader(options: ForecastOptions = {}): () => Promise<SolarForecast> {
  const configured = options.config === undefined ? loadForecastConfig() : options.config === null ? null : validateConfig(options.config);
  // CH2 stops at 120 hours; complete later calendar days use the longer-range blend.
  const config = configured && (options.dayOffset ?? 1) >= 3
    ? { ...configured, weatherModel: 'best_match' as const } : configured;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const dayOffset = options.dayOffset ?? 1;
  const freshAt = (fetchedAt: number, timestamp: number) => timestamp >= fetchedAt && timestamp - fetchedAt < cacheMs
    && (options.cacheAlignment !== 'clock_hour' || Math.floor(timestamp / cacheMs) === Math.floor(fetchedAt / cacheMs));
  let state: ForecastState | null = null;

  async function refresh(current: ForecastState): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounds = getCalendarDayBounds(new Date(`${current.date}T00:00:00Z`));
      const readProvider = async (azimuth?: number): Promise<unknown> => {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.search = new URLSearchParams({
          latitude: String(config!.latitude), longitude: String(config!.longitude),
          ...(config!.weatherModel === 'meteoswiss_icon_ch2' ? { models: config!.weatherModel } : {}),
          ...(azimuth === undefined ? {
            daily: 'shortwave_radiation_sum,weather_code,temperature_2m_min,temperature_2m_max,temperature_2m_mean',
            timezone: timeZone, start_date: current.date, end_date: current.date,
          } : {
            minutely_15: azimuth === -90 ? 'global_tilted_irradiance,temperature_2m' : 'global_tilted_irradiance', tilt: String(config!.panelTiltDegrees), azimuth: String(azimuth),
            timezone: 'GMT', timeformat: 'unixtime',
            start_minutely_15: new Date(bounds.start.getTime() + 900_000).toISOString().slice(0, 16),
            end_minutely_15: bounds.end.toISOString().slice(0, 16),
          }),
        }).toString();
        const response = await request(url, { method: 'GET', redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new ForecastProviderError(`Les prévisions météo sont indisponibles (HTTP ${response.status}).`);
        return response.json().catch(() => { throw new ForecastProviderError('La réponse du fournisseur météo contient du JSON invalide.'); });
      };
      const operation = (async () => {
        if (config!.panelTiltDegrees === undefined) return parseForecast(await readProvider(), current.date, config!);
        // Open-Meteo uses south=0°, east=-90°, west=90°.
        const [daily, east, west] = await Promise.all([
          readProvider().then(body => parseForecast(body, current.date, config!)),
          readProvider(-90).then(body => tiltedRadiation(body, bounds.start, bounds.end)),
          readProvider(90).then(body => tiltedRadiation(body, bounds.start, bounds.end)),
        ]);
        const fraction = config!.eastFraction!;
        // Model output resolution is independent of the hourly refresh cadence.
        // CH2 may be interpolated by Open-Meteo, but each quarter uses its own irradiance.
        const radiation = east.radiation.map((value, index) => (value * fraction + west.radiation[index] * (1 - fraction)) / 1000 / 4);
        const quarterHourly = radiation.map((value, index) => ({
          start: new Date(bounds.start.getTime() + index * 900_000).toISOString(),
          end: new Date(bounds.start.getTime() + (index + 1) * 900_000).toISOString(),
          estimatedProductionKwh: value * config!.arrayPowerKw * config!.performanceRatio,
          temperatureC: east.temperature[index],
        }));
        const hourly = Array.from({ length: quarterHourly.length / 4 }, (_, index) => {
          const quarters = quarterHourly.slice(index * 4, (index + 1) * 4);
          return { start: quarters[0].start, end: quarters[3].end,
            estimatedProductionKwh: quarters.reduce((sum, quarter) => sum + quarter.estimatedProductionKwh, 0),
            temperatureC: quarters[3].temperatureC };
        });
        return { ...daily, hourly, quarterHourly, estimatedProductionKwh: productionEstimate(radiation.reduce((sum, value) => sum + value, 0), config!),
          productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString() };

      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ForecastProviderError('Le délai de réponse des prévisions météo a dépassé 4 secondes.'));
        }, 4000);
      });
      const values = await Promise.race([operation, timeout]);
      current.success = { values, at: now() };
      current.error = null;
    } catch (failure) {
      controller.abort();
      current.error = failure instanceof ForecastProviderError ? failure.message : unavailable;
    } finally {
      clearTimeout(timer);
    }
  }

  return async () => {
    const date = targetDate(now(), dayOffset);
    const empty = emptySolarForecast(date, config);
    if (!config) return empty;
    if (state?.date !== date) state = { date, success: null, lastAttempt: null, error: null, inFlight: null };
    const current = state;
    const timestamp = now().getTime();
    const fresh = current.success && freshAt(current.success.at.getTime(), timestamp);
    // Clock-hour refreshes always get a new attempt at the next hour boundary.
    // Within that hour, failed requests retain the existing retry backoff.
    const backoff = current.lastAttempt !== null && timestamp >= current.lastAttempt && timestamp - current.lastAttempt < retryMs
      && (options.cacheAlignment !== 'clock_hour' || Math.floor(timestamp / cacheMs) === Math.floor(current.lastAttempt / cacheMs));
    if (!fresh && !backoff && !current.inFlight) {
      current.lastAttempt = timestamp;
      current.inFlight = refresh(current).finally(() => { current.inFlight = null; });
    }
    if (current.inFlight) await current.inFlight;
    // A pending request may finish after Zurich midnight. The next poll will
    // fetch the new target instead of relabelling the previous day's forecast.
    const currentTarget = targetDate(now(), dayOffset);
    if (currentTarget !== date) return { ...empty, date: currentTarget };
    if (!current.success) return { ...empty, error: current.error ?? unavailable };
    const age = now().getTime() - current.success.at.getTime();
    if (age < 0) return { ...empty, error: current.error ?? unavailable };
    return {
      ...empty, ...current.success.values,
      status: freshAt(current.success.at.getTime(), now().getTime()) && !current.error ? 'online' : 'stale',
      fetchedAt: current.success.at.toISOString(), error: current.error,
    };
  };
}
