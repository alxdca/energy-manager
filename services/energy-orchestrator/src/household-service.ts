import { randomUUID } from 'node:crypto';
import { getCalendarDayBounds, getLocalDate } from './policy.js';
import { householdModelVersion, predictHousehold, shiftDate, trainHouseholdModel,
  type HouseholdForecast, type HouseholdModel, type HouseholdObservation, type HouseholdWeather } from './household-model.js';
import type { createHouseholdWeather } from './household-weather.js';

export interface HouseholdTrainingRun {
  model: HouseholdModel; observations: HouseholdObservation[]; weather?: HouseholdWeather;
}
export interface HouseholdForecastArchive {
  readObservations(start: Date, end: Date, availableAt: Date): Promise<HouseholdObservation[]>;
  readModel(): Promise<HouseholdModel | null>;
  saveTraining(run: HouseholdTrainingRun): Promise<void>;
  saveForecasts(forecasts: HouseholdForecast[], weather?: HouseholdWeather): Promise<void>;
  readForecast(date: string): Promise<HouseholdForecast | null>;
}
export interface HouseholdTrainingStatus {
  state: 'idle' | 'training' | 'error'; error: string | null; lastTrainedAt: string | null;
  nextTrainingAt: string | null; modelId: string | null; training: HouseholdModel['training'] | null;
  weatherStatus: HouseholdModel['weatherStatus'] | null; mode: 'observation'; scope: 'household_total';
}

/** Daily training and explicit manual training share a serialized path; GETs only read saved results. */
export function createHouseholdService(options: {
  archive: HouseholdForecastArchive; weather: ReturnType<typeof createHouseholdWeather>; now?: () => Date;
  finalizeMeasurements?(): Promise<void>;
}) {
  const now = options.now ?? (() => new Date());
  let model: HouseholdModel | null = null, loaded = false;
  let pending: Promise<void> | null = null, training = false, requestedTraining = false;
  let error: string | null = null;
  let lastAttempt: number | null = null;
  const status = (): HouseholdTrainingStatus => ({ state: training || requestedTraining ? 'training' : error ? 'error' : 'idle', error,
    lastTrainedAt: model?.trainedAt ?? null, nextTrainingAt: model?.validUntil ?? null, modelId: model?.id ?? null,
    training: model?.training ?? null, weatherStatus: model?.weatherStatus ?? null, mode: 'observation', scope: 'household_total' });
  async function calculate(forceTraining: boolean): Promise<void> {
    try {
      if (!loaded) { model = await options.archive.readModel(); loaded = true; }
      const at = now(), today = getLocalDate(at);
      const mustTrain = forceTraining || !model || model.version !== householdModelVersion || model.trainingDate !== today
        || Date.parse(model.validUntil) <= at.getTime();
      const mayRetry = forceTraining || lastAttempt === null || at.getTime() - lastAttempt >= 15 * 60_000;
      let historyUnavailable = false;
      if (mustTrain && mayRetry) {
        training = true; lastAttempt = at.getTime();
        await options.finalizeMeasurements?.();
        const start = getCalendarDayBounds(new Date(`${shiftDate(today, -84)}T00:00:00Z`)).start;
        const [observations, weather] = await Promise.all([
          options.archive.readObservations(start, at, at), options.weather.read('historical', forceTraining),
        ]);
        const trainedAt = now();
        const candidate = trainHouseholdModel({ id: randomUUID(), at: trainedAt, observations, weather });
        await options.archive.saveTraining({ model: candidate, observations, weather });
        model = candidate;
      }
      const weather = await options.weather.read('forecast');
      const issuedAt = now(), date = getLocalDate(issuedAt);
      const start = getCalendarDayBounds(new Date(`${date}T00:00:00Z`)).start;
      let observations: HouseholdObservation[] = [];
      try { observations = await options.archive.readObservations(start, issuedAt, issuedAt); }
      catch { historyUnavailable = true; }
      const forecasts = [0, 1, 2].map(offset => predictHousehold({ date: shiftDate(date, offset), at: issuedAt, model, weather, observations,
        ...(historyUnavailable ? { unavailableReason: 'current_measurements_unavailable' } : {}) }));
      await options.archive.saveForecasts(forecasts, weather);
      error = null;
    } catch {
      error = 'L’apprentissage ou l’enregistrement des prévisions maison a échoué. Nouvelle tentative automatique.';
      // Expired models are never used to conceal a training failure.
      const issuedAt = now(), date = getLocalDate(issuedAt);
      const forecasts = [0, 1, 2].map(offset => predictHousehold({ date: shiftDate(date, offset), at: issuedAt,
        model, unavailableReason: 'training_failed' }));
      await options.archive.saveForecasts(forecasts).catch(() => {});
      throw new Error(error);
    } finally { training = false; }
  }
  function refresh(forceTraining = false): Promise<void> {
    if (forceTraining && !training) requestedTraining = true;
    if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      do {
        const force = requestedTraining; requestedTraining = false;
        await calculate(force);
      } while (requestedTraining);
    });
    pending = task.finally(() => { pending = null; requestedTraining = false; }); return pending;
  }
  return { refresh: () => refresh(), train: () => refresh(true), status,
    forecast: (date: string) => options.archive.readForecast(date),
    stop: () => pending?.catch(() => {}) ?? Promise.resolve() };
}
export type HouseholdService = ReturnType<typeof createHouseholdService>;
