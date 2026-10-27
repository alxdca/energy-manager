import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApi } from './api.js';
import { createTelemetryReader } from './status.js';
import { createEnergyCollector, createObservationCollector } from './energy-collector.js';
import { createEnergyCounterReader } from './energy-counters.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createControlsService } from './controls.js';
import { createForecastReader, loadForecastConfig } from './forecast.js';
import { loadConsumptionConfig } from './consumption.js';
import { createAutomation, type Automation } from './automation.js';
import { createAutomationState } from './automation-state.js';
import { loadAutomationConfig } from './automation-config.js';
import { createEstimateSchedule } from './estimate-schedule.js';
import { createEstimateService } from './estimate-service.js';
import { createPostgresHistory } from './postgres-history.js';
import { createTeslaService } from './tesla.js';
import { createCarAutomation, type CarAutomation } from './car-automation.js';
import { createCarAutomationState } from './car-automation-state.js';
import { loadCarAutomationConfig } from './car-config.js';
import { getCalendarDayBounds } from './policy.js';
import type { CarChargingForecast } from './car-types.js';
import { createCarBatteryCoordinator } from './car-coordination.js';
import { carSolarBatteryBudget } from './car-battery-budget.js';

const host = process.env.API_HOST || '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer between 1 and 65535');
}

const telemetry = createTelemetryReader();
const tesla = createTeslaService();
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL est obligatoire pour conserver l’historique dans PostgreSQL.');
const automationStatePath = process.env.AUTOMATION_STATE_PATH?.trim()
  ? resolve(process.env.AUTOMATION_STATE_PATH.trim()) : fileURLToPath(new URL('../data/automation.json', import.meta.url));
const automationConfig = loadAutomationConfig();
const history = await createPostgresHistory({ connectionString: databaseUrl, batteryCapacityKwh: automationConfig.socCapacityKwh });
const { dailyEnergyStore, batteryHistory } = history;
const readEnergyCounters = createEnergyCounterReader();
const collector = createObservationCollector({
  readSample: async () => {
    const counters = await readEnergyCounters();
    return {
      battery: counters.battery ?? null,
      solar: counters.solar, household: counters.household,
    };
  },
  store: { record: history.record, flush: history.flush },
  onError: () => console.error('La collecte ou l’enregistrement des mesures a échoué. Nouvelle tentative automatique.'),
});
// Provenance has a tighter continuity requirement than archived observation selection.
const provenanceCollector = createEnergyCollector({
  readTelemetry: async () => {
    const observation = await telemetry();
    await controls.sampleChargeEstimate(observation);
    return observation;
  }, store: { record: history.recordTelemetry, flush: history.flush },
  onError: () => console.error('La provenance de la batterie est indisponible. Nouvelle tentative automatique.'),
});
const automationState = await createAutomationState(automationStatePath);
const carStatePath = process.env.CAR_AUTOMATION_STATE_PATH?.trim()
  ? resolve(process.env.CAR_AUTOMATION_STATE_PATH.trim()) : fileURLToPath(new URL('../data/car-automation.json', import.meta.url));
