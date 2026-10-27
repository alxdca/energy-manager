import type { AutomationConfig, EnergyForecast } from './automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from './automation.js';
import { projectBatterySoc, type BatteryProjection } from './battery-projection.js';
import { estimateConsumption, type ConsumptionConfig, type ConsumptionForecast } from './consumption.js';
import { emptySolarForecast, hasUsableForecast, type ForecastConfig, type SolarForecast } from './forecast.js';
import { buildPlannerDetails, getUpcomingHighTariff, type PlannerDetails } from './planner-details.js';
import { getLocalDate } from './policy.js';
import type { Telemetry } from './status.js';
import type { BatteryChargeEstimate } from './charge-estimate.js';
import type { CarChargingForecast } from './car-types.js';
import { validCarCharging } from './car-load.js';
import { solarIntervals } from './solar-intervals.js';
import type { EnergyEstimatePoint, SolarEstimatePoint } from './energy-estimate-history.js';
import type { ForecastBatch } from './forecast-publication.js';

const hourMs = 3_600_000;
const quarterMs = 900_000;
const dateAt = (at: Date, offset: number) => new Date(Date.parse(`${getLocalDate(at)}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const unavailableProjection = (): BatteryProjection => ({ status: 'unavailable', reason: 'awaiting_evaluation',
  assumption: 'automatic_planning', observedAt: null, points: [] });

export interface EstimateReader {
  planner(): PlannerDetails | null;
  projection(): BatteryProjection;
  chargeEstimate?(control: AutomationControllerState): BatteryChargeEstimate | null;
  status(): { calculatedAt: string | null; nextEvaluationAt: string };
}
interface EstimateOptions {
  forecastConfig: ForecastConfig | null;
  consumption: ConsumptionConfig;
  automationConfig: AutomationConfig;
  readSolar(offset: 0 | 1 | 2): Promise<SolarForecast>;
  readTelemetry(): Promise<Telemetry>;
  readControl(): Promise<AutomationControllerState & { automated?: boolean; chargeEstimate?: BatteryChargeEstimate }>;
  readAutomation(): AutomationStatus;
  evaluateAutomation(): Promise<void>;
  /** Prepare one immutable allocation before battery decisions; never called by GET readers. */
  prepareCarForecasts?(forecasts: EnergyForecast[], at: Date): Promise<CarChargingForecast[]>;
  /** Restore started solar intervals when this process has no retained snapshot. */
  readSolarHistory?(date: string): Promise<SolarEstimatePoint[]>;
  /** Restore started consumption quarters after restart for consistent planning inputs. */
  readEnergyHistory?(date: string): Promise<EnergyEstimatePoint[]>;
  /** Commit every estimate channel together before exposing the completed batch. */
  publishForecasts(batch: ForecastBatch): Promise<void>;
  onError?(error: unknown): void;
  now?: () => Date;
}

/** Keep model hours as sums of their independently retained quarter predictions. */
function withSolarQuarters(forecast: SolarForecast, quarterHourly: NonNullable<SolarForecast['quarterHourly']>): SolarForecast {
  const hourly = forecast.hourly?.map((hour, index) => ({ ...hour,
    estimatedProductionKwh: quarterHourly.slice(index * 4, index * 4 + 4).reduce((sum, point) => sum + point.estimatedProductionKwh, 0),
  })) ?? null;
  return { ...forecast, quarterHourly, hourly,
    estimatedProductionKwh: Math.round(quarterHourly.reduce((sum, point) => sum + point.estimatedProductionKwh, 0) * 10) / 10 };
}
function retainSolar(previous: SolarForecast | undefined, next: SolarForecast, at: Date): SolarForecast {
  if (next.quarterHourly && solarIntervals(next)) {
    const old = previous?.quarterHourly;
    if (!old) return next;
    return withSolarQuarters(next, next.quarterHourly.map((point, index) => {
      const previousPoint = old[index];
      return previousPoint?.start === point.start && Date.parse(point.start) <= at.getTime()
        ? { ...point, estimatedProductionKwh: previousPoint.estimatedProductionKwh }
        : point;
    }));
  }
  return next;
}
function retainConsumption(next: ConsumptionForecast, retained: readonly EnergyEstimatePoint[], at: Date): ConsumptionForecast {
  const saved = new Map(retained.map(point => [point.start, point]));
  const quarterHourly = next.quarterHourly.map(point => {
    const old = saved.get(point.start);
    const preserve = Date.parse(point.start) <= at.getTime() && old?.end === point.end
      && typeof old.estimatedConsumptionKwh === 'number' && Number.isFinite(old.estimatedConsumptionKwh) && old.estimatedConsumptionKwh >= 0;
    return { ...point, estimatedConsumptionKwh: preserve ? old.estimatedConsumptionKwh! : point.estimatedConsumptionKwh };
  });
  const hourly = next.hourly.map((hour, index) => ({ ...hour,
    estimatedConsumptionKwh: quarterHourly.slice(index * 4, index * 4 + 4).reduce((sum, point) => sum + point.estimatedConsumptionKwh, 0),
  }));
  const estimatedConsumptionKwh = hourly.reduce((total, hour) => total + hour.estimatedConsumptionKwh, 0);
  return { ...next, quarterHourly, hourly, estimatedConsumptionKwh };
}

/** Only the aligned scheduler calls recalculate; all public readers are side-effect-free snapshots. */
export function createEstimateService(options: EstimateOptions) {
  const now = options.now ?? (() => new Date());
  let inputs = new Map<string, EnergyForecast>();
  let rawSolar = new Map<string, SolarForecast>();
  let completed: { at: string; forecasts: Map<string, EnergyForecast>; planner: PlannerDetails; nextPlanner: PlannerDetails | null; projection: BatteryProjection; automatic: boolean; control: AutomationControllerState; chargeEstimate: BatteryChargeEstimate | null } | null = null;
  let lastSolarHour: number | null = null;
  let pending: Promise<void> | null = null;
  let batteryInvalidated = false, chargeEstimateInvalidated = false;
  let batteryGeneration = 0;
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Preserve the scheduled loop. */ } };
  const enabled = () => !batteryInvalidated && !['disabled', 'manual_override'].includes(options.readAutomation().status);

  async function calculate(at: Date) {
    const generation = batteryGeneration;
    const dates = ([0, 1, 2] as const).map(offset => dateAt(at, offset));
    const solarHour = Math.floor(at.getTime() / hourMs);
    const refreshSolar = lastSolarHour === null || (Math.floor(at.getTime() / quarterMs) % 4 === 0 && solarHour !== lastSolarHour);
    let nextSolar = rawSolar;
    if (refreshSolar) {
      const values = await Promise.all(([0, 1, 2] as const).map(async (offset) => {
        let next: SolarForecast;
        try {
          const value = await options.readSolar(offset);
          next = value.date === dates[offset] ? value : emptySolarForecast(dates[offset], options.forecastConfig);
        } catch (error) { report(error); next = emptySolarForecast(dates[offset], options.forecastConfig); }
        const previous = rawSolar.get(dates[offset]);
        // Keep the complete snapshot for this date, including forecasts prefetched before midnight.
        if (!hasUsableForecast(next, at.getTime()) && previous && hasUsableForecast(previous, at.getTime())) {
          next = { ...previous, status: 'stale', error: next.error };
        }
        return structuredClone(next);
      }));
      nextSolar = new Map(values.map(value => [value.date, value]));
    }
    const restored = new Map(await Promise.all(dates.map(async date => {
      const previous = completed?.forecasts.get(date);
      const [solar, consumption] = await Promise.all([
        !previous?.hourly?.length && nextSolar.get(date)?.hourly?.length && options.readSolarHistory
          ? options.readSolarHistory(date) : Promise.resolve([] as SolarEstimatePoint[]),
        previous?.consumption?.quarterHourly
          ?? (options.readEnergyHistory ? options.readEnergyHistory(date) : Promise.resolve([] as EnergyEstimatePoint[])),
      ]);
      return [date, { solar, consumption }] as const;
    })));
    // History I/O may cross a quarter or midnight: retention and capture share this actual cutoff.
    const solarAt = new Date(now());
    const nextInputs = new Map<string, EnergyForecast>();
    for (const date of dates) {
      const model = nextSolar.get(date) ?? emptySolarForecast(date, options.forecastConfig);
      const previous = completed?.forecasts.get(date);
      let solar = !refreshSolar && previous
        ? { ...model, quarterHourly: previous.quarterHourly, hourly: previous.hourly, estimatedProductionKwh: previous.estimatedProductionKwh }
        : retainSolar(previous, model, solarAt);
      const intervals = solarIntervals(solar);
      if (!previous?.hourly?.length && intervals?.some(point => Date.parse(point.start) <= solarAt.getTime())) {
        const saved = new Map(restored.get(date)!.solar.map(point => [Date.parse(point.start), point]));
        solar = withSolarQuarters(solar, solar.quarterHourly!.map(point => {
          const old = saved.get(Date.parse(point.start));
          return Date.parse(point.start) <= solarAt.getTime() && old?.end === point.end
            && Number.isFinite(old.estimatedProductionKwh) && old.estimatedProductionKwh >= 0
            ? { ...point, estimatedProductionKwh: old.estimatedProductionKwh } : point;
        }));
      }
      const consumptionModel = estimateConsumption(date, options.consumption);
      const consumption = retainConsumption(consumptionModel, restored.get(date)!.consumption, solarAt);
      nextInputs.set(date, { ...solar, consumption });
    }
    // Controllers may consume prepared inputs; completed readers advance only after commit.
    inputs = nextInputs;
    if (options.prepareCarForecasts) {
      let channels: CarChargingForecast[];
      try {
        channels = await options.prepareCarForecasts(structuredClone([...nextInputs.values()]), at);
        if (!Array.isArray(channels) || channels.length !== dates.length
          || new Set(channels.map(value => value.date)).size !== dates.length
          || channels.some(value => !dates.includes(value.date) || !validCarCharging(value))) {
          throw new Error('La prévision de recharge voiture est invalide.');
        }
      } catch (error) {
        report(error);
        channels = dates.map(date => ({ status: 'unavailable', date, calculatedAt: null, socObservedAt: null, slots: [] }));
      }
      const context = structuredClone(channels);
      for (const channel of context) {
        const input = nextInputs.get(channel.date)!;
        nextInputs.set(channel.date, { ...input, carCharging: channel, carChargingContext: context });
      }
    }
    try { await options.evaluateAutomation(); } catch (error) { report(error); }
    const [telemetry, control] = await Promise.all([
      options.readTelemetry().catch(error => {
        report(error);
        return { status: 'offline' as const, observedAt: null, error: 'Télémétrie indisponible.',
          solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null,
          batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null };
      }),
      options.readControl().catch(error => {
        report(error);
        return { available: false, mode: 'unknown' as const, powerKw: null, targetSocPercent: null,
          limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: null }, error: 'Pilotage indisponible.' };
      }),
    ]);
    const capturedAt = now();
    const forecasts = [...inputs.values()];
    const automation = options.readAutomation();
    const projection = projectBatterySoc(capturedAt, telemetry, control, automation, forecasts, options.automationConfig);
    const primary = nextInputs.get(getUpcomingHighTariff(capturedAt).date) ?? forecasts[0];
    const planner = buildPlannerDetails(capturedAt, telemetry, control, automation, primary, options.automationConfig, forecasts);
    const nextPlanner = planner.calculation?.charging.allowed
      ? buildPlannerDetails(capturedAt, telemetry, control, automation, primary, options.automationConfig, forecasts, true) : null;
    await options.publishForecasts(structuredClone({ calculatedAt: capturedAt.toISOString(), forecasts, projection }));
    rawSolar = nextSolar;
    if (refreshSolar) lastSolarHour = solarHour;
    completed = { at: capturedAt.toISOString(), forecasts: structuredClone(nextInputs), planner, nextPlanner, projection,
      automatic: !['disabled', 'manual_override'].includes(automation.status),
      control: structuredClone(control), chargeEstimate: structuredClone('chargeEstimate' in control ? control.chargeEstimate ?? null : null) };
    if (generation === batteryGeneration) {
      batteryInvalidated = false;
      chargeEstimateInvalidated = false;
    }
  }

  const reader: EstimateReader = {
    planner() {
      if (!enabled() || !completed) return null;
      const closesAt = Date.parse(completed.planner.calculation?.charging.nextWindow.end ?? '');
      return structuredClone(completed.nextPlanner && now().getTime() >= closesAt ? completed.nextPlanner : completed.planner);
    },
    projection() {
      if (batteryInvalidated || !completed) return unavailableProjection();
      const automatic = !['disabled', 'manual_override'].includes(options.readAutomation().status);
      if (automatic !== completed.automatic) return unavailableProjection();
      return structuredClone(completed.projection);
    },
    chargeEstimate(control) {
      const captured = completed?.control;
      return !chargeEstimateInvalidated && captured && control.available && ['mode', 'powerKw', 'targetSocPercent', 'automationOwner'].every(key =>
        control[key as keyof AutomationControllerState] === captured[key as keyof AutomationControllerState])
        ? structuredClone(completed?.chargeEstimate ?? null) : null;
    },
    status() { return { calculatedAt: completed?.at ?? null,
      nextEvaluationAt: new Date((Math.floor(now().getTime() / quarterMs) + 1) * quarterMs).toISOString() }; },
  };
  return {
    ...reader,
    invalidateBattery(): void {
      batteryGeneration++;
      batteryInvalidated = true;
      chargeEstimateInvalidated = true;
    },
    recalculate(at = now()): Promise<void> {
      if (pending) return pending;
      pending = calculate(at).finally(() => { pending = null; });
      return pending;
    },
    /** The controller can consume only already-calculated inputs, never start a weather read. */
    planningForecast(offset: 0 | 1): EnergyForecast {
      const value = inputs.get(dateAt(now(), offset));
      if (!value) throw new Error('Les estimations attendent le premier bilan.');
      return structuredClone(value);
    },
  };
}
