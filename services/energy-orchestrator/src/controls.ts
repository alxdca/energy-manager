import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createTelemetryReader, resolveControllerUrl, type StatusOptions, type Telemetry } from './status.js';
import { createChargeEstimator, type BatteryChargeEstimate } from './charge-estimate.js';
import { createWattpilotService, toCarControl, unavailableWattpilot, validateWattpilotCommand, WattpilotControlError,
  type WattpilotCommand, type WattpilotTelemetry } from './wattpilot.js';
import type { CarAutomationController, CarAutomationStatus, CarBatteryConstraint, CarTargetOverride } from './car-types.js';
import { getCarTarget, getNightTariffEnd, getSchedule, policy } from './policy.js';
import { validateCarTargetOverride } from './car-plan.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const defaultLimits = { minPowerKw: 0.1, maxPowerKw: 7, minSocPercent: 0, maxSocPercent: 100 };
export interface BatteryControl {
  available: boolean;
  canReturnToAuto: boolean;
  mode: 'manual' | 'auto' | 'unknown';
  powerKw: number | null;
  requestedPowerKw?: number | null;
  targetSocPercent: number | null;
  limits: typeof defaultLimits & { reserveSocPercent?: number | null };
  error: string | null;
  automationSupported?: boolean;
  automationHoldSupported?: boolean;
  automationSupplySupported?: boolean;
  automationMode?: 'charge' | 'hold' | 'supply';
  minimumSocPercent?: number | null;
  automationFence?: { bootId: string; generation: number };
  automationOwner?: string;
  expiresAt?: string | null;
  revertTimeoutSeconds?: number;
}
export interface ControlsOptions extends StatusOptions {
  readPublishedChargeEstimate?: (control: BatteryControl) => BatteryChargeEstimate | null;
  automation?: {
    enabled(): boolean;
    owns(owner: string): boolean;
    setManualOverride(value: boolean): Promise<void>;
  };
  carAutomation?: {
    status(): CarAutomationStatus;
    owns(owner: string): boolean;
    setManualOverride(value: boolean): Promise<void>;
    setTargetOverride(value: CarTargetOverride | null): Promise<void>;
    manualStateReady?(): boolean;
    batteryConstraint?(): CarBatteryConstraint;
  };
}
type Command = { mode: 'auto' } | { mode: 'manual'; powerKw: number; targetSocPercent?: number | null };
class ControlError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 | 502 | 503 | 504 = 502, readonly unknownOutcome = false) { super(message); }
}
function unavailable(error: string, canReturnToAuto = false): BatteryControl {
  return { available: false, canReturnToAuto, mode: 'unknown', powerKw: null, targetSocPercent: null, limits: { ...defaultLimits }, error };
}
function validateCommand(value: unknown): Command {
  if (!object(value) || (value.mode !== 'manual' && value.mode !== 'auto')) throw new ControlError('Choisissez la charge manuelle ou le mode automatique.', 400);
  const keys = value.mode === 'auto' ? ['mode'] : ['mode', 'powerKw', 'targetSocPercent'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ControlError('Paramètres de commande inattendus.', 400);
  if (value.mode === 'auto') return { mode: 'auto' };
  const minimum = 0.1;
  const maximum = 7;
  if (!finite(value.powerKw) || value.powerKw < minimum || value.powerKw > maximum) throw new ControlError(`La puissance de charge doit être comprise entre ${minimum.toLocaleString('fr-CH')} et ${maximum.toLocaleString('fr-CH')} kW.`, 400);
  if (value.targetSocPercent !== undefined && value.targetSocPercent !== null
    && (!finite(value.targetSocPercent) || value.targetSocPercent <= 0 || value.targetSocPercent > 100)) {
    throw new ControlError('La limite de charge doit être supérieure à 0 % et ne pas dépasser 100 %.', 400);
  }
  // Validate the actual integer-watt command too, before any controller request.
  const powerKw = Math.round(value.powerKw * 1000) / 1000;
  if (powerKw < minimum || powerKw > maximum) throw new ControlError('La puissance de charge est hors de la plage autorisée.', 400);
  return { mode: 'manual', powerKw, ...(value.targetSocPercent === undefined ? {} : { targetSocPercent: value.targetSocPercent as number | null }) };
}
function parseControl(body: unknown): BatteryControl {
  if (!object(body) || body.success !== true || !object(body.control)) throw new ControlError('Le contrôleur a renvoyé un état de commande invalide.');
  const { control, limits } = body;
  if (typeof control.enabled !== 'boolean') throw new ControlError('Le contrôleur a renvoyé un état de commande invalide.');
  if (!control.enabled) return unavailable('Activez le pilotage de l’onduleur dans le contrôleur énergétique pour commander la batterie.');
  if (typeof control.active !== 'boolean') return unavailable('Le contrôleur a renvoyé un état de commande invalide.', true);
  if (!object(limits) || !finite(limits.maxPowerWatts) || limits.maxPowerWatts < 100
    || !finite(limits.minSocPercent) || !finite(limits.maxSocPercent)
    || limits.minSocPercent < 0 || limits.maxSocPercent > 100 || limits.minSocPercent >= limits.maxSocPercent) {
    return unavailable('Les limites de la batterie sont indisponibles sur le contrôleur énergétique.', true);
  }
  const safeLimits = { ...defaultLimits, maxPowerKw: Math.min(7, limits.maxPowerWatts / 1000), minSocPercent: limits.minSocPercent, maxSocPercent: limits.maxSocPercent,
    ...(object(body.capabilities) && body.capabilities.automationCharge === true ? {
      reserveSocPercent: finite(limits.reserveSocPercent) && limits.reserveSocPercent >= 0 && limits.reserveSocPercent <= 100 ? limits.reserveSocPercent : null,
    } : {}),
  };
  const fence = body.automationFence;
  const automationFence = object(fence) && typeof fence.bootId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(fence.bootId)
    && Number.isSafeInteger(fence.generation) && (fence.generation as number) >= 0
    ? { bootId: fence.bootId, generation: fence.generation as number } : null;
  if (typeof control.error === 'string' && control.error) return { ...unavailable('Le contrôleur énergétique signale une erreur de pilotage.', true), limits: safeLimits };
  if (control.active && !finite(control.watts)) return { ...unavailable('La puissance de charge active est indisponible sur le contrôleur.', true), limits: safeLimits };
  return {
    available: true, canReturnToAuto: true, mode: control.active ? 'manual' : 'auto',
    powerKw: control.active ? (control.watts as number) / 1000 : null,
    ...(control.active && 'requestedWatts' in control ? {
      requestedPowerKw: finite(control.requestedWatts) ? control.requestedWatts / 1000 : null,
    } : {}),
    targetSocPercent: control.active && finite(control.targetSocPercent) ? control.targetSocPercent : null,
    limits: safeLimits, error: typeof control.error === 'string' && control.error ? 'Le contrôleur énergétique signale une erreur de pilotage.' : null,
    ...(automationFence ? { automationFence } : {}),
    ...(object(body.capabilities) && body.capabilities.automationCharge === true ? {
      automationSupported: true,
      automationHoldSupported: body.capabilities.automationHold === true,
      ...(body.capabilities.automationSupply === true ? { automationSupplySupported: true } : {}),
      ...(['charge', 'hold', 'supply'].includes(control.automationMode as string) ? { automationMode: control.automationMode as 'charge' | 'hold' | 'supply' } : {}),
      ...(control.automationMode === 'supply' ? { minimumSocPercent: finite(control.minimumSocPercent) ? control.minimumSocPercent : null } : {}),
      revertTimeoutSeconds: finite(limits.revertTimeoutSeconds) ? limits.revertTimeoutSeconds : undefined,
      ...(typeof control.automationOwner === 'string' ? { automationOwner: control.automationOwner } : {}),
      expiresAt: typeof control.expiresAt === 'string' ? control.expiresAt : null,
    } : {}),
  };
}

export function createControlsService(options: ControlsOptions = {}, telemetry = createTelemetryReader(options)) {
  const app = new Hono();
  const base = resolveControllerUrl(options);
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const chargeEstimator = createChargeEstimator();
  let mutating = false;
  let generation = 0;
  let sampledEstimate: { generation: number; control: BatteryControl; value: BatteryChargeEstimate } | null = null;
  let cached: { at: number; value: BatteryControl } | null = null;
  let pending: { generation: number; promise: Promise<BatteryControl> } | null = null;
  const wattpilot = createWattpilotService({ ...options, beforeStart: assertCarGridHeadroom });

  async function upstream(path: string, body?: unknown): Promise<unknown> {
    if (!base) throw new ControlError('Le contrôleur énergétique n’est pas configuré.', 503);
    const url = new URL(base.toString());
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const writing = body !== undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(url, {
            method: writing ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json', ...(writing ? { 'content-type': 'application/json' } : {}) },
            ...(writing ? { body: JSON.stringify(body) } : {}),
          });
          if (!response.ok) throw new ControlError(`Échec de la requête au contrôleur énergétique (HTTP ${response.status}).`, 502, writing);
          return await response.json();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ControlError(writing ? 'La commande au contrôleur a expiré. Son résultat est inconnu ; actualisez l’état avant d’envoyer une autre commande.' : 'La demande d’état du contrôleur a expiré.', 504, writing));
          }, writing ? 10_000 : 3000);
        }),
      ]);
    } catch (failure) {
      if (failure instanceof ControlError) throw failure;
      throw new ControlError(writing ? 'La commande au contrôleur n’a pas pu être confirmée. Son résultat est inconnu ; actualisez l’état avant d’envoyer une autre commande.' : 'L’état du contrôleur énergétique est indisponible.', 502, writing);
    } finally { clearTimeout(timer); }
  }
  async function freshControl(): Promise<BatteryControl> {
    return parseControl(await upstream('/inverter/control-status'));
  }
  async function readControl(): Promise<BatteryControl> {
    if (pending?.generation === generation) return pending.promise;
    if (cached && now().getTime() >= cached.at && now().getTime() - cached.at < 5000) return cached.value;
    const readingGeneration = generation;
    const reading = (async () => {
      let value: BatteryControl;
      try { value = await freshControl(); }
      catch (failure) { value = unavailable(failure instanceof ControlError ? failure.message : 'L’état du contrôleur énergétique est indisponible.'); }
      if (generation === readingGeneration) cached = { at: now().getTime(), value };
      return value;
    })();
    const current = { generation: readingGeneration, promise: reading };
    pending = current;
    try { return await current.promise; } finally { if (pending === current) pending = null; }
  }
  async function sampleChargeEstimate(observation: Telemetry): Promise<void> {
    const readingGeneration = generation;
    const battery = await readControl();
    if (readingGeneration !== generation || mutating) return;
    const at = now();
    sampledEstimate = { generation, control: battery, value: chargeEstimator.estimate(observation, estimateControl(battery, at), at) };
  }
  function estimateControl(battery: BatteryControl, at: Date) {
    if (!battery.automationOwner || !options.automation?.enabled() || !options.automation.owns(battery.automationOwner)) return battery;
    const schedule = getSchedule(at).charging;
    return { ...battery, chargeUntil: schedule.allowed ? schedule.nextWindow.end : at.toISOString() };
  }
  function readChargeEstimate(battery: BatteryControl): BatteryChargeEstimate | null {
    const sampled = sampledEstimate;
    if (!sampled || sampled.generation !== generation || mutating || !battery.available
      || sampled.value.observedAt === null || now().getTime() - Date.parse(sampled.value.observedAt) > 30_000
      || battery.mode !== sampled.control.mode || battery.powerKw !== sampled.control.powerKw
      || battery.targetSocPercent !== sampled.control.targetSocPercent
      || battery.automationOwner !== sampled.control.automationOwner) return null;
    return { ...sampled.value };
  }
  async function readStatus(readOptions: { liveEstimate?: boolean; includeCar?: boolean } = {}) {
    const readingGeneration = generation;
    const [battery, observation, charger] = await Promise.all([
      readControl(), telemetry(), readOptions.includeCar === false ? unavailableWattpilot() : wattpilot.readStatus(),
    ]);
    const unavailableEstimate: BatteryChargeEstimate = {
      status: 'unavailable', targetSocPercent: null, estimatedCompletionAt: null,
      remainingMinutes: null, observedAt: null, method: 'soc_trend',
    };
    const readPublishedEstimate = readOptions.liveEstimate ? undefined : options.readPublishedChargeEstimate;
    const estimateAt = now();
    const estimateInputs = estimateControl(battery, estimateAt);
    const liveEstimate = readingGeneration === generation && !mutating
      ? readPublishedEstimate ? chargeEstimator.observe(observation, estimateInputs, estimateAt)
        : chargeEstimator.estimate(observation, estimateInputs, estimateAt) : unavailableEstimate;
    // Page reads validate and observe the trend; publication comes from the
    // configured background source. Invalid inputs retire an old publication.
    const chargeEstimate = readPublishedEstimate
      ? liveEstimate.status === 'unavailable' ? unavailableEstimate
        : liveEstimate.status === 'not_charging' || liveEstimate.status === 'target_reached' ? liveEstimate
        : readPublishedEstimate(battery) ?? unavailableEstimate
      : liveEstimate;
    const carAutomation = options.carAutomation?.status() ?? {
      enabled: false, status: 'manual' as const, reason: 'manual_override', error: null,
      lastEvaluatedAt: null, nextEvaluationAt: null, plan: null, lastCheckpoint: null,
    };
    const info = charger.automation;
    return { battery: { ...battery, chargeEstimate, ...(battery.automationOwner && options.automation?.owns(battery.automationOwner) ? { automated: true } : {}) },
      car: { ...toCarControl(charger),
        canReturnToAuto: Boolean(options.carAutomation && charger.ready && charger.controlEnabled && info?.supported && !info.stopping && !info.error),
        automated: Boolean(info?.active && info.owner && options.carAutomation?.owns(info.owner)),
      }, wattpilot: charger, carAutomation, carTarget: getCarTarget(now()), automationEnabled: options.automation?.enabled() ?? false };
  }
  async function assertCarGridHeadroom(command: WattpilotCommand, charger: WattpilotTelemetry, signal?: AbortSignal) {
    if (signal?.aborted) throw new WattpilotControlError('La requête a été annulée avant l’envoi de la commande.', 409);
    const [status, battery] = await Promise.all([freshGridStatus(), upstream('/inverter/control-status')]);
    const pendingBatteryWatts = pendingBatteryCharge(battery, status.batteryWatts);
    // Phase selection is configuration, not relay feedback. Reserve all three
    // phases until the device's physical transition behavior has been verified.
    const requestedWatts = command.currentAmps! * 3 * 253;
    const measuredAt = charger.powerObservedAt === null ? NaN : Date.parse(charger.powerObservedAt);
    const synchronized = Number.isFinite(measuredAt) && Math.abs(measuredAt - status.observedAt) <= 3000;
    const currentWatts = synchronized && finite(charger.powerWatts) ? charger.powerWatts : 0;
    const incrementalWatts = Math.max(0, requestedWatts - currentWatts);
    if (status.householdWatts + Math.max(0, -status.batteryWatts) + pendingBatteryWatts + incrementalWatts > policy.totalConsumptionLimitKw * 1000) {
      throw new WattpilotControlError(`Cette charge dépasserait la limite de consommation totale de ${policy.totalConsumptionLimitKw} kW. Réduisez la charge de la batterie maison.`, 409);
    }
  }
  function pendingBatteryCharge(battery: unknown, actualBatteryWatts: number) {
    if (!object(battery) || battery.success !== true || !object(battery.control)
      || typeof battery.control.enabled !== 'boolean' || typeof battery.control.active !== 'boolean'
      || (typeof battery.control.error === 'string' && battery.control.error)
      || (battery.control.active && (!battery.control.enabled || !finite(battery.control.watts)))) {
      throw new WattpilotControlError('La commande active de la batterie doit être confirmée avant de démarrer la voiture.', 503);
    }
    const batteryTargetWatts = battery.control.active ? Math.max(0, battery.control.watts as number) : 0;
    return Math.max(0, batteryTargetWatts - Math.max(0, -actualBatteryWatts));
  }
  async function freshGridStatus() {
    const status = await upstream('/system/status');
    if (!object(status) || status.success !== true || !object(status.site) || !finite(status.site.P_Grid) || !finite(status.site.P_Akku) || !finite(status.site.P_Load) || status.site.P_Load > 0
      || typeof status.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(status.timestamp)) {
      throw new ControlError('Des mesures récentes du réseau et de la batterie sont nécessaires avant de lancer la charge.', 503);
    }
    const observedAt = new Date(status.timestamp).getTime();
    const [year, month, day] = status.timestamp.slice(0, 10).split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const age = now().getTime() - observedAt;
    if (!Number.isFinite(observedAt) || age > 10_000 || age < -5000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
      throw new ControlError('Les mesures du réseau et de la batterie sont périmées ou leur horodatage est invalide.', 503);
    }
    return { gridWatts: status.site.P_Grid, batteryWatts: status.site.P_Akku, householdWatts: -status.site.P_Load, observedAt };
  }
  async function assertGridHeadroom(powerKw: number) {
    const [status, charger] = await Promise.all([
      freshGridStatus(), powerKw > 0 ? wattpilot.readStatus({ fresh: true }) : Promise.resolve(null),
    ]);
    let carReserveWatts = 0;
    if (charger && charger.status !== 'not_configured') {
      if (!charger.ready || charger.status !== 'online' || charger.stale) {
        throw new ControlError('L’état Wattpilot doit être confirmé avant d’ajouter une charge de batterie.', 503);
      }
      if (charger.carConnected !== false && charger.mode !== 'pause') {
        if (charger.carConnected !== true || !['normal', 'eco'].includes(charger.mode)
          || !finite(charger.currentAmps) || !Number.isInteger(charger.currentAmps) || charger.currentAmps < 6 || charger.currentAmps > 32) {
          throw new ControlError('Le courant réservé à la voiture est inconnu. Vérifiez le Wattpilot avant de charger la batterie.', 503);
        }
        const measuredAt = charger.powerObservedAt === null ? NaN : Date.parse(charger.powerObservedAt);
        const synchronized = Number.isFinite(measuredAt) && Math.abs(measuredAt - status.observedAt) <= 3000;
        const actualWatts = synchronized && finite(charger.powerWatts) ? charger.powerWatts : 0;
        carReserveWatts = Math.max(0, charger.currentAmps * 3 * 253 - actualWatts);
      }
    }
    if (status.householdWatts + Math.round(powerKw * 1000) + carReserveWatts > policy.totalConsumptionLimitKw * 1000) {
      throw new ControlError(`Cette charge dépasserait la limite de consommation totale de ${policy.totalConsumptionLimitKw} kW. Réduisez la puissance de charge.`, 409);
    }
  }
  async function automatedMutation(operation: () => Promise<boolean | void>) {
    if (mutating) throw new ControlError('Une commande de batterie est déjà en cours.', 409);
    mutating = true;
    let preserveChargeTrend = false;
    try { preserveChargeTrend = await operation() === true; }
    finally {
      if (!preserveChargeTrend) chargeEstimator.reset();
      mutating = false; generation++; cached = null;
    }
  }
  const automationController = {
    read: readControl,
    charge: (owner: string, targetSocPercent: number, expiresAt: string, isCurrent: () => boolean, powerKw = 6) => automatedMutation(async () => {
      const observed = await freshControl();
      if (!observed.available || !observed.automationSupported || !observed.automationHoldSupported || observed.limits.maxPowerKw < 6) throw new ControlError('Le contrôleur ne permet pas la charge automatique avec préservation de la réserve.', 503);
      if (!finite(observed.limits.reserveSocPercent)) throw new ControlError('La réserve réelle de la batterie est indisponible.', 503);
      if (observed.mode === 'manual' && observed.automationOwner !== owner) throw new ControlError('Une commande manuelle a priorité.', 409);
      if (!finite(targetSocPercent) || targetSocPercent <= observed.limits.minSocPercent || targetSocPercent < observed.limits.reserveSocPercent || targetSocPercent > observed.limits.maxSocPercent) throw new ControlError('La cible automatique est hors limites.', 400);
      if (!finite(powerKw) || powerKw <= 0 || powerKw > Math.min(6, observed.limits.maxPowerKw)
        || !Number.isInteger(powerKw * 1000)) throw new ControlError('La puissance automatique doit être comprise entre 1 et 6000 W.', 400);
      // Reducing an owned charge must remain possible while the meter is above
      // the limit; adding load still requires the full fresh headroom check.
      if (!(observed.automationOwner === owner && observed.automationMode === 'charge'
        && observed.powerKw !== null && powerKw <= observed.powerKw)) await assertGridHeadroom(powerKw);
      if (!isCurrent()) throw new ControlError('Le plan automatique a été remplacé.', 409);
      const result = await upstream('/inverter/automation-charge', { powerWatts: Math.round(powerKw * 1000), targetSocPercent, expiresAt, owner });
      if (!object(result) || result.success !== true || !object(result.control) || (result.control.active === true && result.control.automationOwner !== owner)) throw new ControlError('La commande automatique n’a pas pu être confirmée.', 502, true);
      // The estimate batch renews automation before reading the SOC trend. An
      // unchanged lease must not erase the samples that batch needs for its ETA.
      return result.control.active === true && observed.mode === 'manual'
        && observed.automationOwner === owner && observed.automationMode === 'charge'
        && observed.powerKw === powerKw && observed.targetSocPercent === targetSocPercent;
    }),
    hold: (owner: string, expiresAt: string, isCurrent: () => boolean) => automatedMutation(async () => {
      const observed = await freshControl();
      if (!observed.available || !observed.automationHoldSupported) throw new ControlError('Le contrôleur ne permet pas de préserver la batterie.', 503);
      if (observed.mode === 'manual' && observed.automationOwner !== owner) throw new ControlError('Une commande manuelle a priorité.', 409);
      // An already owned power window can always move to the safer no-discharge
      // hold using fresh device safety state, even if the site meter is offline.
      if (observed.automationOwner !== owner || !['charge', 'hold', 'supply'].includes(observed.automationMode ?? '')) {
        await assertGridHeadroom(0);
      }
      if (!isCurrent()) throw new ControlError('Le plan automatique a été remplacé.', 409);
      const result = await upstream('/inverter/automation-hold', { expiresAt, owner });
      if (!object(result) || result.success !== true || !object(result.control) || result.control.active !== true
        || result.control.automationOwner !== owner || result.control.automationMode !== 'hold') throw new ControlError('La préservation de la batterie n’a pas pu être confirmée.', 502, true);
    }),
    supply: (owner: string, maxPowerWatts: number, minimumSocPercent: number, expiresAt: string, isCurrent: () => boolean,
      authorizationExpiresAt?: string) => automatedMutation(async () => {
      const observed = await freshControl();
      if (!observed.available || !observed.automationSupplySupported || !observed.automationFence || !finite(observed.limits.reserveSocPercent)) {
        throw new ControlError('Le contrôleur ne permet pas le soutien solaire borné de la voiture.', 503);
      }
      if (observed.mode === 'manual' && observed.automationOwner !== owner) throw new ControlError('Une commande manuelle a priorité.', 409);
      if (!Number.isInteger(maxPowerWatts) || maxPowerWatts <= 0 || maxPowerWatts > Math.min(7000, observed.limits.maxPowerKw * 1000)
        || !finite(minimumSocPercent) || minimumSocPercent < observed.limits.reserveSocPercent || minimumSocPercent >= 100) {
        throw new ControlError('La limite de soutien solaire est invalide.', 400);
      }
      if (!isCurrent()) throw new ControlError('Le budget solaire a été remplacé.', 409);
      const sourceExpiry = authorizationExpiresAt ? Date.parse(authorizationExpiresAt) : NaN;
      if (!Number.isFinite(sourceExpiry) || sourceExpiry <= now().getTime() || sourceExpiry > now().getTime() + 10_000) {
        throw new ControlError('La mesure autorisant le soutien solaire a expiré.', 409);
      }
      const result = await upstream('/inverter/automation-supply', { owner, expiresAt, maxPowerWatts, minimumSocPercent,
        automationFence: observed.automationFence, authorizationExpiresAt });
      if (!object(result) || result.success !== true || !object(result.control) || result.control.active !== true
        || result.control.automationOwner !== owner || !['supply', 'hold'].includes(result.control.automationMode as string)) {
        throw new ControlError('Le soutien solaire de la voiture n’a pas pu être confirmé.', 502, true);
      }
    }),
    stop: (owner: string) => automatedMutation(async () => {
      const result = await upstream('/inverter/automation-stop', { owner });
      if (!object(result) || result.success !== true) throw new ControlError('L’arrêt automatique n’a pas pu être confirmé.', 502, true);
    }),
  };
  async function carSiteMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (mutating) throw new ControlError('Une commande est déjà en cours. Actualisez l’état avant de réessayer.', 409);
    mutating = true;
    try { return await operation(); }
    finally { mutating = false; generation++; cached = null; }
  }
  const carAutomationController: CarAutomationController = {
    read: () => wattpilot.readStatus({ fresh: true }),
    authorize: owner => carSiteMutation(async () => {
      await wattpilot.setControl({ mode: 'pause' });
      const before = (await wattpilot.readStatus({ fresh: true })).automation;
      if (!before || before.stopping || before.error) throw new WattpilotControlError('La supervision automatique de la borne est indisponible.', 503);
      let result: WattpilotTelemetry;
      try { result = await wattpilot.establishAutomation(owner, before.fence); }
      catch (failure) {
        // Read back a lost authorization response; never repeat establishment blindly.
        if (!(failure instanceof WattpilotControlError) || !failure.unknownOutcome) throw failure;
        result = await wattpilot.readStatus({ fresh: true });
      }
      const established = result.automation;
      if (!established || established.owner !== owner || !established.epoch || established.manualOverride
        || established.fence !== before.fence + 1 || established.stopping || established.error) {
        throw new WattpilotControlError('L’autorisation automatique de la borne n’a pas pu être confirmée.', 502, true);
      }
      return result;
    }),
    activate: (request, isCurrent, signal) => carSiteMutation(async () => {
      const plan = options.carAutomation?.status().plan;
      const carConstraint = options.carAutomation?.batteryConstraint?.();
      if (request.mode === 'normal') {
        const window = getSchedule(now()).charging;
        const observedAt = plan?.observedAt ? Date.parse(plan.observedAt) : NaN;
        const targetEnd = plan?.target ? Date.parse(plan.target.gridChargingEndsAt) : NaN;
        const expires = Date.parse(request.expiresAt);
        if (!window.allowed || !['night', 'afternoon'].includes(window.currentWindow ?? '')
          || !plan || !plan.target || plan.action !== 'charge' || !Number.isFinite(observedAt)
          || !finite(plan.socPercent) || plan.socPercent >= plan.target.minimumSocPercent
          || !Number.isFinite(targetEnd) || targetEnd <= now().getTime() || !Number.isFinite(expires)
          || expires > Math.min(targetEnd, Date.parse(window.nextWindow.end))
          || now().getTime() - observedAt > 600_000 || observedAt > now().getTime() + 5000
          || (window.currentWindow === 'night' && (plan.target.kind === 'afternoon'
            || plan.target.minimumSocPercent < getCarTarget(now()).minimumSocPercent))
          || (window.currentWindow === 'afternoon' && (plan.target.minimumSocPercent !== 30
            || !finite(plan.socPercent) || plan.socPercent >= 30))) {
          throw new WattpilotControlError('La charge forcée de la voiture est hors de sa période autorisée.', 409);
        }
      }
      if (request.mode === 'eco') {
        const charger = await wattpilot.readStatus({ fresh: true, signal });
        if (charger.carConnected !== false) {
          await assertCarGridHeadroom({ mode: 'eco', currentAmps: request.currentAmps }, charger, signal);
        }
      }
      if (request.mode === 'normal' || getNightTariffEnd(now()) && carConstraint?.active) {
        const battery = await freshControl();
        const support = carConstraint?.supply;
        const maxChargeKw = carConstraint?.maxChargePowerKw ?? 6;
        const supplyPrepared = support && battery.automationMode === 'supply' && battery.powerKw !== null
          && battery.powerKw < 0 && -battery.powerKw <= support.maxDischargeKw + .001
          && finite(battery.minimumSocPercent) && battery.minimumSocPercent >= support.minimumSocPercent;
        if (!battery.available || !battery.automationOwner || !options.automation?.owns(battery.automationOwner)
          || battery.mode !== 'manual' || !(supplyPrepared
            || battery.automationMode === 'hold' && battery.powerKw === 0
            || !support && battery.automationMode === 'charge' && battery.powerKw !== null && battery.powerKw > 0
              && finite(maxChargeKw) && maxChargeKw >= 0 && maxChargeKw <= 6 && battery.powerKw <= maxChargeKw + .001)) {
          throw new WattpilotControlError('La batterie maison doit être coordonnée avant la recharge de la voiture.', 503);
        }
      }
      if (request.mode === 'normal' && plan?.source === 'solar') {
        throw new WattpilotControlError('Le solaire hors créneau est géré par le mode éco de la borne.', 409);
      }
      if (!isCurrent()) throw new WattpilotControlError('Le plan voiture a été remplacé.', 409);
      return wattpilot.activateAutomation(request, signal, isCurrent);
    }),
    renew: (request, isCurrent, signal) => carSiteMutation(async () => {
      if (!isCurrent()) throw new WattpilotControlError('Le plan voiture a été remplacé.', 409);
      return wattpilot.renewAutomation(request, signal);
    }),
    stop: request => wattpilot.stopAutomation(request),
  };
  app.get('/', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await readStatus());
  });
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const origin = c.req.header('Origin');
    if (c.req.header('Sec-Fetch-Site') === 'cross-site' || (origin !== undefined && origin !== new URL(c.req.url).origin)) {
      return c.json({ success: false, error: 'Les commandes doivent provenir de ce tableau de bord.' }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ success: false, error: 'Les commandes doivent utiliser le format application/json.' }, 415);
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ success: false, error: 'La requête de commande est trop volumineuse.' }, 413) }));
  app.post('/car-target', async c => {
    if (!options.carAutomation) return c.json({ success: false, error: 'La planification de la voiture est indisponible.' }, 503);
    let value: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > 4096) return c.json({ success: false, error: 'La requête de commande est trop volumineuse.' }, 413);
      value = JSON.parse(text);
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'BodyLimitError') return c.json({ success: false, error: 'La requête de commande est trop volumineuse.' }, 413);
      return c.json({ success: false, error: 'La cible doit contenir du JSON valide.' }, 400);
    }
    let target: CarTargetOverride | null;
    try { target = validateCarTargetOverride(value, now()); }
    catch { return c.json({ success: false, error: 'Choisissez une cible au moins égale au minimum et un départ futur avant l’échéance du prochain matin.' }, 400); }
    if (c.req.raw.signal.aborted) return c.json({ success: false, error: 'La requête a été annulée.' }, 409);
    try {
      await options.carAutomation.setTargetOverride(target);
      return c.json({ success: true });
    } catch { return c.json({ success: false, error: 'La nouvelle cible de la voiture n’a pas pu être conservée.' }, 503); }
  });
  for (const device of ['battery', 'car'] as const) {
    app.post(`/${device}`, async c => {
      let locked = false;
      try {
        let body: unknown;
        try {
          const text = await c.req.text();
          if (new TextEncoder().encode(text).byteLength > 4096) throw new ControlError('La requête de commande est trop volumineuse.', 413);
          body = JSON.parse(text);
        } catch (failure) {
          if (failure instanceof ControlError) throw failure;
          if (failure instanceof Error && failure.name === 'BodyLimitError') throw new ControlError('La requête de commande est trop volumineuse.', 413);
          throw new ControlError('La commande doit contenir du JSON valide.', 400);
        }
        if (device === 'car') {
          if (object(body) && body.mode === 'auto') {
            if (Object.keys(body).length !== 1) throw new ControlError('Le mode auto ne prend pas de réglage manuel.', 400);
            if (!options.carAutomation) throw new ControlError('La planification de la voiture est indisponible.', 503);
            await options.carAutomation.setManualOverride(false);
            return c.json({ success: true, message: 'La planification automatique de la voiture est activée.' });
          }
          const command = validateWattpilotCommand(body);
          try { await options.carAutomation?.setManualOverride(true); }
          catch (failure) {
            if (command.mode !== 'pause' && options.carAutomation?.manualStateReady?.() !== true) throw failure;
            // The controller can finish revoking an old uncertain lease after
            // manual intent is durable; a failed state write cannot authorize charging.
          }
          if (command.mode !== 'pause') {
            if (mutating) throw new ControlError('Une commande est déjà en cours. Actualisez l’état avant de réessayer.', 409);
            mutating = true;
            locked = true;
          }
          const charger = await wattpilot.setControl(command, c.req.raw.signal);
          if (locked) { locked = false; mutating = false; generation++; cached = null; }
          // Reconcile obsolete local ownership after the controller's authoritative
          // manual handoff, without holding the shared site mutation lock.
          try { await options.carAutomation?.setManualOverride(true); } catch { /* Manual device confirmation remains authoritative. */ }
          return c.json({ success: true, car: toCarControl(charger), wattpilot: charger,
            message: command.mode === 'pause' ? 'La borne a confirmé la pause.' : 'La borne a confirmé le mode et le courant demandés.' });
        }
        const command = validateCommand(body);
        if (mutating) throw new ControlError('Une commande de batterie est déjà en cours. Actualisez l’état avant de réessayer.', 409);
        mutating = true;
        locked = true;
        chargeEstimator.reset();
        const controlStatus = await upstream('/inverter/control-status');
        // Restoring normal operation requires confirmed write opt-in, but no charging capabilities.
        const enabled = object(controlStatus) && controlStatus.success === true && object(controlStatus.control) && controlStatus.control.enabled === true;
        if (!enabled) throw new ControlError('Activez le pilotage de l’onduleur dans le contrôleur énergétique pour commander la batterie.', 503);
        if (command.mode === 'manual') {
          const observed = parseControl(controlStatus);
          if (!observed.available) throw new ControlError(observed.error ?? 'Les commandes de la batterie sont indisponibles.', 503);
          if (command.powerKw > observed.limits.maxPowerKw) throw new ControlError(`Le contrôleur limite la puissance de charge de la batterie à ${observed.limits.maxPowerKw.toLocaleString('fr-CH')} kW.`, 400);
          if (command.targetSocPercent != null && (command.targetSocPercent <= observed.limits.minSocPercent || command.targetSocPercent > observed.limits.maxSocPercent)) {
            throw new ControlError(`La limite de charge doit être supérieure à ${observed.limits.minSocPercent.toLocaleString('fr-CH')} % et ne pas dépasser ${observed.limits.maxSocPercent.toLocaleString('fr-CH')} %.`, 400);
          }
          await assertGridHeadroom(command.powerKw);
        }
        if (c.req.raw.signal.aborted) throw new ControlError('La requête a été annulée avant l’envoi de la commande.', 409);
        if (command.mode === 'manual') await options.automation?.setManualOverride(true);
        const result = command.mode === 'auto'
          ? await upstream('/inverter/set-mode', { mode: 'normal' })
          : await upstream('/inverter/set-charge-power', { powerWatts: Math.round(command.powerKw * 1000), ...(command.targetSocPercent == null ? {} : { targetSocPercent: command.targetSocPercent }) });
        if (!object(result) || result.success !== true) throw new ControlError('Le contrôleur n’a pas confirmé la commande. Son résultat est inconnu ; actualisez l’état avant d’envoyer une autre commande.', 502, true);
        if (command.mode === 'auto') await options.automation?.setManualOverride(false);
        return c.json({ success: true, message: command.mode === 'auto' ? options.automation?.enabled() ? 'Le pilotage automatique de la batterie a repris.' : 'La batterie a retrouvé le fonctionnement normal de l’onduleur. La planification automatique de l’énergie n’est pas encore disponible.' : 'Le contrôleur a confirmé la commande de charge de la batterie.' });
      } catch (failure) {
        const error = failure instanceof ControlError || failure instanceof WattpilotControlError ? failure
          : new ControlError(device === 'car' ? 'Échec de la commande de la borne.' : 'Échec de la commande de la batterie.');
        return c.json({ success: false, error: error.message, ...(error.unknownOutcome ? { outcome: 'unknown' } : {}) }, error.status);
      } finally {
        if (locked) { mutating = false; generation++; cached = null; }
      }
    });
  }
  return { api: app, readStatus, sampleChargeEstimate, readChargeEstimate, automationController, carAutomationController, wattpilot };
}