const carState = await createCarAutomationState(carStatePath);
const carConfig = loadCarAutomationConfig();
const forecastConfig = loadForecastConfig();
const solarReaders = ([0, 1, 2] as const).map(dayOffset => createForecastReader({ config: forecastConfig, dayOffset, cacheAlignment: 'clock_hour' }));
const consumption = loadConsumptionConfig();
let automation: Automation;
let carAutomation: CarAutomation;
const controls = createControlsService({ automation: {
  enabled: () => automationConfig.enabled,
  owns: owner => owner === automationState.owner,
  setManualOverride: async value => {
    try { await automation.setManualOverride(value); }
    finally { estimates.invalidateBattery(); }
  },
}, carAutomation: {
  status: () => carAutomation.status(),
  owns: owner => owner === carState.owner,
  manualStateReady: () => carState.manualOverride && carState.error === null,
  batteryConstraint: () => carAutomation.batteryConstraint(),
  setManualOverride: async value => {
    try { await carAutomation.setManualOverride(value); }
    finally { estimates.invalidateBattery(); }
  },
  setTargetOverride: async value => {
    try { await carAutomation.setTargetOverride(value); }
    finally { estimates.invalidateBattery(); }
  },
}, readPublishedChargeEstimate: control => controls.readChargeEstimate(control) }, telemetry);
automation = createAutomation({
  config: automationConfig, state: automationState, controller: controls.automationController, readTelemetry: telemetry,
  readForecast: async offset => estimates.planningForecast(offset),
  readCarConstraint: () => carAutomation.batteryConstraint(),
});
const carCoordinator = createCarBatteryCoordinator({
  readControl: controls.automationController.read,
  evaluate: () => automation.evaluate(),
  owns: owner => owner === automationState.owner,
  readConstraint: () => carAutomation.batteryConstraint(),
});
carAutomation = createCarAutomation({
  config: carConfig, state: carState, controller: controls.carAutomationController,
  readCar: () => tesla.readStatus(), refreshCarForCharging: signal => tesla.refreshForCharging(signal),
  readTelemetry: telemetry,
  readBattery: async () => {
    const [control, measured, charger] = await Promise.all([
      controls.automationController.read(), telemetry(), controls.wattpilot.readStatus(),
    ]);
    const batteryPlan = automation.status().plan;
    const owned = control.automationOwner === automationState.owner;
    const automatic = automationConfig.enabled && !automationState.manualOverride && !automationState.error
      && (control.mode === 'auto' || owned);
    const goal = batteryPlan?.afternoonTargetSocPercent ?? automationConfig.afternoonTargetSocPercent;
    const needsCharge = control.powerKw !== null && control.powerKw > 0
      || batteryPlan?.action === 'charge'
      || measured.batterySocPercent !== null && measured.batterySocPercent < goal;
    const forecasts = ([0, 1] as const).flatMap(offset => {
      try { return [estimates.planningForecast(offset)]; } catch { return []; }
    });
    const solarSupport = carSolarBatteryBudget({ now: new Date(), origin: history.batteryOrigin.snapshot(),
      telemetry: measured, charger, forecasts, config: automationConfig,
      limits: control.limits, supplySupported: control.available && control.automationSupplySupported === true && Boolean(control.automationFence) });
    return { available: control.available && control.automationHoldSupported === true && control.limits.maxPowerKw >= 6,
      automatic, requestedPowerKw: automatic && needsCharge ? 6 : 0,
      socPercent: measured.batterySocPercent, goalSocPercent: goal, capacityKwh: automationConfig.socCapacityKwh,
      pendingChargeKw: Math.max(0, (control.powerKw ?? 0) - (measured.batteryChargeKw ?? 0)), solarSupport };
  },
  readForecasts: async () => ([0, 1] as const).map(offset => estimates.planningForecast(offset)),
  coordinate: carCoordinator.coordinate,
  releaseCoordination: carCoordinator.release,
});
const estimates = createEstimateService({
  forecastConfig, consumption, automationConfig,
  readSolar: offset => solarReaders[offset](),
  readTelemetry: telemetry,
  readControl: async () => (await controls.readStatus({ liveEstimate: true, includeCar: false })).battery,
  readAutomation: () => automation.status(),
  evaluateAutomation: () => automation.evaluate(),
  prepareCarForecasts: async (forecasts, at) => {
    await carAutomation.evaluate();
    const state = carAutomation.status();
    const plan = state.plan;
    const nativeEco = plan?.action === 'eco' && plan.slots.length === 0;
    const uncertainEcoSupply = nativeEco && carAutomation.batteryConstraint().supply !== undefined;
    return forecasts.map(forecast => {
      const channel: CarChargingForecast = { status: !state.enabled || nativeEco && !uncertainEcoSupply ? 'inactive'
        : uncertainEcoSupply ? 'unavailable'
        : plan?.status === 'available' && !['blocked', 'error', 'stopping', 'waking'].includes(state.status) ? 'available' : 'unavailable',
        date: forecast.date, calculatedAt: plan?.calculatedAt ?? null, socObservedAt: plan?.observedAt ?? null, slots: [] };
      if (channel.status !== 'available' || !plan) return channel;
      const { start, end } = getCalendarDayBounds(new Date(`${forecast.date}T00:00:00.000Z`));
      channel.slots = plan.slots.flatMap(slot => {
        const from = Math.max(Date.parse(slot.start), start.getTime(), at.getTime());
        const until = Math.min(Date.parse(slot.end), end.getTime());
        return until > from ? [{ ...slot, start: new Date(from).toISOString(), end: new Date(until).toISOString(),
          energyKwh: slot.powerKw * (until - from) / 3_600_000 }] : [];
      });
      return channel;
    });
  },
  readSolarHistory: async date => (await history.historyReader.day(date)).solarEstimates,
  readEnergyHistory: async date => (await history.historyReader.day(date)).energyEstimates,
  publishForecasts: history.publishForecasts,
  onError: () => console.error('Le bilan des estimations a échoué. Nouvelle tentative au prochain bilan.'),
});
const estimateSchedule = createEstimateSchedule({
  run: at => estimates.recalculate(at), initializeImmediately: true,
  onError: () => console.error('Le bilan des estimations a échoué. Nouvelle tentative au prochain quart d’heure.'),
});
const app = createApi({ telemetryReader: telemetry, dailyEnergyStore, controlsService: controls,
  estimates, automationConfig, automationStatus: () => automation.status(),
  forecastStore: history, batteryHistory,
  historyReader: history.historyReader, teslaService: tesla });

const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  collector.start();
  provenanceCollector.start();
  tesla.start();
  automation.start();
  carAutomation.start();
  estimateSchedule.start();
  console.log(`Energy Orchestrator dashboard running on http://${host}:${port}`);
  console.log(automationConfig.enabled ? 'Automatic battery planning every 15 minutes, charging at 6 kW.' : 'Battery automation disabled; monitoring and manual controls available.');
}) as Server;

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  // Stop the car first so its allocation is released while battery supervision is still available.
  await carAutomation.stop();
  const results = await Promise.allSettled([estimateSchedule.stop(), automation.stop(), collector.stop(), provenanceCollector.stop(), tesla.stop()]);
  await history.close();
  if (results.some(result => result.status === 'rejected')) throw new Error('Arrêt incomplet des collecteurs.');
};
const shutdown = () => { void stop().catch(() => { console.error('La sauvegarde finale des mesures a échoué.'); process.exitCode = 1; }); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
